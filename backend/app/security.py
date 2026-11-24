"""JWT authentication, password hashing, business membership and RBAC."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Annotated, Callable

import bcrypt
import jwt
from fastapi import Cookie, Depends, Header
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.database import get_db
from app.errors import bad_request, forbidden, not_found, unauthorized
from app.models import BusinessMember, RevokedToken, Supplier, User
from app.utils import utcnow

logger = logging.getLogger(__name__)
settings = get_settings()
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login", auto_error=False)

MANAGE_ROLES = frozenset({"owner", "admin"})
WRITE_ROLES = frozenset({"owner", "admin", "finance_manager"})
ALL_ROLES = frozenset({"owner", "admin", "finance_manager", "supplier"})


def hash_password(password: str) -> str:
    raw = password.encode("utf-8")[:72]
    return bcrypt.hashpw(raw, bcrypt.gensalt()).decode("ascii")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8")[:72], password_hash.encode("ascii"))
    except (ValueError, TypeError) as exc:
        logger.warning("Stored password hash could not be verified: %s", exc)
        return False


def create_access_token(user_id: str, extra: dict | None = None) -> str:
    now = utcnow()
    payload = {
        "sub": user_id,
        "jti": str(uuid.uuid4()),
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=settings.jwt_expire_minutes)).timestamp()),
    }
    if extra:
        payload.update(extra)
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def decode_access_token(token: str) -> dict:
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except jwt.PyJWTError as exc:
        raise unauthorized("Invalid or expired authentication token") from exc
    if not payload.get("sub"):
        raise unauthorized("Invalid authentication token")
    return payload


def get_current_user(
    db: Annotated[Session, Depends(get_db)],
    bearer_token: Annotated[str | None, Depends(oauth2_scheme)] = None,
    cookie_token: Annotated[
        str | None, Cookie(alias=settings.session_cookie_name)
    ] = None,
) -> User:
    """Accept a Bearer token (API clients) or an httpOnly session cookie (browser)."""
    token = bearer_token or cookie_token
    if not token:
        raise unauthorized("Authentication required")
    payload = decode_access_token(token)
    jti = payload.get("jti")
    if jti and db.scalar(select(RevokedToken).where(RevokedToken.jti == str(jti))) is not None:
        raise unauthorized("This session has been revoked")
    user = db.get(User, str(payload["sub"]))
    if user is None or not user.is_active:
        raise unauthorized("Account is inactive or no longer exists")
    return user


def revoke_token(db: Session, token: str, user_id: str) -> None:
    """Record a JWT id so it can no longer be used after logout."""
    payload = decode_access_token(token)
    jti = payload.get("jti")
    if not jti:
        return
    if db.scalar(select(RevokedToken).where(RevokedToken.jti == str(jti))) is not None:
        return
    exp = payload.get("exp")
    expires_at = (
        datetime.fromtimestamp(int(exp), tz=timezone.utc).replace(tzinfo=None)
        if exp
        else utcnow() + timedelta(minutes=settings.jwt_expire_minutes)
    )
    db.add(RevokedToken(jti=str(jti), user_id=user_id, expires_at=expires_at))
    db.commit()



def membership_for(db: Session, user: User, business_id: str) -> BusinessMember:
    if not business_id:
        raise bad_request("X-Business-ID header is required", "MISSING_BUSINESS")
    membership = db.scalar(
        select(BusinessMember).where(
            BusinessMember.business_id == business_id,
            BusinessMember.user_id == user.id,
            BusinessMember.status == "active",
        )
    )
    if membership is None:
        raise forbidden("You are not an active member of this business")
    return membership


def get_business_membership(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
    x_business_id: Annotated[str, Header(alias="X-Business-ID")],
) -> BusinessMember:
    return membership_for(db, user, x_business_id)


def require_roles(*roles: str) -> Callable:
    """Dependency factory: owner/admin always allowed; others must hold a listed role."""

    def dependency(
        membership: Annotated[BusinessMember, Depends(get_business_membership)],
    ) -> BusinessMember:
        if membership.role in MANAGE_ROLES or membership.role in roles:
            return membership
        raise forbidden("Your role does not permit this action")

    return dependency


def supplier_scope(db: Session, user: User, membership: BusinessMember) -> list[str] | None:
    """Return supplier IDs visible to the caller, or None for unrestricted access."""
    if membership.role in MANAGE_ROLES or membership.role == "finance_manager":
        return None
    return [
        supplier.id
        for supplier in db.query(Supplier)
        .filter(
            Supplier.business_id == membership.business_id,
            Supplier.email.isnot(None),
            Supplier.email == user.email,
        )
        .all()
    ]


def require_business(membership: BusinessMember, business_id: str) -> BusinessMember:
    if membership.business_id != business_id:
        raise not_found("Resource not found in this business")
    return membership
