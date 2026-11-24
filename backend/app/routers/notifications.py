"""In-app notification inbox."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.errors import not_found
from app.models import Notification
from app.schemas import NotificationOut
from app.security import get_business_membership
from app.utils import utcnow

router = APIRouter(prefix="/notifications", tags=["notifications"])


@router.get("", response_model=list[NotificationOut])
def list_notifications(
    unread_only: bool = False,
    membership=Depends(get_business_membership),
    db: Session = Depends(get_db),
):
    query = select(Notification).where(
        Notification.business_id == membership.business_id,
        Notification.user_id == membership.user_id,
    )
    if unread_only:
        query = query.where(Notification.is_read.is_(False))
    rows = db.scalars(query.order_by(Notification.created_at.desc()).limit(100)).all()
    return [NotificationOut.model_validate(row) for row in rows]


@router.patch("/read-all")
def read_all(
    membership=Depends(get_business_membership), db: Session = Depends(get_db)
):
    rows = db.scalars(
        select(Notification).where(
            Notification.business_id == membership.business_id,
            Notification.user_id == membership.user_id,
            Notification.is_read.is_(False),
        )
    ).all()
    for row in rows:
        row.is_read = True
        row.updated_at = utcnow()
    db.commit()
    return {"ok": True, "updated": len(rows)}


@router.patch("/{notification_id}/read", response_model=NotificationOut)
def mark_read(
    notification_id: str,
    membership=Depends(get_business_membership),
    db: Session = Depends(get_db),
):
    notification = db.get(Notification, notification_id)
    if (
        notification is None
        or notification.business_id != membership.business_id
        or notification.user_id != membership.user_id
    ):
        raise not_found("Notification not found")
    notification.is_read = True
    notification.updated_at = utcnow()
    db.commit()
    db.refresh(notification)
    return NotificationOut.model_validate(notification)
