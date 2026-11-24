"""Edge-case unit tests for the Stellar/Soroban boundary (all network calls mocked)."""

from __future__ import annotations

import pytest
from stellar_sdk import Account, Asset, Keypair, StrKey, TransactionBuilder
from stellar_sdk.exceptions import NotFoundError

from app.config import TESTNET_PASSPHRASE
from app.errors import BizError
from app.services import stellar

SOURCE = Keypair.random().public_key
CONTRACT = StrKey.encode_contract(Keypair.random().raw_public_key())


def _signed_xdr() -> str:
    """Build a real, signed testnet transaction without any RPC/HTTP calls."""
    signer = Keypair.random()
    builder = TransactionBuilder(
        Account(signer.public_key, 1), network_passphrase=TESTNET_PASSPHRASE, base_fee=100
    )
    builder.append_payment_op(
        destination=Keypair.random().public_key, asset=Asset.native(), amount="1"
    )
    builder.add_memo(stellar.TextMemo("REF"))
    builder.set_timeout(600)
    tx = builder.build()
    tx.sign(signer)
    return tx.to_xdr()


class _AccountServer:
    def __init__(self, *, fail=False, fee=100):
        self.fail = fail
        self.fee = fee

    def load_account(self, account_id):
        if self.fail:
            raise RuntimeError("horizon offline")
        return Account(account_id, 1)

    def fetch_base_fee(self):
        if self.fail:
            raise RuntimeError("horizon offline")
        return self.fee


class _PollServer:
    """Configurable Horizon stand-in for submit_transaction polling."""

    def __init__(self, *, submit_error=None, tx_results=None, ops=None, ops_error=None):
        self.submit_error = submit_error
        self.tx_results = list(tx_results or [])
        self.ops = ops if ops is not None else []
        self.ops_error = ops_error
        self.submitted = []

    def submit_transaction(self, xdr):
        self.submitted.append(xdr)
        if self.submit_error:
            raise self.submit_error
        return {"hash": "accepted", "successful": True, "ledger": 1}

    def transactions(self):
        return _TxEndpoint(self)

    def operations(self):
        return _OpsEndpoint(self)


class _TxEndpoint:
    def __init__(self, parent):
        self.parent = parent

    def transaction(self, tx_hash):
        return self

    def call(self):
        if self.parent.tx_results:
            result = self.parent.tx_results.pop(0)
        else:
            result = {"hash": "x" * 64, "successful": True, "ledger": 7, "source_account": "GSRC"}
        if isinstance(result, Exception):
            raise result
        return result


class _OpsEndpoint:
    def __init__(self, parent):
        self.parent = parent

    def for_transaction(self, tx_hash):
        return self

    def call(self):
        if self.parent.ops_error:
            raise self.parent.ops_error
        return {"_embedded": {"records": self.parent.ops}}


class _SorobanServer:
    def __init__(self, *, fail_load=False, fail_prepare=False, status="SUCCESS",
                 send_error=None, poll_error=None):
        self.fail_load = fail_load
        self.fail_prepare = fail_prepare
        self.status = status
        self.send_error = send_error
        self.poll_error = poll_error
        self.prepared_from = None

    def load_account(self, account_id):
        if self.fail_load:
            raise RuntimeError("rpc offline")
        return Account(account_id, 1)

    def prepare_transaction(self, transaction):
        self.prepared_from = transaction
        if self.fail_prepare:
            raise RuntimeError("simulation failed")
        return transaction

    def send_transaction(self, xdr):
        if self.send_error:
            raise self.send_error
        return {"hash": "x" * 64}

    def poll_transaction(self, tx_hash, max_attempts=20):
        if self.poll_error:
            raise self.poll_error

        class Result:
            pass

        result = Result()
        result.status = type("Status", (), {"value": self.status})()
        result.ledger = 42
        result.latest_ledger = 43
        return result


# --- _asset -----------------------------------------------------------------

