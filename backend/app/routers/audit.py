"""Read-only immutable audit trail."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import AuditLog
from app.schemas import AuditOut, Page
from app.security import get_business_membership
from app.utils import Pagination, paginate

router = APIRouter(prefix="/audit-logs", tags=["audit"])


@router.get("", response_model=Page[AuditOut])
def list_audit_logs(
    action: str | None = None,
    pagination: Pagination = Depends(),
    membership=Depends(get_business_membership),
    db: Session = Depends(get_db),
):
    query = select(AuditLog).where(AuditLog.business_id == membership.business_id)
    if action:
        query = query.where(AuditLog.action.ilike(f"%{action}%"))
    total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
    rows = db.scalars(
        query.order_by(AuditLog.created_at.desc()).offset(pagination.offset).limit(pagination.per_page)
    ).all()
    return paginate([AuditOut.model_validate(row) for row in rows], total, pagination)
