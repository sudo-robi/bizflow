"""Edge-case unit tests for independent on-chain verification (RPC mocked)."""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace

import pytest
from stellar_sdk import scval

from app.errors import BizError
from app.services import stellar, verification
from tests.conftest import TestSession

HASH = "d" * 64
CONTRACT = "C" + "d" * 55


def _scval(value) -> str:
    """Encode a Python value as an XDR scval string for event topics/values."""
    if isinstance(value, str):
        return scval.to_symbol(value).to_xdr()
    if isinstance(value, int):
        return scval.to_uint32(value).to_xdr()
    return scval.to_int128(value).to_xdr()


class _Event:
    def __init__(self, **data):
        self._data = data

    def model_dump(self):
        return dict(self._data)


class _SorobanServer:
    def __init__(self, *, tx_error=None, status="SUCCESS", events=None,
                 events_error=None, ledger=10, latest_ledger=100):
        self.tx_error = tx_error
        self.status = status
        self.events = events or []
        self.events_error = events_error
        self.ledger = ledger
        self.latest_ledger = latest_ledger
        self.event_calls = []

    def get_transaction(self, tx_hash):
        if self.tx_error:
            raise self.tx_error
        return SimpleNamespace(
            status=SimpleNamespace(value=self.status),
            ledger=self.ledger,
            latest_ledger=self.latest_ledger,
        )

    def get_events(self, **kwargs):
        self.event_calls.append(kwargs)
        if self.events_error:
            raise self.events_error
        return SimpleNamespace(events=[_Event(**event) for event in self.events])


def _event(*, symbol="funded", topics=None, value=None, tx_hash=HASH, contract_id=CONTRACT):
    return {
        "transaction_hash": tx_hash,
        "contract_id": contract_id,
        "topic": topics if topics is not None else [_scval(symbol)],
        "value": value if value is not None else _scval(100000000),
    }


# --- result serialization ---------------------------------------------------

def test_as_dict_handles_missing_amount_and_checked_at():
    result = verification._result(
        hash=HASH, confirmed=False, successful=False, settled=False, status="pending",
        ledger=None, source_account=None, destination_account=None, asset_code=None,
        asset_issuer=None, amount=None, memo=None, network="testnet",
    )
    body = result.as_dict()
    assert body["amount"] is None
    assert body["checked_at"] is not None and body["contract_id"] is None
    assert body["event_matched"] is False


# --- verify_stellar_payment -------------------------------------------------

def _horizon(tx=None, ops=None, ops_error=None):
    tx = tx or {
        "hash": HASH, "successful": True, "ledger": 5,
        "source_account": "GSRC", "memo": "MEMO", "memo_type": "text",
    }
    monkeypatch_ops = ops if ops is not None else [{
        "type": "payment", "from": "GSRC", "to": "GDEST",
        "asset_type": "native", "amount": "10", "transaction_successful": True,
    }]

    def fetch_ops(_hash):
        if ops_error:
            raise ops_error
        return monkeypatch_ops

    return tx, fetch_ops


def test_stellar_verify_tolerates_operation_fetch_failure(monkeypatch):
    tx, fetch_ops = _horizon(ops_error=RuntimeError("events down"))
    monkeypatch.setattr(stellar, "fetch_transaction", lambda h: tx)
    monkeypatch.setattr(stellar, "fetch_transaction_operations", fetch_ops)
    result = verification.verify_stellar_payment(HASH)
    assert result.successful and not result.settled
    assert "payment operation" in result.reason


def test_stellar_verify_discards_non_text_memo(monkeypatch):
    tx, fetch_ops = _horizon()
    tx["memo_type"] = "hash"
    monkeypatch.setattr(stellar, "fetch_transaction", lambda h: tx)
    monkeypatch.setattr(stellar, "fetch_transaction_operations", fetch_ops)
    result = verification.verify_stellar_payment(HASH)
    assert result.memo is None


