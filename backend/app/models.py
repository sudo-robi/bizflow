"""ORM models for every BizFlow table. Amounts use Numeric(20, 7) + Decimal."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    JSON,
    LargeBinary,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.utils import utcnow

AMOUNT = Numeric(20, 7, asdecimal=True)


def DecimalZero():  # noqa: N802 - callable default for mapped_column
    from decimal import Decimal

    return Decimal("0")


def new_id() -> str:
    return str(uuid.uuid4())


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utcnow,
        onupdate=utcnow,
        server_default=func.now(),
        nullable=False,
    )


class User(Base, TimestampMixin):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    email: Mapped[str] = mapped_column(String(320), unique=True, nullable=False, index=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    full_name: Mapped[str] = mapped_column(String(255), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


class Business(Base, TimestampMixin):
    __tablename__ = "businesses"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    legal_name: Mapped[str | None] = mapped_column(String(255))
    country: Mapped[str | None] = mapped_column(String(100))
    currency: Mapped[str] = mapped_column(String(10), default="USD", nullable=False)
    created_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))


class BusinessMember(Base, TimestampMixin):
    __tablename__ = "business_members"
    __table_args__ = (
        UniqueConstraint("business_id", "user_id", name="uq_member_business_user"),
        UniqueConstraint("business_id", "email", name="uq_member_business_email"),
        Index("ix_member_business", "business_id"),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    business_id: Mapped[str] = mapped_column(
        ForeignKey("businesses.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    email: Mapped[str] = mapped_column(String(320), nullable=False)
    role: Mapped[str] = mapped_column(String(32), default="finance_manager", nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="active", nullable=False)
    invited_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    business: Mapped["Business"] = relationship(lazy="joined")
    user: Mapped["User | None"] = relationship(lazy="joined", foreign_keys=[user_id])


class Supplier(Base, TimestampMixin):
    __tablename__ = "suppliers"
    __table_args__ = (
        UniqueConstraint("business_id", "wallet_address", name="uq_supplier_business_wallet"),
        Index("ix_supplier_business_status", "business_id", "status"),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    business_id: Mapped[str] = mapped_column(
        ForeignKey("businesses.id", ondelete="CASCADE"), nullable=False
    )
    business_name: Mapped[str] = mapped_column(String(255), nullable=False)
    contact_name: Mapped[str | None] = mapped_column(String(255))
    email: Mapped[str | None] = mapped_column(String(320))
    phone: Mapped[str | None] = mapped_column(String(50))
    wallet_address: Mapped[str] = mapped_column(String(56), nullable=False)
    country: Mapped[str | None] = mapped_column(String(100))
    notes: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), default="active", nullable=False)


class Invoice(Base, TimestampMixin):
    __tablename__ = "invoices"
    __table_args__ = (
        UniqueConstraint("business_id", "invoice_number", name="uq_invoice_business_number"),
        Index("ix_invoice_business_status", "business_id", "status"),
        Index("ix_invoice_supplier", "supplier_id"),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    business_id: Mapped[str] = mapped_column(
        ForeignKey("businesses.id", ondelete="CASCADE"), nullable=False
    )
    supplier_id: Mapped[str] = mapped_column(
        ForeignKey("suppliers.id", ondelete="RESTRICT"), nullable=False
    )
    invoice_number: Mapped[str] = mapped_column(String(32), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    amount: Mapped[Any] = mapped_column(AMOUNT, nullable=False)
    asset_code: Mapped[str] = mapped_column(String(12), default="XLM", nullable=False)
    asset_issuer: Mapped[str | None] = mapped_column(String(56))
    due_date: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    reference: Mapped[str | None] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(String(24), default="draft", nullable=False)
    created_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))


class SupplierInvitation(Base, TimestampMixin):
    """Persistent, time-limited invitation for a supplier contact to join a business.

    Acceptance is an explicit authenticated action by the invited email address;
    registering an account alone never grants the supplier role.
    """

    __tablename__ = "supplier_invitations"
    __table_args__ = (
        UniqueConstraint("token", name="uq_supplier_invite_token"),
        Index("ix_supplier_invite_business_email", "business_id", "email"),
        Index("ix_supplier_invite_supplier", "supplier_id"),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    business_id: Mapped[str] = mapped_column(
        ForeignKey("businesses.id", ondelete="CASCADE"), nullable=False
    )
    supplier_id: Mapped[str] = mapped_column(
        ForeignKey("suppliers.id", ondelete="CASCADE"), nullable=False
    )
    email: Mapped[str] = mapped_column(String(320), nullable=False)
    role: Mapped[str] = mapped_column(String(32), default="supplier", nullable=False)
    token: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="pending", nullable=False)
    invited_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    accepted_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))


class InvoiceAttachment(Base, TimestampMixin):
    """An uploaded document bound to exactly one invoice and its business."""

    __tablename__ = "invoice_attachments"
    __table_args__ = (Index("ix_invoice_attachment_invoice", "invoice_id"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    business_id: Mapped[str] = mapped_column(
        ForeignKey("businesses.id", ondelete="CASCADE"), nullable=False
    )
    invoice_id: Mapped[str] = mapped_column(
        ForeignKey("invoices.id", ondelete="CASCADE"), nullable=False
    )
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    content_type: Mapped[str] = mapped_column(String(100), nullable=False)
    size: Mapped[int] = mapped_column(Integer, nullable=False)
    content: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    uploaded_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))


class InvoiceItem(Base, TimestampMixin):
    __tablename__ = "invoice_items"
    __table_args__ = (Index("ix_invoice_item_invoice", "invoice_id"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    invoice_id: Mapped[str] = mapped_column(
        ForeignKey("invoices.id", ondelete="CASCADE"), nullable=False
    )
    description: Mapped[str] = mapped_column(Text, nullable=False)
    quantity: Mapped[Any] = mapped_column(AMOUNT, nullable=False)
    unit_price: Mapped[Any] = mapped_column(AMOUNT, nullable=False)


class MilestoneEvidence(Base, TimestampMixin):
    """Supplier-submitted proof for a milestone; approval stays off-chain here.

    On-chain approval is only recorded by the real Soroban `approve_milestone`
    flow, never by approving one of these records.
    """

    __tablename__ = "milestone_evidence"
    __table_args__ = (
        Index("ix_evidence_milestone", "milestone_id"),
        Index("ix_evidence_agreement", "agreement_id"),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    business_id: Mapped[str] = mapped_column(
        ForeignKey("businesses.id", ondelete="CASCADE"), nullable=False
    )
    agreement_id: Mapped[str] = mapped_column(
        ForeignKey("payment_agreements.id", ondelete="CASCADE"), nullable=False
    )
    milestone_id: Mapped[str] = mapped_column(
        ForeignKey("agreement_milestones.id", ondelete="CASCADE"), nullable=False
    )
    supplier_id: Mapped[str] = mapped_column(
        ForeignKey("suppliers.id", ondelete="RESTRICT"), nullable=False
    )
    note: Mapped[str | None] = mapped_column(Text)
    url: Mapped[str | None] = mapped_column(String(2048))
    filename: Mapped[str | None] = mapped_column(String(255))
    content_type: Mapped[str | None] = mapped_column(String(100))
    content: Mapped[bytes | None] = mapped_column(LargeBinary)
    size: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="submitted", nullable=False)
    submitted_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    approved_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class PaymentAgreement(Base, TimestampMixin):
    __tablename__ = "payment_agreements"
    __table_args__ = (
        UniqueConstraint("business_id", "reference", name="uq_agreement_business_reference"),
        Index("ix_agreement_business_status", "business_id", "status"),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    business_id: Mapped[str] = mapped_column(
        ForeignKey("businesses.id", ondelete="CASCADE"), nullable=False
    )
    supplier_id: Mapped[str] = mapped_column(
        ForeignKey("suppliers.id", ondelete="RESTRICT"), nullable=False
    )
    reference: Mapped[str] = mapped_column(String(32), nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    total_amount: Mapped[Any] = mapped_column(AMOUNT, nullable=False)
    asset_code: Mapped[str] = mapped_column(String(12), default="XLM", nullable=False)
    asset_issuer: Mapped[str | None] = mapped_column(String(56))
    expiry_date: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    conditions: Mapped[dict | None] = mapped_column(JSON)
    approval_requirements: Mapped[dict | None] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(24), default="draft", nullable=False)
    escrow_contract_id: Mapped[str | None] = mapped_column(String(56))
    # Numeric id stored in the Soroban contract (one contract instance per agreement).
    onchain_agreement_id: Mapped[int | None] = mapped_column(Integer)
    funded_amount: Mapped[Any] = mapped_column(AMOUNT, default=DecimalZero, nullable=False)
    fund_transaction_hash: Mapped[str | None] = mapped_column(String(64))
    cancellation_reason: Mapped[str | None] = mapped_column(Text)
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))


class AgreementMilestone(Base, TimestampMixin):
    __tablename__ = "agreement_milestones"
    __table_args__ = (Index("ix_milestone_agreement", "agreement_id"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    agreement_id: Mapped[str] = mapped_column(
        ForeignKey("payment_agreements.id", ondelete="CASCADE"), nullable=False
    )
    description: Mapped[str] = mapped_column(Text, nullable=False)
    amount: Mapped[Any] = mapped_column(AMOUNT, nullable=False)
    due_date: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(16), default="pending", nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    release_transaction_hash: Mapped[str | None] = mapped_column(String(64))
    released_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class PaymentRecord(Base, TimestampMixin):
    __tablename__ = "payment_records"
    __table_args__ = (
        UniqueConstraint("hash", name="uq_payment_hash"),
        Index(
            "uq_payment_invoice_amount_active",
            "invoice_id",
            "amount",
            "kind",
            unique=True,
            sqlite_where=text("invoice_id IS NOT NULL AND status != 'failed'"),
            postgresql_where=text("invoice_id IS NOT NULL AND status != 'failed'"),
        ),
        Index("ix_payment_business_status", "business_id", "status"),
        Index("ix_payment_agreement", "agreement_id"),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    business_id: Mapped[str] = mapped_column(
        ForeignKey("businesses.id", ondelete="CASCADE"), nullable=False
    )
    invoice_id: Mapped[str | None] = mapped_column(
        ForeignKey("invoices.id", ondelete="RESTRICT")
    )
    agreement_id: Mapped[str | None] = mapped_column(
        ForeignKey("payment_agreements.id", ondelete="RESTRICT")
    )
    milestone_id: Mapped[str | None] = mapped_column(
        ForeignKey("agreement_milestones.id", ondelete="RESTRICT")
    )
    kind: Mapped[str] = mapped_column(String(24), default="ordinary", nullable=False)
    amount: Mapped[Any] = mapped_column(AMOUNT, nullable=False)
    asset_code: Mapped[str] = mapped_column(String(12), nullable=False)
    asset_issuer: Mapped[str | None] = mapped_column(String(56))
    source_account: Mapped[str | None] = mapped_column(String(56))
    destination_account: Mapped[str | None] = mapped_column(String(56))
    memo: Mapped[str | None] = mapped_column(String(64))
    xdr: Mapped[str] = mapped_column(Text, nullable=False)
    hash: Mapped[str | None] = mapped_column(String(64), unique=True)
    status: Mapped[str] = mapped_column(String(16), default="prepared", nullable=False)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    failure_reason: Mapped[str | None] = mapped_column(Text)
    prepared_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))


class BlockchainTransaction(Base, TimestampMixin):
    __tablename__ = "blockchain_transactions"
    __table_args__ = (
        UniqueConstraint("hash", name="uq_blockchain_hash"),
        UniqueConstraint("payment_record_id", name="uq_blockchain_payment"),
        Index("ix_blockchain_business", "business_id"),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    business_id: Mapped[str] = mapped_column(
        ForeignKey("businesses.id", ondelete="CASCADE"), nullable=False
    )
    hash: Mapped[str] = mapped_column(String(64), nullable=False)
    network: Mapped[str] = mapped_column(String(16), default="testnet", nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="pending", nullable=False)
    successful: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    source_account: Mapped[str | None] = mapped_column(String(56))
    destination_account: Mapped[str | None] = mapped_column(String(56))
    asset_code: Mapped[str | None] = mapped_column(String(12))
    asset_issuer: Mapped[str | None] = mapped_column(String(56))
    amount: Mapped[Any | None] = mapped_column(AMOUNT, nullable=True)
    memo: Mapped[str | None] = mapped_column(String(64))
    ledger: Mapped[int | None] = mapped_column(Integer)
    payment_record_id: Mapped[str | None] = mapped_column(
        ForeignKey("payment_records.id", ondelete="SET NULL")
    )
    details: Mapped[dict | None] = mapped_column(JSON)
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class WalletConnection(Base, TimestampMixin):
    __tablename__ = "wallet_connections"
    __table_args__ = (
        UniqueConstraint("business_id", "public_key", name="uq_wallet_business_key"),
        Index("ix_wallet_business", "business_id"),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    business_id: Mapped[str] = mapped_column(
        ForeignKey("businesses.id", ondelete="CASCADE"), nullable=False
    )
    public_key: Mapped[str] = mapped_column(String(56), nullable=False)
    network: Mapped[str] = mapped_column(String(16), default="testnet", nullable=False)
    label: Mapped[str | None] = mapped_column(String(255))
    created_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))


class Notification(Base, TimestampMixin):
    __tablename__ = "notifications"
    __table_args__ = (Index("ix_notification_user_read", "user_id", "is_read"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    business_id: Mapped[str] = mapped_column(
        ForeignKey("businesses.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    type: Mapped[str] = mapped_column(String(32), default="info", nullable=False)
    is_read: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    related_id: Mapped[str | None] = mapped_column(String(36))


class RevokedToken(Base):
    """Server-side logout/revocation ledger; JWTs are checked against it."""

    __tablename__ = "revoked_tokens"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    jti: Mapped[str] = mapped_column(String(36), unique=True, nullable=False, index=True)
    user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now(), nullable=False
    )


class AuditLog(Base):
    __tablename__ = "audit_logs"
    __table_args__ = (Index("ix_audit_business_action", "business_id", "action"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    business_id: Mapped[str] = mapped_column(
        ForeignKey("businesses.id", ondelete="CASCADE"), nullable=False
    )
    actor_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    action: Mapped[str] = mapped_column(String(64), nullable=False)
    entity_type: Mapped[str | None] = mapped_column(String(64))
    entity_id: Mapped[str | None] = mapped_column(String(36))
    details: Mapped[dict | None] = mapped_column(JSON)
    ip_address: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now(), nullable=False
    )
