"""Independent verification service unit tests with mocked Horizon response objects."""

from __future__ import annotations

import pytest

from app.errors import BizError
from app.services import stellar, verification
from tests.conftest import TestSession

HASH = "c" * 64


def _horizon(successful=True, op_successful=True, amount="10.5000000"):
    tx = {
        "hash": HASH,
        "successful": successful,
        "ledger": 99,
        "source_account": "GSOURCE",
        "memo": "INV-2026-0001",
        "memo_type": "text",
    }
    op = {
        "type": "payment",
        "from": "GSOURCE",
        "to": "GDEST",
        "asset_type": "native",
        "amount": amount,
        "transaction_successful": op_successful,
    }
    return tx, [op]


def test_verified_matching_payment_is_settled(monkeypatch):
    tx, ops = _horizon()
    monkeypatch.setattr(stellar, "fetch_transaction", lambda h: tx)
    monkeypatch.setattr(stellar, "fetch_transaction_operations", lambda h: ops)
    result = verification.verify_stellar_payment(
        HASH,
        expected={
            "source_account": "GSOURCE",
            "destination_account": "GDEST",
            "asset_code": "XLM",
            "asset_issuer": None,
            "amount": "10.5",
            "memo": "INV-2026-0001",
        },
    )
    assert result.confirmed is True
    assert result.successful is True
    assert result.settled is True
    assert result.asset_code == "XLM"
    assert str(result.amount) == "10.5000000"


def test_amount_mismatch_never_settles(monkeypatch):
    tx, ops = _horizon()
    monkeypatch.setattr(stellar, "fetch_transaction", lambda h: tx)
    monkeypatch.setattr(stellar, "fetch_transaction_operations", lambda h: ops)
    result = verification.verify_stellar_payment(HASH, expected={"amount": "99"})
    assert result.successful is True
    assert result.settled is False
    assert "amount" in result.reason


def test_unsuccessful_transaction_never_settles(monkeypatch):
    tx, ops = _horizon(successful=False)
    monkeypatch.setattr(stellar, "fetch_transaction", lambda h: tx)
    monkeypatch.setattr(stellar, "fetch_transaction_operations", lambda h: ops)
    result = verification.verify_stellar_payment(HASH)
    assert result.confirmed is False
    assert result.settled is False
    assert result.status == "failed"


def test_unsuccessful_operation_never_settles(monkeypatch):
    tx, ops = _horizon(op_successful=False)
    monkeypatch.setattr(stellar, "fetch_transaction", lambda h: tx)
    monkeypatch.setattr(stellar, "fetch_transaction_operations", lambda h: ops)
    result = verification.verify_stellar_payment(HASH)
    assert result.successful is True
    assert result.settled is False
    assert "payment operation" in result.reason


def test_network_failure_raises_chain_error(monkeypatch):
    def boom(_):
        raise RuntimeError("horizon down")

    monkeypatch.setattr(stellar, "fetch_transaction", boom)
    with pytest.raises(BizError) as exc:
        verification.verify_stellar_payment(HASH)
    assert exc.value.status_code == 502


def test_hash_reuse_is_detected_after_recording(monkeypatch):
    tx, ops = _horizon()
    monkeypatch.setattr(stellar, "fetch_transaction", lambda h: tx)
    monkeypatch.setattr(stellar, "fetch_transaction_operations", lambda h: ops)
    result = verification.verify_stellar_payment(HASH)
    db = TestSession()
    try:
        assert verification.hash_already_used(db, HASH) is False
        verification.record_transaction(db, "business-1", result)
        db.commit()
        assert verification.hash_already_used(db, HASH) is True
    finally:
        db.close()
