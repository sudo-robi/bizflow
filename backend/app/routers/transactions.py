"""Blockchain transaction history, independent verification and public receipts."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.database import get_db
from app.errors import conflict, not_found
from app.models import BlockchainTransaction, Business, Invoice, PaymentRecord
from app.schemas import Page, PublicReceiptOut, TransactionOut, VerificationOut, VerifyIn
from app.security import get_business_membership
from app.services import verification
from app.utils import Pagination, paginate

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/transactions", tags=["transactions"])
public_router = APIRouter(prefix="/verify", tags=["verification"])


@router.get("", response_model=Page[TransactionOut])
def list_transactions(
    pagination: Pagination = Depends(),
    membership=Depends(get_business_membership),
    db: Session = Depends(get_db),
):
    base = select(BlockchainTransaction).where(
        BlockchainTransaction.business_id == membership.business_id
    )
    total = db.scalar(select(func.count()).select_from(base.subquery())) or 0
    rows = db.scalars(
        base.order_by(BlockchainTransaction.created_at.desc())
        .offset(pagination.offset)
        .limit(pagination.per_page)
    ).all()
    return paginate([TransactionOut.model_validate(row) for row in rows], total, pagination)


@router.get("/{tx_hash}")
def get_transaction(
    tx_hash: str,
    membership=Depends(get_business_membership),
    db: Session = Depends(get_db),
):
    record = db.scalar(
        select(BlockchainTransaction).where(
            BlockchainTransaction.hash == tx_hash,
            BlockchainTransaction.business_id == membership.business_id,
        )
    )
    if record is None:
        raise not_found("Transaction not found")
    fresh = None
    try:
        result = verification.verify_stellar_payment(tx_hash)
        fresh = result.as_dict()
    except Exception as exc:
        logger.warning("Fresh verification unavailable for %s: %s", tx_hash, exc)
        fresh = {"status": "unknown", "reason": str(exc)}
    return {"transaction": TransactionOut.model_validate(record), "verification": fresh}


@router.post("/verify", response_model=VerificationOut)
def verify_transaction(
    payload: VerifyIn,
    membership=Depends(get_business_membership),
    db: Session = Depends(get_db),
):
    if verification.hash_already_used(db, payload.hash):
        raise conflict("This transaction hash is already linked to a payment", "DUPLICATE_HASH")
    if payload.invoice_id:
        invoice = db.get(Invoice, payload.invoice_id)
        if invoice is None or invoice.business_id != membership.business_id:
            raise not_found("Invoice not found")

    payment = db.scalar(
        select(PaymentRecord).where(
            PaymentRecord.hash == payload.hash, PaymentRecord.business_id == membership.business_id
        )
    )
    if payment and payment.kind == "escrow_release":
        from app.models import AgreementMilestone, PaymentAgreement
        agreement = db.get(PaymentAgreement, payment.agreement_id) if payment.agreement_id else None
        milestone = db.get(AgreementMilestone, payment.milestone_id) if payment.milestone_id else None
        agreement_ref = (
            str(agreement.onchain_agreement_id)
            if agreement and agreement.onchain_agreement_id is not None
            else payment.agreement_id or ""
        )
        result = verification.verify_soroban_release(
            payload.hash,
            payment.destination_account or "",
            agreement_ref,
            milestone.sort_order if milestone else 0,
        )
    else:
        result = verification.verify_stellar_payment(payload.hash)
    if not verification.hash_already_used(db, payload.hash):
        verification.record_transaction(
            db, membership.business_id, result, payment.id if payment else None
        )
        db.commit()
    return VerificationOut.model_validate(result.as_dict())


@public_router.get("/{tx_hash}", response_model=PublicReceiptOut)
def public_receipt(tx_hash: str, db: Session = Depends(get_db)):
    """Limited public data only: no internal notes, emails or user identifiers."""
    record = db.scalar(select(BlockchainTransaction).where(BlockchainTransaction.hash == tx_hash))
    if record is None:
        result = verification.verify_stellar_payment(tx_hash)
        return {
            "hash": tx_hash,
            "network": result.network,
            "status": result.status,
            "successful": result.successful,
            "amount": None if result.amount is None else str(result.amount),
            "asset_code": result.asset_code,
            "source_account": result.source_account,
            "destination_account": result.destination_account,
            "memo": result.memo,
            "ledger": result.ledger,
        }
    business = db.get(Business, record.business_id)
    payment = db.scalar(
        select(PaymentRecord).where(PaymentRecord.id == record.payment_record_id)
    )
    invoice = db.get(Invoice, payment.invoice_id) if payment and payment.invoice_id else None
    return {
        "hash": record.hash,
        "network": record.network,
        "status": record.status,
        "successful": record.successful,
        "amount": str(record.amount) if record.amount is not None else None,
        "asset_code": record.asset_code,
        "source_account": record.source_account,
        "destination_account": record.destination_account,
        "memo": record.memo,
        "ledger": record.ledger,
        "business_name": business.name if business else None,
        "invoice_number": invoice.invoice_number if invoice else None,
        "confirmed_at": record.confirmed_at,
    }
