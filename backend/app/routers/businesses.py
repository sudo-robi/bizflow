"""Business and membership management with owner/admin RBAC."""

from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import Column, DateTime, String, inspect, select
from sqlalchemy.orm import Session

from app.database import get_db
from app.errors import bad_request, conflict, forbidden, not_found
from app.models import Business, BusinessMember, User
from app.schemas import (
    BusinessCreate,
    BusinessOut,
    BusinessUpdate,
    MemberCreate,
    MemberInviteOut,
    MemberOut,
    MemberUpdate,
)
from app.security import (
    get_business_membership,
    get_current_user,
    membership_for,
    require_business,
    require_roles,
)
from app.services.notifications import audit
from app.utils import naive, utcnow

router = APIRouter(prefix="/businesses", tags=["businesses"])

INVITATION_TTL_DAYS = 7


def _enable_member_invitation_columns() -> None:
    """Attach the one-time invitation columns to the BusinessMember ORM model.

    The model itself lives in ``app.models``; registering the columns here keeps
    the change scoped to the membership router. ``Base.metadata.create_all``
    (tests) and Alembic revision 0007 (deployments) create the same nullable
    columns, so existing rows keep working unchanged.
    """
    table = BusinessMember.__table__
    for name, column in (
        ("invitation_token", Column("invitation_token", String(64), nullable=True)),
        (
            "invitation_expires_at",
            Column("invitation_expires_at", DateTime(timezone=True), nullable=True),
        ),
    ):
        if name not in table.c:
            table.append_column(column)
            inspect(BusinessMember).add_property(name, column)


_enable_member_invitation_columns()


def _hash_invitation_token(token: str) -> str:
    """Only the digest is persisted; the raw token is returned exactly once."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _business_or_404(db: Session, business_id: str) -> Business:
    business = db.get(Business, business_id)
    if business is None:
        raise not_found("Business not found")
    return business


def _member_or_404(db: Session, business_id: str, user_id: str) -> BusinessMember:
    member = db.scalar(
        select(BusinessMember).where(
            BusinessMember.business_id == business_id, BusinessMember.user_id == user_id
        )
    )
    if member is None:
        raise not_found("Membership not found")
    return member


@router.get("")
def list_businesses(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    memberships = db.scalars(
        select(BusinessMember).where(
            BusinessMember.user_id == user.id, BusinessMember.status == "active"
        )
    ).all()
    return [
        {
            "id": member.business_id,
            "name": member.business.name,
            "legal_name": member.business.legal_name,
            "country": member.business.country,
            "currency": member.business.currency,
            "created_at": member.business.created_at,
            "role": member.role,
        }
        for member in memberships
    ]


@router.post("", response_model=BusinessOut, status_code=201)
def create_business(
    payload: BusinessCreate, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    business = Business(
        name=payload.name,
        legal_name=payload.legal_name,
        country=payload.country,
        currency=(payload.currency or "USD").upper(),
        created_by=user.id,
    )
    db.add(business)
    db.flush()
    db.add(
        BusinessMember(
            business_id=business.id,
            user_id=user.id,
            email=user.email,
            role="owner",
            status="active",
        )
    )
    audit(db, business.id, user.id, "business.created", "business", business.id, {"name": business.name})
    db.commit()
    db.refresh(business)
    return business


@router.get("/{business_id}", response_model=BusinessOut)
def get_business(
    business_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    membership_for(db, user, business_id)
    return _business_or_404(db, business_id)


@router.patch("/{business_id}", response_model=BusinessOut)
def update_business(
    business_id: str,
    payload: BusinessUpdate,
    membership: BusinessMember = Depends(require_roles("owner", "admin")),
    db: Session = Depends(get_db),
):
    require_business(membership, business_id)
    business = _business_or_404(db, business_id)
    updates = payload.model_dump(exclude_unset=True, exclude_none=True)
    for field, value in updates.items():
        setattr(business, field, value.upper() if field == "currency" else value)
    audit(db, business_id, membership.user_id, "business.updated", "business", business_id, updates)
    db.commit()
    db.refresh(business)
    return business


@router.get("/{business_id}/members", response_model=list[MemberOut])
def list_members(
    business_id: str,
    membership: BusinessMember = Depends(require_roles("finance_manager")),
    db: Session = Depends(get_db),
):
    require_business(membership, business_id)
    members = db.scalars(
        select(BusinessMember).where(BusinessMember.business_id == business_id)
    ).all()
    return [
        MemberOut(
            id=member.id,
            user=member.user,
            email=member.email,
            role=member.role,
            status=member.status,
            created_at=member.created_at,
        )
        for member in members
    ]


@router.post("/{business_id}/members", response_model=MemberInviteOut, status_code=201)
def add_member(
    business_id: str,
    payload: MemberCreate,
    membership: BusinessMember = Depends(require_roles()),
    db: Session = Depends(get_db),
):
    require_business(membership, business_id)
    email = str(payload.email).lower()
    user = db.scalar(select(User).where(User.email == email))
    existing = db.scalar(
        select(BusinessMember).where(
            BusinessMember.business_id == business_id, BusinessMember.email == email
        )
    )
    if existing is not None or (user and membership_for_optional(db, user.id, business_id)):
        raise conflict("This member already exists", "MEMBER_EXISTS")

    # Unknown emails never grant privileges on registration: the invitee must
    # prove mailbox ownership by accepting a one-time, expiring token.
    raw_token: str | None = None
    expires_at = None
    if user is None:
        raw_token = secrets.token_urlsafe(32)
        expires_at = utcnow() + timedelta(days=INVITATION_TTL_DAYS)
    member = BusinessMember(
        business_id=business_id,
        user_id=user.id if user else None,
        email=email,
        role=payload.role,
        status="active" if user else "invited",
        invited_by=membership.user_id,
    )
    if raw_token is not None:
        member.invitation_token = _hash_invitation_token(raw_token)
        member.invitation_expires_at = expires_at
    db.add(member)
    audit(
        db, business_id, membership.user_id, "member.invited", "business_member", member.id,
        {"email": email, "role": payload.role},
    )
    db.commit()
    db.refresh(member)
    return MemberInviteOut(
        id=member.id,
        user=member.user,
        email=member.email,
        role=member.role,
        status=member.status,
        created_at=member.created_at,
        invitation_token=raw_token,
        invitation_expires_at=expires_at,
    )


@router.post("/{business_id}/members/invitations/{token}/accept", response_model=MemberOut)
def accept_member_invitation(
    business_id: str,
    token: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Accept a membership invitation as the authenticated owner of the email.

    The caller's verified session email must match the invited address. An
    owner/admin cannot accept on someone else's behalf, and registration alone
    never grants the role.
    """
    digest = _hash_invitation_token(token)
    invited = db.scalar(
        select(BusinessMember).where(
            BusinessMember.business_id == business_id,
            BusinessMember.invitation_token == digest,
        )
    )
    if invited is None or invited.status != "invited" or not hmac.compare_digest(
        invited.invitation_token or "", digest
    ):
        raise bad_request("Invitation is invalid or has already been used", "INVITATION_INVALID")
    if user.email.lower() != invited.email.lower():
        raise forbidden("This invitation was sent to a different email address")

    expires_at = naive(invited.invitation_expires_at)
    if expires_at is None or expires_at <= utcnow():
        invited.status = "expired"
        invited.invitation_token = None
        invited.invitation_expires_at = None
        db.commit()
        raise bad_request("Invitation has expired", "INVITATION_EXPIRED")
    if membership_for_optional(db, user.id, business_id) is not None:
        raise conflict("You are already an active member of this business", "MEMBER_EXISTS")

    invited.user_id = user.id
    invited.status = "active"
    invited.invitation_token = None
    invited.invitation_expires_at = None
    audit(
        db, business_id, user.id, "member.invitation_accepted", "business_member", invited.id,
        {"email": invited.email, "role": invited.role},
    )
    db.commit()
    db.refresh(invited)
    return MemberOut(
        id=invited.id,
        user=invited.user,
        email=invited.email,
        role=invited.role,
        status=invited.status,
        created_at=invited.created_at,
    )


