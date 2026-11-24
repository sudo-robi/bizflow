"""Initial BizFlow schema.

Revision ID: 0001_initial
Revises:
Create Date: 2026-01-01
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None

AMOUNT = sa.Numeric(20, 7, asdecimal=True)
TS = sa.DateTime(timezone=True)


def _timestamps(with_update: bool = True) -> list[sa.Column]:
    columns = [
        sa.Column("created_at", TS, server_default=sa.func.now(), nullable=False),
    ]
    if with_update:
        columns.append(sa.Column("updated_at", TS, server_default=sa.func.now(), nullable=False))
    return columns


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("email", sa.String(320), nullable=False),
        sa.Column("password_hash", sa.String(255), nullable=False),
        sa.Column("full_name", sa.String(255), nullable=False),
        sa.Column("is_active", sa.Boolean, nullable=False, server_default=sa.true()),
        *_timestamps(),
    )
    op.create_index("ix_users_email", "users", ["email"], unique=True)

    op.create_table(
        "businesses",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("legal_name", sa.String(255)),
        sa.Column("country", sa.String(100)),
        sa.Column("currency", sa.String(10), nullable=False, server_default="USD"),
        sa.Column("created_by", sa.String(36), sa.ForeignKey("users.id", ondelete="SET NULL")),
        *_timestamps(),
    )
    op.create_index("ix_businesses_name", "businesses", ["name"])

    op.create_table(
        "business_members",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("business_id", sa.String(36), sa.ForeignKey("businesses.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE")),
        sa.Column("email", sa.String(320), nullable=False),
        sa.Column("role", sa.String(32), nullable=False, server_default="finance_manager"),
        sa.Column("status", sa.String(16), nullable=False, server_default="active"),
        sa.Column("invited_by", sa.String(36), sa.ForeignKey("users.id", ondelete="SET NULL")),
        *_timestamps(),
        sa.UniqueConstraint("business_id", "user_id", name="uq_member_business_user"),
        sa.UniqueConstraint("business_id", "email", name="uq_member_business_email"),
    )
    op.create_index("ix_member_business", "business_members", ["business_id"])

    op.create_table(
        "suppliers",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("business_id", sa.String(36), sa.ForeignKey("businesses.id", ondelete="CASCADE"), nullable=False),
        sa.Column("business_name", sa.String(255), nullable=False),
        sa.Column("contact_name", sa.String(255)),
        sa.Column("email", sa.String(320)),
        sa.Column("phone", sa.String(50)),
        sa.Column("wallet_address", sa.String(56), nullable=False),
        sa.Column("country", sa.String(100)),
        sa.Column("notes", sa.Text),
        sa.Column("status", sa.String(16), nullable=False, server_default="active"),
        *_timestamps(),
        sa.UniqueConstraint("business_id", "wallet_address", name="uq_supplier_business_wallet"),
    )
    op.create_index("ix_supplier_business_status", "suppliers", ["business_id", "status"])

    op.create_table(
        "invoices",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("business_id", sa.String(36), sa.ForeignKey("businesses.id", ondelete="CASCADE"), nullable=False),
        sa.Column("supplier_id", sa.String(36), sa.ForeignKey("suppliers.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("invoice_number", sa.String(32), nullable=False),
        sa.Column("description", sa.Text, nullable=False),
        sa.Column("amount", AMOUNT, nullable=False),
        sa.Column("asset_code", sa.String(12), nullable=False, server_default="XLM"),
        sa.Column("asset_issuer", sa.String(56)),
        sa.Column("due_date", TS, nullable=False),
        sa.Column("reference", sa.String(255)),
        sa.Column("status", sa.String(24), nullable=False, server_default="draft"),
        sa.Column("created_by", sa.String(36), sa.ForeignKey("users.id", ondelete="SET NULL")),
        *_timestamps(),
        sa.UniqueConstraint("business_id", "invoice_number", name="uq_invoice_business_number"),
    )
    op.create_index("ix_invoice_business_status", "invoices", ["business_id", "status"])
    op.create_index("ix_invoice_supplier", "invoices", ["supplier_id"])

    op.create_table(
        "invoice_items",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("invoice_id", sa.String(36), sa.ForeignKey("invoices.id", ondelete="CASCADE"), nullable=False),
        sa.Column("description", sa.Text, nullable=False),
        sa.Column("quantity", AMOUNT, nullable=False),
        sa.Column("unit_price", AMOUNT, nullable=False),
        *_timestamps(),
    )
    op.create_index("ix_invoice_item_invoice", "invoice_items", ["invoice_id"])

    op.create_table(
        "payment_agreements",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("business_id", sa.String(36), sa.ForeignKey("businesses.id", ondelete="CASCADE"), nullable=False),
        sa.Column("supplier_id", sa.String(36), sa.ForeignKey("suppliers.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("reference", sa.String(32), nullable=False),
        sa.Column("title", sa.String(255), nullable=False),
        sa.Column("description", sa.Text),
        sa.Column("total_amount", AMOUNT, nullable=False),
        sa.Column("asset_code", sa.String(12), nullable=False, server_default="XLM"),
        sa.Column("asset_issuer", sa.String(56)),
        sa.Column("expiry_date", TS, nullable=False),
        sa.Column("conditions", sa.JSON),
        sa.Column("approval_requirements", sa.JSON),
        sa.Column("status", sa.String(24), nullable=False, server_default="draft"),
        sa.Column("escrow_contract_id", sa.String(56)),
        sa.Column("funded_amount", AMOUNT, nullable=False, server_default="0"),
        sa.Column("fund_transaction_hash", sa.String(64)),
        sa.Column("cancellation_reason", sa.Text),
        sa.Column("accepted_at", TS),
        sa.Column("created_by", sa.String(36), sa.ForeignKey("users.id", ondelete="SET NULL")),
        *_timestamps(),
        sa.UniqueConstraint("business_id", "reference", name="uq_agreement_business_reference"),
    )
    op.create_index("ix_agreement_business_status", "payment_agreements", ["business_id", "status"])

    op.create_table(
        "agreement_milestones",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("agreement_id", sa.String(36), sa.ForeignKey("payment_agreements.id", ondelete="CASCADE"), nullable=False),
        sa.Column("description", sa.Text, nullable=False),
        sa.Column("amount", AMOUNT, nullable=False),
        sa.Column("due_date", TS),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("sort_order", sa.Integer, nullable=False, server_default="0"),
        sa.Column("release_transaction_hash", sa.String(64)),
        sa.Column("released_at", TS),
        *_timestamps(),
    )
    op.create_index("ix_milestone_agreement", "agreement_milestones", ["agreement_id"])

    op.create_table(
        "payment_records",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("business_id", sa.String(36), sa.ForeignKey("businesses.id", ondelete="CASCADE"), nullable=False),
        sa.Column("invoice_id", sa.String(36), sa.ForeignKey("invoices.id", ondelete="RESTRICT")),
        sa.Column("agreement_id", sa.String(36), sa.ForeignKey("payment_agreements.id", ondelete="RESTRICT")),
        sa.Column("milestone_id", sa.String(36), sa.ForeignKey("agreement_milestones.id", ondelete="RESTRICT")),
        sa.Column("kind", sa.String(24), nullable=False, server_default="ordinary"),
        sa.Column("amount", AMOUNT, nullable=False),
        sa.Column("asset_code", sa.String(12), nullable=False),
        sa.Column("asset_issuer", sa.String(56)),
        sa.Column("source_account", sa.String(56)),
        sa.Column("destination_account", sa.String(56)),
        sa.Column("memo", sa.String(64)),
        sa.Column("xdr", sa.Text, nullable=False),
        sa.Column("hash", sa.String(64)),
        sa.Column("status", sa.String(16), nullable=False, server_default="prepared"),
        sa.Column("expires_at", TS),
        sa.Column("confirmed_at", TS),
        sa.Column("failure_reason", sa.Text),
        sa.Column("prepared_by", sa.String(36), sa.ForeignKey("users.id", ondelete="SET NULL")),
        *_timestamps(),
        sa.UniqueConstraint("hash", name="uq_payment_hash"),
    )
    op.create_index(
        "uq_payment_invoice_amount_active", "payment_records",
        ["invoice_id", "amount", "kind"], unique=True,
        sqlite_where=sa.text("invoice_id IS NOT NULL AND status != 'failed'"),
        postgresql_where=sa.text("invoice_id IS NOT NULL AND status != 'failed'"),
    )
    op.create_index("ix_payment_business_status", "payment_records", ["business_id", "status"])
    op.create_index("ix_payment_agreement", "payment_records", ["agreement_id"])

    op.create_table(
        "blockchain_transactions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("business_id", sa.String(36), sa.ForeignKey("businesses.id", ondelete="CASCADE"), nullable=False),
        sa.Column("hash", sa.String(64), nullable=False),
        sa.Column("network", sa.String(16), nullable=False, server_default="testnet"),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("successful", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("source_account", sa.String(56)),
        sa.Column("destination_account", sa.String(56)),
        sa.Column("asset_code", sa.String(12)),
        sa.Column("asset_issuer", sa.String(56)),
        sa.Column("amount", AMOUNT),
        sa.Column("memo", sa.String(64)),
        sa.Column("ledger", sa.Integer),
        sa.Column("payment_record_id", sa.String(36), sa.ForeignKey("payment_records.id", ondelete="SET NULL")),
        sa.Column("details", sa.JSON),
        sa.Column("confirmed_at", TS),
        *_timestamps(),
        sa.UniqueConstraint("hash", name="uq_blockchain_hash"),
        sa.UniqueConstraint("payment_record_id", name="uq_blockchain_payment"),
    )
    op.create_index("ix_blockchain_business", "blockchain_transactions", ["business_id"])

    op.create_table(
        "wallet_connections",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("business_id", sa.String(36), sa.ForeignKey("businesses.id", ondelete="CASCADE"), nullable=False),
        sa.Column("public_key", sa.String(56), nullable=False),
        sa.Column("network", sa.String(16), nullable=False, server_default="testnet"),
        sa.Column("label", sa.String(255)),
        sa.Column("created_by", sa.String(36), sa.ForeignKey("users.id", ondelete="SET NULL")),
        *_timestamps(),
        sa.UniqueConstraint("business_id", "public_key", name="uq_wallet_business_key"),
    )
    op.create_index("ix_wallet_business", "wallet_connections", ["business_id"])

    op.create_table(
        "notifications",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("business_id", sa.String(36), sa.ForeignKey("businesses.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("title", sa.String(255), nullable=False),
        sa.Column("message", sa.Text, nullable=False),
        sa.Column("type", sa.String(32), nullable=False, server_default="info"),
        sa.Column("is_read", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("related_id", sa.String(36)),
        *_timestamps(),
    )
    op.create_index("ix_notification_user_read", "notifications", ["user_id", "is_read"])

    op.create_table(
        "audit_logs",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("business_id", sa.String(36), sa.ForeignKey("businesses.id", ondelete="CASCADE"), nullable=False),
        sa.Column("actor_id", sa.String(36), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("action", sa.String(64), nullable=False),
        sa.Column("entity_type", sa.String(64)),
        sa.Column("entity_id", sa.String(36)),
        sa.Column("details", sa.JSON),
        sa.Column("ip_address", sa.String(64)),
        sa.Column("created_at", TS, server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_audit_business_action", "audit_logs", ["business_id", "action"])


def downgrade() -> None:
    for table in (
        "audit_logs", "notifications", "wallet_connections", "blockchain_transactions",
        "payment_records", "agreement_milestones", "payment_agreements", "invoice_items",
        "invoices", "suppliers", "business_members", "businesses", "users",
    ):
        op.drop_table(table)