def test_native_asset_rejects_issuer():
    with pytest.raises(BizError) as exc:
        stellar._asset("xlm", "GISSUER")
    assert exc.value.code == "INVALID_ASSET"


def test_non_native_asset_requires_issuer():
    with pytest.raises(BizError) as exc:
        stellar._asset("USD", None)
    assert exc.value.code == "INVALID_ASSET"


def test_invalid_asset_issuer_is_rejected():
    with pytest.raises(BizError) as exc:
        stellar._asset("USD", "not-a-key")
    assert exc.value.code == "INVALID_ASSET"


def test_valid_credit_asset_is_built():
    issuer = Keypair.random().public_key
    asset = stellar._asset("usd", issuer)
    assert asset.code == "USD" and asset.issuer == issuer


# --- build_payment_xdr ------------------------------------------------------

def test_build_payment_rejects_non_positive_amount():
    source, destination = Keypair.random().public_key, Keypair.random().public_key
    with pytest.raises(BizError) as exc:
        stellar.build_payment_xdr(source, destination, "0", "XLM", None, "REF")
    assert exc.value.code == "INVALID_AMOUNT"


def test_build_payment_rejects_non_numeric_amount():
    source, destination = Keypair.random().public_key, Keypair.random().public_key
    with pytest.raises(BizError) as exc:
        stellar.build_payment_xdr(source, destination, "abc", "XLM", None, "REF")
    assert exc.value.code == "INVALID_AMOUNT"


def test_build_payment_rejects_invalid_destination():
    source = Keypair.random().public_key
    with pytest.raises(BizError) as exc:
        stellar.build_payment_xdr(source, "bad-key", "1", "XLM", None, "REF")
    assert exc.value.code == "INVALID_KEY"


def test_build_payment_wraps_horizon_unavailability(monkeypatch):
    source, destination = Keypair.random().public_key, Keypair.random().public_key
    monkeypatch.setattr(stellar, "horizon_server", lambda: _AccountServer(fail=True))
    with pytest.raises(BizError) as exc:
        stellar.build_payment_xdr(source, destination, "1", "XLM", None, "REF")
    assert exc.value.status_code == 502


def test_build_payment_clamps_low_base_fee_and_truncates_memo(monkeypatch):
    source, destination = Keypair.random().public_key, Keypair.random().public_key
    monkeypatch.setattr(stellar, "horizon_server", lambda: _AccountServer(fee=1))
    prepared = stellar.build_payment_xdr(source, destination, "1", "XLM", None, "M" * 40)
    envelope = TransactionBuilder.from_xdr(prepared.xdr, TESTNET_PASSPHRASE)
    assert envelope.transaction.memo.memo_text == b"M" * 28
    assert envelope.transaction.fee == 100


# --- submit_transaction -----------------------------------------------------

def test_submit_rejects_invalid_xdr():
    with pytest.raises(BizError) as exc:
        stellar.submit_transaction("not-xdr")
    assert exc.value.code == "INVALID_XDR"


def test_submit_records_rejection_by_horizon(monkeypatch):
    server = _PollServer(submit_error=RuntimeError("duplicate"))
    monkeypatch.setattr(stellar, "horizon_server", lambda: server)
    result = stellar.submit_transaction(_signed_xdr())
    assert result.status == "rejected" and result.confirmed is False
    assert "duplicate" in result.reason


def test_submit_confirms_successful_transaction_even_without_operations(monkeypatch):
    server = _PollServer(ops_error=RuntimeError("events lagging"))
    monkeypatch.setattr(stellar, "horizon_server", lambda: server)
    result = stellar.submit_transaction(_signed_xdr())
    assert result.status == "successful" and result.confirmed and result.successful
    assert result.ledger == 7 and result.operations == []
    assert result.source_account == "GSRC"


def test_submit_reads_operation_records(monkeypatch):
    op = {"type": "payment", "amount": "1"}
    monkeypatch.setattr(stellar, "horizon_server", lambda: _PollServer(ops=[op]))
    result = stellar.submit_transaction(_signed_xdr())
    assert result.operations == [op]