def membership_for_optional(db: Session, user_id: str, business_id: str) -> BusinessMember | None:
    return db.scalar(
        select(BusinessMember).where(
            BusinessMember.business_id == business_id, BusinessMember.user_id == user_id
        )
    )


@router.patch("/{business_id}/members/{user_id}", response_model=MemberOut)
def update_member(
    business_id: str,
    user_id: str,
    payload: MemberUpdate,
    membership: BusinessMember = Depends(require_roles()),
    db: Session = Depends(get_db),
):
    require_business(membership, business_id)
    target = _member_or_404(db, business_id, user_id)
    if target.role == "owner" and payload.role != "owner" and target.user_id:
        owners = db.scalars(
            select(BusinessMember).where(
                BusinessMember.business_id == business_id,
                BusinessMember.role == "owner",
                BusinessMember.status == "active",
            )
        ).all()
        if len(owners) <= 1:
            raise bad_request("A business must keep at least one owner", "LAST_OWNER")
    target.role = payload.role
    audit(
        db, business_id, membership.user_id, "member.role_changed", "business_member", target.id,
        {"role": payload.role},
    )
    db.commit()
    db.refresh(target)
    return MemberOut(
        id=target.id,
        user=target.user,
        email=target.email,
        role=target.role,
        status=target.status,
        created_at=target.created_at,
    )


@router.delete("/{business_id}/members/{user_id}")
def remove_member(
    business_id: str,
    user_id: str,
    membership: BusinessMember = Depends(require_roles()),
    db: Session = Depends(get_db),
):
    require_business(membership, business_id)
    target = _member_or_404(db, business_id, user_id)
    if target.role == "owner" and target.user_id:
        owners = db.scalars(
            select(BusinessMember).where(
                BusinessMember.business_id == business_id,
                BusinessMember.role == "owner",
                BusinessMember.status == "active",
            )
        ).all()
        if len(owners) <= 1:
            raise bad_request("A business must keep at least one owner", "LAST_OWNER")
    db.delete(target)
    audit(
        db, business_id, membership.user_id, "member.removed", "business_member", target.id,
        {"email": target.email},
    )
    db.commit()
    return {"ok": True}
