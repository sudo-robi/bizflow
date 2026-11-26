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


@pytest.fixture(autouse=True)
def _stub_contract_identity(monkeypatch):
    """Event-layer stubs replace chain reads in this unit suite."""
    from app.services import reconciliation

    monkeypatch.setattr(reconciliation, "assert_contract_identity", lambda *a, **k: {})


def _set_onchain_id(agreement_id: str, value: int = 1) -> None:
    db = TestSession()
    try:
        row = db.get(models.PaymentAgreement, agreement_id)
        row.onchain_agreement_id = value
        row.escrow_contract_id = CONTRACT_ID
        db.commit()
    finally:
        db.close()


def _activate_status(agreement_id: str) -> None:
    db = TestSession()
    try:
        agreement = db.get(models.PaymentAgreement, agreement_id)
        agreement.status = "active"
        agreement.onchain_agreement_id = 1
        agreement.escrow_contract_id = CONTRACT_ID
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

def test_fund_agreement_amount_and_verification_errors(client, owner, monkeypatch):
    supplier = create_supplier(client, owner)
    agreement = _agreement(client, owner, supplier["id"])
    path = f"/api/v1/agreements/{agreement['id']}/fund"
    body = {"transaction_hash": "a" * 64, "funded_amount": "101"}
    assert client.post(path, headers=owner.headers, json=body).status_code == 409

    assert client.post(
        f"/api/v1/agreements/{agreement['id']}/fund", headers=owner.headers, json=body
    ).status_code == 409
    _activate_status(agreement["id"])

    unverified = verification.VerificationResult(
        hash="a" * 64, confirmed=True, successful=True, settled=False, status="failed",
        ledger=1, source_account=None, destination_account=None, asset_code=None,
        asset_issuer=None, amount=None, memo=None, network="testnet", reason="not matching",
    )
    monkeypatch.setattr(verification, "verify_stellar_payment", lambda *a, **k: unverified)
    response = client.post(path, headers=owner.headers, json={**body, "funded_amount": "100"})
    assert response.status_code == 409 and response.json()["code"] == "UNVERIFIED_TX"

    monkeypatch.setattr(
        verification, "verify_stellar_payment", lambda *a, **k: _settled_stellar_result("a" * 64)
    )
    db = TestSession()
    try:
        db.add(models.BlockchainTransaction(
            business_id=owner.business_id, hash="a" * 64, network="testnet",
            status="successful", successful=True,
        ))
        db.commit()
    finally:
        db.close()
    duplicate = client.post(path, headers=owner.headers, json={**body, "funded_amount": "100"})
    assert duplicate.status_code == 409 and duplicate.json()["code"] == "DUPLICATE_HASH"


def test_fund_agreement_expected_fields_and_unrelated_destination(client, owner, monkeypatch):
    supplier = create_supplier(client, owner)
    agreement = _agreement(client, owner, supplier["id"])
    _activate_status(agreement["id"])
    captured = {}

    def fake_verify(tx_hash, expected=None):
        captured.update(expected or {})
        return _settled_stellar_result(tx_hash)

    monkeypatch.setattr(verification, "verify_stellar_payment", fake_verify)
    response = client.post(
        f"/api/v1/agreements/{agreement['id']}/fund",
        headers=owner.headers,
        json={
            "transaction_hash": "c" * 64, "funded_amount": "100",
            "source_account": Keypair.random().public_key, "memo": agreement["reference"],
        },
    )
    assert response.status_code == 200, response.text
    assert captured["destination_account"] == CONTRACT_ID
    assert captured["memo"] == agreement["reference"]
    assert captured["amount"] == Decimal("100")
    assert response.json()["escrow_contract_id"] == CONTRACT_ID

    other = _agreement(client, owner, supplier["id"], total="50")
    _activate_status(other["id"])
    unrelated = verification.VerificationResult(
        hash="d" * 64, confirmed=True, successful=True, settled=False,
        status="successful", ledger=1, source_account=None,
        destination_account=Keypair.random().public_key, asset_code="XLM",
        asset_issuer=None, amount=Decimal("50"), memo=other["reference"], network="testnet",
        reason="Transaction fields do not match: destination_account",
    )
    monkeypatch.setattr(verification, "verify_stellar_payment", lambda *a, **k: unrelated)
    rejected = client.post(
        f"/api/v1/agreements/{other['id']}/fund", headers=owner.headers,
        json={"transaction_hash": "d" * 64, "funded_amount": "50"},
    )
    assert rejected.status_code == 409 and rejected.json()["code"] == "UNVERIFIED_TX"
    assert "destination_account" in rejected.json()["detail"]


