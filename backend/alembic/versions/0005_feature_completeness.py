"""Supplier invitations, invoice attachments and milestone evidence.

Revision ID: 0005_feature_completeness
Revises: 0004_onchain_agreement_id
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0005_feature_completeness"
down_revision = "0004_onchain_agreement_id"
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)


def _tables() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def upgrade() -> None:
    """Forward-safe: existing tables are left untouched if already present."""
    existing = _tables()

    if "supplier_invitations" not in existing:
        op.create_table(
            "supplier_invitations",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column(
                "business_id", sa.String(36),
                sa.ForeignKey("businesses.id", ondelete="CASCADE"), nullable=False,
            ),
            sa.Column(
                "supplier_id", sa.String(36),
                sa.ForeignKey("suppliers.id", ondelete="CASCADE"), nullable=False,
            ),
            sa.Column("email", sa.String(320), nullable=False),
            sa.Column("role", sa.String(32), nullable=False, server_default="supplier"),
            sa.Column("token", sa.String(64), nullable=False),
            sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
            sa.Column(
                "invited_by", sa.String(36),
                sa.ForeignKey("users.id", ondelete="SET NULL"),
            ),
            sa.Column("expires_at", TS, nullable=False),
            sa.Column("accepted_at", TS),
            sa.Column(
                "accepted_by", sa.String(36),
                sa.ForeignKey("users.id", ondelete="SET NULL"),
            ),
            sa.Column("created_at", TS, server_default=sa.func.now(), nullable=False),
            sa.Column("updated_at", TS, server_default=sa.func.now(), nullable=False),
            sa.UniqueConstraint("token", name="uq_supplier_invite_token"),
        )
        op.create_index("ix_supplier_invite_business_email", "supplier_invitations", ["business_id", "email"])
        op.create_index("ix_supplier_invite_supplier", "supplier_invitations", ["supplier_id"])

    if "invoice_attachments" not in existing:
        op.create_table(
            "invoice_attachments",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column(
                "business_id", sa.String(36),
                sa.ForeignKey("businesses.id", ondelete="CASCADE"), nullable=False,
            ),
            sa.Column(
                "invoice_id", sa.String(36),
                sa.ForeignKey("invoices.id", ondelete="CASCADE"), nullable=False,
            ),
            sa.Column("filename", sa.String(255), nullable=False),
            sa.Column("content_type", sa.String(100), nullable=False),
            sa.Column("size", sa.Integer, nullable=False),
            sa.Column("content", sa.LargeBinary, nullable=False),
            sa.Column(
                "uploaded_by", sa.String(36),
                sa.ForeignKey("users.id", ondelete="SET NULL"),
            ),
            sa.Column("created_at", TS, server_default=sa.func.now(), nullable=False),
            sa.Column("updated_at", TS, server_default=sa.func.now(), nullable=False),
        )
        op.create_index("ix_invoice_attachment_invoice", "invoice_attachments", ["invoice_id"])

    if "milestone_evidence" not in existing:
        op.create_table(
            "milestone_evidence",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column(
                "business_id", sa.String(36),
                sa.ForeignKey("businesses.id", ondelete="CASCADE"), nullable=False,
            ),
            sa.Column(
                "agreement_id", sa.String(36),
                sa.ForeignKey("payment_agreements.id", ondelete="CASCADE"), nullable=False,
            ),
            sa.Column(
                "milestone_id", sa.String(36),
                sa.ForeignKey("agreement_milestones.id", ondelete="CASCADE"), nullable=False,
            ),
            sa.Column(
                "supplier_id", sa.String(36),
                sa.ForeignKey("suppliers.id", ondelete="RESTRICT"), nullable=False,
            ),
            sa.Column("note", sa.Text),
            sa.Column("url", sa.String(2048)),
            sa.Column("filename", sa.String(255)),
            sa.Column("content_type", sa.String(100)),
            sa.Column("content", sa.LargeBinary),
            sa.Column("size", sa.Integer, nullable=False, server_default="0"),
            sa.Column("status", sa.String(16), nullable=False, server_default="submitted"),
            sa.Column(
                "submitted_by", sa.String(36),
                sa.ForeignKey("users.id", ondelete="SET NULL"),
            ),
            sa.Column(
                "approved_by", sa.String(36),
                sa.ForeignKey("users.id", ondelete="SET NULL"),
            ),
            sa.Column("approved_at", TS),
            sa.Column("created_at", TS, server_default=sa.func.now(), nullable=False),
            sa.Column("updated_at", TS, server_default=sa.func.now(), nullable=False),
        )
        op.create_index("ix_evidence_milestone", "milestone_evidence", ["milestone_id"])
        op.create_index("ix_evidence_agreement", "milestone_evidence", ["agreement_id"])


def downgrade() -> None:
    existing = _tables()
    for name in ("milestone_evidence", "invoice_attachments", "supplier_invitations"):
        if name in existing:
            op.drop_table(name)
