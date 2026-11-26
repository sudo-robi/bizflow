"""Independent on-chain verification. Only confirmed, matching transactions settle."""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from stellar_sdk import Address, soroban_rpc

from app import models
from app.config import get_settings
from app.errors import chain_error, conflict
from app.services import stellar
from app.utils import money_str, to_decimal, utcnow

logger = logging.getLogger(__name__)
settings = get_settings()


@dataclass(frozen=True)
class VerificationResult:
    hash: str
    confirmed: bool
    successful: bool
    settled: bool
    status: str
    ledger: int | None
    source_account: str | None
    destination_account: str | None
    asset_code: str | None
    asset_issuer: str | None
    amount: Decimal | None
    memo: str | None
    network: str
    contract_id: str | None = None
    event_matched: bool = False
    checked_at: datetime | None = None
    reason: str | None = None

    def as_dict(self) -> dict:
        return {
            "hash": self.hash,
            "confirmed": self.confirmed,
            "successful": self.successful,
            "settled": self.settled,
            "status": self.status,
            "ledger": self.ledger,
            "source_account": self.source_account,
            "destination_account": self.destination_account,
            "asset_code": self.asset_code,
            "asset_issuer": self.asset_issuer,
            "amount": money_str(self.amount) if self.amount is not None else None,
            "memo": self.memo,
            "network": self.network,
            "contract_id": self.contract_id,
            "event_matched": self.event_matched,
            "checked_at": (self.checked_at or utcnow()).isoformat(),
            "reason": self.reason,
        }


def _result(**kwargs) -> VerificationResult:
    kwargs.setdefault("checked_at", utcnow())
    return VerificationResult(**kwargs)


def _normalize_native(value):
    """SCVal addresses decode to Address objects; use their strkey for matching."""
    return value.address if isinstance(value, Address) else value


def verify_stellar_payment(tx_hash: str, expected: dict | None = None) -> VerificationResult:
    """Fetch a Horizon transaction and independently check it against expectations."""
    try:
        tx = stellar.fetch_transaction(tx_hash)
    except Exception as exc:
        logger.warning("Horizon verification failed for %s: %s", tx_hash, exc)
        raise chain_error(f"Could not verify transaction on Horizon: {exc}") from exc

    successful = tx.get("successful") is True and tx.get("ledger") is not None
    status = "successful" if successful else ("failed" if tx.get("successful") is False else "pending")
    try:
        operations = stellar.fetch_transaction_operations(tx_hash)
    except Exception as exc:
        logger.warning("Horizon operation fetch failed for %s: %s", tx_hash, exc)
        operations = None

    # Exactly one operation, and it must be the payment we validated. A bundled
    # extra operation can hide a second effect in the same confirmed transaction.
    single_payment = (
        isinstance(operations, list)
        and len(operations) == 1
        and operations[0].get("type") == "payment"
    )
    payment = operations[0] if single_payment else {}
    # Horizon payment ops expose `from`/`to`; native XLM has no asset_code.
    asset_code = payment.get("asset_code") or (
        "XLM" if payment.get("asset_type") == "native" else payment.get("asset_type")
    )
    asset_issuer = payment.get("asset_issuer")
    amount = to_decimal(payment["amount"]) if payment.get("amount") is not None else None
    memo = tx.get("memo")
    operation_ok = payment.get("transaction_successful") is True
    if tx.get("memo_type") not in (None, "text", "text_memo"):
        memo = None

    source_account = payment.get("from") or tx.get("source_account")
    mismatches: list[str] = []
    for key, actual in (
        ("source_account", source_account),
        ("destination_account", payment.get("to")),
        ("asset_code", asset_code),
        ("asset_issuer", asset_issuer),
        ("amount", amount),
        ("memo", memo),
    ):
        if expected and key in expected and expected[key] is not None:
            wanted = expected[key]
            if key == "amount":
                wanted = to_decimal(wanted)
            if actual != wanted:
                mismatches.append(key)

    reason = None
    if not successful:
        reason = "Transaction is not confirmed as successful on the ledger"
    elif not single_payment:
        reason = "Transaction must contain exactly one payment operation"
    elif not operation_ok:
        reason = "The payment operation was not successful on the ledger"
    elif mismatches:
        reason = "Transaction fields do not match: " + ", ".join(mismatches)

    return _result(
        hash=tx_hash,
        confirmed=successful,
        successful=successful,
        settled=bool(successful and single_payment and operation_ok and not mismatches),
        status=status,
        ledger=int(tx["ledger"]) if tx.get("ledger") is not None else None,
        source_account=source_account,
        destination_account=payment.get("to"),
        asset_code=asset_code,
        asset_issuer=asset_issuer,
        amount=amount,
        memo=memo,
        network=stellar.network_name(),
        reason=reason,
    )


