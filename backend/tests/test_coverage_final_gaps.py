"""Small edge cases left uncovered: config guards, helpers and provider errors."""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from types import SimpleNamespace

import pytest
from stellar_sdk import scval

from app import models
from app.config import Settings
from app.errors import BizError
from app.security import get_current_user, require_business
from app.services import invoices as invoice_service
from app.services import stellar, verification
from app.utils import to_decimal, utcnow
from tests.conftest import TestSession, create_supplier, register

HASH = "a" * 64


# --- config guards ----------------------------------------------------------

def test_production_config_requires_strong_secret_and_database():
    with pytest.raises(ValueError, match="at least 32 characters"):
        Settings(jwt_secret="short", environment="production")
    prod = Settings(jwt_secret="x" * 32, environment="prod", use_sqlite=True)
    assert prod.session_cookie_secure is True
    with pytest.raises(ValueError, match="DATABASE_URL"):
        Settings(
            jwt_secret="x" * 32, environment="staging", use_sqlite=False,
            database_url="postgresql+psycopg2://bizflow:bizflow@localhost:5432/bizflow",
        )
    # No publicly known fallback key exists. An empty secret is either rejected
    # or replaced by an ephemeral random key for the local SQLite test fallback.
    weak = Settings(jwt_secret="", environment="development", use_sqlite=True)
    assert len(weak.jwt_secret) >= 32
    assert weak.jwt_secret != "dev-only-jwt-secret-change-me"
    with pytest.raises(ValueError, match="at least 32 characters"):
        Settings(jwt_secret="", environment="development", use_sqlite=False)


# --- utility / security helpers --------------------------------------------

def test_to_decimal_rejects_out_of_range_money():
    with pytest.raises(BizError) as exc:
        to_decimal("1e30")
    assert "money range" in exc.value.detail


def test_get_current_user_rejects_inactive_account():
    db = TestSession()
    try:
        user = models.User(email="inactive@example.com", password_hash="x", full_name="X", is_active=False)
        db.add(user)
        db.flush()
        token = __import__("app.security", fromlist=["create_access_token"]).create_access_token(user.id)
        with pytest.raises(BizError) as exc:
            get_current_user(db, token, None)
        assert exc.value.status_code == 401
    finally:
        db.close()


def test_require_business_rejects_foreign_business():
    db = TestSession()
    try:
        membership = models.BusinessMember(business_id="b1", email="x@example.com", role="owner")
        with pytest.raises(BizError) as exc:
            require_business(membership, "b2")
        assert exc.value.status_code == 404
    finally:
        db.close()


def test_invoice_overdue_and_supplier_filtered_query():
    db = TestSession()
    try:
        supplier = models.Supplier(
            business_id="b", business_name="S", wallet_address="G" + "a" * 55, status="active"
        )
        db.add(supplier)
        db.flush()
        invoice = models.Invoice(
            business_id="b", supplier_id=supplier.id, invoice_number="INV-X",
            description="Work", amount=Decimal("10"), asset_code="XLM",
            due_date=utcnow() - timedelta(days=1), status="pending",
        )
        db.add(invoice)
        db.commit()
        assert invoice_service.derived_status(db, invoice) == "overdue"
        rows = db.scalars(invoice_service.visible_invoice_query(db, "b", None, supplier.id)).all()
        assert rows == [invoice]
    finally:
        db.close()


# --- transactions provider error paths -------------------------------------

def test_verify_endpoint_wraps_provider_failures(client, owner, monkeypatch):
    def provider_error(*args, **kwargs):
        raise BizError(502, "CHAIN_ERROR", "upstream down")

    monkeypatch.setattr(verification, "verify_stellar_payment", provider_error)
    response = client.post(
        "/api/v1/transactions/verify", headers=owner.headers, json={"hash": HASH}
    )
    assert response.status_code == 502 and response.json()["code"] == "CHAIN_ERROR"

    def unexpected(*args, **kwargs):
        raise RuntimeError("unexpected")

    monkeypatch.setattr(verification, "verify_stellar_payment", unexpected)
    response = client.post(
        "/api/v1/transactions/verify", headers=owner.headers, json={"hash": HASH}
    )
    assert response.status_code == 502 and response.json()["code"] == "CHAIN_ERROR"


def test_verify_endpoint_handles_hash_recorded_by_another_business(client, owner, second_owner, monkeypatch):
    db = TestSession()
    try:
        db.add(models.BlockchainTransaction(
            business_id=second_owner.business_id, hash=HASH, network="testnet",
            status="successful", successful=True,
        ))
        db.commit()
    finally:
        db.close()
    monkeypatch.setattr(
        verification, "verify_stellar_payment",
        lambda *a, **k: verification._result(
            hash=HASH, confirmed=True, successful=True, settled=True, status="successful",
            ledger=1, source_account=None, destination_account=None, asset_code=None,
            asset_issuer=None, amount=None, memo=None, network="testnet",
        ),
    )
    response = client.post(
        "/api/v1/transactions/verify", headers=owner.headers, json={"hash": HASH}
    )
    assert response.status_code == 200 and response.json()["hash"] == HASH
    assert client.get("/api/v1/transactions", headers=owner.headers).json()["total"] == 0


def test_verify_endpoint_tolerates_recording_failure(client, owner, monkeypatch):
    monkeypatch.setattr(
        verification, "verify_stellar_payment",
        lambda *a, **k: verification._result(
            hash=HASH, confirmed=True, successful=True, settled=True, status="successful",
            ledger=1, source_account=None, destination_account=None, asset_code=None,
            asset_issuer=None, amount=None, memo=None, network="testnet",
        ),
    )
    monkeypatch.setattr(
        verification, "record_transaction",
        lambda *a, **k: (_ for _ in ()).throw(BizError(409, "DUPLICATE_HASH", "nope")),
    )
    response = client.post(
        "/api/v1/transactions/verify", headers=owner.headers, json={"hash": HASH}
    )
    assert response.status_code == 200 and response.json()["settled"] is True


# --- agreement events from Soroban -----------------------------------------

def test_agreement_events_include_matching_soroban_events(client, owner, monkeypatch):
    supplier = create_supplier(client, owner)
    agreement = client.post(
        "/api/v1/agreements", headers=owner.headers,
        json={
            "supplier_id": supplier["id"], "title": "Work", "total_amount": "10",
            "asset_code": "XLM", "expiry_date": "2030-12-31T00:00:00",
            "milestones": [{"description": "A", "amount": "10"}],
        },
    ).json()
    db = TestSession()
    try:
        row = db.get(models.PaymentAgreement, agreement["id"])
        row.onchain_agreement_id = 7
        row.escrow_contract_id = "C" + "d" * 55
        db.commit()
    finally:
        db.close()

    class FakeRpc:
        def get_events(self, **kwargs):
            event = SimpleNamespace(
                contract_id="C" + "d" * 55,
                topic=[scval.to_symbol("funded").to_xdr(), scval.to_uint32(7).to_xdr()],
                value=scval.to_uint32(1).to_xdr(),
                ledger=5,
                transaction_hash=HASH,
            )
            return SimpleNamespace(events=[event])

    monkeypatch.setattr(stellar, "soroban_server", lambda: FakeRpc())
    response = client.get(f"/api/v1/agreements/{agreement['id']}/events", headers=owner.headers)
    assert response.status_code == 200
    assert any(item["source"] == "soroban" for item in response.json())
