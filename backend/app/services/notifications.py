"""In-app notification and immutable audit-log helpers."""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import models

logger = logging.getLogger(__name__)


def notify(
    db: Session,
    business_id: str,
    user_id: str,
    title: str,
    message: str,
    type: str = "info",
    related_id: str | None = None,
) -> models.Notification:
    notification = models.Notification(
        business_id=business_id,
        user_id=user_id,
        title=title[:255],
        message=message,
        type=type,
        related_id=related_id,
    )
    db.add(notification)
    return notification


def notify_business(
    db: Session,
    business_id: str,
    title: str,
    message: str,
    type: str = "info",
    related_id: str | None = None,
) -> list[models.Notification]:
    members = db.scalars(
        select(models.BusinessMember).where(
            models.BusinessMember.business_id == business_id,
            models.BusinessMember.status == "active",
            models.BusinessMember.user_id.isnot(None),
        )
    ).all()
    return [
        notify(db, business_id, member.user_id, title, message, type, related_id)
        for member in members
    ]


def audit(
    db: Session,
    business_id: str,
    actor_id: str | None,
    action: str,
    entity_type: str | None = None,
    entity_id: str | None = None,
    details: dict[str, Any] | None = None,
    ip_address: str | None = None,
) -> models.AuditLog:
    entry = models.AuditLog(
        business_id=business_id,
        actor_id=actor_id,
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        details=details,
        ip_address=ip_address,
    )
    db.add(entry)
    return entry


def log_event(
    db: Session,
    business_id: str,
    actor_id: str | None,
    action: str,
    entity_type: str | None,
    entity_id: str | None,
    details: dict[str, Any] | None = None,
) -> None:
    """Best-effort audit side effect; never masks the caller's primary error."""
    try:
        audit(
            db,
            business_id,
            actor_id,
            action,
            entity_type,
            entity_id,
            details or {},
        )
    except Exception as exc:
        logger.exception("Could not write audit entry for %s", action)
