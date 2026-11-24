"""Payment agreements, state machine and Soroban escrow milestone releases."""

from __future__ import annotations

import logging

from pathlib import Path
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, File, Form, UploadFile
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import get_settings
from app.database import get_db
from app.errors import bad_request, conflict, forbidden, not_found
from app.models import (
    AgreementMilestone,
    AuditLog,
    BlockchainTransaction,
    Business,
    MilestoneEvidence,
    PaymentAgreement,
    PaymentRecord,
    Supplier,
    User,
)
from app.schemas import (
    AgreementCancel,
    AgreementCreate,
    AgreementFundIn,
    AgreementOut,
    AgreementUpdate,
    EvidenceApproveIn,
    MilestoneEvidenceOut,
    MilestoneOut,
    Page,
    ReleaseIn,
    ReleasePrepareIn,
    issuer_required,
)
from app.security import (
    get_business_membership,
    get_current_user,
    require_business,
    require_roles,
    supplier_scope,
)
from app.services import stellar, verification
from app.services.notifications import audit, notify_business
from app.utils import (
    Pagination,
    money_str,
    next_reference,
    paginate,
    parse_datetime,
    to_decimal,
    utcnow,
)

logger = logging.getLogger(__name__)
settings = get_settings()
router = APIRouter(prefix="/agreements", tags=["agreements"])

EVIDENCE_TYPES = frozenset({"application/pdf", "image/png", "image/jpeg", "text/plain", "text/csv"})
MAX_EVIDENCE_BYTES = 5 * 1024 * 1024


def approved_evidence_exists(db: Session, milestone_id: str) -> bool:
    """Off-chain evidence approval never substitutes for on-chain approval."""
    return (
        db.scalar(
            select(MilestoneEvidence).where(
                MilestoneEvidence.milestone_id == milestone_id,
                MilestoneEvidence.status == "approved",
            )
        )
        is not None
    )


def _agreement(db: Session, agreement_id: str, business_id: str) -> PaymentAgreement:
    agreement = db.get(PaymentAgreement, agreement_id)
    if agreement is None or agreement.business_id != business_id:
        raise not_found("Agreement not found")
    return agreement


def _milestone(db: Session, agreement_id: str, milestone_id: str) -> AgreementMilestone:
    milestone = db.get(AgreementMilestone, milestone_id)
    if milestone is None or milestone.agreement_id != agreement_id:
        raise not_found("Milestone not found")
    return milestone


def _visible(db: Session, agreement: PaymentAgreement, membership, user) -> None:
    allowed = supplier_scope(db, user, membership)
    if allowed is None:
        return
    if agreement.supplier_id not in allowed:
        raise forbidden("This agreement is not linked to your supplier account")


def _linked_supplier(db: Session, agreement: PaymentAgreement, user: User) -> Supplier:
    supplier = db.get(Supplier, agreement.supplier_id)
    if supplier is None or str(supplier.email).lower() != user.email.lower():
        raise forbidden("This agreement is not linked to your supplier account")
    return supplier


def _evidence_out(row: MilestoneEvidence) -> MilestoneEvidenceOut:
    return MilestoneEvidenceOut(
        id=row.id,
        business_id=row.business_id,
        agreement_id=row.agreement_id,
        milestone_id=row.milestone_id,
        supplier_id=row.supplier_id,
        note=row.note,
        url=row.url,
        filename=row.filename,
        content_type=row.content_type,
        size=row.size,
        status=row.status,
        submitted_by=row.submitted_by,
        approved_by=row.approved_by,
        approved_at=row.approved_at,
        created_at=row.created_at,
    )


