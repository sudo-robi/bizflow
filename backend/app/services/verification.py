"""Independent on-chain verification. Only confirmed, matching transactions settle."""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from stellar_sdk import soroban_rpc

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
        operations = []

    payment = next((op for op in operations if op.get("type") == "payment"), {})
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
    elif not operation_ok:
        reason = "The payment operation was not successful on the ledger"
    elif mismatches:
        reason = "Transaction fields do not match: " + ", ".join(mismatches)

    return _result(
        hash=tx_hash,
        confirmed=successful,
        successful=successful,
        settled=bool(successful and operation_ok and not mismatches),
        status=status,
        ledger=int(tx["ledger"]) if tx.get("ledger") is not None else None,
        source_account=source_account,
        destination_account=payment.get("to"),
        asset_code=asset_code,
        asset_issuer=asset_issuer,
        amount=amount,
        memo=memo,
        network="testnet",
        reason=reason,
    )


def _native(xdr_value: str):
    try:
        return soroban_rpc_scval_to_native(xdr_value)
    except Exception as exc:
        logger.warning("Could not decode Soroban event value: %s", exc)
        return None


def decode_event_topic(value) -> object | None:
    """Decode an event topic (XDR string or SCVal) into a native Python value."""
    if isinstance(value, str):
        return _native(value)
    try:
        return soroban_rpc_scval_to_native(value.to_xdr())
    except Exception as exc:
        logger.warning("Could not decode Soroban event topic: %s", exc)
        return None


def soroban_rpc_scval_to_native(value: str):
    from stellar_sdk import scval

    return scval.to_native(value)


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
    """Require a SUCCESS transaction and a matching contract event.

    Event topics are decoded from XDR rather than trusting any client-supplied
    result. For ``fund`` events the emitted value carries [total, funded].
    """
    server = stellar.soroban_server()
    try:
        response = server.get_transaction(tx_hash)
    except Exception as exc:
        logger.warning("Soroban verification failed for %s: %s", tx_hash, exc)
        raise chain_error(f"Could not verify Soroban transaction: {exc}") from exc

    status = getattr(response.status, "value", str(response.status))
    success = status == "SUCCESS"
    event_matched = False
    observed_amount: Decimal | None = None
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
            except Exception as exc:
                logger.warning("Soroban getEvents failed for %s: %s", tx_hash, exc)
                events = []

            for event in events:
                if str(event.get("transaction_hash")) != tx_hash:
                    continue
                if str(event.get("contract_id")) != contract_id:
                    continue
                topics = [_native(topic) for topic in event.get("topic", [])]
                if symbol not in topics:
                    continue
                if agreement_id is not None:
                    numeric_id = None
                    try:
                        numeric_id = int(agreement_id)
                    except (ValueError, TypeError):
                        numeric_id = None
                    if numeric_id is None or (numeric_id not in topics and agreement_id not in topics):
                        continue
                if milestone_index is not None and milestone_index not in topics:
                    continue
                if payer is not None and payer not in topics:
                    continue
                if amount is not None:
                    value = _native(event.get("value", ""))
                    values = value if isinstance(value, list) else [value]
                    candidates = [Decimal(str(v)) for v in values if str(v).lstrip("-").isdigit()]
                    if not any(candidate == amount * Decimal("10000000") for candidate in candidates):
                        continue
                    observed_amount = amount
                event_matched = True
                break
            if event_matched:
                break
            if attempt + 1 < 6:
                time.sleep(1.5)

    reason = None if success and event_matched else (
        "Soroban transaction did not succeed" if not success
        else f"No matching {symbol} contract event was found"
    )
    return _result(
        hash=tx_hash,
        confirmed=success,
        successful=success,
        settled=bool(success and event_matched),
        status=status,
        ledger=response.ledger,
        source_account=None,
        destination_account=contract_id,
        asset_code=None,
        asset_issuer=None,
        amount=observed_amount,
        memo=None,
        network="testnet",
        contract_id=contract_id,
        event_matched=event_matched,
        reason=reason,
    )


def verify_soroban_release(
    tx_hash: str,
    contract_id: str,
    agreement_id: str,
    milestone_index: int,
) -> VerificationResult:
    """Require SUCCESS status and a matching `released` contract event."""
    return verify_soroban_event(
        tx_hash, contract_id, "released",
        agreement_id=agreement_id, milestone_index=milestone_index,
    )


def verify_soroban_funding(
    tx_hash: str, contract_id: str, amount: Decimal, agreement_id: str | None = None
) -> VerificationResult:
    return verify_soroban_event(
        tx_hash, contract_id, "funded", agreement_id=agreement_id, amount=amount
    )


def verify_soroban_approval(
    tx_hash: str, contract_id: str, agreement_id: str, milestone_index: int
) -> VerificationResult:
    return verify_soroban_event(
        tx_hash, contract_id, "approved",
        agreement_id=agreement_id, milestone_index=milestone_index,
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
