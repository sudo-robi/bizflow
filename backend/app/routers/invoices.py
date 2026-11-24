"""Invoice CRUD, server-derived statuses and professional PDF generation."""

from __future__ import annotations

import re
from pathlib import Path

from fastapi import APIRouter, Depends, File, Response, UploadFile
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import get_db
from app.errors import bad_request, conflict, forbidden, not_found
from app.models import Business, Invoice, InvoiceAttachment, InvoiceItem, Supplier
from app.schemas import (
    InvoiceAttachmentOut,
    InvoiceCreate,
    InvoiceDecisionIn,
    InvoiceOut,
    InvoiceUpdate,
    Page,
    issuer_required,
)
from app.security import (
    get_business_membership,
    get_current_user,
    require_roles,
    supplier_scope,
)
from app.services.invoices import confirmed_total, derived_status, invoice_out, visible_invoice_query
from app.services.notifications import audit, notify_business
from app.services.receipts import build_invoice_pdf
from app.utils import Pagination, money_str, next_reference, paginate, parse_datetime, to_decimal, utcnow

MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
ALLOWED_ATTACHMENT_TYPES = frozenset(
    {
        "application/pdf",
        "image/png",
        "image/jpeg",
        "text/plain",
        "text/csv",
        "application/csv",
    }
)
SECRET_FILE_SUFFIXES = frozenset({".env", ".pem", ".key", ".p12", ".pfx", ".secret"})
SAFE_FILENAME = re.compile(r"^[\w.()\- ]+$")

router = APIRouter(prefix="/invoices", tags=["invoices"])


def _invoice(db: Session, invoice_id: str, business_id: str) -> Invoice:
    invoice = db.get(Invoice, invoice_id)
    if invoice is None or invoice.business_id != business_id:
        raise not_found("Invoice not found")
    return invoice


def _check_visible(db: Session, invoice: Invoice, membership, user) -> None:
    allowed = supplier_scope(db, user, membership)
    if allowed is None:
        return
    supplier = db.get(Supplier, invoice.supplier_id)
    if supplier is None or supplier.id not in allowed:
        raise forbidden("This invoice is not linked to your supplier account")


@router.get("", response_model=Page[InvoiceOut])
def list_invoices(
    status: str | None = None,
    supplier_id: str | None = None,
    pagination: Pagination = Depends(),
    user=Depends(get_current_user),
    membership=Depends(get_business_membership),
    db: Session = Depends(get_db),
):
    query = visible_invoice_query(db, membership.business_id, status, supplier_id)
    allowed = supplier_scope(db, user, membership)
    if allowed is not None:
        query = query.where(Invoice.supplier_id.in_(allowed))
    rows = db.scalars(query.order_by(Invoice.created_at.desc())).all()
    serialized = [invoice_out(db, row) for row in rows]
    if status:
        serialized = [row for row in serialized if row.status == status]
    total = len(serialized)
    items = serialized[pagination.offset : pagination.offset + pagination.per_page]
    return paginate(items, total, pagination)


@router.post("", response_model=InvoiceOut, status_code=201)
def create_invoice(
    payload: InvoiceCreate,
    membership=Depends(require_roles("finance_manager")),
    db: Session = Depends(get_db),
):
    supplier = db.get(Supplier, payload.supplier_id)
    if supplier is None or supplier.business_id != membership.business_id:
        raise not_found("Supplier not found in this business")
    if supplier.status != "active":
        raise bad_request("Cannot invoice an archived supplier", "SUPPLIER_ARCHIVED")
    invoice = Invoice(
        business_id=membership.business_id,
        supplier_id=supplier.id,
        invoice_number=next_reference(db, Invoice, Invoice.invoice_number, "INV"),
        description=payload.description,
        amount=to_decimal(payload.amount, "amount", positive=True),
        asset_code=payload.asset_code.upper(),
        asset_issuer=payload.asset_issuer,
        due_date=parse_datetime(payload.due_date, "due_date"),
        reference=payload.reference,
        status="draft",
        created_by=membership.user_id,
    )
    db.add(invoice)
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise conflict(
            "Invoice number was claimed concurrently; retry the request", "REFERENCE_CONFLICT"
        ) from exc
    for item in payload.items:
        db.add(
            InvoiceItem(
                invoice_id=invoice.id,
                description=item.description,
                quantity=to_decimal(item.quantity, "quantity", positive=True),
                unit_price=to_decimal(item.unit_price, "unit_price"),
            )
        )
    audit(db, membership.business_id, membership.user_id, "invoice.created", "invoice", invoice.id, {"number": invoice.invoice_number})
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise conflict(
            "Invoice number was claimed concurrently; retry the request", "REFERENCE_CONFLICT"
        ) from exc
    db.refresh(invoice)
    return invoice_out(db, invoice)


