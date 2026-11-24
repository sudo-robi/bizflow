"""Real Stellar/Horizon and Soroban RPC transaction construction and submission.

Nothing here marks a payment as successful unless the ledger reports a definitive
confirmed result. Submission acceptance is never treated as settlement.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from decimal import Decimal

from stellar_sdk import (
    Account,
    Asset,
    Keypair,
    Server,
    SorobanServer,
    StrKey,
    TextMemo,
    TransactionBuilder,
    scval,
    xdr,
)
from stellar_sdk.exceptions import NotFoundError

from app.config import get_settings
from app.errors import bad_request, chain_error
from app.utils import to_decimal

logger = logging.getLogger(__name__)
settings = get_settings()


@dataclass(frozen=True)
class PreparedTransaction:
    xdr: str
    hash: str


@dataclass(frozen=True)
class ChainResult:
    hash: str
    status: str
    confirmed: bool
    successful: bool
    ledger: int | None = None
    source_account: str | None = None
    operations: list[dict] = field(default_factory=list)
    events: list[dict] = field(default_factory=list)
    raw: dict = field(default_factory=dict)
    reason: str | None = None


def horizon_server() -> Server:
    return Server(settings.stellar_horizon_url)


def soroban_server() -> SorobanServer:
    return SorobanServer(settings.stellar_soroban_rpc_url)


def _asset(asset_code: str, asset_issuer: str | None) -> Asset:
    code = (asset_code or "XLM").upper()
    if code == "XLM":
        if asset_issuer:
            raise bad_request("Native XLM must not have an asset issuer", "INVALID_ASSET")
        return Asset.native()
    if not asset_issuer:
        raise bad_request("asset_issuer is required for non-XLM assets", "INVALID_ASSET")
    try:
        return Asset(code, asset_issuer)
    except (ValueError, TypeError) as exc:
        raise bad_request("Invalid Stellar asset", "INVALID_ASSET") from exc


def build_payment_xdr(
    source_account: str,
    destination: str,
    amount_str: str,
    asset_code: str,
    asset_issuer: str | None,
    memo: str,
    passphrase: str | None = None,
) -> PreparedTransaction:
    """Load the live source account, build a real Stellar payment and return XDR+hash."""
    network = passphrase or settings.stellar_network_passphrase
    amount = to_decimal(amount_str, "amount", positive=True)
    for key, label in ((source_account, "source_account"), (destination, "destination")):
        try:
            Keypair.from_public_key(key)
        except (ValueError, TypeError) as exc:
            raise bad_request(f"{label} must be a valid Stellar public key", "INVALID_KEY") from exc

    server = horizon_server()
    try:
        account = server.load_account(source_account)
        base_fee = max(100, int(server.fetch_base_fee()))
    except Exception as exc:
        logger.exception("Unable to load source account from Horizon")
        raise chain_error(f"Horizon is unavailable: {exc}") from exc

    builder = TransactionBuilder(account, network_passphrase=network, base_fee=base_fee)
    builder.append_payment_op(
        destination=destination, asset=_asset(asset_code, asset_issuer), amount=str(amount)
    )
    builder.add_memo(TextMemo(memo[:28]))
    builder.set_timeout(settings.prepare_expires_minutes * 60)
    tx = builder.build()
    return PreparedTransaction(xdr=tx.to_xdr(), hash=tx.hash_hex())


def submit_transaction(signed_xdr: str) -> ChainResult:
    """Submit a signed payment to Horizon, then poll until a definitive result."""
    try:
        envelope = TransactionBuilder.from_xdr(signed_xdr, settings.stellar_network_passphrase)
        tx_hash = envelope.hash_hex()
    except Exception as exc:
        raise bad_request("signed_xdr is not a valid Stellar transaction", "INVALID_XDR") from exc

    server = horizon_server()
    try:
        submitted = server.submit_transaction(signed_xdr)
    except Exception as exc:
        logger.warning("Horizon rejected transaction %s: %s", tx_hash, exc)
        return ChainResult(
            hash=tx_hash, status="rejected", confirmed=False, successful=False, reason=str(exc)
        )

    result_raw = dict(submitted or {})
    for attempt in range(settings.horizon_poll_attempts):
        try:
            tx = server.transactions().transaction(tx_hash).call()
            result_raw = dict(tx)
            successful = bool(tx.get("successful")) and tx.get("ledger") is not None
            if successful:
                operations = []
                try:
                    ops = server.operations().for_transaction(tx_hash).call()
                    operations = list(ops.get("_embedded", {}).get("records", []))
                except Exception as exc:
                    logger.warning("Could not read operations for %s: %s", tx_hash, exc)
                return ChainResult(
                    hash=tx_hash,
                    status="successful",
                    confirmed=True,
                    successful=True,
                    ledger=int(tx["ledger"]),
                    source_account=tx.get("source_account"),
                    operations=operations,
                    raw=result_raw,
                )
            if tx.get("successful") is False:
                return ChainResult(
                    hash=tx_hash,
                    status="failed",
                    confirmed=True,
                    successful=False,
                    raw=result_raw,
                    reason="Horizon reported an unsuccessful transaction result",
                )
        except NotFoundError:
            pass
        except Exception as exc:
            logger.warning("Horizon poll failed for %s: %s", tx_hash, exc)
        if attempt + 1 < settings.horizon_poll_attempts:
            time.sleep(settings.horizon_poll_interval_seconds)

    return ChainResult(
        hash=tx_hash,
        status="pending",
        confirmed=False,
        successful=False,
        raw=result_raw,
        reason="Transaction was not confirmed within the polling window",
    )


def fetch_transaction(tx_hash: str) -> dict:
    """Fetch a single Horizon transaction record; raises on network failure."""
    return dict(horizon_server().transactions().transaction(tx_hash).call())


def fetch_transaction_operations(tx_hash: str) -> list[dict]:
    response = horizon_server().operations().for_transaction(tx_hash).call()
    return list(response.get("_embedded", {}).get("records", []))


def build_soroban_invoke_xdr(
    contract_id: str,
    source_account: str,
    function_name: str,
    parameters: list,
    passphrase: str | None = None,
) -> PreparedTransaction:
    """Simulate + assemble a real Soroban contract invocation.

    ``prepare_transaction`` applies the simulation's auth entries and restored
    ledger footprint before the XDR is returned to the wallet for signing.
    No transaction is submitted here and no success is assumed.
    """
    if not contract_id:
        raise chain_error("Escrow contract ID is not configured")
    network = passphrase or settings.stellar_network_passphrase
    server = soroban_server()
    try:
        account = server.load_account(source_account)
    except Exception as exc:
        logger.exception("Unable to load Soroban source account")
        raise chain_error(f"Soroban RPC is unavailable: {exc}") from exc

    builder = TransactionBuilder(account, network_passphrase=network, base_fee=100)
    builder.append_invoke_contract_function_op(
        contract_id=contract_id,
        function_name=function_name,
        parameters=parameters,
    )
    builder.set_timeout(settings.prepare_expires_minutes * 60)
    try:
        prepared = server.prepare_transaction(builder.build())
    except Exception as exc:
        logger.exception("Soroban simulation failed for %s", function_name)
        raise chain_error(f"Soroban simulation failed: {exc}") from exc
    return PreparedTransaction(xdr=prepared.to_xdr(), hash=prepared.hash_hex())


def build_soroban_release_xdr(
    contract_id: str,
    source_account: str,
    agreement_id: str,
    milestone_index: int,
    passphrase: str | None = None,
) -> PreparedTransaction:
    if int(milestone_index) < 0:
        raise bad_request("milestone_index must be non-negative", "INVALID_MILESTONE")
    return build_soroban_invoke_xdr(
        contract_id,
        source_account,
        "release_milestone",
        [scval.to_address(source_account), scval.to_uint32(int(milestone_index))],
        passphrase,
    )


def build_soroban_approve_xdr(
    contract_id: str,
    source_account: str,
    milestone_index: int,
    passphrase: str | None = None,
) -> PreparedTransaction:
    if int(milestone_index) < 0:
        raise bad_request("milestone_index must be non-negative", "INVALID_MILESTONE")
    return build_soroban_invoke_xdr(
        contract_id,
        source_account,
        "approve_milestone",
        [scval.to_address(source_account), scval.to_uint32(int(milestone_index))],
        passphrase,
    )


def build_soroban_fund_xdr(
    contract_id: str,
    source_account: str,
    amount: Decimal,
    passphrase: str | None = None,
) -> PreparedTransaction:
    """Prepare a `fund(from, amount)` invocation; amount is converted to stroops."""
    stroops = int((amount * Decimal("10000000")).to_integral_value())
    if stroops <= 0:
        raise bad_request("Funding amount must be positive", "INVALID_AMOUNT")
    return build_soroban_invoke_xdr(
        contract_id,
        source_account,
        "fund",
        [scval.to_address(source_account), scval.to_int128(stroops)],
        passphrase,
    )


def build_soroban_refund_xdr(
    contract_id: str,
    source_account: str,
    passphrase: str | None = None,
) -> PreparedTransaction:
    """Prepare the real `refund(caller)` invocation (no token/amount invented)."""
    return build_soroban_invoke_xdr(
        contract_id,
        source_account,
        "refund",
        [scval.to_address(source_account)],
        passphrase,
    )


def invoked_contract_function(signed_xdr: str, passphrase: str | None = None) -> tuple[str | None, str | None]:
    """Decode the contract id and function name from a signed Soroban invocation.

    Returned values come from the signed XDR itself, never from client input, so
    they can be compared against the server-side expectation before submission.
    """
    envelope = TransactionBuilder.from_xdr(
        signed_xdr, passphrase or settings.stellar_network_passphrase
    )
    transaction = getattr(envelope, "transaction", None) or getattr(envelope, "_transaction", None)
    operations = getattr(transaction, "operations", None) or []
    for operation in operations:
        # stellar-sdk 17 returns an InvokeHostFunction operation object directly;
        # older SDKs expose it through operation.body.invoke_host_function_op.
        host_function = getattr(operation, "host_function", None)
        if host_function is None:
            body = getattr(operation, "body", None)
            invoke_op = getattr(body, "invoke_host_function_op", None)
            host_function = getattr(invoke_op, "host_function", None)
        if host_function is None:
            continue
        if host_function.type != xdr.HostFunctionType.HOST_FUNCTION_TYPE_INVOKE_CONTRACT:
            continue
        invocation = host_function.invoke_contract
        symbol = invocation.function_name
        raw_symbol = getattr(symbol, "sc_symbol", None)
        function_name = bytes(raw_symbol).decode() if raw_symbol is not None else str(symbol)
        address = invocation.contract_address
        if address.type != xdr.SCAddressType.SC_ADDRESS_TYPE_CONTRACT:
            continue
        contract_id = StrKey.encode_contract(address.contract_id.contract_id.hash)
        return contract_id, str(function_name)
    return None, None


def submit_soroban(
    signed_xdr: str,
    contract_id: str | None = None,
    function_name: str | None = None,
) -> ChainResult:
    """Send a signed Soroban tx and poll getTransaction for a definitive status.

    The submitted invocation is decoded from the signed XDR and checked against
    the expected contract and function so a valid but unrelated transaction can
    never be used to settle an agreement.
    """
    try:
        envelope = TransactionBuilder.from_xdr(
            signed_xdr, settings.stellar_network_passphrase
        )
        tx_hash = envelope.hash_hex()
    except Exception as exc:
        raise bad_request("signed_xdr is not a valid Soroban transaction", "INVALID_XDR") from exc

    if contract_id or function_name:
        try:
            decoded_contract, decoded_function = invoked_contract_function(signed_xdr)
        except Exception as exc:
            raise bad_request("signed_xdr is not a contract invocation", "INVALID_XDR") from exc
        if decoded_contract is None or (contract_id and decoded_contract != contract_id):
            raise bad_request("Signed transaction targets a different contract", "CONTRACT_MISMATCH")
        if function_name and decoded_function != function_name:
            raise bad_request("Signed transaction invokes a different function", "FUNCTION_MISMATCH")

    server = soroban_server()
    try:
        server.send_transaction(signed_xdr)
    except Exception as exc:
        logger.warning("Soroban rejected transaction %s: %s", tx_hash, exc)
        return ChainResult(
            hash=tx_hash, status="rejected", confirmed=False, successful=False, reason=str(exc)
        )

    try:
        result = server.poll_transaction(tx_hash, max_attempts=settings.soroban_poll_attempts)
    except Exception as exc:
        logger.exception("Soroban polling failed for %s", tx_hash)
        return ChainResult(
            hash=tx_hash, status="pending", confirmed=False, successful=False, reason=str(exc)
        )

    status = getattr(result.status, "value", str(result.status))
    success = status == "SUCCESS"
    return ChainResult(
        hash=tx_hash,
        status=status,
        confirmed=success,
        successful=success,
        ledger=result.ledger,
        raw={"latest_ledger": result.latest_ledger, "status": status},
        reason=None if success else f"Soroban transaction status: {status}",
    )


def transaction_hash(signed_xdr: str) -> str:
    """Compute the hash of a signed XDR without submitting it anywhere."""
    try:
        return TransactionBuilder.from_xdr(
            signed_xdr, settings.stellar_network_passphrase
        ).hash_hex()
    except Exception as exc:
        raise bad_request("signed_xdr is not a valid Stellar transaction", "INVALID_XDR") from exc


def parse_amount(value: object) -> Decimal | None:
    if value is None:
        return None
    return to_decimal(value)


def validate_contract_id(value: str) -> str:
    """Contract IDs are C-strkeys (strkey version byte 2), not G-addresses."""
    if not value:
        raise bad_request("Escrow contract ID is not configured", "CONTRACT_NOT_CONFIGURED")
    if not StrKey.is_valid_contract(value):
        raise bad_request("Invalid escrow contract ID", "INVALID_CONTRACT")
    return value
