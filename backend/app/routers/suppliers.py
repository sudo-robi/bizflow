"""Supplier directory with strict business and role scoping."""

from __future__ import annotations

import secrets

from fastapi import APIRouter, Depends
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.database import get_db
from app.errors import bad_request, conflict, forbidden, not_found
from app.models import BusinessMember, Invoice, PaymentRecord, Supplier, SupplierInvitation, User
from app.schemas import (
    InvoiceOut,
    Page,
    PaymentOut,
    SupplierCreate,
    SupplierInvitationAcceptOut,
    SupplierInvitationOut,
    SupplierInviteIn,
    SupplierOut,
    SupplierUpdate,
)
from app.security import (
    get_business_membership,
    get_current_user,
    require_roles,
    supplier_scope,
)
from app.services.notifications import audit, notify, notify_business
from app.utils import Pagination, add_seconds, naive, paginate, utcnow

router = APIRouter(prefix="/suppliers", tags=["suppliers"])
INVITE_TTL_SECONDS = 7 * 24 * 60 * 60


def _invitation_out(invite: SupplierInvitation, *, with_token: bool = False) -> SupplierInvitationOut:
    return SupplierInvitationOut(
        id=invite.id,
        business_id=invite.business_id,
        supplier_id=invite.supplier_id,
        email=invite.email,
        role=invite.role,
        status=invite.status,
        expires_at=invite.expires_at,
        created_at=invite.created_at,
        token=invite.token if with_token else None,
    )


def _supplier(db: Session, supplier_id: str, business_id: str) -> Supplier:
    supplier = db.get(Supplier, supplier_id)
    if supplier is None or supplier.business_id != business_id:
        raise not_found("Supplier not found")
    return supplier


def _check_visible(db: Session, supplier: Supplier, membership, user) -> None:
    allowed = supplier_scope(db, user, membership)
    if allowed is not None and supplier.id not in allowed:
        raise forbidden("This supplier is not linked to your account")


@router.post("/{supplier_id}/invitations", response_model=SupplierInvitationOut, status_code=201)
def invite_supplier(
    supplier_id: str,
    payload: SupplierInviteIn,
    membership=Depends(require_roles("finance_manager")),
    db: Session = Depends(get_db),
):
    """Invite a supplier contact to join the business as a supplier member.

    The invitation is durable and requires an explicit authenticated accept. The
    acceptance token is returned only here so the inviter can share it once.
    """
    supplier = _supplier(db, supplier_id, membership.business_id)
    email = str(payload.email).lower()
    if supplier.email and supplier.email.lower() != email:
        raise bad_request("Invitation email must match the supplier's contact email", "EMAIL_MISMATCH")

    duplicate = db.scalar(
        select(SupplierInvitation).where(
            SupplierInvitation.business_id == membership.business_id,
            SupplierInvitation.email == email,
            SupplierInvitation.status == "pending",
            SupplierInvitation.expires_at > utcnow(),
        )
    )
    if duplicate is not None:
        raise conflict("A supplier invitation is already pending for this email", "INVITE_EXISTS")

    member = db.scalar(
        select(BusinessMember).where(
            BusinessMember.business_id == membership.business_id,
            BusinessMember.email == email,
        )
    )
    if member is not None and member.status == "active":
        raise conflict("This email already belongs to an active member", "MEMBER_EXISTS")
    if member is not None and member.role != "supplier":
        raise conflict("This email already has a different pending invitation", "MEMBER_EXISTS")

    invite = SupplierInvitation(
        business_id=membership.business_id,
        supplier_id=supplier.id,
        email=email,
        role="supplier",
        token=secrets.token_urlsafe(32),
        status="pending",
        invited_by=membership.user_id,
        expires_at=add_seconds(INVITE_TTL_SECONDS),
    )
    db.add(invite)
    # Status "invited" deliberately differs from the account-registration invite
    # status "pending": registering an account must not auto-accept supplier access.
    if member is None:
        db.add(
            BusinessMember(
                business_id=membership.business_id,
                user_id=None,
                email=email,
                role="supplier",
                status="invited",
                invited_by=membership.user_id,
            )
        )
    else:
        member.status = "invited"
        member.invited_by = membership.user_id

    if supplier.email is None:
        supplier.email = email
    audit(
        db, membership.business_id, membership.user_id, "supplier.invited",
        "supplier", supplier.id, {"email": email, "invitation_id": invite.id},
    )
    invited_user = db.scalar(select(User).where(User.email == email))
    if invited_user is not None:
        notify(
            db, membership.business_id, invited_user.id, "Supplier invitation",
            f"You were invited to act as a supplier for {supplier.business_name}.",
            "supplier", invite.id,
        )
    db.commit()
    db.refresh(invite)
    return _invitation_out(invite, with_token=True)


