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



# --- transactions -----------------------------------------------------------

def test_transaction_list_get_and_fresh_verification(client, owner, fake_horizon):
    _, _, prepared, _ = _confirm_payment(client, owner, fake_horizon)
    listing = client.get("/api/v1/transactions?page=1&per_page=1", headers=owner.headers)
    assert listing.status_code == 200 and listing.json()["total"] == 1
    detail = client.get(f"/api/v1/transactions/{prepared['hash']}", headers=owner.headers)
    assert detail.status_code == 200
    assert detail.json()["verification"]["status"] == "successful"
    assert client.get("/api/v1/transactions/missing", headers=owner.headers).status_code == 404


def test_get_transaction_reports_unknown_when_fresh_verification_fails(client, owner, fake_horizon, monkeypatch):
    _, _, prepared, _ = _confirm_payment(client, owner, fake_horizon)

    def boom(_hash):
        raise RuntimeError("horizon down")

    monkeypatch.setattr(verification, "verify_stellar_payment", boom)
    response = client.get(f"/api/v1/transactions/{prepared['hash']}", headers=owner.headers)
    assert response.status_code == 200
    assert response.json()["verification"] == {"status": "unknown", "reason": "horizon down"}


def test_verify_transaction_duplicate_invoice_and_escrow_paths(client, owner, fake_horizon, monkeypatch):
    tx_hash = "b" * 64
    fake_horizon.amount = "10.0000000"
    fake_horizon.memo = "EXTRA"
    first = client.post(
        "/api/v1/transactions/verify",
        headers=owner.headers,
        json={"hash": tx_hash},
    )
    assert first.status_code == 200, first.text
    assert first.json()["settled"] is True
    duplicate = client.post(
        "/api/v1/transactions/verify", headers=owner.headers, json={"hash": tx_hash}
    )
    assert duplicate.status_code == 409 and duplicate.json()["code"] == "DUPLICATE_HASH"

    other_invoice = create_invoice(client, owner, create_supplier(client, owner)["id"])
    missing_invoice = client.post(
        "/api/v1/transactions/verify",
        headers=owner.headers,
        json={"hash": "c" * 64, "invoice_id": str(uuid.uuid4())},
    )
    assert missing_invoice.status_code == 404

    db = TestSession()
    try:
        db.add(models.PaymentRecord(
            business_id=owner.business_id, kind="escrow_release", amount=Decimal("1"),
            asset_code="XLM", xdr="x", hash="e" * 64, status="prepared",
            destination_account="C" + "d" * 55, agreement_id="agr-1", milestone_id="ms-1",
        ))
        db.commit()
    finally:
        db.close()

    monkeypatch.setattr(verification, "verify_soroban_release", lambda *a, **k: _verified_result("e" * 64))
    escrow = client.post(
        "/api/v1/transactions/verify", headers=owner.headers, json={"hash": "e" * 64}
    )
    assert escrow.status_code == 200 and escrow.json()["event_matched"] is True
    assert client.get("/api/v1/transactions", headers=owner.headers).json()["total"] == 2


def test_public_receipt_for_unrecorded_and_recorded_transaction(client, owner, fake_horizon):
    unrecorded = client.get(f"/api/v1/verify/{'f' * 64}")
    assert unrecorded.status_code == 200, unrecorded.text
    assert unrecorded.json()["status"] == "successful"
    assert unrecorded.json()["business_name"] is None

    _, _, prepared, _ = _confirm_payment(client, owner, fake_horizon)
    recorded = client.get(f"/api/v1/verify/{prepared['hash']}")
    assert recorded.status_code == 200
    assert recorded.json()["invoice_number"] is not None
    assert recorded.json()["business_name"]



# --- main handlers / misc ---------------------------------------------------

def test_health_and_http_error_envelope(client):
    assert client.get("/health").json()["network"] == "testnet"
    missing = client.get("/api/v1/definitely-missing")
    assert missing.status_code == 404 and missing.json()["code"] == "NOT_FOUND"


def test_main_exception_handlers_produce_structured_envelopes():
    limited = asyncio.run(rate_limit_handler(None, None))
    assert limited.status_code == 429 and limited.body
    assert b"RATE_LIMITED" in limited.body

    http = asyncio.run(http_exception_handler(None, HTTPException(status_code=418, detail="teapot")))
    assert http.status_code == 418 and b"HTTP_ERROR" in http.body

    from types import SimpleNamespace

    request = SimpleNamespace(method="GET", url=SimpleNamespace(path="/boom"))
    unexpected = asyncio.run(unexpected_error_handler(request, RuntimeError("boom")))
    assert unexpected.status_code == 500 and b"INTERNAL_ERROR" in unexpected.body

    cleaned = _jsonable_validation_error({
        "ctx": {"error": ValueError("bad")}, "input": object(), "loc": ("body", "amount"),
    })
    assert cleaned["loc"] == ("body", "amount")
    assert isinstance(cleaned["ctx"]["error"], str)
    assert isinstance(cleaned["input"], str)


def test_auth_inactive_account_is_rejected(client, owner):
    db = TestSession()
    try:
        user = db.get(models.User, owner.user_id)
        user.is_active = False
        db.commit()
    finally:
        db.close()
    response = client.post(
        "/api/v1/auth/login", json={"email": owner.email, "password": "Str0ngPassw0rd!"}
    )
    assert response.status_code == 401 and "inactive" in response.json()["detail"]


def test_notification_missing_is_not_found(client, owner):
    response = client.patch(
        f"/api/v1/notifications/{uuid.uuid4()}/read", headers=owner.headers
    )
    assert response.status_code == 404