@router.post("/{agreement_id}/milestones/{milestone_id}/evidence", response_model=MilestoneEvidenceOut, status_code=201)
def submit_milestone_evidence(
    agreement_id: str,
    milestone_id: str,
    note: str | None = Form(default=None, max_length=4000),
    url: str | None = Form(default=None, max_length=2048),
    file: UploadFile | None = File(default=None),
    user: User = Depends(get_current_user),
    membership=Depends(get_business_membership),
    db: Session = Depends(get_db),
):
    """The linked supplier submits proof; the milestone becomes `submitted`."""
    if membership.role != "supplier":
        raise forbidden("Only the linked supplier can submit milestone evidence")
    agreement = _agreement(db, agreement_id, membership.business_id)
    supplier = _linked_supplier(db, agreement, user)
    milestone = _milestone(db, agreement.id, milestone_id)
    if milestone.status not in ("pending", "submitted"):
        raise conflict("Evidence cannot be submitted for this milestone", "MILESTONE_STATE")

    filename = content_type = None
    content = b""
    if url:
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise bad_request("evidence url must be an http(s) URL", "INVALID_URL")
    if file is not None and file.filename:
        filename = Path(file.filename).name
        content_type = (file.content_type or "").split(";", 1)[0].strip().lower()
        if not filename or content_type not in EVIDENCE_TYPES:
            raise bad_request("Unsupported evidence attachment type", "INVALID_FILE_TYPE")
        if Path(filename).suffix.lower() in {".env", ".pem", ".key", ".p12", ".pfx"}:
            raise bad_request("Secret/key files cannot be attached", "INVALID_FILE_TYPE")
        content = file.file.read(MAX_EVIDENCE_BYTES + 1)
        if len(content) > MAX_EVIDENCE_BYTES:
            raise bad_request("Evidence attachment exceeds the 5 MB limit", "FILE_TOO_LARGE")
        if not content:
            raise bad_request("Evidence attachment is empty", "EMPTY_FILE")
        if b"-----BEGIN " in content or b"PRIVATE KEY" in content:
            raise bad_request("Evidence appears to contain a private key", "SECRET_CONTENT")
    if not (note or url or content):
        raise bad_request("Provide evidence text, a URL or an attachment", "MISSING_EVIDENCE")

    evidence = MilestoneEvidence(
        business_id=membership.business_id,
        agreement_id=agreement.id,
        milestone_id=milestone.id,
        supplier_id=supplier.id,
        note=note or None,
        url=url or None,
        filename=filename,
        content_type=content_type,
        content=content or None,
        size=len(content),
        status="submitted",
        submitted_by=user.id,
    )
    db.add(evidence)
    milestone.status = "submitted"
    audit(
        db, membership.business_id, user.id, "milestone.evidence_submitted",
        "agreement_milestone", milestone.id, {"evidence_id": evidence.id},
    )
    notify_business(
        db, membership.business_id, "Milestone evidence submitted",
        f"Milestone {milestone.sort_order + 1} of {agreement.title} has evidence to review.",
        "agreement", agreement.id,
    )
    db.commit()
    db.refresh(evidence)
    return _evidence_out(evidence)


@router.get("/{agreement_id}/milestones/{milestone_id}/evidence", response_model=list[MilestoneEvidenceOut])
def list_milestone_evidence(
    agreement_id: str,
    milestone_id: str,
    user: User = Depends(get_current_user),
    membership=Depends(get_business_membership),
    db: Session = Depends(get_db),
):
    agreement = _agreement(db, agreement_id, membership.business_id)
    _visible(db, agreement, membership, user)
    milestone = _milestone(db, agreement.id, milestone_id)
    rows = db.scalars(
        select(MilestoneEvidence).where(
            MilestoneEvidence.business_id == membership.business_id,
            MilestoneEvidence.agreement_id == agreement.id,
            MilestoneEvidence.milestone_id == milestone.id,
        ).order_by(MilestoneEvidence.created_at.desc())
    ).all()
    return [_evidence_out(row) for row in rows]


