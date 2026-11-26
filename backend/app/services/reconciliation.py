"""Read-only on-chain reconciliation for Soroban escrow agreements.

This module never repairs financial records. It reads authoritative contract
state from Soroban RPC, compares it with database state, and reports every
discrepancy for an auditable human decision.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session
from stellar_sdk import Address, Asset, TransactionBuilder, scval, soroban_rpc

from app.config import get_settings
from app.errors import BizError, chain_error, conflict
from app.models import (
    AgreementMilestone,
    BlockchainTransaction,
    PaymentAgreement,
    PaymentRecord,
    ReconciliationRecord,
)
from app.services import stellar
from app.utils import to_decimal, utcnow

logger = logging.getLogger(__name__)
settings = get_settings()
STROOPS = Decimal("10000000")


def _normalize(value):
    """Convert decoded SCVal Address objects (and nested values) to strkeys."""
    if isinstance(value, Address):
        return value.address
    if isinstance(value, dict):
        return {_normalize(key): _normalize(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_normalize(item) for item in value]
    return value


def _native(value):
    """Decode an XDR SCVal and normalise Address objects to strkeys."""
    return _normalize(scval.to_native(value))


@dataclass(frozen=True)
class ReconciliationReport:
    agreement_id: str
    contract_id: str | None
    onchain: dict[str, int] | None
    database: dict[str, int]
    discrepancies: tuple[str, ...]
    checked_at: str
    evidence: dict
    # Added dimensions; defaults keep older callers and persisted report fields valid.
    contract_agreement: dict | None = None
    milestones: list[dict] = field(default_factory=list)
    events: list[dict] = field(default_factory=list)
    payments: list[dict] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "agreement_id": self.agreement_id,
            "contract_id": self.contract_id,
            "onchain": self.onchain,
            "database": self.database,
            "discrepancies": list(self.discrepancies),
            "consistent": not self.discrepancies,
            "checked_at": self.checked_at,
            "evidence": self.evidence,
            "contract_agreement": self.contract_agreement,
            "milestones": self.milestones,
            "events": self.events,
            "payments": self.payments,
        }


def _simulate_getter(contract_id: str, source_account: str, function_name: str, parameters: list):
    """Simulate one read-only contract getter; never sign or submit anything."""
    server = stellar.soroban_server()
    try:
        account = server.load_account(source_account)
        builder = TransactionBuilder(
            account, network_passphrase=settings.stellar_network_passphrase, base_fee=100
        )
        builder.append_invoke_contract_function_op(
            contract_id=contract_id, function_name=function_name, parameters=parameters
        )
        builder.set_timeout(60)
        response = server.simulate_transaction(builder.build())
    except Exception as exc:
        logger.warning("On-chain getter %s failed for %s: %s", function_name, contract_id, type(exc).__name__)
        raise chain_error(f"Could not read on-chain contract {function_name}") from exc

    payload = response.model_dump()
    if payload.get("error"):
        raise chain_error("On-chain simulation reported an error")
    results = payload.get("results") or []
    if not results or not results[0].get("xdr"):
        raise chain_error("On-chain simulation returned no result")
    try:
        return _native(results[0]["xdr"]), payload.get("latest_ledger")
    except Exception as exc:
        raise chain_error("Could not decode on-chain contract state") from exc


def read_contract_balances(contract_id: str, source_account: str) -> tuple[dict[str, int], int | None]:
    """Call the real `get_balance` getter through Soroban simulation (no signing)."""
    native, ledger = _simulate_getter(contract_id, source_account, "get_balance", [])
    if not isinstance(native, dict):
        raise chain_error("Unexpected on-chain contract state shape")
    try:
        balances = {key: int(native[key]) for key in ("funded", "released", "remaining")}
    except (KeyError, TypeError, ValueError) as exc:
        raise chain_error("On-chain contract state is missing balance fields") from exc
    return balances, ledger


def read_contract_agreement(contract_id: str, source_account: str) -> dict:
    """Read the authoritative `get_agreement` struct via simulation.

    Fields mirror `Agreement` in contracts/escrow/src/lib.rs. The numeric
    agreement id is derived from this getter and from nowhere else.
    """
    native, _ledger = _simulate_getter(contract_id, source_account, "get_agreement", [])
    if not isinstance(native, dict):
        raise chain_error("On-chain agreement has an unexpected shape")
    normalized = {str(key): value for key, value in _normalize(native).items()}
    required = (
        "agreement_id", "payer", "payee", "asset", "total_amount", "milestone_count",
        "funded", "released", "remaining", "authorized", "status",
    )
    if any(key not in normalized for key in required):
        raise chain_error("On-chain agreement is missing required fields")
    try:
        return {
            "agreement_id": int(normalized["agreement_id"]),
            "payer": normalized["payer"],
            "payee": normalized["payee"],
            "asset": normalized["asset"],
            "total_amount": int(normalized["total_amount"]),
            "milestone_count": int(normalized["milestone_count"]),
            "funded": int(normalized["funded"]),
            "released": int(normalized["released"]),
            "remaining": int(normalized["remaining"]),
            "authorized": normalized["authorized"],
            "status": str(normalized["status"]),
        }
    except (TypeError, ValueError) as exc:
        raise chain_error("On-chain agreement fields could not be decoded") from exc


def read_contract_milestone(contract_id: str, source_account: str, index: int) -> dict:
    """Read the authoritative `get_milestone(index)` getter via simulation."""
    native, _ledger = _simulate_getter(
        contract_id, source_account, "get_milestone", [scval.to_uint32(int(index))]
    )
    if not isinstance(native, dict):
        raise chain_error("On-chain milestone state has an unexpected shape")
    state = {str(key): value for key, value in _normalize(native).items()}
    if not isinstance(state.get("approved"), bool) or not isinstance(state.get("released"), bool):
        raise chain_error("On-chain milestone state is missing flags")
    try:
        return {
            "index": int(state.get("index", index)),
            "description": str(state.get("description", "")),
            "amount": int(state["amount"]),
            "approved": state["approved"],
            "released": state["released"],
        }
    except (KeyError, TypeError, ValueError) as exc:
        raise chain_error("On-chain milestone fields could not be decoded") from exc


def read_contract_events(contract_id: str, *, limit: int = 200) -> list[dict]:
    """Read indexed Soroban events for one contract. RPC failures are raised."""
    try:
        response = stellar.soroban_server().get_events(
            filters=[soroban_rpc.EventFilter(contractIds=[contract_id])], limit=limit
        )
        events = [event.model_dump() for event in response.events]
    except Exception as exc:
        logger.warning("Soroban getEvents failed for %s: %s", contract_id, exc)
        raise chain_error("Could not read on-chain contract events") from exc
    normalized = []
    for event in events:
        normalized.append(
            {
                "transaction_hash": str(event.get("transaction_hash")),
                "contract_id": str(event.get("contract_id")),
                "topics": [_native(topic) for topic in event.get("topic", [])],
                "value": _native(event.get("value", "")),
                "ledger": event.get("ledger"),
            }
        )
    return normalized


def _expected_sac(asset_code: str, asset_issuer: str | None) -> str:
    """The Stellar Asset Contract address the configured network derives from the DB asset."""
    return stellar._asset(asset_code, asset_issuer).contract_id(settings.stellar_network_passphrase)


def assert_contract_identity(
    agreement: PaymentAgreement, contract_id: str, source_account: str, db: Session | None = None
) -> dict:
    """Fail closed unless the bound contract really holds this agreement.

    Called before every Soroban settlement: a different contract (or a getter
    that cannot be read) must never move funds or milestones for this record.
    """
    if agreement.onchain_agreement_id is None:
        raise conflict("Agreement has no derived on-chain id", "NO_ONCHAIN_ID")
    try:
        state = read_contract_agreement(contract_id, source_account)
    except Exception as exc:
        raise BizError(
            502, "CONTRACT_STATE_READ_FAILED",
            f"Escrow contract identity could not be read: {exc}",
        ) from exc
    if state["agreement_id"] != int(agreement.onchain_agreement_id):
        raise conflict(
            "Escrow contract holds a different agreement", "CONTRACT_IDENTITY_MISMATCH"
        )
    if state["milestone_count"] != len(_milestones(agreement, db)):
        raise conflict("Escrow contract milestone count does not match", "CONTRACT_STATE_MISMATCH")
    if int((to_decimal(agreement.total_amount) * STROOPS).to_integral_value()) != state["total_amount"]:
        raise conflict("Escrow contract total amount does not match", "CONTRACT_STATE_MISMATCH")
    expected_payer = getattr(agreement, "escrow_payer", None)
    if expected_payer and state["payer"] != expected_payer:
        raise conflict("Escrow contract payer does not match the binding", "CONTRACT_STATE_MISMATCH")
    expected_asset = _expected_sac(agreement.asset_code, agreement.asset_issuer)
    if state["asset"] != expected_asset:
        raise conflict("Escrow contract asset does not match the agreement", "CONTRACT_STATE_MISMATCH")
    return state


def _milestones(agreement: PaymentAgreement, db: Session | None = None) -> list:
    """DB milestone rows ordered by index (works with real sessions and test doubles)."""
    if db is None:
        return list(getattr(agreement, "milestones", []) or [])
    return list(
        db.scalars(
            select(AgreementMilestone)
            .where(AgreementMilestone.agreement_id == agreement.id)
            .order_by(AgreementMilestone.sort_order)
        ).all()
    )


def _expected_balances(
    db: Session, agreement: PaymentAgreement, *, released_extra: int = 0,
    funded_extra: int = 0, expect_empty: bool = False,
) -> dict[str, int]:
    """Balances the database expects on-chain after a successful operation."""
    if expect_empty:
        return {"funded": 0, "released": 0, "remaining": 0}
    funded = int((to_decimal(agreement.funded_amount) * STROOPS).to_integral_value()) + funded_extra
    released_amount = sum(
        (to_decimal(milestone.amount) for milestone in _milestones(agreement, db)
         if milestone.status == "released"),
        Decimal("0"),
    )
    released = int((released_amount * STROOPS).to_integral_value()) + released_extra
    return {"funded": funded, "released": released, "remaining": funded - released}


def verify_escrow_state(
    db: Session,
    agreement: PaymentAgreement,
    *,
    contract_id: str | None,
    source_account: str | None,
    released_extra: int = 0,
    funded_extra: int = 0,
    expect_empty: bool = False,
    milestone_index: int | None = None,
    expect_approved: bool | None = None,
    expect_released: bool | None = None,
) -> dict:
    """Independently read contract state; never infer settlement from an event alone.

    A failed read, missing state or mismatch raises a conflict so the backend
    cannot mark funds or milestones settled on an unverified chain state.
    """
    if not contract_id or not source_account:
        raise conflict("Escrow state cannot be verified without a contract and source account", "ESCROW_STATE_UNVERIFIED")
    try:
        observed, ledger = read_contract_balances(contract_id, source_account)
    except Exception as exc:
        logger.warning("Post-operation state read failed for %s: %s", agreement.id, exc)
        raise conflict("On-chain contract state could not be verified", "ESCROW_STATE_READ_FAILED") from exc
    expected = _expected_balances(
        db, agreement, released_extra=released_extra,
        funded_extra=funded_extra, expect_empty=expect_empty,
    )
    if observed != expected:
        logger.warning("Escrow state mismatch for %s: expected %s observed %s", agreement.id, expected, observed)
        raise BizError(
            409, "ESCROW_STATE_MISMATCH", "On-chain contract state does not match the agreement",
            {"expected": expected, "observed": observed},
        )
    evidence: dict = {"expected": expected, "observed": observed, "latest_ledger": ledger}
    try:
        identity = read_contract_agreement(contract_id, source_account)
    except Exception as exc:
        raise conflict("On-chain agreement identity could not be verified", "ESCROW_STATE_READ_FAILED") from exc
    if identity["agreement_id"] != agreement.onchain_agreement_id:
        raise BizError(
            409, "ESCROW_STATE_MISMATCH", "On-chain agreement identity does not match",
            {"expected": {"agreement_id": agreement.onchain_agreement_id},
             "observed": {"agreement_id": identity["agreement_id"]}},
        )
    evidence["agreement_identity"] = identity
    if milestone_index is not None:
        try:
            milestone_state = read_contract_milestone(contract_id, source_account, milestone_index)
        except Exception as exc:
            logger.warning("Post-operation milestone read failed for %s: %s", agreement.id, exc)
            raise conflict("On-chain milestone state could not be verified", "ESCROW_STATE_READ_FAILED") from exc
        if expect_approved is not None and milestone_state["approved"] != expect_approved:
            raise BizError(
                409, "ESCROW_STATE_MISMATCH", "On-chain milestone approval state does not match",
                {"expected": {"approved": expect_approved}, "observed": milestone_state},
            )
        if expect_released is not None and milestone_state["released"] != expect_released:
            raise BizError(
                409, "ESCROW_STATE_MISMATCH", "On-chain milestone release state does not match",
                {"expected": {"released": expect_released}, "observed": milestone_state},
            )
        evidence["milestone"] = milestone_state
    return evidence


def discrepancy_report(
    *,
    agreement: PaymentAgreement,
    contract_id: str | None,
    expected: dict,
    observed: dict | None,
    discrepancies: tuple[str, ...] | list[str],
    evidence: dict | None = None,
) -> ReconciliationReport:
    """Synthesize the read-only report persisted when a post-submit check fails."""
    return ReconciliationReport(
        agreement_id=agreement.id,
        contract_id=contract_id,
        onchain=observed,
        database=expected,
        discrepancies=tuple(discrepancies),
        checked_at=datetime.now(timezone.utc).isoformat(),
        evidence={
            "fund_transaction_hash": agreement.fund_transaction_hash,
            "onchain_agreement_id": agreement.onchain_agreement_id,
            "network": settings.stellar_network_passphrase,
            **(evidence or {}),
        },
    )


def persist_report(db: Session, report: ReconciliationReport, business_id: str) -> ReconciliationRecord:
    """Append an immutable reconciliation observation. Never repairs records."""
    record = ReconciliationRecord(
        business_id=business_id,
        agreement_id=report.agreement_id,
        transaction_hash=(report.evidence or {}).get("fund_transaction_hash"),
        contract_id=report.contract_id,
        expected_state=report.database,
        observed_state=report.onchain,
        discrepancy=list(report.discrepancies),
        resolution_status="open",
    )
    db.add(record)
    db.flush()
    return record


def _database_balances(db: Session, agreement: PaymentAgreement) -> dict[str, int]:
    funded = int((to_decimal(agreement.funded_amount) * STROOPS).to_integral_value())
    released_amount = sum(
        (to_decimal(milestone.amount) for milestone in _milestones(agreement, db)
         if milestone.status == "released"),
        Decimal("0"),
    )
    released = int((released_amount * STROOPS).to_integral_value())
    return {"funded": funded, "released": released, "remaining": funded - released}


def _event_discrepancies(events: list[dict], agreement: PaymentAgreement) -> tuple[list[str], set[str]]:
    """Compare observed contract events with agreement identity and confirmed payments."""
    discrepancies: list[str] = []
    matched_hashes: set[str] = set()
    expected_id = agreement.onchain_agreement_id
    for event in events:
        topics = event.get("topics") or []
        if not topics or not str(topics[0]).startswith(("funded", "approved", "released", "refunded")):
            continue
        matched_hashes.add(event["transaction_hash"])
        if expected_id is not None and (len(topics) < 2 or topics[1] != int(expected_id)):
            discrepancies.append("WRONG_AGREEMENT_EVENT_ASSOCIATION")
        if agreement.fund_transaction_hash and event["transaction_hash"] == agreement.fund_transaction_hash:
            if topics[0] != "funded":
                discrepancies.append("FUNDING_TX_EVENT_MISMATCH")
    return discrepancies, matched_hashes


def _payment_discrepancies(db: Session, agreement: PaymentAgreement) -> list[dict]:
    """Report confirmed DB states without a matching verified chain transaction."""
    issues: list[dict] = []
    rows = [
        row for row in db.scalars(
            select(PaymentRecord).where(PaymentRecord.agreement_id == agreement.id)
        ).all()
        if isinstance(row, PaymentRecord)
    ]
    hashes: dict[str, list[BlockchainTransaction]] = {}
    for tx in db.scalars(
        select(BlockchainTransaction).where(
            BlockchainTransaction.business_id == agreement.business_id
        )
    ).all():
        if isinstance(tx, BlockchainTransaction):
            hashes.setdefault(tx.hash, []).append(tx)
    for row in rows:
        txs = hashes.get(row.hash, [])
        if len(txs) > 1:
            issues.append({"hash": row.hash, "issue": "DUPLICATE_TRANSACTION_HASH"})
        if row.status != "confirmed":
            continue
        verified = [
            tx for tx in txs
            if tx.successful and tx.confirmed_at is not None
            and tx.status != "pending" and tx.payment_record_id == row.id
        ]
        if not verified:
            issues.append({"hash": row.hash, "issue": "CONFIRMED_PAYMENT_WITHOUT_VERIFIED_TX"})
        elif any(tx.status == "pending" or tx.ledger is None for tx in txs):
            issues.append({"hash": row.hash, "issue": "PENDING_TX_RECORDED_AS_CONFIRMED"})
        if row.business_id != agreement.business_id:
            issues.append({"hash": row.hash, "issue": "WRONG_AGREEMENT_ASSOCIATION"})
    if agreement.fund_transaction_hash and len(hashes.get(agreement.fund_transaction_hash, [])) > 1:
        issues.append({"hash": agreement.fund_transaction_hash, "issue": "DUPLICATE_FUNDING_TRANSACTION"})
    return issues


def reconcile_agreement(
    db: Session, agreement: PaymentAgreement, *, source_account: str | None = None
) -> ReconciliationReport:
    """Compare database state with the authoritative on-chain contract state."""
    contract_id = agreement.escrow_contract_id or settings.stellar_escrow_contract_id or None
    discrepancies: list[str] = []
    onchain: dict[str, int] | None = None
    ledger: int | None = None
    contract_agreement: dict | None = None
    milestones: list[dict] = []
    events: list[dict] = []

    if not contract_id:
        discrepancies.append("NO_CONTRACT_BOUND_TO_AGREEMENT")
    if not source_account:
        discrepancies.append("NO_FUNDING_SOURCE_ACCOUNT")

    if contract_id and source_account:
        try:
            onchain, ledger = read_contract_balances(contract_id, source_account)
        except Exception as exc:
            logger.warning("Reconciliation read failed for %s: %s", agreement.id, exc)
            discrepancies.append("ONCHAIN_READ_FAILED")
        else:
            database = _database_balances(db, agreement)
            for key in ("funded", "released", "remaining"):
                if database[key] != onchain[key]:
                    discrepancies.append(f"MISMATCH_{key.upper()}")

        try:
            contract_agreement = read_contract_agreement(contract_id, source_account)
        except Exception as exc:
            logger.warning("Agreement getter read failed for %s: %s", agreement.id, exc)
            discrepancies.append("AGREEMENT_GETTER_FAILED")
        else:
            if agreement.onchain_agreement_id is None:
                discrepancies.append("NO_ONCHAIN_AGREEMENT_ID")
            elif contract_agreement["agreement_id"] != int(agreement.onchain_agreement_id):
                discrepancies.append("AGREEMENT_ID_MISMATCH")
            if int((to_decimal(agreement.total_amount) * STROOPS).to_integral_value()) != contract_agreement["total_amount"]:
                discrepancies.append("TOTAL_AMOUNT_MISMATCH")
            if len(_milestones(agreement, db)) != contract_agreement["milestone_count"]:
                discrepancies.append("MILESTONE_COUNT_MISMATCH")
            expected_asset = _expected_sac(agreement.asset_code, agreement.asset_issuer)
            if contract_agreement["asset"] != expected_asset:
                discrepancies.append("ASSET_MISMATCH")
            expected_payer = getattr(agreement, "escrow_payer", None)
            if expected_payer and contract_agreement["payer"] != expected_payer:
                discrepancies.append("PAYER_MISMATCH")

        for index, milestone in enumerate(_milestones(agreement, db)):
            try:
                state = read_contract_milestone(contract_id, source_account, index)
            except Exception as exc:
                logger.warning("Milestone getter read failed for %s#%s: %s", agreement.id, index, exc)
                discrepancies.append(f"MILESTONE_READ_FAILED_{index}")
                continue
            milestones.append(state)
            if state["approved"] != (milestone.status in ("approved", "released")):
                discrepancies.append(f"APPROVED_FLAG_MISMATCH_{index}")
            if state["released"] != (milestone.status == "released"):
                discrepancies.append(f"RELEASED_FLAG_MISMATCH_{index}")
            if state["amount"] != int((to_decimal(milestone.amount) * STROOPS).to_integral_value()):
                discrepancies.append(f"MILESTONE_AMOUNT_MISMATCH_{index}")

    if contract_id:
        try:
            events = read_contract_events(contract_id)
        except Exception as exc:
            logger.warning("Event read failed for %s: %s", agreement.id, exc)
            discrepancies.append("ONCHAIN_EVENTS_READ_FAILED")
        else:
            event_issues, _ = _event_discrepancies(events, agreement)
            discrepancies.extend(event_issues)

    payments = _payment_discrepancies(db, agreement)
    discrepancies.extend(item["issue"] for item in payments)

    database = _database_balances(db, agreement)
    return ReconciliationReport(
        agreement_id=agreement.id,
        contract_id=contract_id,
        onchain=onchain,
        database=database,
        discrepancies=tuple(dict.fromkeys(discrepancies)),
        checked_at=datetime.now(timezone.utc).isoformat(),
        evidence={
            "fund_transaction_hash": agreement.fund_transaction_hash,
            "onchain_agreement_id": agreement.onchain_agreement_id,
            "latest_ledger": ledger,
            "network": settings.stellar_network_passphrase,
        },
        contract_agreement=contract_agreement,
        milestones=milestones,
        events=events,
        payments=payments,
    )
