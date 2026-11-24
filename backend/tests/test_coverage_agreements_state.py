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



# --- agreements -------------------------------------------------------------

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


def test_agreement_update_and_state_rejections(client, owner):
    supplier = create_supplier(client, owner)
    agreement = _agreement(client, owner, supplier["id"])
    updated = client.patch(
        f"/api/v1/agreements/{agreement['id']}", headers=owner.headers,
        json={
            "title": "Renamed", "description": "new", "asset_code": "xlm",
            "expiry_date": "2031-01-01T00:00:00",
            "conditions": {"a": 1}, "approval_requirements": {"b": 2},
        },
    )
    assert updated.status_code == 200 and updated.json()["title"] == "Renamed"
    assert updated.json()["asset_code"] == "XLM"
    assert len(updated.json()["milestones"]) == 1

    submitted = client.post(f"/api/v1/agreements/{agreement['id']}/submit", headers=owner.headers)
    assert submitted.status_code == 200
    assert client.patch(
        f"/api/v1/agreements/{agreement['id']}", headers=owner.headers, json={"title": "No"}
    ).status_code == 409
    assert client.post(
        f"/api/v1/agreements/{agreement['id']}/submit", headers=owner.headers
    ).status_code == 409
    assert client.post(
        f"/api/v1/agreements/{agreement['id']}/accept", headers=owner.headers
    ).status_code == 403
    assert client.post(
        f"/api/v1/agreements/{agreement['id']}/reject", headers=owner.headers
    ).status_code == 403

    cancelled = client.post(
        f"/api/v1/agreements/{agreement['id']}/cancel", headers=owner.headers,
        json={"reason": "Done"},
    )
    assert cancelled.status_code == 200
    assert client.post(
        f"/api/v1/agreements/{agreement['id']}/cancel", headers=owner.headers
    ).status_code == 409


def test_dispute_requires_active_agreement_and_allowed_role(client, owner, supplier_actor, finance_actor):
    supplier = create_supplier(client, owner, email=supplier_actor.email)
    agreement = _agreement(client, owner, supplier["id"])
    denied = client.post(
        f"/api/v1/agreements/{agreement['id']}/dispute", headers=finance_actor.headers
    )
    assert denied.status_code == 403
    assert client.post(
        f"/api/v1/agreements/{agreement['id']}/dispute", headers=owner.headers
    ).status_code == 409

    client.post(f"/api/v1/agreements/{agreement['id']}/submit", headers=owner.headers)
    client.post(f"/api/v1/agreements/{agreement['id']}/accept", headers=supplier_actor.headers)
    disputed = client.post(
        f"/api/v1/agreements/{agreement['id']}/dispute", headers=owner.headers
    )
    assert disputed.status_code == 200 and disputed.json()["status"] == "disputed"


def test_agreement_reject_wrong_state_and_missing_agreement(client, owner, supplier_actor):
    supplier = create_supplier(client, owner, email=supplier_actor.email)
    agreement = _agreement(client, owner, supplier["id"])
    response = client.post(
        f"/api/v1/agreements/{agreement['id']}/reject", headers=supplier_actor.headers
    )
    assert response.status_code == 409 and response.json()["code"] == "AGREEMENT_STATE"
    assert client.get(
        f"/api/v1/agreements/{uuid.uuid4()}", headers=owner.headers
    ).status_code == 404
    assert client.post(
        "/api/v1/agreements/missing/submit", headers=owner.headers
    ).status_code == 404