@router.post("/{agreement_id}/milestones/{milestone_id}/evidence/{evidence_id}/approve", response_model=MilestoneEvidenceOut)
def approve_milestone_evidence(
    agreement_id: str,
    milestone_id: str,
    evidence_id: str,
    payload: EvidenceApproveIn | None = None,
    membership=Depends(require_roles("finance_manager")),
    db: Session = Depends(get_db),
):
    """Approve the *evidence only*; on-chain approval still needs Soroban."""
    agreement = _agreement(db, agreement_id, membership.business_id)
    milestone = _milestone(db, agreement.id, milestone_id)
    evidence = db.get(MilestoneEvidence, evidence_id)
    if (
        evidence is None
        or evidence.business_id != membership.business_id
        or evidence.agreement_id != agreement.id
        or evidence.milestone_id != milestone.id
    ):
        raise not_found("Evidence not found")
    if evidence.status != "submitted":
        raise conflict("Evidence is no longer awaiting review", "EVIDENCE_STATE")
    if milestone.status != "submitted":
        raise conflict("Milestone is not awaiting evidence review", "MILESTONE_STATE")
    evidence.status = "approved"
    evidence.approved_by = membership.user_id
    evidence.approved_at = utcnow()
    details = {"evidence_id": evidence.id}
    if payload and payload.note:
        details["note"] = payload.note
    audit(
        db, membership.business_id, membership.user_id, "milestone.evidence_approved",
        "agreement_milestone", milestone.id, details,
    )
    notify_business(
        db, membership.business_id, "Milestone evidence approved",
        f"Evidence for milestone {milestone.sort_order + 1} was approved. "
        "On-chain approval is still required before release.",
        "agreement", agreement.id,
    )
    db.commit()
    db.refresh(evidence)
    return _evidence_out(evidence)


def agreement_out(db: Session, agreement: PaymentAgreement) -> AgreementOut:
    milestones = db.scalars(
        select(AgreementMilestone)
        .where(AgreementMilestone.agreement_id == agreement.id)
        .order_by(AgreementMilestone.sort_order)
    ).all()
    return AgreementOut(
        id=agreement.id,
        business_id=agreement.business_id,
        supplier_id=agreement.supplier_id,
        reference=agreement.reference,
        title=agreement.title,
        description=agreement.description,
        total_amount=money_str(agreement.total_amount),
        asset_code=agreement.asset_code,
        asset_issuer=agreement.asset_issuer,
        expiry_date=agreement.expiry_date,
        conditions=agreement.conditions,
        approval_requirements=agreement.approval_requirements,
        status=agreement.status,
        escrow_contract_id=agreement.escrow_contract_id,
        onchain_agreement_id=agreement.onchain_agreement_id,
        funded_amount=money_str(agreement.funded_amount),
        fund_transaction_hash=agreement.fund_transaction_hash,
        cancellation_reason=agreement.cancellation_reason,
        accepted_at=agreement.accepted_at,
        created_at=agreement.created_at,
        milestones=[
            MilestoneOut(
                id=m.id,
                agreement_id=m.agreement_id,
                description=m.description,
                amount=money_str(m.amount),
                due_date=m.due_date,
                status=m.status,
                sort_order=m.sort_order,
                release_transaction_hash=m.release_transaction_hash,
                released_at=m.released_at,
            )
            for m in milestones
        ],
    )


def _create_milestones(db: Session, agreement_id: str, milestones) -> None:
    for index, milestone in enumerate(milestones):
        db.add(
            AgreementMilestone(
                agreement_id=agreement_id,
                description=milestone.description,
                amount=to_decimal(milestone.amount, "amount", positive=True),
                due_date=parse_datetime(milestone.due_date, "due_date"),
                sort_order=index,
                status="pending",
            )
        )


@router.get("", response_model=Page[AgreementOut])
def list_agreements(
    status: str | None = None,
    pagination: Pagination = Depends(),
    user: User = Depends(get_current_user),
    membership=Depends(get_business_membership),
    db: Session = Depends(get_db),
):
    query = select(PaymentAgreement).where(PaymentAgreement.business_id == membership.business_id)
    allowed = supplier_scope(db, user, membership)
    if allowed is not None:
        query = query.where(PaymentAgreement.supplier_id.in_(allowed))
    if status:
        query = query.where(PaymentAgreement.status == status)
    rows = db.scalars(query.order_by(PaymentAgreement.created_at.desc())).all()
    serialized = [agreement_out(db, row) for row in rows]
    items = serialized[pagination.offset : pagination.offset + pagination.per_page]
    return paginate(items, len(serialized), pagination)