def test_submit_marks_failed_transaction(monkeypatch):
    server = _PollServer(tx_results=[{"successful": False, "ledger": 7}])
    monkeypatch.setattr(stellar, "horizon_server", lambda: server)
    result = stellar.submit_transaction(_signed_xdr())
    assert result.status == "failed" and result.confirmed and not result.successful
    assert "unsuccessful" in result.reason


def test_submit_retries_not_found_then_confirms(monkeypatch):
    class Missing(Exception):
        pass

    monkeypatch.setattr(stellar, "NotFoundError", Missing)
    monkeypatch.setattr(stellar.time, "sleep", lambda *_: None)
    server = _PollServer(tx_results=[Missing(), {"successful": True, "ledger": 9}])
    monkeypatch.setattr(stellar, "horizon_server", lambda: server)
    result = stellar.submit_transaction(_signed_xdr())
    assert result.status == "successful" and result.ledger == 9


def test_submit_retries_generic_poll_error_then_confirms(monkeypatch):
    monkeypatch.setattr(stellar.time, "sleep", lambda *_: None)
    server = _PollServer(tx_results=[RuntimeError("timeout"), {"successful": True, "ledger": 11}])
    monkeypatch.setattr(stellar, "horizon_server", lambda: server)
    result = stellar.submit_transaction(_signed_xdr())
    assert result.status == "successful" and result.ledger == 11


def test_submit_returns_pending_when_polling_window_expires(monkeypatch):
    class Missing(Exception):
        pass

    monkeypatch.setattr(stellar, "NotFoundError", Missing)
    monkeypatch.setattr(stellar.time, "sleep", lambda *_: None)
    server = _PollServer(tx_results=[Missing()] * 3)
    monkeypatch.setattr(stellar, "horizon_server", lambda: server)
    monkeypatch.setattr(stellar.settings, "horizon_poll_attempts", 3)
    result = stellar.submit_transaction(_signed_xdr())
    assert result.status == "pending" and not result.confirmed
    assert "polling window" in result.reason


def test_submit_returns_pending_when_success_has_no_ledger(monkeypatch):
    monkeypatch.setattr(stellar.time, "sleep", lambda *_: None)
    server = _PollServer(tx_results=[{"successful": True, "ledger": None}] * 2)
    monkeypatch.setattr(stellar, "horizon_server", lambda: server)
    monkeypatch.setattr(stellar.settings, "horizon_poll_attempts", 2)
    result = stellar.submit_transaction(_signed_xdr())
    assert result.status == "pending" and not result.confirmed


# --- fetch helpers ----------------------------------------------------------

def test_fetch_transaction_and_operations_use_horizon(monkeypatch):
    server = _PollServer(tx_results=[{"hash": "abc", "successful": True}], ops=[{"type": "payment"}])
    monkeypatch.setattr(stellar, "horizon_server", lambda: server)
    assert stellar.fetch_transaction("h" * 64) == {"hash": "abc", "successful": True}
    assert stellar.fetch_transaction_operations("h" * 64) == [{"type": "payment"}]


# --- Soroban builders -------------------------------------------------------

def test_soroban_invoke_requires_contract_id():
    with pytest.raises(BizError) as exc:
        stellar.build_soroban_invoke_xdr("", SOURCE, "fund", [])
    assert exc.value.status_code == 502


def test_soroban_invoke_wraps_account_load_failure(monkeypatch):
    monkeypatch.setattr(stellar, "soroban_server", lambda: _SorobanServer(fail_load=True))
    with pytest.raises(BizError) as exc:
        stellar.build_soroban_invoke_xdr(CONTRACT, SOURCE, "fund", [])
    assert exc.value.status_code == 502


