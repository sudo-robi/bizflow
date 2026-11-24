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



# --- businesses -------------------------------------------------------------

def test_business_update_and_member_lifecycle(client, owner, second_owner):
    assert client.get("/api/v1/businesses", headers=owner.headers).status_code == 200
    updated = client.patch(
        f"/api/v1/businesses/{owner.business_id}",
        headers=owner.headers,
        json={"legal_name": "Legal", "currency": "eur"},
    )
    assert updated.status_code == 200 and updated.json()["currency"] == "EUR"
    assert client.get(
        f"/api/v1/businesses/{owner.business_id}", headers=owner.headers
    ).status_code == 200

    member_user = register(client, business=False)
    member_email = member_user.email
    added = client.post(
        f"/api/v1/businesses/{owner.business_id}/members",
        headers=owner.headers,
        json={"email": member_email, "role": "finance_manager"},
    )
    assert added.status_code == 201 and added.json()["status"] == "active"
    duplicate = client.post(
        f"/api/v1/businesses/{owner.business_id}/members",
        headers=owner.headers,
        json={"email": member_email, "role": "finance_manager"},
    )
    assert duplicate.status_code == 409

    members = client.get(f"/api/v1/businesses/{owner.business_id}/members", headers=owner.headers)
    assert members.status_code == 200
    target = next(m for m in members.json() if m["email"] == member_email)
    changed = client.patch(
        f"/api/v1/businesses/{owner.business_id}/members/{target['user']['id']}",
        headers=owner.headers,
        json={"role": "admin"},
    )
    assert changed.status_code == 200 and changed.json()["role"] == "admin"
    removed = client.delete(
        f"/api/v1/businesses/{owner.business_id}/members/{target['user']['id']}",
        headers=owner.headers,
    )
    assert removed.status_code == 200 and removed.json()["ok"] is True


def test_last_owner_cannot_be_demoted_or_removed(client, owner):
    assert client.patch(
        f"/api/v1/businesses/{owner.business_id}/members/{owner.user_id}",
        headers=owner.headers, json={"role": "finance_manager"},
    ).status_code == 400
    assert client.delete(
        f"/api/v1/businesses/{owner.business_id}/members/{owner.user_id}",
        headers=owner.headers,
    ).status_code == 400



# --- suppliers --------------------------------------------------------------

def test_supplier_crud_filters_and_archived_invoice_rejection(client, owner):
    supplier = create_supplier(client, owner)
    duplicate = client.post(
        "/api/v1/suppliers", headers=owner.headers,
        json={
            "business_name": "Other", "contact_name": "X", "email": "o@example.com",
            "wallet_address": supplier["wallet_address"], "country": "PT",
        },
    )
    assert duplicate.status_code == 409 and duplicate.json()["code"] == "DUPLICATE_WALLET"
    found = client.get(
        "/api/v1/suppliers?search=Acme&status=active", headers=owner.headers
    )
    assert found.status_code == 200 and found.json()["total"] == 1
    assert client.get(f"/api/v1/suppliers/{supplier['id']}", headers=owner.headers).status_code == 200
    changed = client.patch(
        f"/api/v1/suppliers/{supplier['id']}", headers=owner.headers,
        json={"email": "NEW@Example.com", "notes": "updated"},
    )
    assert changed.status_code == 200 and changed.json()["email"] == "new@example.com"

    archived = client.post(
        f"/api/v1/suppliers/{supplier['id']}/archive", headers=owner.headers
    )
    assert archived.status_code == 200 and archived.json()["status"] == "archived"
    invoice = client.post(
        "/api/v1/invoices", headers=owner.headers,
        json={
            "supplier_id": supplier["id"], "description": "Work", "amount": "10",
            "asset_code": "XLM", "due_date": "2030-12-31T00:00:00",
        },
    )
    assert invoice.status_code == 400 and invoice.json()["code"] == "SUPPLIER_ARCHIVED"


def test_supplier_scoped_invoice_and_payment_lists(client, owner, supplier_actor):
    supplier = create_supplier(client, owner, email=supplier_actor.email)
    invoice = create_invoice(client, owner, supplier["id"])
    invoices = client.get(
        f"/api/v1/suppliers/{supplier['id']}/invoices", headers=supplier_actor.headers
    )
    assert invoices.status_code == 200 and invoices.json()["total"] == 1
    payments = client.get(
        f"/api/v1/suppliers/{supplier['id']}/payments", headers=supplier_actor.headers
    )
    assert payments.status_code == 200 and payments.json()["total"] == 0

    unlinked = create_supplier(client, owner)
    denied = client.get(
        f"/api/v1/suppliers/{unlinked['id']}/invoices", headers=supplier_actor.headers
    )
    assert denied.status_code == 403
    assert client.get(
        f"/api/v1/suppliers/{unlinked['id']}", headers=supplier_actor.headers
    ).status_code == 403
    assert invoice["amount"] == "1250.5"