def test_stellar_verify_accepts_known_text_memo_variant(monkeypatch):
    tx, fetch_ops = _horizon()
    tx["memo_type"] = "text_memo"
    monkeypatch.setattr(stellar, "fetch_transaction", lambda h: tx)
    monkeypatch.setattr(stellar, "fetch_transaction_operations", fetch_ops)
    assert verification.verify_stellar_payment(HASH).memo == "MEMO"


def test_stellar_verify_reports_each_field_mismatch(monkeypatch):
    tx, fetch_ops = _horizon()
    monkeypatch.setattr(stellar, "fetch_transaction", lambda h: tx)
    monkeypatch.setattr(stellar, "fetch_transaction_operations", fetch_ops)
    result = verification.verify_stellar_payment(HASH, expected={
        "source_account": "OTHER", "destination_account": "OTHER", "asset_code": "USD",
        "asset_issuer": "GISSUER", "amount": "999", "memo": "OTHER",
    })
    assert not result.settled
    for field in ("source_account", "destination_account", "asset_code", "asset_issuer", "amount", "memo"):
        assert field in result.reason


def test_stellar_verify_reports_pending_status(monkeypatch):
    tx, fetch_ops = _horizon()
    tx["successful"] = None
    monkeypatch.setattr(stellar, "fetch_transaction", lambda h: tx)
    monkeypatch.setattr(stellar, "fetch_transaction_operations", fetch_ops)
    result = verification.verify_stellar_payment(HASH)
    assert result.status == "pending" and not result.confirmed
    assert result.ledger == 5


def test_stellar_verify_uses_credit_asset_fields_from_operation(monkeypatch):
    tx, _ = _horizon()
    ops = [{
        "type": "payment", "from": "GSRC", "to": "GDEST", "asset_code": "USD",
        "asset_issuer": "GISSUER", "amount": "1.5", "transaction_successful": True,
    }]
    monkeypatch.setattr(stellar, "fetch_transaction", lambda h: tx)
    monkeypatch.setattr(stellar, "fetch_transaction_operations", lambda h: ops)
    result = verification.verify_stellar_payment(HASH)
    assert result.asset_code == "USD" and result.asset_issuer == "GISSUER"


# --- Soroban event decoding -------------------------------------------------

def test_soroban_scval_to_native_decodes_real_xdr():
    assert verification.soroban_rpc_scval_to_native(_scval("funded")) == "funded"
    assert verification.soroban_rpc_scval_to_native(_scval(3)) == 3


def test_native_returns_none_for_undecodable_value():
    assert verification._native("not-xdr") is None


# --- verify_soroban_event ---------------------------------------------------

def test_soroban_verification_raises_on_rpc_failure(monkeypatch):
    monkeypatch.setattr(
        stellar, "soroban_server", lambda: _SorobanServer(tx_error=RuntimeError("down"))
    )
    with pytest.raises(BizError) as exc:
        verification.verify_soroban_event(HASH, CONTRACT, "funded")
    assert exc.value.status_code == 502


def test_soroban_verification_does_not_settle_failed_transaction(monkeypatch):
    monkeypatch.setattr(stellar, "soroban_server", lambda: _SorobanServer(status="FAILED"))
    result = verification.verify_soroban_event(HASH, CONTRACT, "funded")
    assert not result.confirmed and not result.settled
    assert "did not succeed" in result.reason
    assert result.destination_account == CONTRACT


def test_soroban_verification_matches_funding_event(monkeypatch):
    monkeypatch.setattr(stellar.time, "sleep", lambda *_: None)
    event = _event(topics=[_scval("funded"), _scval(7)], value=_scval(100000000))
    server = _SorobanServer(events=[event])
    monkeypatch.setattr(stellar, "soroban_server", lambda: server)
    result = verification.verify_soroban_event(
        HASH, CONTRACT, "funded", agreement_id="7", amount=Decimal("10")
    )
    assert result.confirmed and result.event_matched and result.settled
    assert result.amount == Decimal("10")
    assert server.event_calls[0]["filters"][0].contract_ids == [CONTRACT]


