"""Tests for read-only on-chain reconciliation (no real transactions submitted)."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

from stellar_sdk import Account, Keypair as StellarKeypair, scval

from app.config import get_settings
from app.services import reconciliation, stellar

settings = get_settings()


def _balance_xdr(funded: int, released: int, remaining: int) -> str:
    value = scval.to_map(
        {
            scval.to_symbol("funded"): scval.to_int128(funded),
            scval.to_symbol("released"): scval.to_int128(released),
            scval.to_symbol("remaining"): scval.to_int128(remaining),
        }
    )
    return value.to_xdr()


def test_read_contract_balances_decodes_soroban_result(monkeypatch):
    response = MagicMock()
    response.model_dump.return_value = {
        "error": None,
        "results": [{"xdr": _balance_xdr(20000000, 10000000, 10000000)}],
        "latest_ledger": 5907394,
    }
    server = MagicMock()
    server.load_account.return_value = Account(StellarKeypair.random().public_key, 1)
    server.simulate_transaction.return_value = response
    monkeypatch.setattr(stellar, "soroban_server", lambda: server)

    balances, ledger = reconciliation.read_contract_balances(
        settings.stellar_escrow_contract_id or settings.stellar_escrow_contract_id, StellarKeypair.random().public_key
    )
    assert balances == {"funded": 20000000, "released": 10000000, "remaining": 10000000}
    assert ledger == 5907394


def test_reconciliation_reports_mismatch_and_never_repairs(monkeypatch):
    agreement = SimpleNamespace(
        id="agreement-1",
        escrow_contract_id=settings.stellar_escrow_contract_id,
        onchain_agreement_id=1,
        funded_amount="2",
        fund_transaction_hash="a" * 64,
    )
    milestone = SimpleNamespace(amount="1", status="released")
    db = MagicMock()
    db.scalars.return_value.all.return_value = [milestone]
    db.scalar.return_value = 1
    monkeypatch.setattr(
        reconciliation, "read_contract_balances", lambda *a, **k: ({"funded": 20000000, "released": 0, "remaining": 20000000}, 1)
    )

    report = reconciliation.reconcile_agreement(db, agreement, source_account=StellarKeypair.random().public_key)
    data = report.as_dict()
    assert data["consistent"] is False
    assert "MISMATCH_RELEASED" in data["discrepancies"]
    assert "MISMATCH_REMAINING" in data["discrepancies"]
    assert data["database"] == {"funded": 20000000, "released": 10000000, "remaining": 10000000}
    # No write operations are issued against the database session.
    db.add.assert_not_called()
    db.commit.assert_not_called()


def test_reconcile_endpoint_returns_report_and_audit(client, owner, monkeypatch):
    """The authenticated API exposes read-only reconciliation with an audit record."""
    from datetime import datetime, timedelta, timezone

    from app import models
    from tests.conftest import TestSession

    supplier = client.post(
        "/api/v1/suppliers",
        headers=owner.headers,
        json={
            "business_name": "Reconciliation Supplier",
            "wallet_address": StellarKeypair.random().public_key,
        },
    ).json()
    due = (datetime.now(timezone.utc) + timedelta(days=7)).isoformat()
    agreement = client.post(
        "/api/v1/agreements",
        headers=owner.headers,
        json={
            "supplier_id": supplier["id"],
            "title": "Reconciliation agreement",
            "total_amount": "2",
            "expiry_date": due,
            "milestones": [{"description": "M1", "amount": "2"}],
        },
    ).json()

    db = TestSession()
    tx_hash = "c" * 64
    db.add(
        models.BlockchainTransaction(
            business_id=owner.business_id,
            hash=tx_hash,
            network="testnet",
            status="successful",
            successful=True,
            source_account=StellarKeypair.random().public_key,
        )
    )
    db.commit()
    row = db.get(models.PaymentAgreement, agreement["id"])
    row.fund_transaction_hash = tx_hash
    row.escrow_contract_id = settings.stellar_escrow_contract_id
    row.onchain_agreement_id = 1
    row.funded_amount = "2"
    db.commit()
    db.close()

    monkeypatch.setattr(
        reconciliation,
        "read_contract_balances",
        lambda *a, **k: ({"funded": 20000000, "released": 0, "remaining": 20000000}, 1),
    )
    response = client.post(
        f"/api/v1/agreements/{agreement['id']}/reconcile", headers=owner.headers
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["consistent"] is True
    assert body["onchain"]["funded"] == 20000000
    assert body["evidence"]["fund_transaction_hash"] == tx_hash

    audit = client.get("/api/v1/audit-logs", headers=owner.headers).json()
    entries = audit.get("items", audit) if isinstance(audit, dict) else audit
    assert any(entry["action"] == "agreement.reconciled" for entry in entries)


def test_reconciliation_consistent_state(monkeypatch):
    agreement = SimpleNamespace(
        id="agreement-2",
        escrow_contract_id=settings.stellar_escrow_contract_id,
        onchain_agreement_id=1,
        funded_amount="2",
        fund_transaction_hash="b" * 64,
    )
    milestone = SimpleNamespace(amount="1", status="released")
    db = MagicMock()
    db.scalars.return_value.all.return_value = [milestone]
    db.scalar.return_value = 1
    monkeypatch.setattr(
        reconciliation,
        "read_contract_balances",
        lambda *a, **k: ({"funded": 20000000, "released": 10000000, "remaining": 10000000}, 1),
    )
    report = reconciliation.reconcile_agreement(db, agreement, source_account=StellarKeypair.random().public_key)
    assert report.as_dict()["consistent"] is True
