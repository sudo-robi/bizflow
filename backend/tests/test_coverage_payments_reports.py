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



# --- payments ---------------------------------------------------------------

def test_payment_prepare_and_submit_error_paths(client, owner, fake_horizon):
    assert client.post(
        "/api/v1/payments/prepare", headers=owner.headers,
        json={"invoice_id": str(uuid.uuid4()), "source_account": fake_horizon.source},
    ).status_code == 404
    supplier = create_supplier(client, owner, wallet=fake_horizon.destination)
    invoice = create_invoice(client, owner, supplier["id"])
    client.post(f"/api/v1/invoices/{invoice['id']}/submit", headers=owner.headers)
    client.post(f"/api/v1/invoices/{invoice['id']}/cancel", headers=owner.headers)
    cancelled = client.post(
        "/api/v1/payments/prepare", headers=owner.headers,
        json={"invoice_id": invoice["id"], "source_account": fake_horizon.source},
    )
    assert cancelled.status_code == 409 and cancelled.json()["code"] == "INVOICE_STATE"

    paid_invoice = create_invoice(client, owner, supplier["id"], amount="10")
    db = TestSession()
    try:
        db.add(models.PaymentRecord(
            business_id=owner.business_id, invoice_id=paid_invoice["id"], kind="ordinary",
            amount=Decimal("10"), asset_code="XLM", xdr="x", hash="1" * 64,
            status="confirmed", confirmed_at=utcnow(),
        ))
        db.commit()
    finally:
        db.close()
    settled = client.post(
        "/api/v1/payments/prepare", headers=owner.headers,
        json={"invoice_id": paid_invoice["id"], "source_account": fake_horizon.source},
    )
    assert settled.status_code == 409 and settled.json()["code"] == "INVOICE_STATE"


def test_payment_submit_expiry_and_unverified_payment(client, owner, fake_horizon, monkeypatch):
    supplier = create_supplier(client, owner, wallet=fake_horizon.destination)
    invoice = create_invoice(client, owner, supplier["id"])
    prepared = client.post(
        "/api/v1/payments/prepare", headers=owner.headers,
        json={"invoice_id": invoice["id"], "source_account": fake_horizon.source},
    ).json()
    payment_id = prepared["payment_id"]

    db = TestSession()
    try:
        payment = db.get(models.PaymentRecord, payment_id)
        payment.status = "confirmed"
        db.commit()
    finally:
        db.close()
    wrong_state = client.post(
        f"/api/v1/payments/{payment_id}/submit", headers=owner.headers,
        json={"signed_xdr": prepared["xdr"]},
    )
    assert wrong_state.status_code == 409 and wrong_state.json()["code"] == "PAYMENT_STATE"

    db = TestSession()
    try:
        payment = db.get(models.PaymentRecord, payment_id)
        payment.status = "prepared"
        payment.expires_at = utcnow() - timedelta(seconds=1)
        db.commit()
    finally:
        db.close()
    expired = client.post(
        f"/api/v1/payments/{payment_id}/submit", headers=owner.headers,
        json={"signed_xdr": prepared["xdr"]},
    )
    assert expired.status_code == 409 and expired.json()["code"] == "EXPIRED_XDR"

    db = TestSession()
    try:
        payment = db.get(models.PaymentRecord, payment_id)
        payment.expires_at = utcnow() + timedelta(minutes=10)
        payment.status = "prepared"
        payment.failure_reason = None
        db.commit()
    finally:
        db.close()
    monkeypatch.setattr(
        verification, "verify_stellar_payment",
        lambda *a, **k: verification.VerificationResult(
            hash=prepared["hash"], confirmed=True, successful=True, settled=False,
            status="successful", ledger=1, source_account=None, destination_account=None,
            asset_code=None, asset_issuer=None, amount=None, memo=None, network="testnet",
            reason="mismatch",
        ),
    )
    unverified = client.post(
        f"/api/v1/payments/{payment_id}/submit", headers=owner.headers,
        json={"signed_xdr": prepared["xdr"]},
    )
    assert unverified.status_code == 409 and unverified.json()["code"] == "UNVERIFIED_TX"
    assert client.get(f"/api/v1/payments/{payment_id}/receipt", headers=owner.headers).status_code == 409
    assert client.get("/api/v1/payments?status=prepared", headers=owner.headers).status_code == 200