@router.get("/{invoice_id}", response_model=InvoiceOut)
def get_invoice(
    invoice_id: str,
    user=Depends(get_current_user),
    membership=Depends(get_business_membership),
    db: Session = Depends(get_db),
):
    invoice = _invoice(db, invoice_id, membership.business_id)
    _check_visible(db, invoice, membership, user)
    return invoice_out(db, invoice)


@router.patch("/{invoice_id}", response_model=InvoiceOut)
def update_invoice(
    invoice_id: str,
    payload: InvoiceUpdate,
    membership=Depends(require_roles("finance_manager")),
    db: Session = Depends(get_db),
):
    invoice = _invoice(db, invoice_id, membership.business_id)
    if derived_status(db, invoice) not in ("draft", "pending"):
        raise conflict("Only draft or pending invoices can be edited", "INVOICE_NOT_EDITABLE")
    updates = payload.model_dump(exclude_unset=True, exclude_none=True)
    if "amount" in updates:
        updates["amount"] = to_decimal(updates["amount"], "amount", positive=True)
    if "due_date" in updates:
        updates["due_date"] = parse_datetime(updates["due_date"], "due_date")
    if "asset_code" in updates:
        updates["asset_code"] = updates["asset_code"].upper()
    if issuer_required(
        updates.get("asset_code", invoice.asset_code),
        updates.get("asset_issuer", invoice.asset_issuer),
    ):
        raise bad_request("asset_issuer is required for non-XLM assets", "INVALID_ASSET")
    for field, value in updates.items():
        setattr(invoice, field, value)
    audit(db, membership.business_id, membership.user_id, "invoice.updated", "invoice", invoice.id, list(updates))
    db.commit()
    db.refresh(invoice)
    return invoice_out(db, invoice)


@router.post("/{invoice_id}/submit", response_model=InvoiceOut)
def submit_invoice(
    invoice_id: str,
    membership=Depends(require_roles("finance_manager")),
    db: Session = Depends(get_db),
):
    invoice = _invoice(db, invoice_id, membership.business_id)
    if invoice.status != "draft":
        raise conflict("Only draft invoices can be submitted", "INVOICE_NOT_DRAFT")
    invoice.status = "pending"
    audit(db, membership.business_id, membership.user_id, "invoice.submitted", "invoice", invoice.id)
    notify_business(
        db, membership.business_id, "Invoice submitted for approval",
        f"Invoice {invoice.invoice_number} is awaiting review.", "invoice", invoice.id,
    )
    db.commit()
    db.refresh(invoice)
    return invoice_out(db, invoice)


@router.post("/{invoice_id}/approve", response_model=InvoiceOut)
def approve_invoice(
    invoice_id: str,
    payload: InvoiceDecisionIn | None = None,
    membership=Depends(require_roles("finance_manager")),
    db: Session = Depends(get_db),
):
    """Authorized finance staff approve a submitted invoice (server-derived status)."""
    invoice = _invoice(db, invoice_id, membership.business_id)
    if invoice.status != "pending":
        raise conflict("Only pending invoices can be approved", "INVOICE_NOT_PENDING")
    invoice.status = "approved"
    details = {"reason": payload.reason} if payload and payload.reason else None
    audit(db, membership.business_id, membership.user_id, "invoice.approved", "invoice", invoice.id, details)
    notify_business(
        db, membership.business_id, "Invoice approved",
        f"Invoice {invoice.invoice_number} was approved for payment.", "invoice", invoice.id,
    )
    db.commit()
    db.refresh(invoice)
    return invoice_out(db, invoice)


@router.post("/{invoice_id}/reject", response_model=InvoiceOut)
def reject_invoice(
    invoice_id: str,
    payload: InvoiceDecisionIn | None = None,
    membership=Depends(require_roles("finance_manager")),
    db: Session = Depends(get_db),
):
    """Reject a submitted invoice, keeping the reason in the audit trail."""
    invoice = _invoice(db, invoice_id, membership.business_id)
    if invoice.status != "pending":
        raise conflict("Only pending invoices can be rejected", "INVOICE_NOT_PENDING")
    reason = (payload.reason if payload else None) or "Rejected by reviewer"
    invoice.status = "rejected"
    details = {"reason": reason}
    audit(db, membership.business_id, membership.user_id, "invoice.rejected", "invoice", invoice.id, details)
    notify_business(
        db, membership.business_id, "Invoice rejected",
        f"Invoice {invoice.invoice_number} was rejected: {reason}", "invoice", invoice.id,
    )
    db.commit()
    db.refresh(invoice)
    return invoice_out(db, invoice)


@router.post("/{invoice_id}/cancel", response_model=InvoiceOut)
def cancel_invoice(
    invoice_id: str,
    membership=Depends(require_roles("finance_manager")),
    db: Session = Depends(get_db),
):
    invoice = _invoice(db, invoice_id, membership.business_id)
    if confirmed_total(db, invoice.id) > 0:
        raise conflict("An invoice with a confirmed payment cannot be cancelled", "PAID_INVOICE")
    invoice.status = "cancelled"
    audit(db, membership.business_id, membership.user_id, "invoice.cancelled", "invoice", invoice.id)
    db.commit()
    db.refresh(invoice)
    return invoice_out(db, invoice)


