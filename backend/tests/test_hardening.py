"""Regression tests for blockchain, security and deployment hardening."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from app import models
from app.config import get_settings
from app.security import csrf_token_for_jwt
from app.services import reconciliation, stellar, verification
from tests.conftest import TestSession, create_supplier

CONTRACT = get_settings().stellar_escrow_contract_id
HASH = "f" * 64


@pytest.fixture(autouse=True)
def _stub_contract_identity(monkeypatch):
    """Event-layer stubs replace chain reads in this unit suite."""
    monkeypatch.setattr(reconciliation, "assert_contract_identity", lambda *a, **k: {})


def _agreement_body(supplier_id: str, total: str = "100.00"):
    return {
        "supplier_id": supplier_id,
        "title": "Hardening agreement",
        "total_amount": total,
        "asset_code": "XLM",
        "expiry_date": "2030-12-31T00:00:00",
        "milestones": [
            {"description": "First", "amount": "40.00"},
            {"description": "Second", "amount": "60.00"},
        ],
    }


def _active_agreement(client, owner):
    supplier = create_supplier(client, owner)
    response = client.post(
        "/api/v1/agreements", headers=owner.headers, json=_agreement_body(supplier["id"])
    )
    assert response.status_code == 201, response.text
    agreement = response.json()
    client.post(f"/api/v1/agreements/{agreement['id']}/submit", headers=owner.headers)
    db = TestSession()
    try:
        row = db.get(models.PaymentAgreement, agreement["id"])
        row.onchain_agreement_id = 1
        row.escrow_contract_id = CONTRACT  # escrow binding is now required to fund
        row.status = "active"  # fixture: supplier acceptance is covered elsewhere
        db.commit()
    finally:
        db.close()
    return agreement


# --- CSRF / headers / input validation -------------------------------------

def test_csrf_blocks_cookie_authenticated_mutation(client):
    response = client.post(
        "/api/v1/auth/register",
        json={
            "email": f"csrf-{uuid.uuid4().hex[:8]}@example.com",
            "password": "Str0ngPassw0rd!",
            "full_name": "CSRF User",
            "business_name": "CSRF Co",
        },
    )
    assert response.status_code == 201
    token = client.cookies.get("bizflow_csrf")
    session = client.cookies.get("bizflow_session")
    assert token and session
    assert token == csrf_token_for_jwt(session)

    # Cookie present, no header and no Origin -> rejected.
    blocked = client.post("/api/v1/businesses", json={"name": "Cross-site"})
    assert blocked.status_code == 403
    assert blocked.json()["code"] == "CSRF_TOKEN_MISSING"

    # Sec-Fetch-Site is never a substitute for the token.
    fetch_site = client.post(
        "/api/v1/businesses",
        json={"name": "Cross-site"},
        headers={"Sec-Fetch-Site": "same-origin"},
    )
    assert fetch_site.status_code == 403
    assert fetch_site.json()["code"] == "CSRF_TOKEN_MISSING"

    # A token from a different session is rejected even with a same-origin hint.
    foreign = client.post(
        "/api/v1/businesses",
        json={"name": "Cross-site"},
        headers={"X-CSRF-Token": "a" * 64, "Sec-Fetch-Site": "same-origin"},
    )
    assert foreign.status_code == 403
    assert foreign.json()["code"] == "CSRF_TOKEN_INVALID"

    # The value derived from this session's JWT is accepted.
    allowed = client.post(
        "/api/v1/businesses", json={"name": "Legitimate"}, headers={"X-CSRF-Token": token}
    )
    assert allowed.status_code == 201, allowed.text


def test_csrf_rejects_foreign_origin_with_and_without_token(client):
    client.post(
        "/api/v1/auth/register",
        json={
            "email": f"origin-{uuid.uuid4().hex[:8]}@example.com",
            "password": "Str0ngPassw0rd!",
            "full_name": "Origin User",
        },
    )
    response = client.post(
        "/api/v1/businesses", json={"name": "Bad"}, headers={"Origin": "https://evil.example"}
    )
    assert response.status_code == 403
    assert response.json()["code"] == "CSRF_ORIGIN_DENIED"

    # A valid token does not excuse a foreign Origin (defense in depth).
    token = client.cookies.get("bizflow_csrf")
    with_token = client.post(
        "/api/v1/businesses",
        json={"name": "Bad"},
        headers={"Origin": "https://evil.example", "X-CSRF-Token": token},
    )
    assert with_token.status_code == 403
    assert with_token.json()["code"] == "CSRF_ORIGIN_DENIED"


def test_security_headers_and_correlation_id(client):
    response = client.get("/health")
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["X-Frame-Options"] == "DENY"
    assert response.headers["Referrer-Policy"] == "strict-origin-when-cross-origin"
    assert response.headers["Content-Security-Policy"].startswith("default-src 'self'")
    assert response.headers["X-Request-ID"]

    echoed = client.get("/health", headers={"X-Request-ID": "trace-123"})
    assert echoed.headers["X-Request-ID"] == "trace-123"


def test_validation_errors_do_not_echo_submitted_secrets(client):
    response = client.post(
        "/api/v1/auth/register",
        json={"email": "x@example.com", "password": {"secret": "DO_NOT_LEAK"}, "full_name": "X"},
    )
    assert response.status_code == 422
    assert "DO_NOT_LEAK" not in response.text


def test_malformed_transaction_hash_is_rejected(client, owner):
    assert client.get("/api/v1/transactions/not-a-hash", headers=owner.headers).status_code == 422
    assert client.get(f"/api/v1/verify/{'z' * 64}").status_code == 422


def test_oversized_request_is_rejected(client):
    from app.config import get_settings as settings_fn

    limit = settings_fn().max_request_body_bytes
    response = client.post(
        "/api/v1/auth/register",
        content=b"x" * (limit + 1),
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 413
    assert response.json()["code"] == "REQUEST_TOO_LARGE"


# --- Authorization ----------------------------------------------------------

def test_supplier_cannot_manage_wallets_or_read_financial_reports(client, supplier_actor):
    key = stellar.Keypair.random().public_key  # type: ignore[attr-defined]
    assert client.post(
        "/api/v1/wallets", headers=supplier_actor.headers, json={"public_key": key}
    ).status_code == 403
    for path in ("/api/v1/reports/dashboard", "/api/v1/audit-logs"):
        assert client.get(path, headers=supplier_actor.headers).status_code == 403


# --- Blockchain integrity ---------------------------------------------------

def test_cancel_funded_agreement_is_blocked(client, owner):
    agreement = _active_agreement(client, owner)
    db = TestSession()
    try:
        row = db.get(models.PaymentAgreement, agreement["id"])
        row.funded_amount = "100.0000000"
        row.fund_transaction_hash = HASH
        db.commit()
    finally:
        db.close()
    response = client.post(f"/api/v1/agreements/{agreement['id']}/cancel", headers=owner.headers)
    assert response.status_code == 409
    assert response.json()["code"] == "ESCROW_FUNDS_OUTSTANDING"


def test_duplicate_hash_cannot_be_reused_for_escrow_funding(client, owner, monkeypatch):
    agreement = _active_agreement(client, owner)
    monkeypatch.setattr(
        stellar, "build_soroban_fund_xdr",
        lambda *a, **k: stellar.PreparedTransaction(xdr="AAAA-fund", hash=HASH),
    )
    prepared = client.post(
        f"/api/v1/agreements/{agreement['id']}/prepare-fund",
        headers=owner.headers,
        json={"source_account": stellar.Keypair.random().public_key},  # type: ignore[attr-defined]
    )
    assert prepared.status_code == 200, prepared.text
    xdr = prepared.json()["xdr"]
    monkeypatch.setattr(stellar, "transaction_hash", lambda _xdr: prepared.json()["hash"])

    db = TestSession()
    try:
        db.add(
            models.BlockchainTransaction(
                business_id=owner.business_id,
                hash=prepared.json()["hash"],
                network="testnet",
                status="successful",
                successful=True,
            )
        )
        db.commit()
    finally:
        db.close()

    response = client.post(
        f"/api/v1/agreements/{agreement['id']}/fund-escrow",
        headers=owner.headers,
        json={"signed_xdr": xdr},
    )
    assert response.status_code == 409
    assert response.json()["code"] == "DUPLICATE_HASH"


def test_release_event_verification_requires_exact_amount(monkeypatch):
    calls = []

    def fake(tx_hash, contract_id, symbol, **kwargs):
        calls.append((symbol, kwargs))
        from app.services.verification import _result

        return _result(
            hash=tx_hash, confirmed=True, successful=True, settled=True, status="SUCCESS",
            ledger=1, source_account=None, destination_account=contract_id, asset_code=None,
            asset_issuer=None, amount=None, memo=None, network="testnet",
        )

    monkeypatch.setattr(verification, "verify_soroban_event", fake)
    from decimal import Decimal

    verification.verify_soroban_release("a" * 64, CONTRACT, "1", 0, amount=Decimal("40.0"))
    assert calls[-1][1]["amount"] == Decimal("40.0")


def test_escrow_state_mismatch_blocks_settlement(client, owner, monkeypatch):
    """With state verification enabled, a conflicting chain read must refuse funding."""
    from app.routers import agreements_chain
    from app.services import reconciliation

    # This regression is about post-submit balance mismatch, not getter identity.
    monkeypatch.setattr(
        reconciliation, "assert_contract_identity", lambda *a, **k: {"agreement_id": 1}
    )
    agreement = _active_agreement(client, owner)
    monkeypatch.setattr(
        stellar, "build_soroban_fund_xdr",
        lambda *a, **k: stellar.PreparedTransaction(xdr="AAAA-fund", hash=HASH),
    )
    prepared = client.post(
        f"/api/v1/agreements/{agreement['id']}/prepare-fund",
        headers=owner.headers,
        json={"source_account": stellar.Keypair.random().public_key},  # type: ignore[attr-defined]
    )
    assert prepared.status_code == 200, prepared.text
    xdr = prepared.json()["xdr"]
    monkeypatch.setattr(stellar, "transaction_hash", lambda _xdr: prepared.json()["hash"])
    monkeypatch.setattr(
        stellar, "submit_soroban",
        lambda *a, **k: stellar.ChainResult(hash="a", status="SUCCESS", confirmed=True, successful=True),
    )
    monkeypatch.setattr(
        verification, "verify_soroban_funding",
        lambda *a, **k: verification._result(
            hash="a", confirmed=True, successful=True, settled=True, status="SUCCESS",
            ledger=1, source_account=None, destination_account=CONTRACT, asset_code=None,
            asset_issuer=None, amount=None, memo=None, network="testnet",
        ),
    )
    monkeypatch.setattr(
        reconciliation, "read_contract_balances",
        lambda *a, **k: ({"funded": 0, "released": 0, "remaining": 0}, 1),
    )
    monkeypatch.setattr(
        reconciliation, "read_contract_agreement",
        lambda *a, **k: {
            "agreement_id": 1, "payer": None, "payee": None, "asset": None,
            "total_amount": 1000000000, "milestone_count": 2,
            "funded": 0, "released": 0, "remaining": 0,
            "authorized": None, "status": "Created",
        },
    )
    monkeypatch.setattr(agreements_chain.settings, "enforce_escrow_state_verification", True)

    response = client.post(
        f"/api/v1/agreements/{agreement['id']}/fund-escrow",
        headers=owner.headers,
        json={"signed_xdr": xdr},
    )
    assert response.status_code == 409
    assert response.json()["code"] == "ESCROW_STATE_MISMATCH"

    db = TestSession()
    try:
        row = db.get(models.PaymentAgreement, agreement["id"])
        assert row.fund_transaction_hash is None
    finally:
        db.close()
    monkeypatch.setattr(agreements_chain.settings, "enforce_escrow_state_verification", False)


def test_reconciliation_creates_auditable_record(client, owner):
    agreement = _active_agreement(client, owner)
    response = client.post(
        f"/api/v1/agreements/{agreement['id']}/reconcile", headers=owner.headers
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["reconciliation_record_id"]
    assert body["resolution_status"] == "open"

    db = TestSession()
    try:
        record = db.scalar(
            select(models.ReconciliationRecord).where(
                models.ReconciliationRecord.agreement_id == agreement["id"]
            )
        )
        assert record is not None
        assert record.expected_state is not None
        assert record.discrepancy is not None
    finally:
        db.close()
