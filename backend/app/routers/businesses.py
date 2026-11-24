"""Business and membership management with owner/admin RBAC."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.errors import bad_request, conflict, not_found
from app.models import Business, BusinessMember, User
from app.schemas import (
    BusinessCreate,
    BusinessOut,
    BusinessUpdate,
    MemberCreate,
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

router = APIRouter(prefix="/businesses", tags=["businesses"])


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
    membership: BusinessMember = Depends(get_business_membership),
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


@router.post("/{business_id}/members", response_model=MemberOut, status_code=201)
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
    member = BusinessMember(
        business_id=business_id,
        user_id=user.id if user else None,
        email=email,
        role=payload.role,
        status="active" if user else "pending",
        invited_by=membership.user_id,
    )
    db.add(member)
    audit(
        db, business_id, membership.user_id, "member.invited", "business_member", member.id,
        {"email": email, "role": payload.role},
    )
    db.commit()
    db.refresh(member)
    return MemberOut(
        id=member.id,
        user=member.user,
        email=member.email,
        role=member.role,
        status=member.status,
        created_at=member.created_at,
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