@router.get("/{invoice_id}/pdf")
def invoice_pdf(
    invoice_id: str,
    user=Depends(get_current_user),
    membership=Depends(get_business_membership),
    db: Session = Depends(get_db),
):
    invoice = _invoice(db, invoice_id, membership.business_id)
    _check_visible(db, invoice, membership, user)
    business = db.get(Business, membership.business_id)
    supplier = db.get(Supplier, invoice.supplier_id)
    items = db.scalars(select(InvoiceItem).where(InvoiceItem.invoice_id == invoice.id)).all()
    pdf = build_invoice_pdf(invoice, supplier, business, items)
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{invoice.invoice_number}.pdf"'},
    )


def _safe_upload(upload: UploadFile) -> tuple[str, str, bytes]:
    filename = Path(upload.filename or "").name
    if not filename or not SAFE_FILENAME.fullmatch(filename):
        raise bad_request("Invalid attachment filename", "INVALID_FILENAME")
    if Path(filename).suffix.lower() in SECRET_FILE_SUFFIXES:
        raise bad_request("Secret/key files cannot be attached", "INVALID_FILE_TYPE")
    content_type = (upload.content_type or "").split(";", 1)[0].strip().lower()
    if content_type not in ALLOWED_ATTACHMENT_TYPES:
        raise bad_request("Unsupported attachment type", "INVALID_FILE_TYPE")
    content = upload.file.read(MAX_ATTACHMENT_BYTES + 1)
    if len(content) > MAX_ATTACHMENT_BYTES:
        raise bad_request("Attachment exceeds the 5 MB limit", "FILE_TOO_LARGE")
    if not content:
        raise bad_request("Attachment is empty", "EMPTY_FILE")
    if b"-----BEGIN " in content or b"SECRET_KEY=" in content or b"PRIVATE KEY" in content:
        raise bad_request("Attachment appears to contain a private key or secret", "SECRET_CONTENT")
    return filename, content_type, content


@router.post("/{invoice_id}/attachments", response_model=InvoiceAttachmentOut, status_code=201)
def upload_invoice_attachment(
    invoice_id: str,
    file: UploadFile = File(...),
    user=Depends(get_current_user),
    membership=Depends(require_roles("finance_manager")),
    db: Session = Depends(get_db),
):
    """Persist an invoice document with an explicit invoice/business binding."""
    invoice = _invoice(db, invoice_id, membership.business_id)
    _check_visible(db, invoice, membership, user)
    filename, content_type, content = _safe_upload(file)
    attachment = InvoiceAttachment(
        business_id=membership.business_id,
        invoice_id=invoice.id,
        filename=filename,
        content_type=content_type,
        size=len(content),
        content=content,
        uploaded_by=membership.user_id,
    )
    db.add(attachment)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise conflict("Attachment could not be stored", "ATTACHMENT_CONFLICT") from exc
    db.refresh(attachment)
    audit(
        db, membership.business_id, membership.user_id, "invoice.attachment_uploaded",
        "invoice", invoice.id, {"attachment_id": attachment.id, "filename": filename},
    )
    db.commit()
    return InvoiceAttachmentOut.model_validate(attachment)


@router.get("/{invoice_id}/attachments", response_model=list[InvoiceAttachmentOut])
def list_invoice_attachments(
    invoice_id: str,
    user=Depends(get_current_user),
    membership=Depends(get_business_membership),
    db: Session = Depends(get_db),
):
    invoice = _invoice(db, invoice_id, membership.business_id)
    _check_visible(db, invoice, membership, user)
    rows = db.scalars(
        select(InvoiceAttachment)
        .where(
            InvoiceAttachment.invoice_id == invoice.id,
            InvoiceAttachment.business_id == membership.business_id,
        )
        .order_by(InvoiceAttachment.created_at.desc())
    ).all()
    return [InvoiceAttachmentOut.model_validate(row) for row in rows]


@router.get("/{invoice_id}/attachments/{attachment_id}/download")
def download_invoice_attachment(
    invoice_id: str,
    attachment_id: str,
    user=Depends(get_current_user),
    membership=Depends(get_business_membership),
    db: Session = Depends(get_db),
):
    invoice = _invoice(db, invoice_id, membership.business_id)
    _check_visible(db, invoice, membership, user)
    attachment = db.get(InvoiceAttachment, attachment_id)
    if (
        attachment is None
        or attachment.invoice_id != invoice.id
        or attachment.business_id != membership.business_id
    ):
        raise not_found("Attachment not found")
    return Response(
        content=bytes(attachment.content),
        media_type=attachment.content_type,
        headers={
            "Content-Disposition": f'attachment; filename="{attachment.filename}"',
            "Content-Length": str(attachment.size),
        },
    )
