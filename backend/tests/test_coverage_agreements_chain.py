"""Endpoint tests for under-covered success and rejection branches."""

from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from fastapi import HTTPException
from stellar_sdk import Keypair, StrKey

from app import models
from app.config import get_settings
from app.errors import BizError
from app.main import (
    _jsonable_validation_error,
    http_exception_handler,
    rate_limit_handler,
    unexpected_error_handler,
)
from app.services import stellar, verification
from app.utils import utcnow
from tests.conftest import TestSession, create_invoice, create_supplier, register

CONTRACT_ID = get_settings().stellar_escrow_contract_id


def _set_onchain_id(agreement_id: str, value: int = 1) -> None:
    db = TestSession()
    try:
        db.get(models.PaymentAgreement, agreement_id).onchain_agreement_id = value
        db.commit()
    finally:
        db.close()


def _activate_status(agreement_id: str) -> None:
    db = TestSession()
    try:
        agreement = db.get(models.PaymentAgreement, agreement_id)
        agreement.status = "active"
        agreement.onchain_agreement_id = 1
        db.commit()
    finally:
        db.close()


def _settled_stellar_result(tx_hash: str, amount="100"):
    return verification.VerificationResult(
        hash=tx_hash, confirmed=True, successful=True, settled=True,
        status="successful", ledger=5, source_account=Keypair.random().public_key,
        destination_account=CONTRACT_ID, asset_code="XLM", asset_issuer=None,
        amount=Decimal(amount), memo=None, network="testnet",
    )


def _verified_result(tx_hash="a" * 64, settled=True, reason=None):
    return verification.VerificationResult(
        hash=tx_hash, confirmed=True, successful=True, settled=settled,
        status="SUCCESS" if settled else "failed", ledger=12,
        source_account=None, destination_account="C", asset_code=None,
        asset_issuer=None, amount=None, memo=None, network="testnet",
        contract_id="C", event_matched=settled, checked_at=datetime.now(timezone.utc),
        reason=reason,
    )


def _confirm_payment(client, owner, fake_horizon, amount="1250.50"):
    supplier = create_supplier(client, owner, wallet=fake_horizon.destination)
    invoice = create_invoice(client, owner, supplier["id"], amount=amount)
    prepared = client.post(
        "/api/v1/payments/prepare",
        headers=owner.headers,
        json={"invoice_id": invoice["id"], "source_account": fake_horizon.source},
    ).json()
    fake_horizon.amount = money(amount)
    fake_horizon.memo = invoice["invoice_number"]
    response = client.post(
        f"/api/v1/payments/{prepared['payment_id']}/submit",
        headers=owner.headers,
        json={"signed_xdr": prepared["xdr"]},
    )
    assert response.status_code == 200, response.text
    return supplier, invoice, prepared, response.json()


def money(value):
    return f"{Decimal(value):.7f}"

# --- agreements_chain -------------------------------------------------------

def _active_agreement(client, owner, supplier_actor, fake_horizon, monkeypatch):
    supplier = create_supplier(
        client, owner, email=supplier_actor.email, wallet=fake_horizon.destination
    )
    agreement = _agreement(client, owner, supplier["id"])
    client.post(f"/api/v1/agreements/{agreement['id']}/submit", headers=owner.headers)
    client.post(f"/api/v1/agreements/{agreement['id']}/accept", headers=supplier_actor.headers)
    return agreement


def _fake_horizon_stub():
    class Stub:
        source = Keypair.random().public_key
        destination = Keypair.random().public_key
        amount = "100.0000000"
        memo = "EXTRA"

    return Stub()

def _agreement(client, owner, supplier_id, total="100"):
    response = client.post(
        "/api/v1/agreements", headers=owner.headers,
        json={
            "supplier_id": supplier_id, "title": "Work", "total_amount": total,
            "asset_code": "XLM", "expiry_date": "2030-12-31T00:00:00",
            "milestones": [{"description": "A", "amount": total}],
        },
    )
    assert response.status_code == 201, response.text
    return response.json()