@router.post("", response_model=AgreementOut, status_code=201)
def create_agreement(
    payload: AgreementCreate,
    membership=Depends(require_roles("owner", "admin")),
    db: Session = Depends(get_db),
):
    supplier = db.get(Supplier, payload.supplier_id)
    if supplier is None or supplier.business_id != membership.business_id:
        raise not_found("Supplier not found in this business")
    agreement = PaymentAgreement(
        business_id=membership.business_id,
        supplier_id=supplier.id,
        reference=next_reference(db, PaymentAgreement, PaymentAgreement.reference, "AGR"),
        title=payload.title,
        description=payload.description,
        total_amount=to_decimal(payload.total_amount, "total_amount", positive=True),
        asset_code=payload.asset_code.upper(),
        asset_issuer=payload.asset_issuer,
        expiry_date=parse_datetime(payload.expiry_date, "expiry_date"),
        conditions=payload.conditions,
        approval_requirements=payload.approval_requirements,
        status="draft",
        created_by=membership.user_id,
    )
    db.add(agreement)
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise conflict(
            "Agreement reference was claimed concurrently; retry the request", "REFERENCE_CONFLICT"
        ) from exc
    _create_milestones(db, agreement.id, payload.milestones)
    audit(db, membership.business_id, membership.user_id, "agreement.created", "agreement", agreement.id, {"reference": agreement.reference})
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise conflict(
            "Agreement reference was claimed concurrently; retry the request", "REFERENCE_CONFLICT"
        ) from exc
    db.refresh(agreement)
    return agreement_out(db, agreement)


@router.get("/{agreement_id}", response_model=AgreementOut)
def get_agreement(
    agreement_id: str,
    user: User = Depends(get_current_user),
    membership=Depends(get_business_membership),
    db: Session = Depends(get_db),
):
    agreement = _agreement(db, agreement_id, membership.business_id)
    _visible(db, agreement, membership, user)
    return agreement_out(db, agreement)


@router.patch("/{agreement_id}", response_model=AgreementOut)
def update_agreement(
    agreement_id: str,
    payload: AgreementUpdate,
    membership=Depends(require_roles("owner", "admin")),
    db: Session = Depends(get_db),
):
    agreement = _agreement(db, agreement_id, membership.business_id)
    if agreement.status != "draft":
        raise conflict("Only draft agreements can be edited", "AGREEMENT_NOT_DRAFT")
    updates = payload.model_dump(exclude_unset=True, exclude_none=True)
    milestones = updates.pop("milestones", None)
    total = to_decimal(updates["total_amount"], "total_amount", positive=True) if "total_amount" in updates else to_decimal(agreement.total_amount)
    if milestones is not None:
        from decimal import Decimal

        if sum((to_decimal(m.amount) for m in milestones), Decimal("0")) != total:
            raise bad_request("Milestone amounts must sum exactly to total_amount", "MILESTONE_SUM")
    if "total_amount" in updates:
        updates["total_amount"] = total
    if issuer_required(
        updates.get("asset_code", agreement.asset_code),
        updates.get("asset_issuer", agreement.asset_issuer),
    ):
        raise bad_request("asset_issuer is required for non-XLM assets", "INVALID_ASSET")
    for field, value in updates.items():
        if field == "expiry_date":
            value = parse_datetime(value, "expiry_date")
        if field == "asset_code":
            value = value.upper()
        setattr(agreement, field, value)
    if milestones is not None:
        db.query(AgreementMilestone).filter(AgreementMilestone.agreement_id == agreement.id).delete()
        _create_milestones(db, agreement.id, milestones)
    audit(db, membership.business_id, membership.user_id, "agreement.updated", "agreement", agreement.id, list(updates))
    db.commit()
    db.refresh(agreement)
    return agreement_out(db, agreement)


@router.post("/{agreement_id}/submit", response_model=AgreementOut)
def submit_agreement(
    agreement_id: str,
    membership=Depends(require_roles("owner", "admin")),
    db: Session = Depends(get_db),
):
    agreement = _agreement(db, agreement_id, membership.business_id)
    if agreement.status != "draft":
        raise conflict("Only draft agreements can be submitted", "AGREEMENT_NOT_DRAFT")
    if parse_datetime(agreement.expiry_date) < utcnow():
        raise bad_request("An expired agreement cannot be submitted", "AGREEMENT_EXPIRED")
    agreement.status = "awaiting_acceptance"
    audit(db, membership.business_id, membership.user_id, "agreement.submitted", "agreement", agreement.id)
    db.commit()
    db.refresh(agreement)
    return agreement_out(db, agreement)