def _native(xdr_value: str):
    try:
        return _normalize_native(soroban_rpc_scval_to_native(xdr_value))
    except Exception as exc:
        logger.warning("Could not decode Soroban event value: %s", exc)
        return None


def decode_event_topic(value) -> object | None:
    """Decode an event topic (XDR string or SCVal) into a native Python value."""
    if isinstance(value, str):
        return _native(value)
    try:
        return _normalize_native(soroban_rpc_scval_to_native(value.to_xdr()))
    except Exception as exc:
        logger.warning("Could not decode Soroban event topic: %s", exc)
        return None


def soroban_rpc_scval_to_native(value: str):
    from stellar_sdk import scval

    return scval.to_native(value)


def _topics_match(
    topics: list,
    symbol: str,
    *,
    agreement_id: str | None,
    milestone_index: int | None,
    payer: str | None,
) -> bool:
    """Match event topics by *position*, as emitted by contracts/escrow/src/lib.rs.

    topics[0]=symbol, topics[1]=agreement id (u64), and topics[2] is the payer
    for funded/refunded or the milestone index for approved/released. Scanning
    the whole topic list allowed a milestone index to impersonate an agreement
    id (or vice versa); positions are authoritative now.
    """
    if not topics or topics[0] != symbol:
        return False
    if agreement_id is not None:
        if agreement_id in topics:
            return False  # a string id can never be the numeric contract id
        try:
            numeric_id = int(agreement_id)
        except (ValueError, TypeError):
            return False
        if len(topics) < 2 or topics[1] != numeric_id:
            return False
    if symbol in ("funded", "refunded"):
        if payer is not None and (len(topics) < 3 or topics[2] != payer):
            return False
    elif symbol in ("approved", "released"):
        if milestone_index is not None and (
            len(topics) < 3 or topics[2] != int(milestone_index)
        ):
            return False
    elif milestone_index is not None and (
        len(topics) < 3 or topics[2] != int(milestone_index)
    ):
        # Generic verifier callers using a positional third topic still get a
        # strict check; the real contract shapes are handled above.
        return False
    return True


def _event_amount_matches(value, amount: Decimal) -> bool:
    """Escrow event values are stroops, scalar for approve/refund and [amount, total] for others."""
    candidates = value if isinstance(value, list) else [value]
    for candidate in candidates:
        if str(candidate).lstrip("-").isdigit() and Decimal(str(candidate)) == amount * Decimal("10000000"):
            return True
    return False