def test_prepare_approve_state_errors(client, owner, supplier_actor, monkeypatch):
    agreement = _active_agreement(client, owner, supplier_actor, _fake_horizon_stub(), monkeypatch)
    _set_onchain_id(agreement["id"])
    milestones = client.get(
        f"/api/v1/agreements/{agreement['id']}/milestones", headers=owner.headers
    ).json()
    path = f"/api/v1/agreements/{agreement['id']}/milestones/{milestones[0]['id']}/prepare-approve"
    response = client.post(path, headers=owner.headers, json={"source_account": Keypair.random().public_key})
    assert response.status_code == 409 and response.json()["code"] == "AGREEMENT_STATE"

    monkeypatch.setattr(stellar, "build_soroban_fund_xdr", lambda *a, **k: stellar.PreparedTransaction(xdr="AAAA", hash="f" * 64))
    monkeypatch.setattr(stellar, "transaction_hash", lambda _xdr: "f" * 64)
    monkeypatch.setattr(verification, "verify_stellar_payment", lambda *a, **k: _settled_stellar_result("f" * 64))
    funded = client.post(
        f"/api/v1/agreements/{agreement['id']}/fund", headers=owner.headers,
        json={"transaction_hash": "f" * 64, "funded_amount": "100"},
    )
    assert funded.status_code == 200, funded.text
    db = TestSession()
    try:
        db.get(models.AgreementMilestone, milestones[0]["id"]).status = "approved"
        db.commit()
    finally:
        db.close()
    bad_state = client.post(
        f"/api/v1/agreements/{agreement['id']}/milestones/{milestones[0]['id']}/prepare-approve",
        headers=owner.headers, json={"source_account": Keypair.random().public_key},
    )
    assert bad_state.status_code == 409 and bad_state.json()["code"] == "MILESTONE_STATE"


def _funded_approved_agreement(client, owner, supplier_actor, monkeypatch):
    agreement = _active_agreement(client, owner, supplier_actor, _fake_horizon_stub(), monkeypatch)
    _set_onchain_id(agreement["id"])
    monkeypatch.setattr(stellar, "build_soroban_fund_xdr", lambda *a, **k: stellar.PreparedTransaction(xdr="AAAA", hash="f" * 64))
    monkeypatch.setattr(stellar, "build_soroban_approve_xdr", lambda *a, **k: stellar.PreparedTransaction(xdr="AAAA-appr", hash="a" * 64))
    monkeypatch.setattr(stellar, "build_soroban_release_xdr", lambda *a, **k: stellar.PreparedTransaction(xdr="AAAA-rel", hash="r" * 64))
    monkeypatch.setattr(stellar, "transaction_hash", lambda xdr: {"AAAA-appr": "a" * 64, "AAAA-rel": "r" * 64}.get(xdr, "f" * 64))
    monkeypatch.setattr(verification, "verify_stellar_payment", lambda *a, **k: _settled_stellar_result("f" * 64))
    assert client.post(
        f"/api/v1/agreements/{agreement['id']}/fund", headers=owner.headers,
        json={"transaction_hash": "f" * 64, "funded_amount": "100"},
    ).status_code == 200
    milestones = client.get(
        f"/api/v1/agreements/{agreement['id']}/milestones", headers=owner.headers
    ).json()
    db = TestSession()
    try:
        db.get(models.AgreementMilestone, milestones[0]["id"]).status = "approved"
        db.commit()
    finally:
        db.close()
    return agreement, milestones