def test_soroban_invoke_wraps_simulation_failure(monkeypatch):
    server = _SorobanServer(fail_prepare=True)
    monkeypatch.setattr(stellar, "soroban_server", lambda: server)
    with pytest.raises(BizError) as exc:
        stellar.build_soroban_invoke_xdr(CONTRACT, SOURCE, "fund", [])
    assert exc.value.status_code == 502
    assert server.prepared_from is not None


def test_soroban_invoke_builds_real_xdr(monkeypatch):
    server = _SorobanServer()
    monkeypatch.setattr(stellar, "soroban_server", lambda: server)
    prepared = stellar.build_soroban_invoke_xdr(CONTRACT, SOURCE, "fund", [])
    assert prepared.xdr and len(prepared.hash) == 64
    envelope = TransactionBuilder.from_xdr(prepared.xdr, TESTNET_PASSPHRASE)
    assert len(envelope.transaction.operations) == 1


def test_soroban_release_rejects_negative_milestone():
    with pytest.raises(BizError) as exc:
        stellar.build_soroban_release_xdr(CONTRACT, SOURCE, "AGR", -1)
    assert exc.value.code == "INVALID_MILESTONE"


def test_soroban_release_builds_positive_milestone(monkeypatch):
    monkeypatch.setattr(stellar, "soroban_server", lambda: _SorobanServer())
    prepared = stellar.build_soroban_release_xdr(CONTRACT, SOURCE, "AGR", 2)
    assert prepared.hash and len(prepared.hash) == 64


def test_soroban_approve_rejects_negative_milestone():
    with pytest.raises(BizError) as exc:
        stellar.build_soroban_approve_xdr(CONTRACT, SOURCE, -1)
    assert exc.value.code == "INVALID_MILESTONE"


def test_soroban_approve_builds_positive_milestone(monkeypatch):
    monkeypatch.setattr(stellar, "soroban_server", lambda: _SorobanServer())
    prepared = stellar.build_soroban_approve_xdr(CONTRACT, SOURCE, 0)
    assert prepared.hash and len(prepared.hash) == 64


def test_soroban_fund_rejects_zero_amount():
    from decimal import Decimal

    with pytest.raises(BizError) as exc:
        stellar.build_soroban_fund_xdr(CONTRACT, SOURCE, Decimal("0"))
    assert exc.value.code == "INVALID_AMOUNT"


def test_soroban_fund_converts_decimal_to_stroops(monkeypatch):
    from decimal import Decimal

    monkeypatch.setattr(stellar, "soroban_server", lambda: _SorobanServer())
    prepared = stellar.build_soroban_fund_xdr(CONTRACT, SOURCE, Decimal("1.5"))
    assert prepared.hash and len(prepared.hash) == 64


# --- submit_soroban / hash helpers -----------------------------------------

def test_submit_soroban_rejects_invalid_xdr():
    with pytest.raises(BizError) as exc:
        stellar.submit_soroban("not-xdr")
    assert exc.value.code == "INVALID_XDR"


def test_submit_soroban_records_send_rejection(monkeypatch):
    monkeypatch.setattr(
        stellar, "soroban_server", lambda: _SorobanServer(send_error=RuntimeError("declined"))
    )
    result = stellar.submit_soroban(_signed_xdr())
    assert result.status == "rejected" and not result.confirmed


def test_submit_soroban_records_poll_failure(monkeypatch):
    monkeypatch.setattr(
        stellar, "soroban_server", lambda: _SorobanServer(poll_error=RuntimeError("rpc down"))
    )
    result = stellar.submit_soroban(_signed_xdr())
    assert result.status == "pending" and not result.confirmed
    assert "rpc down" in result.reason


def test_submit_soroban_does_not_confirm_failed_status(monkeypatch):
    monkeypatch.setattr(stellar, "soroban_server", lambda: _SorobanServer(status="FAILED"))
    result = stellar.submit_soroban(_signed_xdr())
    assert result.status == "FAILED" and not result.confirmed and not result.successful
    assert "FAILED" in result.reason