def test_soroban_verification_matches_numeric_agreement_in_topics(monkeypatch):
    server = _SorobanServer(events=[_event(topics=[_scval("released"), _scval(12), _scval(1)])])
    monkeypatch.setattr(stellar, "soroban_server", lambda: server)
    result = verification.verify_soroban_event(
        HASH, CONTRACT, "released", agreement_id="12", milestone_index=1
    )
    assert result.settled and result.event_matched


def test_soroban_verification_skips_non_numeric_agreement_id(monkeypatch):
    # A non-numeric agreement_id cannot be matched even when present in topics.
    server = _SorobanServer(events=[_event(topics=[_scval("approved"), _scval("AGR-1")])])
    monkeypatch.setattr(stellar, "soroban_server", lambda: server)
    result = verification.verify_soroban_event(
        HASH, CONTRACT, "approved", agreement_id="AGR-1"
    )
    assert not result.settled and not result.event_matched


def test_soroban_verification_accepts_list_value(monkeypatch):
    vec = scval.to_vec([scval.to_int128(100000000), scval.to_int128(5)]).to_xdr()
    server = _SorobanServer(events=[_event(value=vec)])
    monkeypatch.setattr(stellar, "soroban_server", lambda: server)
    result = verification.verify_soroban_event(HASH, CONTRACT, "funded", amount=Decimal("10"))
    assert result.settled and result.amount == Decimal("10")


def test_soroban_verification_skips_events_with_wrong_transaction_or_contract(monkeypatch):
    monkeypatch.setattr(stellar.time, "sleep", lambda *_: None)
    events = [
        _event(tx_hash="other" * 4 + "other"),
        _event(contract_id="C" + "e" * 55),
    ]
    server = _SorobanServer(events=events)
    monkeypatch.setattr(stellar, "soroban_server", lambda: server)
    result = verification.verify_soroban_event(HASH, CONTRACT, "funded")
    assert not result.settled and "No matching" in result.reason


def test_soroban_verification_skips_wrong_symbol_agreement_milestone_and_amount(monkeypatch):
    monkeypatch.setattr(stellar.time, "sleep", lambda *_: None)
    events = [
        _event(topics=[_scval("other-symbol")]),
        _event(topics=[_scval("funded"), _scval(99)]),
        _event(topics=[_scval("funded"), _scval(7), _scval(0)], value=_scval(1)),
    ]
    server = _SorobanServer(events=events)
    monkeypatch.setattr(stellar, "soroban_server", lambda: server)
    result = verification.verify_soroban_event(
        HASH, CONTRACT, "funded", agreement_id="7", milestone_index=1, amount=Decimal("10")
    )
    assert not result.event_matched and not result.settled


def test_soroban_verification_skips_undecodable_topic(monkeypatch):
    server = _SorobanServer(events=[_event(topics=["bad-xdr"])])
    monkeypatch.setattr(stellar, "soroban_server", lambda: server)
    result = verification.verify_soroban_event(HASH, CONTRACT, "funded")
    assert not result.event_matched


def test_soroban_verification_tolerates_get_events_failure(monkeypatch):
    server = _SorobanServer(events_error=RuntimeError("indexer down"))
    monkeypatch.setattr(stellar, "soroban_server", lambda: server)
    result = verification.verify_soroban_event(HASH, CONTRACT, "funded")
    assert not result.settled and len(server.event_calls) >= 1


