"""Invoice status derivation and serialization from confirmed payment records."""

from __future__ import annotations

from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Invoice, InvoiceItem, PaymentRecord
from app.schemas import InvoiceItemOut, InvoiceOut
from app.utils import money_str, naive, utcnow


def confirmed_total(db: Session, invoice_id: str) -> Decimal:
    value = db.scalar(
        select(func.coalesce(func.sum(PaymentRecord.amount), 0)).where(
            PaymentRecord.invoice_id == invoice_id,
            PaymentRecord.status == "confirmed",
        )
    )
    return Decimal(str(value or 0))


def derived_status(db: Session, invoice: Invoice) -> str:
    """Server-side status; confirmed on-chain payments are the only source of truth."""
    if invoice.status == "cancelled":
        return "cancelled"
    paid = confirmed_total(db, invoice.id)
    total = Decimal(str(invoice.amount))
    if paid >= total and total > 0:
        return "paid"
    if paid > 0:
        return "partially_paid"
    if invoice.status in ("approved", "rejected"):
        return invoice.status
    if invoice.status in ("pending", "partially_paid") and naive(invoice.due_date) < utcnow():
        return "overdue"
    return invoice.status


def visible_invoice_query(db: Session, business_id: str, status, supplier_id):
    query = select(Invoice).where(Invoice.business_id == business_id)
    if supplier_id:
        query = query.where(Invoice.supplier_id == supplier_id)
    return query


def invoice_out(db: Session, invoice: Invoice, *, items: bool = True) -> InvoiceOut:
    invoice_items = (
        db.scalars(select(InvoiceItem).where(InvoiceItem.invoice_id == invoice.id)).all()
        if items
        else []
    )
    return InvoiceOut(
        id=invoice.id,
        business_id=invoice.business_id,
        supplier_id=invoice.supplier_id,
        invoice_number=invoice.invoice_number,
        description=invoice.description,
        amount=money_str(invoice.amount),
        asset_code=invoice.asset_code,
        asset_issuer=invoice.asset_issuer,
        due_date=invoice.due_date,
        reference=invoice.reference,
        status=derived_status(db, invoice),
        amount_paid=money_str(confirmed_total(db, invoice.id)),
        remaining_amount=money_str(
            max(Decimal("0"), Decimal(str(invoice.amount)) - confirmed_total(db, invoice.id))
        ),
        created_at=invoice.created_at,
        items=[
            InvoiceItemOut(
                id=item.id,
                description=item.description,
                quantity=money_str(item.quantity),
                unit_price=money_str(item.unit_price),
            )
            for item in invoice_items
        ],
    )