def test_submit_soroban_confirms_success(monkeypatch):
    monkeypatch.setattr(stellar, "soroban_server", lambda: _SorobanServer())
    result = stellar.submit_soroban(_signed_xdr())
    assert result.status == "SUCCESS" and result.confirmed and result.successful
    assert result.ledger == 42 and result.raw["latest_ledger"] == 43


def test_transaction_hash_matches_builder_and_rejects_garbage():
    xdr = _signed_xdr()
    assert stellar.transaction_hash(xdr) == TransactionBuilder.from_xdr(
        xdr, TESTNET_PASSPHRASE
    ).hash_hex()
    with pytest.raises(BizError) as exc:
        stellar.transaction_hash("garbage")
    assert exc.value.code == "INVALID_XDR"


def test_parse_amount_handles_none_and_decimals():
    assert stellar.parse_amount(None) is None
    assert stellar.parse_amount("12.5") == stellar.to_decimal("12.5")


def test_validate_contract_id_checks_presence_and_strkey():
    from stellar_sdk import Keypair, StrKey

    with pytest.raises(BizError) as exc:
        stellar.validate_contract_id("")
    assert exc.value.code == "CONTRACT_NOT_CONFIGURED"
    with pytest.raises(BizError) as exc:
        stellar.validate_contract_id(Keypair.random().public_key)
    assert exc.value.code == "INVALID_CONTRACT"
    contract = StrKey.encode_contract(Keypair.random().raw_public_key())
    assert stellar.validate_contract_id(contract) == contract


# --- hardened signed-XDR validation ----------------------------------------
#
# NOTE: invoked_contract_function() currently reads ``envelope._transaction``
# which does not exist in the installed stellar-sdk; it therefore returns
# (None, None) for real invocation XDR. The validation logic in submit_soroban
# is tested here with the decoder mocked at its boundary; see final report.


def _mock_invocation(monkeypatch, contract, function):
    monkeypatch.setattr(stellar, "invoked_contract_function", lambda _xdr, _pass=None: (contract, function))


def test_invoked_contract_function_returns_none_for_payment_xdr():
    assert stellar.invoked_contract_function(_signed_xdr()) == (None, None)


def test_submit_soroban_accepts_matching_contract_and_function(monkeypatch):
    _mock_invocation(monkeypatch, CONTRACT, "fund")
    monkeypatch.setattr(stellar, "soroban_server", lambda: _SorobanServer())
    result = stellar.submit_soroban(_signed_xdr(), CONTRACT, "fund")
    assert result.confirmed and result.successful


def test_submit_soroban_rejects_mismatched_contract(monkeypatch):
    _mock_invocation(monkeypatch, CONTRACT, "fund")
    other = StrKey.encode_contract(Keypair.random().raw_public_key())
    with pytest.raises(BizError) as exc:
        stellar.submit_soroban(_signed_xdr(), other, "fund")
    assert exc.value.code == "CONTRACT_MISMATCH"


def test_submit_soroban_rejects_mismatched_function(monkeypatch):
    _mock_invocation(monkeypatch, CONTRACT, "fund")
    with pytest.raises(BizError) as exc:
        stellar.submit_soroban(_signed_xdr(), CONTRACT, "release_milestone")
    assert exc.value.code == "FUNCTION_MISMATCH"


def test_submit_soroban_rejects_undecodable_invocation(monkeypatch):
    def boom(_xdr, _pass=None):
        raise RuntimeError("bad xdr")

    monkeypatch.setattr(stellar, "invoked_contract_function", boom)
    with pytest.raises(BizError) as exc:
        stellar.submit_soroban(_signed_xdr(), CONTRACT, "fund")
    assert exc.value.code == "INVALID_XDR"


def test_submit_soroban_rejects_non_invocation_xdr_when_validating(monkeypatch):
    _mock_invocation(monkeypatch, None, None)
    with pytest.raises(BizError) as exc:
        stellar.submit_soroban(_signed_xdr(), CONTRACT, "fund")
    assert exc.value.code == "CONTRACT_MISMATCH"
