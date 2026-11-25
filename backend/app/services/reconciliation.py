"""Read-only on-chain reconciliation for Soroban escrow agreements.

This module never repairs financial records. It reads authoritative contract
state from Soroban RPC, compares it with database state, and reports every
discrepancy for an auditable human decision.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session
from stellar_sdk import TransactionBuilder, scval

from app.config import get_settings
from app.errors import chain_error, conflict
from app.models import (
    AgreementMilestone,
    BlockchainTransaction,
    PaymentAgreement,
    ReconciliationRecord,
)
from app.services import stellar
from app.utils import to_decimal, utcnow

logger = logging.getLogger(__name__)
settings = get_settings()
STROOPS = Decimal("10000000")


@dataclass(frozen=True)
class ReconciliationReport:
    agreement_id: str
    contract_id: str | None
    onchain: dict[str, int] | None
    database: dict[str, int]
    discrepancies: tuple[str, ...]
    checked_at: str
    evidence: dict

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
        }


def read_contract_balances(contract_id: str, source_account: str) -> tuple[dict[str, int], int | None]:
    """Call the real `get_balance` getter through Soroban simulation (no signing)."""
    server = stellar.soroban_server()
    try:
        account = server.load_account(source_account)
        builder = TransactionBuilder(
            account, network_passphrase=settings.stellar_network_passphrase, base_fee=100
        )
        builder.append_invoke_contract_function_op(
            contract_id=contract_id, function_name="get_balance", parameters=[]
        )
        builder.set_timeout(60)
        response = server.simulate_transaction(builder.build())
    except Exception as exc:
        logger.warning("On-chain state read failed for %s: %s", contract_id, type(exc).__name__)
        raise chain_error("Could not read on-chain contract state") from exc

    payload = response.model_dump()
    if payload.get("error"):
        raise chain_error("On-chain simulation reported an error")
    results = payload.get("results") or []
    if not results or not results[0].get("xdr"):
        raise chain_error("On-chain simulation returned no result")
    try:
        native = scval.to_native(results[0]["xdr"])
    except Exception as exc:
        raise chain_error("Could not decode on-chain contract state") from exc
    if not isinstance(native, dict):
        raise chain_error("Unexpected on-chain contract state shape")
    try:
        balances = {key: int(native[key]) for key in ("funded", "released", "remaining")}
    except (KeyError, TypeError, ValueError) as exc:
        raise chain_error("On-chain contract state is missing balance fields") from exc
    return balances, payload.get("latest_ledger")


def read_contract_milestone(contract_id: str, source_account: str, index: int) -> dict:
    """Read the authoritative `get_milestone(index)` getter via simulation."""
    server = stellar.soroban_server()
    try:
        account = server.load_account(source_account)
        builder = TransactionBuilder(
            account, network_passphrase=settings.stellar_network_passphrase, base_fee=100
        )
        builder.append_invoke_contract_function_op(
            contract_id=contract_id,
            function_name="get_milestone",
            parameters=[scval.to_uint32(int(index))],
        )
        builder.set_timeout(60)
        response = server.simulate_transaction(builder.build())
    except Exception as exc:
        logger.warning("On-chain milestone read failed for %s#%s: %s", contract_id, index, type(exc).__name__)
        raise chain_error("Could not read on-chain milestone state") from exc

    payload = response.model_dump()
    results = payload.get("results") or []
    if payload.get("error") or not results or not results[0].get("xdr"):
        raise chain_error("On-chain milestone simulation returned no result")
    try:
        native = scval.to_native(results[0]["xdr"])
    except Exception as exc:
        raise chain_error("Could not decode on-chain milestone state") from exc
    if not isinstance(native, dict) or not isinstance(native.get("approved"), bool) or not isinstance(native.get("released"), bool):
        raise chain_error("On-chain milestone state is missing flags")
    return {"approved": native["approved"], "released": native["released"]}


def _expected_balances(
    db: Session, agreement: PaymentAgreement, *, released_extra: int = 0,
    funded_extra: int = 0, expect_empty: bool = False,
) -> dict[str, int]:
    """Balances the database expects on-chain after a successful operation."""
    if expect_empty:
        return {"funded": 0, "released": 0, "remaining": 0}
    funded = int((to_decimal(agreement.funded_amount) * STROOPS).to_integral_value()) + funded_extra
    released_amount = sum(
        (to_decimal(milestone.amount) for milestone in db.scalars(
            select(AgreementMilestone).where(AgreementMilestone.agreement_id == agreement.id)
        ).all() if milestone.status == "released"),
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
        raise conflict("On-chain contract state does not match the agreement", "ESCROW_STATE_MISMATCH")
    evidence: dict = {"expected": expected, "observed": observed, "latest_ledger": ledger}
    if milestone_index is not None:
        try:
            milestone_state = read_contract_milestone(contract_id, source_account, milestone_index)
        except Exception as exc:
            logger.warning("Post-operation milestone read failed for %s: %s", agreement.id, exc)
            raise conflict("On-chain milestone state could not be verified", "ESCROW_STATE_READ_FAILED") from exc
        if expect_approved is not None and milestone_state["approved"] != expect_approved:
            raise conflict("On-chain milestone approval state does not match", "ESCROW_STATE_MISMATCH")
        if expect_released is not None and milestone_state["released"] != expect_released:
            raise conflict("On-chain milestone release state does not match", "ESCROW_STATE_MISMATCH")
        evidence["milestone"] = milestone_state
    return evidence


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
        (to_decimal(milestone.amount) for milestone in db.scalars(
            select(AgreementMilestone).where(AgreementMilestone.agreement_id == agreement.id)
        ).all() if milestone.status == "released"),
        Decimal("0"),
    )
    released = int((released_amount * STROOPS).to_integral_value())
    return {"funded": funded, "released": released, "remaining": funded - released}


def reconcile_agreement(
    db: Session, agreement: PaymentAgreement, *, source_account: str | None = None
) -> ReconciliationReport:
    """Compare database state with the authoritative on-chain contract state."""
    contract_id = agreement.escrow_contract_id or settings.stellar_escrow_contract_id or None
    discrepancies: list[str] = []
    onchain: dict[str, int] | None = None
    ledger: int | None = None

    if not contract_id:
        discrepancies.append("NO_CONTRACT_BOUND_TO_AGREEMENT")
    if not source_account:
        discrepancies.append("NO_FUNDING_SOURCE_ACCOUNT")

    if contract_id and source_account:
        try:
            onchain, ledger = read_contract_balances(contract_id, source_account)
        except Exception as exc:
            # Log server-side detail only; clients get a stable reason code.
            logger.warning("Reconciliation read failed for %s: %s", agreement.id, exc)
            discrepancies.append("ONCHAIN_READ_FAILED")
        else:
            database = _database_balances(db, agreement)
            for key in ("funded", "released", "remaining"):
                if database[key] != onchain[key]:
                    discrepancies.append(f"MISMATCH_{key.upper()}")

    database = _database_balances(db, agreement)
    if agreement.fund_transaction_hash:
        uses = db.scalar(
            select(func.count()).select_from(BlockchainTransaction).where(
                BlockchainTransaction.hash == agreement.fund_transaction_hash
            )
        )
        if uses and uses > 1:
            discrepancies.append("DUPLICATE_FUNDING_TRANSACTION")

    onchain_agreement_id = agreement.onchain_agreement_id
    if contract_id and onchain_agreement_id is None:
        discrepancies.append("NO_ONCHAIN_AGREEMENT_ID")

    return ReconciliationReport(
        agreement_id=agreement.id,
        contract_id=contract_id,
        onchain=onchain,
        database=database,
        discrepancies=tuple(discrepancies),
        checked_at=datetime.now(timezone.utc).isoformat(),
        evidence={
            "fund_transaction_hash": agreement.fund_transaction_hash,
            "onchain_agreement_id": onchain_agreement_id,
            "latest_ledger": ledger,
            "network": settings.stellar_network_passphrase,
        },
    )