def verify_soroban_event(
    tx_hash: str,
    contract_id: str,
    symbol: str,
    *,
    agreement_id: str | None = None,
    milestone_index: int | None = None,
    amount: Decimal | None = None,
    payer: str | None = None,
) -> VerificationResult:
    """Require a SUCCESS transaction and one exactly matching contract event.

    Event topics are decoded from XDR rather than trusting any client-supplied
    result. An unavailable event index is a failed verification, not an empty
    list that could be mistaken for a harmless absence.
    """
    network = stellar.network_name()  # fail closed on a misconfigured network
    server = stellar.soroban_server()
    try:
        response = server.get_transaction(tx_hash)
    except Exception as exc:
        logger.warning("Soroban verification failed for %s: %s", tx_hash, exc)
        raise chain_error(f"Could not verify Soroban transaction: {exc}") from exc

    status = getattr(response.status, "value", str(response.status))
    success = status == "SUCCESS" and getattr(response, "ledger", None) is not None
    event_matched = False
    observed_amount: Decimal | None = None
    events_failed = False
    if success:
        # Event indexing can lag a confirmed transaction by a few ledgers.
        for attempt in range(6):
            latest = response.latest_ledger + attempt
            try:
                events_response = server.get_events(
                    start_ledger=max(1, latest - 200),
                    end_ledger=latest,
                    filters=[soroban_rpc.EventFilter(contractIds=[contract_id])],
                    limit=200,
                )
                events = [event.model_dump() for event in events_response.events]
                events_failed = False
            except Exception as exc:
                logger.warning("Soroban getEvents failed for %s: %s", tx_hash, exc)
                events = []
                events_failed = True

            for event in events:
                if str(event.get("transaction_hash")) != tx_hash:
                    continue
                if str(event.get("contract_id")) != contract_id:
                    continue
                topics = [_native(topic) for topic in event.get("topic", [])]
                if not _topics_match(
                    topics, symbol,
                    agreement_id=agreement_id, milestone_index=milestone_index, payer=payer,
                ):
                    continue
                if amount is not None and not _event_amount_matches(_native(event.get("value", "")), amount):
                    continue
                if amount is not None:
                    observed_amount = amount
                event_matched = True
                break
            if event_matched:
                break
            if attempt + 1 < 6:
                time.sleep(1.5)

    if not success:
        reason = "Soroban transaction did not succeed"
    elif events_failed:
        reason = "Soroban event index could not be read; settlement is not verified"
    elif not event_matched:
        reason = f"No matching {symbol} contract event was found"
    else:
        reason = None
    return _result(
        hash=tx_hash,
        confirmed=success,
        successful=success,
        settled=bool(success and event_matched),
        status=status,
        ledger=getattr(response, "ledger", None),
        source_account=None,
        destination_account=contract_id,
        asset_code=None,
        asset_issuer=None,
        amount=observed_amount,
        memo=None,
        network=network,
        contract_id=contract_id,
        event_matched=event_matched,
        reason=reason,
    )


def verify_soroban_release(
    tx_hash: str,
    contract_id: str,
    agreement_id: str,
    milestone_index: int,
    amount: Decimal | None = None,
) -> VerificationResult:
    """Require SUCCESS status and a `released` event for the exact milestone amount."""
    return verify_soroban_event(
        tx_hash, contract_id, "released",
        agreement_id=agreement_id, milestone_index=milestone_index, amount=amount,
    )


def verify_soroban_funding(
    tx_hash: str, contract_id: str, amount: Decimal, agreement_id: str | None = None,
    payer: str | None = None,
) -> VerificationResult:
    """The `funded` event must name the agreement and the trusted payer."""
    return verify_soroban_event(
        tx_hash, contract_id, "funded", agreement_id=agreement_id, amount=amount,
        payer=payer,
    )


def verify_soroban_approval(
    tx_hash: str, contract_id: str, agreement_id: str, milestone_index: int,
    amount: Decimal | None = None,
) -> VerificationResult:
    """The `approved` event value must equal the milestone's configured amount."""
    return verify_soroban_event(
        tx_hash, contract_id, "approved",
        agreement_id=agreement_id, milestone_index=milestone_index, amount=amount,
    )


def verify_soroban_refund(
    tx_hash: str, contract_id: str, agreement_id: str, payer: str | None = None,
    amount: Decimal | None = None,
) -> VerificationResult:
    """Require the real `refunded` event emitted by the escrow contract."""
    return verify_soroban_event(
        tx_hash, contract_id, "refunded",
        agreement_id=agreement_id, payer=payer, amount=amount,
    )


def hash_already_used(db, tx_hash: str) -> bool:
    return (
        db.scalar(
            select(models.BlockchainTransaction).where(
                models.BlockchainTransaction.hash == tx_hash
            )
        )
        is not None
    )


def record_transaction(
    db,
    business_id: str,
    result: VerificationResult,
    payment_id: str | None = None,
) -> models.BlockchainTransaction:
    record = models.BlockchainTransaction(
        business_id=business_id,
        hash=result.hash,
        network=result.network,
        status=result.status,
        successful=result.successful,
        source_account=result.source_account,
        destination_account=result.destination_account,
        asset_code=result.asset_code,
        asset_issuer=result.asset_issuer,
        amount=result.amount,
        memo=result.memo,
        ledger=result.ledger,
        payment_record_id=payment_id,
        details=result.as_dict(),
        confirmed_at=utcnow() if result.confirmed and result.successful else None,
    )
    db.add(record)
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        logger.warning("Blockchain transaction insert violated a uniqueness constraint: %s", exc)
        raise conflict("This transaction hash is already linked to another record", "DUPLICATE_HASH") from exc
    return record
