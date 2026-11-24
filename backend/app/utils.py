"""Money, time and pagination helpers. All money is Decimal, never float."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Any

from fastapi import Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.errors import bad_request

MONEY_QUANTUM = Decimal("0.0000001")


def utcnow() -> datetime:
    """Timezone-naive UTC value; consistently stored in all timestamp columns."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def naive(value: datetime | None) -> datetime | None:
    """Normalize DB timestamps (aware on PostgreSQL, naive on SQLite) for comparison."""
    if value is None:
        return None
    return value.replace(tzinfo=None) if value.tzinfo else value


def parse_datetime(value: str | datetime | None, field: str = "date") -> datetime | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.replace(tzinfo=None) if value.tzinfo else value
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, AttributeError) as exc:
        raise bad_request(f"{field} must be an ISO-8601 date/time", "INVALID_DATE") from exc
    return parsed.replace(tzinfo=None) if parsed.tzinfo else parsed


def to_decimal(value: Any, field: str = "amount", *, positive: bool = False) -> Decimal:
    if isinstance(value, bool) or value is None:
        raise bad_request(f"{field} must be a decimal amount", "INVALID_AMOUNT")
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise bad_request(f"{field} must be a decimal amount", "INVALID_AMOUNT") from exc
    if not amount.is_finite():
        raise bad_request(f"{field} must be a finite amount", "INVALID_AMOUNT")
    try:
        # Quantize first: a tiny positive value that rounds to zero is not money.
        amount = amount.quantize(MONEY_QUANTUM)
    except InvalidOperation as exc:
        raise bad_request(f"{field} is outside the supported money range", "INVALID_AMOUNT") from exc
    if positive and amount <= 0:
        raise bad_request(f"{field} must be greater than zero", "INVALID_AMOUNT")
    return amount


def money_str(value: Any) -> str:
    """Stable string rendering of a decimal amount (at most 7 places)."""
    amount = to_decimal(value)
    rendered = format(amount, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return rendered if rendered not in ("", "-0") else "0"


def jsonify(value: Any) -> str:
    return json.dumps(value, default=str, separators=(",", ":"))


def from_json(value: str | None, default: Any) -> Any:
    if not value:
        return default
    try:
        return json.loads(value)
    except (ValueError, TypeError) as exc:
        raise bad_request("Stored JSON data is corrupt", "CORRUPT_DATA") from exc


class Pagination:
    def __init__(self, page: int = Query(1, ge=1), per_page: int = Query(20, ge=1, le=100)):
        self.page = page
        self.per_page = per_page

    @property
    def offset(self) -> int:
        return (self.page - 1) * self.per_page


def paginate(items: list[Any], total: int, pagination: Pagination) -> dict[str, Any]:
    return {
        "items": items,
        "total": total,
        "page": pagination.page,
        "per_page": pagination.per_page,
    }


def next_reference(db: Session, model: Any, column: Any, prefix: str) -> str:
    """Allocate the next INV-/AGR-YYYY-0001 reference from the stored maximum.

    Using MAX rather than COUNT means a deleted or rolled-back row cannot force a
    duplicate. The unique constraint remains the final arbiter: concurrent writers
    can still collide between this read and their INSERT, so callers MUST catch
    IntegrityError on flush/commit and translate it to HTTP 409.
    """
    year = utcnow().year
    pattern = f"{prefix}-{year}-%"
    latest = db.scalar(select(func.max(column)).where(column.like(pattern)))
    highest = 0
    if latest:
        suffix = str(latest).rsplit("-", 1)[-1]
        if suffix.isdigit():
            highest = int(suffix)
    return f"{prefix}-{year}-{highest + 1:04d}"


def add_seconds(seconds: float) -> datetime:
    return utcnow() + timedelta(seconds=seconds)