def test_approve_milestone_soroban_rejections(client, owner, supplier_actor, monkeypatch):
    agreement, milestones = _funded_approved_agreement(client, owner, supplier_actor, monkeypatch)
    db = TestSession()
    try:
        db.get(models.AgreementMilestone, milestones[0]["id"]).status = "pending"
        db.commit()
    finally:
        db.close()
    base = f"/api/v1/agreements/{agreement['id']}/milestones/{milestones[0]['id']}"
    assert client.post(
        f"{base}/prepare-approve", headers=owner.headers,
        json={"source_account": Keypair.random().public_key},
    ).status_code == 200

    monkeypatch.setattr(
        stellar, "submit_soroban",
        lambda *a, **k: stellar.ChainResult(
            hash="a", status="FAILED", confirmed=False, successful=False, reason="declined"
        ),
    )
    unconfirmed = client.post(f"{base}/approve", headers=owner.headers, json={"signed_xdr": "AAAA-appr"})
    assert unconfirmed.status_code == 409 and unconfirmed.json()["code"] == "UNCONFIRMED_TX"

    db = TestSession()
    try:
        from sqlalchemy import select
        approval = db.scalar(
            select(models.PaymentRecord).where(
                models.PaymentRecord.agreement_id == agreement["id"],
                models.PaymentRecord.kind == "escrow_approval",
            )
        )
        approval.status = "prepared"
        approval.failure_reason = None
        db.commit()
    finally:
        db.close()

    db = TestSession()
    try:
        from sqlalchemy import select
        approval = db.scalar(
            select(models.PaymentRecord).where(
                models.PaymentRecord.agreement_id == agreement["id"],
                models.PaymentRecord.kind == "escrow_approval",
            )
        )
        approval.status = "prepared"
        approval.failure_reason = None
        db.commit()
    finally:
        db.close()

    monkeypatch.setattr(
        stellar, "submit_soroban",
        lambda *a, **k: stellar.ChainResult(hash="a", status="SUCCESS", confirmed=True, successful=True),
    )
    monkeypatch.setattr(
        verification, "verify_soroban_approval",
        lambda *a, **k: _verified_result(settled=False, reason="no approval event"),
    )
    unverified = client.post(f"{base}/approve", headers=owner.headers, json={"signed_xdr": "AAAA-appr"})
    assert unverified.status_code == 409 and unverified.json()["code"] == "UNVERIFIED_EVENT"

    # Reset the failed approval record to prepared, then expire it.
    db = TestSession()
    try:
        from sqlalchemy import select
        approval = db.scalar(
            select(models.PaymentRecord).where(
                models.PaymentRecord.agreement_id == agreement["id"],
                models.PaymentRecord.kind == "escrow_approval",
            )
        )
        assert approval is not None
        approval.status = "prepared"
        approval.expires_at = utcnow() - timedelta(seconds=1)
        db.commit()
    finally:
        db.close()
    expired = client.post(f"{base}/approve", headers=owner.headers, json={"signed_xdr": "AAAA-appr"})
    assert expired.status_code == 409 and expired.json()["code"] == "EXPIRED_XDR"

    monkeypatch.setattr(verification, "verify_soroban_approval", lambda *a, **k: _verified_result("a" * 64))
    db = TestSession()
    try:
        from sqlalchemy import select
        approval = db.scalar(
            select(models.PaymentRecord).where(
                models.PaymentRecord.agreement_id == agreement["id"],
                models.PaymentRecord.kind == "escrow_approval",
            )
        )
        approval.expires_at = utcnow() + timedelta(minutes=10)
        approval.kind = "escrow_fund"
        db.commit()
    finally:
        db.close()
    wrong_kind = client.post(f"{base}/approve", headers=owner.headers, json={"signed_xdr": "AAAA-appr"})
    assert wrong_kind.status_code == 404


