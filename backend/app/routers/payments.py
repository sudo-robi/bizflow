"""Ordinary Stellar payments: prepare, submit, verify and receipts."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.database import get_db
from app.errors import bad_request, conflict, forbidden, not_found
from app.models import (
    BlockchainTransaction,
    Business,
    Invoice,
    PaymentRecord,
    Supplier,
    User,
)
from app.schemas import (
    Page,
    PaymentOut,
    PaymentPrepareIn,
    PaymentPreparedOut,
    PaymentSubmitIn,
    PreparedXdrOut,
)
from app.security import (
    get_business_membership,
    get_current_user,
    require_roles,
    supplier_scope,
)
from app.services import stellar, verification
from app.services.verification import VerificationResult
from app.services.invoices import confirmed_total, derived_status, invoice_out
from app.services.notifications import audit, notify_business
from app.services.receipts import build_receipt_pdf
from app.utils import Pagination, add_seconds, money_str, naive, paginate, to_decimal, utcnow

settings = get_settings()
router = APIRouter(prefix="/payments", tags=["payments"])


def _payment(db: Session, payment_id: str, business_id: str) -> PaymentRecord:
    payment = db.get(PaymentRecord, payment_id)
    if payment is None or payment.business_id != business_id:
        raise not_found("Payment not found")
    return payment


def _record_failed(db: Session, business_id: str, submitted, payment_id: str) -> None:
    """Persist failed/unconfirmed ledger outcomes; they never credit an invoice."""
    if verification.hash_already_used(db, submitted.hash):
        return
    result = VerificationResult(
        hash=submitted.hash,
        confirmed=submitted.confirmed,
        successful=False,
        settled=False,
        status=submitted.status,
        ledger=submitted.ledger,
        source_account=submitted.source_account,
        destination_account=None,
        asset_code=None,
        asset_issuer=None,
        amount=None,
        memo=None,
        network="testnet",
        reason=submitted.reason,
    )
    verification.record_transaction(db, business_id, result, payment_id)


def _visible(db: Session, payment: PaymentRecord, membership, user) -> None:
    allowed = supplier_scope(db, user, membership)
    if allowed is None:
        return
    if not payment.invoice_id:
        raise forbidden("This payment is not linked to your supplier account")
    invoice = db.get(Invoice, payment.invoice_id)
    if invoice is None or invoice.supplier_id not in allowed:
        raise forbidden("This payment is not linked to your supplier account")


@router.get("", response_model=Page[PaymentOut])
def list_payments(
    status: str | None = None,
    pagination: Pagination = Depends(),
    user: User = Depends(get_current_user),
    membership=Depends(get_business_membership),
    db: Session = Depends(get_db),
):
    query = select(PaymentRecord).where(PaymentRecord.business_id == membership.business_id)
    allowed = supplier_scope(db, user, membership)
    if allowed is not None:
        query = query.where(PaymentRecord.invoice_id.in_(select(Invoice.id).where(Invoice.supplier_id.in_(allowed))))
    if status:
        query = query.where(PaymentRecord.status == status)
    total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
    rows = db.scalars(
        query.order_by(PaymentRecord.created_at.desc()).offset(pagination.offset).limit(pagination.per_page)
    ).all()
    return paginate([PaymentOut.model_validate(row) for row in rows], total, pagination)


@router.post("/prepare", response_model=PaymentPreparedOut, status_code=201)
def prepare_payment(
    payload: PaymentPrepareIn,
    membership=Depends(require_roles("finance_manager")),
    db: Session = Depends(get_db),
):
    invoice = db.get(Invoice, payload.invoice_id)
    if invoice is None or invoice.business_id != membership.business_id:
        raise not_found("Invoice not found")
    state = derived_status(db, invoice)
    if state in ("cancelled", "paid"):
        raise conflict(f"Cannot prepare a payment for a {state} invoice", "INVOICE_STATE")
    supplier = db.get(Supplier, invoice.supplier_id)
    if supplier is None:
        raise not_found("Supplier not found")

    outstanding = to_decimal(invoice.amount) - confirmed_total(db, invoice.id)
    if outstanding <= 0:
        raise conflict("This invoice is already fully settled", "INVOICE_SETTLED")
    amount = to_decimal(payload.amount, "amount", positive=True) if payload.amount else outstanding
    if amount > outstanding:
        raise bad_request(
            f"Payment amount exceeds the outstanding balance ({money_str(outstanding)})",
            "OVERPAYMENT",
        )

    duplicate = db.scalar(
        select(PaymentRecord).where(
            PaymentRecord.invoice_id == invoice.id,
            PaymentRecord.amount == amount,
            PaymentRecord.status != "failed",
        )
    )
    if duplicate is not None:
        raise conflict("A payment for this invoice amount is already prepared", "DUPLICATE_PAYMENT")

    prepared = stellar.build_payment_xdr(
        source_account=payload.source_account,
        destination=supplier.wallet_address,
        amount_str=money_str(amount),
        asset_code=invoice.asset_code,
        asset_issuer=invoice.asset_issuer,
        memo=invoice.invoice_number,
    )
    payment = PaymentRecord(
        business_id=membership.business_id,
        invoice_id=invoice.id,
        kind="ordinary",
        amount=amount,
        asset_code=invoice.asset_code,
        asset_issuer=invoice.asset_issuer,
        source_account=payload.source_account,
        destination_account=supplier.wallet_address,
        memo=invoice.invoice_number,
        xdr=prepared.xdr,
        hash=prepared.hash,
        status="prepared",
        expires_at=add_seconds(settings.prepare_expires_minutes * 60),
        prepared_by=membership.user_id,
    )
    db.add(payment)
    audit(db, membership.business_id, membership.user_id, "payment.prepared", "payment", payment.id, {"hash": prepared.hash})
    db.commit()
    return PaymentPreparedOut(
        payment_id=payment.id, xdr=prepared.xdr, hash=prepared.hash, expires_at=payment.expires_at
    )


@router.post("/{payment_id}/submit", response_model=PaymentOut)
def submit_payment(
    payment_id: str,
    payload: PaymentSubmitIn,
    membership=Depends(require_roles("finance_manager")),
    db: Session = Depends(get_db),
):
    payment = _payment(db, payment_id, membership.business_id)
    if payment.status != "prepared":
        raise conflict("Payment is no longer awaiting submission", "PAYMENT_STATE")
    if payment.expires_at and naive(payment.expires_at) < utcnow():
        payment.status = "failed"
        payment.failure_reason = "Prepared transaction expired"
        db.commit()
        raise conflict("Prepared transaction has expired; prepare a new payment", "EXPIRED_XDR")

    signed_hash = stellar.transaction_hash(payload.signed_xdr)
    if signed_hash != payment.hash:
        raise bad_request("Signed transaction hash does not match the prepared payment", "HASH_MISMATCH")

    submitted = stellar.submit_transaction(payload.signed_xdr)
    if not (submitted.confirmed and submitted.successful):
        payment.status = "failed"
        payment.failure_reason = submitted.reason
        _record_failed(db, membership.business_id, submitted, payment.id)
        audit(db, membership.business_id, membership.user_id, "payment.failed", "payment", payment.id, {"hash": submitted.hash})
        db.commit()
        raise conflict(submitted.reason or "Transaction was not confirmed on-chain", "UNCONFIRMED_TX")

    verified = verification.verify_stellar_payment(
        submitted.hash,
        expected={
            "source_account": payment.source_account,
            "destination_account": payment.destination_account,
            "asset_code": payment.asset_code,
            "asset_issuer": payment.asset_issuer,
            "amount": payment.amount,
            "memo": payment.memo,
        },
    )
    if not verified.settled:
        payment.status = "failed"
        payment.failure_reason = verified.reason
        if not verification.hash_already_used(db, verified.hash):
            verification.record_transaction(db, membership.business_id, verified, payment.id)
        db.commit()
        raise conflict(verified.reason or "Payment could not be independently verified", "UNVERIFIED_TX")

    verification.record_transaction(db, membership.business_id, verified, payment.id)
    payment.status = "confirmed"
    payment.confirmed_at = utcnow()
    if payment.invoice_id:
        invoice = db.get(Invoice, payment.invoice_id)
        paid = confirmed_total(db, invoice.id)
        total = to_decimal(invoice.amount)
        invoice.status = "paid" if paid >= total else "partially_paid"
    audit(
        db, membership.business_id, membership.user_id, "payment.confirmed", "payment", payment.id,
        {"hash": verified.hash, "amount": money_str(payment.amount)},
    )
    notify_business(
        db, membership.business_id, "Payment confirmed",
        f"Payment of {money_str(payment.amount)} {payment.asset_code} was verified on-chain.",
        "payment", payment.id,
    )
    db.commit()
    db.refresh(payment)
    return PaymentOut.model_validate(payment)


@router.get("/{payment_id}/prepared-xdr", response_model=PreparedXdrOut)
def get_prepared_xdr(
    payment_id: str,
    user: User = Depends(get_current_user),
    membership=Depends(get_business_membership),
    db: Session = Depends(get_db),
):
    """Return the stored XDR for a *prepared* payment in the caller's business.

    Confirmed/failed XDRs are never reused as new transaction material.
    """
    payment = _payment(db, payment_id, membership.business_id)
    _visible(db, payment, membership, user)
    if payment.status != "prepared":
        raise conflict("Only prepared payments expose a signing XDR", "PAYMENT_NOT_PREPARED")
    if payment.expires_at and naive(payment.expires_at) < utcnow():
        raise conflict("Prepared transaction has expired; prepare a new payment", "EXPIRED_XDR")
    return PreparedXdrOut(
        payment_id=payment.id,
        xdr=payment.xdr,
        hash=payment.hash,
        status=payment.status,
        expires_at=payment.expires_at,
    )


@router.get("/{payment_id}", response_model=PaymentOut)
def get_payment(
    payment_id: str,
    user: User = Depends(get_current_user),
    membership=Depends(get_business_membership),
    db: Session = Depends(get_db),
):
    payment = _payment(db, payment_id, membership.business_id)
    _visible(db, payment, membership, user)
    return PaymentOut.model_validate(payment)


@router.get("/{payment_id}/receipt")
def payment_receipt(
    payment_id: str,
    user: User = Depends(get_current_user),
    membership=Depends(get_business_membership),
    db: Session = Depends(get_db),
):
    payment = _payment(db, payment_id, membership.business_id)
    _visible(db, payment, membership, user)
    if payment.status != "confirmed":
        raise conflict("A receipt is available only for verified payments", "PAYMENT_NOT_CONFIRMED")
    invoice = db.get(Invoice, payment.invoice_id) if payment.invoice_id else None
    supplier = db.get(Supplier, invoice.supplier_id) if invoice else None
    business = db.get(Business, membership.business_id)
    chain = db.scalar(
        select(BlockchainTransaction).where(BlockchainTransaction.payment_record_id == payment.id)
    )
    receipt = build_receipt_pdf(
        {
            "receipt_id": f"RCP-{payment.id[:8].upper()}",
            "payment_id": payment.id,
            "invoice_number": invoice.invoice_number if invoice else "-",
            "business_name": business.name,
            "supplier_name": supplier.business_name if supplier else "-",
            "amount": money_str(payment.amount),
            "asset_code": payment.asset_code,
            "asset_issuer": payment.asset_issuer,
            "source_account": payment.source_account,
            "destination_account": payment.destination_account,
            "memo": payment.memo,
            "hash": payment.hash,
            "ledger": chain.ledger if chain else None,
            "network": chain.network if chain else "testnet",
            "status": payment.status,
            "confirmed_at": payment.confirmed_at,
            "verified": bool(chain and chain.successful),
        }
    )
    return Response(
        content=receipt,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="receipt-{payment.id[:8]}.pdf"'},
    )