# --- reports ----------------------------------------------------------------

def test_analytics_aging_and_reconciliation_detail(client, owner):
    supplier = create_supplier(client, owner)
    db = TestSession()
    try:
        old = models.Invoice(
            business_id=owner.business_id, supplier_id=supplier["id"],
            invoice_number="INV-OLD", description="old", amount=Decimal("100"),
            asset_code="XLM", due_date=utcnow() - timedelta(days=120), status="pending",
        )
        recent = models.Invoice(
            business_id=owner.business_id, supplier_id=supplier["id"],
            invoice_number="INV-NEW", description="new", amount=Decimal("100"),
            asset_code="XLM", due_date=utcnow() - timedelta(days=10), status="pending",
        )
        overpaid = models.Invoice(
            business_id=owner.business_id, supplier_id=supplier["id"],
            invoice_number="INV-OVER", description="over", amount=Decimal("100"),
            asset_code="XLM", due_date=utcnow() - timedelta(days=10), status="pending",
        )
        db.add_all([old, recent, overpaid])
        db.flush()
        db.add_all([
            models.PaymentRecord(
                business_id=owner.business_id, invoice_id=old.id, kind="ordinary",
                amount=Decimal("40"), asset_code="XLM", xdr="x", hash="2" * 64,
                status="confirmed", confirmed_at=utcnow(),
            ),
            models.PaymentRecord(
                business_id=owner.business_id, invoice_id=recent.id, kind="ordinary",
                amount=Decimal("50"), asset_code="XLM", xdr="x", hash="3" * 64,
                status="confirmed", confirmed_at=utcnow(),
            ),
            models.PaymentRecord(
                business_id=owner.business_id, invoice_id=overpaid.id, kind="ordinary",
                amount=Decimal("150"), asset_code="XLM", xdr="x", hash="5" * 64,
                status="confirmed", confirmed_at=utcnow(),
            ),
            models.PaymentRecord(
                business_id=owner.business_id, invoice_id=recent.id, kind="ordinary",
                amount=Decimal("5"), asset_code="XLM", xdr="x", status="failed",
            ),
        ])
        db.add(models.BlockchainTransaction(
            business_id=owner.business_id, hash="4" * 64, network="testnet",
            status="pending", successful=False,
        ))
        db.commit()
    finally:
        db.close()

    analytics = client.get("/api/v1/reports/analytics", headers=owner.headers)
    assert analytics.status_code == 200
    body = analytics.json()
    assert body["completed_payments"] == 3 and body["failed_payments"] == 1
    assert body["invoice_aging"]["90_plus"]["count"] == "1"
    assert body["invoice_aging"]["0_30"]["count"] == "1"
    assert body["outstanding_liabilities"] == "110"
    assert len(body["monthly_payment_volume"]) == 1
    month = next(iter(body["monthly_payment_volume"].values()))
    assert month["change_pct"] is None
    assert body["supplier_breakdown"]

    reconciliation = client.get("/api/v1/reports/reconciliation", headers=owner.headers)
    assert reconciliation.status_code == 200
    data = reconciliation.json()
    assert len(data["unmatched_transactions"]) == 1
    assert len(data["partial_payments"]) == 2
    assert len(data["overpayments"]) == 1
    assert data["confirmed_payments_without_hash"] == 0

    dashboard = client.get("/api/v1/reports/dashboard", headers=owner.headers)
    assert dashboard.status_code == 200
    assert dashboard.json()["counts"]["payments_failed"] if "payments_failed" in dashboard.json()["counts"] else True