def test_release_validation_and_soroban_rejections(client, owner, supplier_actor, monkeypatch):
    agreement = _active_agreement(client, owner, supplier_actor, _fake_horizon_stub(), monkeypatch)
    _set_onchain_id(agreement["id"])
    milestones = client.get(
        f"/api/v1/agreements/{agreement['id']}/milestones", headers=owner.headers
    ).json()
    base = f"/api/v1/agreements/{agreement['id']}/milestones/{milestones[0]['id']}"
    not_funded = client.post(f"{base}/prepare-release", headers=owner.headers, json={})
    assert not_funded.status_code == 409 and not_funded.json()["code"] == "NOT_FUNDED"

    agreement, milestones = _funded_approved_agreement(client, owner, supplier_actor, monkeypatch)
    db = TestSession()
    try:
        extra = models.AgreementMilestone(
            agreement_id=agreement["id"], description="Extra", amount=Decimal("1"),
            sort_order=1, status="pending",
        )
        db.add(extra)
        db.commit()
        remaining = extra.id
    finally:
        db.close()
    other_base = f"/api/v1/agreements/{agreement['id']}/milestones/{remaining}"
    not_approved = client.post(f"{other_base}/prepare-release", headers=owner.headers, json={})
    assert not_approved.status_code == 409 and not_approved.json()["code"] == "MILESTONE_NOT_APPROVED"

    approved_base = f"/api/v1/agreements/{agreement['id']}/milestones/{milestones[0]['id']}"
    prepared = client.post(f"{approved_base}/prepare-release", headers=owner.headers, json={})
    assert prepared.status_code == 200, prepared.text

    monkeypatch.setattr(
        stellar, "submit_soroban",
        lambda *a, **k: stellar.ChainResult(
            hash="r", status="FAILED", confirmed=False, successful=False, reason="declined"
        ),
    )
    unconfirmed = client.post(
        f"{approved_base}/release", headers=owner.headers, json={"signed_xdr": "AAAA-rel"}
    )
    assert unconfirmed.status_code == 409 and unconfirmed.json()["code"] == "UNCONFIRMED_TX"
    db = TestSession()
    try:
        failed_audits = db.query(models.AuditLog).filter_by(action="milestone.release_failed").count()
        assert failed_audits == 1
        from sqlalchemy import select
        release = db.scalar(
            select(models.PaymentRecord).where(
                models.PaymentRecord.agreement_id == agreement["id"],
                models.PaymentRecord.kind == "escrow_release",
            )
        )
        release.status = "prepared"
        release.failure_reason = None
        db.commit()
    finally:
        db.close()
    events = client.get(f"/api/v1/agreements/{agreement['id']}/events", headers=owner.headers)
    assert any(row["source"] == "audit" for row in events.json())

    monkeypatch.setattr(
        stellar, "submit_soroban",
        lambda *a, **k: stellar.ChainResult(hash="r", status="SUCCESS", confirmed=True, successful=True),
    )
    monkeypatch.setattr(
        verification, "verify_soroban_release",
        lambda *a, **k: _verified_result(settled=False, reason="no event"),
    )
    unverified = client.post(
        f"{approved_base}/release", headers=owner.headers, json={"signed_xdr": "AAAA-rel"}
    )
    assert unverified.status_code == 409 and unverified.json()["code"] == "UNVERIFIED_EVENT"

    db = TestSession()
    try:
        from sqlalchemy import select
        release = db.scalar(
            select(models.PaymentRecord).where(
                models.PaymentRecord.agreement_id == agreement["id"],
                models.PaymentRecord.kind == "escrow_release",
            )
        )
        release.expires_at = utcnow() - timedelta(seconds=1)
        release.status = "prepared"
        db.commit()
    finally:
        db.close()
    expired = client.post(
        f"{approved_base}/release", headers=owner.headers, json={"signed_xdr": "AAAA-rel"}
    )
    assert expired.status_code == 409 and expired.json()["code"] == "EXPIRED_XDR"

    db = TestSession()
    try:
        from sqlalchemy import select
        release = db.scalar(
            select(models.PaymentRecord).where(
                models.PaymentRecord.agreement_id == agreement["id"],
                models.PaymentRecord.kind == "escrow_release",
            )
        )
        release.expires_at = utcnow() + timedelta(minutes=10)
        release.kind = "escrow_fund"
        db.commit()
    finally:
        db.close()
    wrong_kind = client.post(
        f"{approved_base}/release", headers=owner.headers, json={"signed_xdr": "AAAA-rel"}
    )
    assert wrong_kind.status_code == 404


def test_final_release_completes_agreement(client, owner, supplier_actor, monkeypatch):
    agreement, milestones = _funded_approved_agreement(client, owner, supplier_actor, monkeypatch)
    monkeypatch.setattr(stellar, "submit_soroban", lambda *a, **k: stellar.ChainResult(
        hash="a" * 64, status="SUCCESS", confirmed=True, successful=True,
    ))
    monkeypatch.setattr(verification, "verify_soroban_approval", lambda *a, **k: _verified_result("a" * 64))
    monkeypatch.setattr(verification, "verify_soroban_release", lambda *a, **k: _verified_result("r" * 64))
    db = TestSession()
    try:
        db.get(models.AgreementMilestone, milestones[0]["id"]).status = "pending"
        db.commit()
    finally:
        db.close()
    base = f"/api/v1/agreements/{agreement['id']}/milestones/{milestones[0]['id']}"
    assert client.post(
        f"{base}/prepare-approve", headers=owner.headers,
        json={"source_account": Keypair.random().public_key},
    ).status_code == 200
    assert client.post(f"{base}/approve", headers=owner.headers, json={"signed_xdr": "AAAA-appr"}).status_code == 200
    assert client.post(f"{base}/prepare-release", headers=owner.headers, json={}).status_code == 200
    released = client.post(f"{base}/release", headers=owner.headers, json={"signed_xdr": "AAAA-rel"})
    assert released.status_code == 200, released.text
    assert released.json()["status"] == "completed"