def test_soroban_verification_retries_later_ledgers(monkeypatch):
    monkeypatch.setattr(stellar.time, "sleep", lambda *_: None)
    server = _SorobanServer(latest_ledger=100)
    response_calls = []

    def get_events(**kwargs):
        response_calls.append(kwargs)
        if len(response_calls) == 1:
            return SimpleNamespace(events=[])
        return SimpleNamespace(events=[_Event(**_event())])

    server.get_events = get_events
    monkeypatch.setattr(stellar, "soroban_server", lambda: server)
    result = verification.verify_soroban_event(HASH, CONTRACT, "funded")
    assert result.settled and len(response_calls) == 2
    assert response_calls[0]["end_ledger"] == 100
    assert response_calls[1]["end_ledger"] == 101


def test_soroban_wrapper_functions_delegate_to_event_verifier(monkeypatch):
    calls = []

    def fake(tx_hash, contract_id, symbol, **kwargs):
        calls.append((symbol, kwargs))
        return verification._result(
            hash=tx_hash, confirmed=True, successful=True, settled=True, status="SUCCESS",
            ledger=1, source_account=None, destination_account=contract_id, asset_code=None,
            asset_issuer=None, amount=None, memo=None, network="testnet",
        )

    monkeypatch.setattr(verification, "verify_soroban_event", fake)
    assert verification.verify_soroban_release(HASH, CONTRACT, "AGR-1", 2).settled
    assert calls[-1] == (
        "released", {"agreement_id": "AGR-1", "milestone_index": 2, "amount": None}
    )
    assert verification.verify_soroban_funding(HASH, CONTRACT, Decimal("1"), "9").settled
    assert calls[-1][0] == "funded"
    assert verification.verify_soroban_approval(HASH, CONTRACT, "AGR-1", 3).settled
    assert calls[-1][0] == "approved"


# --- persistence ------------------------------------------------------------

def test_duplicate_hash_is_reported_as_conflict():
    db = TestSession()
    try:
        result = verification._result(
            hash=HASH, confirmed=True, successful=True, settled=True, status="successful",
            ledger=5, source_account="GSRC", destination_account="GDEST", asset_code="XLM",
            asset_issuer=None, amount=Decimal("10"), memo="MEMO", network="testnet",
        )
        verification.record_transaction(db, "business-1", result)
        db.commit()
        with pytest.raises(BizError) as exc:
            verification.record_transaction(db, "business-1", result)
        assert exc.value.code == "DUPLICATE_HASH"
        assert exc.value.status_code == 409
    finally:
        db.close()


def test_recorded_confirmed_transaction_has_confirmation_time():
    db = TestSession()
    try:
        result = verification._result(
            hash="e" * 64, confirmed=True, successful=True, settled=True, status="successful",
            ledger=5, source_account=None, destination_account=None, asset_code=None,
            asset_issuer=None, amount=None, memo=None, network="testnet",
        )
        record = verification.record_transaction(db, "business-1", result, "payment-1")
        db.commit()
        assert record.confirmed_at is not None
        assert record.details["hash"] == "e" * 64
        assert record.status == "successful"
    finally:
        db.close()


# --- hardened event topic decoding ------------------------------------------

def test_decode_event_topic_handles_xdr_string_scval_and_garbage():
    value = _scval("funded")
    assert verification.decode_event_topic(value) == "funded"
    from stellar_sdk import scval as sdk_scval

    assert verification.decode_event_topic(sdk_scval.to_uint32(3)) == 3
    assert verification.decode_event_topic("bad-xdr") is None

    class Broken:
        def to_xdr(self):
            raise RuntimeError("cannot encode")

    assert verification.decode_event_topic(Broken()) is None


def test_soroban_verification_amount_mismatch_is_skipped(monkeypatch):
    monkeypatch.setattr(stellar.time, "sleep", lambda *_: None)
    event = _event(topics=[_scval("funded"), _scval(7)], value=_scval(1))
    server = _SorobanServer(events=[event])
    monkeypatch.setattr(stellar, "soroban_server", lambda: server)
    result = verification.verify_soroban_event(
        HASH, CONTRACT, "funded", agreement_id="7", amount=Decimal("10")
    )
    assert not result.settled and not result.event_matched
    assert "No matching" in result.reason
