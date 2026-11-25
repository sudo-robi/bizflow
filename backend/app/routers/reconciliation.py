"""Read-only on-chain reconciliation endpoint for payment agreements."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.errors import not_found
from app.models import BlockchainTransaction
from app.routers.agreements import _agreement
from app.security import require_roles
from app.services import reconciliation
from app.services.notifications import audit

router = APIRouter(prefix="/agreements", tags=["agreements"])


@router.post("/{agreement_id}/reconcile")
def reconcile_agreement(
    agreement_id: str,
    membership=Depends(require_roles("owner", "admin", "finance_manager")),
    db: Session = Depends(get_db),
):
    """Read real contract state and report differences without changing records."""
    agreement = _agreement(db, agreement_id, membership.business_id)
    funding = db.scalar(
        select(BlockchainTransaction).where(
            BlockchainTransaction.hash == agreement.fund_transaction_hash
        )
    )
    if agreement.fund_transaction_hash and funding is None:
        raise not_found("Funding transaction record is missing")
    report = reconciliation.reconcile_agreement(
        db, agreement, source_account=funding.source_account if funding else None
    )
    record = reconciliation.persist_report(db, report, membership.business_id)
    audit(
        db,
        membership.business_id,
        membership.user_id,
        "agreement.reconciled",
        "agreement",
        agreement.id,
        {
            "discrepancies": list(report.discrepancies),
            "consistent": not report.discrepancies,
            "reconciliation_record_id": record.id,
        },
    )
    db.commit()
    result = report.as_dict()
    result["reconciliation_record_id"] = record.id
    result["resolution_status"] = record.resolution_status
    return result