def test_prepare_escrow_fund_validation_errors(client, owner, supplier_actor, monkeypatch):
    agreement = _active_agreement(client, owner, supplier_actor, _fake_horizon_stub(), monkeypatch)
    _set_onchain_id(agreement["id"])
    path = f"/api/v1/agreements/{agreement['id']}/prepare-fund"
    assert client.post(path, headers=owner.headers, json={"amount": "101"}).status_code == 400
    assert client.post(
        path, headers=owner.headers, json={"escrow_contract_id": Keypair.random().public_key}
    ).status_code == 422

    monkeypatch.setattr(
        stellar, "build_soroban_fund_xdr",
        lambda *a, **k: stellar.PreparedTransaction(xdr="AAAA", hash="f" * 64),
    )
    different = StrKey.encode_contract(Keypair.random().raw_public_key())
    from app.config import get_settings as _get_settings

    monkeypatch.setattr(_get_settings(), "stellar_escrow_contract_id", CONTRACT_ID)
    mismatch = client.post(
        path, headers=owner.headers,
        json={"escrow_contract_id": different, "source_account": Keypair.random().public_key},
    )
    assert mismatch.status_code == 400 and mismatch.json()["code"] == "CONTRACT_MISMATCH"

    missing_id = _agreement(client, owner, create_supplier(client, owner)["id"])
    db = TestSession()
    try:
        db.get(models.PaymentAgreement, missing_id["id"]).status = "active"
        db.commit()
    finally:
        db.close()
    no_id = client.post(
        f"/api/v1/agreements/{missing_id['id']}/prepare-fund", headers=owner.headers,
        json={"source_account": Keypair.random().public_key},
    )
    assert no_id.status_code == 409 and no_id.json()["code"] == "NO_ONCHAIN_ID"


def _fake_horizon_stub():
    class Stub:
        source = Keypair.random().public_key
        destination = Keypair.random().public_key
        amount = "100.0000000"
        memo = "EXTRA"

    return Stub()


def test_prepare_and_submit_escrow_fund_rejections(client, owner, supplier_actor, monkeypatch):
    agreement = _active_agreement(client, owner, supplier_actor, _fake_horizon_stub(), monkeypatch)
    _set_onchain_id(agreement["id"])
    monkeypatch.setattr(
        stellar, "build_soroban_fund_xdr",
        lambda *a, **k: stellar.PreparedTransaction(xdr="AAAA", hash="f" * 64),
    )
    prepare_path = f"/api/v1/agreements/{agreement['id']}/prepare-fund"
    # A client-supplied on-chain id can never overwrite the server-derived binding.
    override = client.post(
        prepare_path, headers=owner.headers,
        json={"onchain_agreement_id": 7, "source_account": Keypair.random().public_key},
    )
    assert override.status_code == 400
    assert override.json()["code"] == "ONCHAIN_ID_READ_ONLY"
    prepared = client.post(
        prepare_path, headers=owner.headers,
        json={"source_account": Keypair.random().public_key},
    )
    assert prepared.status_code == 200, prepared.text
    assert client.get(
        f"/api/v1/agreements/{agreement['id']}", headers=owner.headers
    ).json()["onchain_agreement_id"] == 1
    submit_path = f"/api/v1/agreements/{agreement['id']}/fund-escrow"
    xdr = prepared.json()["xdr"]
    monkeypatch.setattr(stellar, "transaction_hash", lambda _xdr: prepared.json()["hash"])

    db = TestSession()
    try:
        payment = db.get(models.PaymentRecord, prepared.json()["payment_id"])
        payment.expires_at = utcnow() - timedelta(seconds=1)
        db.commit()
    finally:
        db.close()
    expired = client.post(submit_path, headers=owner.headers, json={"signed_xdr": xdr})
    assert expired.status_code == 409 and expired.json()["code"] == "EXPIRED_XDR"

    db = TestSession()
    try:
        payment = db.get(models.PaymentRecord, prepared.json()["payment_id"])
        payment.expires_at = utcnow() + timedelta(minutes=10)
        payment.status = "prepared"
        db.commit()
    finally:
        db.close()

    monkeypatch.setattr(
        stellar, "submit_soroban",
        lambda *a, **k: stellar.ChainResult(
            hash="a", status="FAILED", confirmed=False, successful=False, reason="rpc declined"
        ),
    )
    unconfirmed = client.post(submit_path, headers=owner.headers, json={"signed_xdr": xdr})
    assert unconfirmed.status_code == 409 and unconfirmed.json()["code"] == "UNCONFIRMED_TX"

    monkeypatch.setattr(
        stellar, "submit_soroban",
        lambda *a, **k: stellar.ChainResult(hash="a", status="SUCCESS", confirmed=True, successful=True),
    )
    monkeypatch.setattr(
        verification, "verify_soroban_funding",
        lambda *a, **k: _verified_result(settled=False, reason="no event"),
    )
    unverified = client.post(submit_path, headers=owner.headers, json={"signed_xdr": xdr})
    assert unverified.status_code == 409 and unverified.json()["code"] == "UNVERIFIED_EVENT"