@router.post("/{agreement_id}/accept", response_model=AgreementOut)
def accept_agreement(
    agreement_id: str,
    membership=Depends(get_business_membership),
    db: Session = Depends(get_db),
):
    if membership.role != "supplier":
        raise forbidden("Only the linked supplier can accept an agreement")
    agreement = _agreement(db, agreement_id, membership.business_id)
    supplier = db.get(Supplier, agreement.supplier_id)
    if supplier is None or str(supplier.email).lower() != membership.email.lower():
        raise forbidden("This agreement is not linked to your supplier profile")
    if agreement.status != "awaiting_acceptance":
        raise conflict("Agreement is not awaiting acceptance", "AGREEMENT_STATE")
    if parse_datetime(agreement.expiry_date) < utcnow():
        raise bad_request("An expired agreement cannot be accepted", "AGREEMENT_EXPIRED")
    agreement.status = "active"
    agreement.accepted_at = utcnow()
    audit(db, membership.business_id, membership.user_id, "agreement.accepted", "agreement", agreement.id)
    db.commit()
    db.refresh(agreement)
    return agreement_out(db, agreement)


@router.post("/{agreement_id}/reject", response_model=AgreementOut)
def reject_agreement(
    agreement_id: str,
    payload: AgreementCancel | None = None,
    membership=Depends(get_business_membership),
    db: Session = Depends(get_db),
):
    """The linked supplier declines an agreement offered for acceptance."""
    if membership.role != "supplier":
        raise forbidden("Only the linked supplier can reject an agreement")
    agreement = _agreement(db, agreement_id, membership.business_id)
    supplier = db.get(Supplier, agreement.supplier_id)
    if supplier is None or str(supplier.email).lower() != membership.email.lower():
        raise forbidden("This agreement is not linked to your supplier profile")
    if agreement.status != "awaiting_acceptance":
        raise conflict("Agreement is not awaiting acceptance", "AGREEMENT_STATE")
    reason = payload.reason if payload else "Rejected by supplier"
    agreement.status = "cancelled"
    agreement.cancellation_reason = f"Rejected by supplier: {reason}"
    audit(db, membership.business_id, membership.user_id, "agreement.rejected", "agreement", agreement.id, {"reason": reason})
    db.commit()
    db.refresh(agreement)
    return agreement_out(db, agreement)


@router.post("/{agreement_id}/cancel", response_model=AgreementOut)
def cancel_agreement(
    agreement_id: str,
    payload: AgreementCancel | None = None,
    membership=Depends(require_roles("owner", "admin")),
    db: Session = Depends(get_db),
):
    agreement = _agreement(db, agreement_id, membership.business_id)
    if agreement.status in ("completed", "cancelled"):
        raise conflict("Agreement is already final", "AGREEMENT_STATE")
    released = db.scalar(
        select(AgreementMilestone).where(
            AgreementMilestone.agreement_id == agreement.id,
            AgreementMilestone.status == "released",
        )
    )
    if released is not None:
        raise conflict("An agreement with released milestones cannot be cancelled", "MILESTONE_RELEASED")
    reason = payload.reason if payload else "Cancelled by business"
    agreement.status = "cancelled"
    agreement.cancellation_reason = reason
    audit(db, membership.business_id, membership.user_id, "agreement.cancelled", "agreement", agreement.id, {"reason": reason})
    db.commit()
    db.refresh(agreement)
    return agreement_out(db, agreement)


@router.post("/{agreement_id}/dispute", response_model=AgreementOut)
def dispute_agreement(
    agreement_id: str,
    user: User = Depends(get_current_user),
    membership=Depends(get_business_membership),
    db: Session = Depends(get_db),
):
    if membership.role not in ("owner", "admin", "supplier"):
        raise forbidden("Your role cannot dispute agreements")
    agreement = _agreement(db, agreement_id, membership.business_id)
    _visible(db, agreement, membership, user)
    if agreement.status != "active":
        raise conflict("Only active agreements can be disputed", "AGREEMENT_STATE")
    agreement.status = "disputed"
    audit(db, membership.business_id, membership.user_id, "agreement.disputed", "agreement", agreement.id)
    db.commit()
    db.refresh(agreement)
    return agreement_out(db, agreement)