@router.get("/invitations", response_model=list[SupplierInvitationOut])
def list_supplier_invitations(
    membership=Depends(require_roles("finance_manager")),
    db: Session = Depends(get_db),
):
    invites = db.scalars(
        select(SupplierInvitation)
        .where(SupplierInvitation.business_id == membership.business_id)
        .order_by(SupplierInvitation.created_at.desc())
    ).all()
    return [_invitation_out(invite) for invite in invites]


@router.post("/invitations/{token}/accept", response_model=SupplierInvitationAcceptOut)
def accept_supplier_invitation(
    token: str,
    user=Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Accept an invitation; only the invited email address may do so."""
    invite = db.scalar(select(SupplierInvitation).where(SupplierInvitation.token == token))
    if invite is None:
        raise not_found("Supplier invitation not found")
    if invite.status != "pending":
        raise conflict("This invitation is no longer pending", "INVITE_STATE")
    if naive(invite.expires_at) < utcnow():
        invite.status = "expired"
        db.commit()
        raise conflict("This invitation has expired", "INVITE_EXPIRED")
    if user.email.lower() != invite.email.lower():
        raise forbidden("This invitation was sent to a different email address")

    member = db.scalar(
        select(BusinessMember).where(
            BusinessMember.business_id == invite.business_id,
            BusinessMember.email == invite.email,
        )
    )
    if member is None:
        member = BusinessMember(
            business_id=invite.business_id,
            user_id=user.id,
            email=invite.email,
            role="supplier",
            status="active",
            invited_by=invite.invited_by,
        )
        db.add(member)
    else:
        if member.status == "active" and member.user_id not in (None, user.id):
            raise conflict("This email is already linked to another member", "MEMBER_EXISTS")
        member.user_id = user.id
        member.role = "supplier"
        member.status = "active"

    invite.status = "accepted"
    invite.accepted_at = utcnow()
    invite.accepted_by = user.id
    audit(
        db, invite.business_id, user.id, "supplier.invitation_accepted",
        "supplier", invite.supplier_id, {"invitation_id": invite.id},
    )
    notify_business(
        db, invite.business_id, "Supplier invitation accepted",
        f"{invite.email} accepted the supplier invitation.", "supplier", invite.supplier_id,
    )
    db.commit()
    db.refresh(invite)
    return SupplierInvitationAcceptOut(
        id=invite.id,
        business_id=invite.business_id,
        supplier_id=invite.supplier_id,
        email=invite.email,
        status=invite.status,
        role=invite.role,
        accepted_at=invite.accepted_at,
    )


@router.get("", response_model=Page[SupplierOut])
def list_suppliers(
    search: str = "",
    status: str | None = None,
    pagination: Pagination = Depends(),
    user=Depends(get_current_user),
    membership=Depends(get_business_membership),
    db: Session = Depends(get_db),
):
    query = select(Supplier).where(Supplier.business_id == membership.business_id)
    allowed = supplier_scope(db, user, membership)
    if allowed is not None:
        query = query.where(Supplier.id.in_(allowed))
    if search:
        query = query.where(
            or_(
                Supplier.business_name.ilike(f"%{search}%"),
                Supplier.contact_name.ilike(f"%{search}%"),
                Supplier.email.ilike(f"%{search}%"),
            )
        )
    if status:
        query = query.where(Supplier.status == status)
    total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
    rows = db.scalars(query.order_by(Supplier.created_at.desc()).offset(pagination.offset).limit(pagination.per_page)).all()
    return paginate([SupplierOut.model_validate(row) for row in rows], total, pagination)


@router.post("", response_model=SupplierOut, status_code=201)
def create_supplier(
    payload: SupplierCreate,
    membership=Depends(require_roles("finance_manager")),
    db: Session = Depends(get_db),
):
    duplicate = db.scalar(
        select(Supplier).where(
            Supplier.business_id == membership.business_id,
            Supplier.wallet_address == payload.wallet_address,
        )
    )
    if duplicate is not None:
        raise conflict("A supplier with this wallet already exists", "DUPLICATE_WALLET")
    supplier = Supplier(
        business_id=membership.business_id,
        business_name=payload.business_name,
        contact_name=payload.contact_name,
        email=str(payload.email).lower() if payload.email else None,
        phone=payload.phone,
        wallet_address=payload.wallet_address,
        country=payload.country,
        notes=payload.notes,
        status="active",
    )
    db.add(supplier)
    audit(db, membership.business_id, membership.user_id, "supplier.created", "supplier", supplier.id, {"wallet_address": supplier.wallet_address})
    db.commit()
    db.refresh(supplier)
    return supplier


@router.get("/{supplier_id}", response_model=SupplierOut)
def get_supplier(
    supplier_id: str,
    user=Depends(get_current_user),
    membership=Depends(get_business_membership),
    db: Session = Depends(get_db),
):
    supplier = _supplier(db, supplier_id, membership.business_id)
    _check_visible(db, supplier, membership, user)
    return supplier


@router.patch("/{supplier_id}", response_model=SupplierOut)
def update_supplier(
    supplier_id: str,
    payload: SupplierUpdate,
    membership=Depends(require_roles("finance_manager")),
    db: Session = Depends(get_db),
):
    supplier = _supplier(db, supplier_id, membership.business_id)
    updates = payload.model_dump(exclude_unset=True, exclude_none=True)
    if "email" in updates and updates["email"]:
        updates["email"] = str(updates["email"]).lower()
    for field, value in updates.items():
        setattr(supplier, field, value)
    audit(db, membership.business_id, membership.user_id, "supplier.updated", "supplier", supplier.id, updates)
    db.commit()
    db.refresh(supplier)
    return supplier


@router.post("/{supplier_id}/archive", response_model=SupplierOut)
def archive_supplier(
    supplier_id: str,
    membership=Depends(require_roles("owner", "admin")),
    db: Session = Depends(get_db),
):
    supplier = _supplier(db, supplier_id, membership.business_id)
    supplier.status = "archived"
    audit(db, membership.business_id, membership.user_id, "supplier.archived", "supplier", supplier.id)
    db.commit()
    db.refresh(supplier)
    return supplier


@router.get("/{supplier_id}/invoices", response_model=Page[InvoiceOut])
def supplier_invoices(
    supplier_id: str,
    pagination: Pagination = Depends(),
    user=Depends(get_current_user),
    membership=Depends(get_business_membership),
    db: Session = Depends(get_db),
):
    from app.services.invoices import invoice_out, visible_invoice_query

    supplier = _supplier(db, supplier_id, membership.business_id)
    _check_visible(db, supplier, membership, user)
    query = visible_invoice_query(db, membership.business_id, None, None).where(
        Invoice.supplier_id == supplier.id
    )
    total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
    rows = db.scalars(query.order_by(Invoice.created_at.desc()).offset(pagination.offset).limit(pagination.per_page)).all()
    return paginate([invoice_out(db, row) for row in rows], total, pagination)


@router.get("/{supplier_id}/payments", response_model=Page[PaymentOut])
def supplier_payments(
    supplier_id: str,
    pagination: Pagination = Depends(),
    user=Depends(get_current_user),
    membership=Depends(get_business_membership),
    db: Session = Depends(get_db),
):
    supplier = _supplier(db, supplier_id, membership.business_id)
    _check_visible(db, supplier, membership, user)
    query = (
        select(PaymentRecord)
        .join(Invoice, Invoice.id == PaymentRecord.invoice_id)
        .where(
            PaymentRecord.business_id == membership.business_id,
            Invoice.supplier_id == supplier.id,
        )
    )
    total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
    rows = db.scalars(query.order_by(PaymentRecord.created_at.desc()).offset(pagination.offset).limit(pagination.per_page)).all()
    return paginate([PaymentOut.model_validate(row) for row in rows], total, pagination)
