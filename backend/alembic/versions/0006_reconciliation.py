"""Persisted reconciliation records and unique escrow agreement bindings.

Revision ID: 0006_reconciliation
Revises: 0005_feature_completeness
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0006_reconciliation"
down_revision = "0005_feature_completeness"
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)


def _tables() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def _indexes(table: str) -> set[str]:
    return {idx["name"] for idx in sa.inspect(op.get_bind()).get_indexes(table)}


def upgrade() -> None:
    existing = _tables()
    if "reconciliation_records" not in existing:
        op.create_table(
            "reconciliation_records",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column(
                "business_id", sa.String(36),
                sa.ForeignKey("businesses.id", ondelete="CASCADE"), nullable=False,
            ),
            sa.Column(
                "agreement_id", sa.String(36),
                sa.ForeignKey("payment_agreements.id", ondelete="CASCADE"), nullable=False,
            ),
            sa.Column("transaction_hash", sa.String(64)),
            sa.Column("contract_id", sa.String(56)),
            sa.Column("expected_state", sa.JSON, nullable=False),
            sa.Column("observed_state", sa.JSON),
            sa.Column("discrepancy", sa.JSON, nullable=False),
            sa.Column("resolution_status", sa.String(24), nullable=False,
                      server_default="open"),
            sa.Column("resolved_by", sa.String(36),
                      sa.ForeignKey("users.id", ondelete="SET NULL")),
            sa.Column("resolved_at", TS),
            sa.Column("resolution_note", sa.Text),
            sa.Column("detected_at", TS, nullable=False, server_default=sa.func.now()),
        )
        op.create_index("ix_reconciliation_agreement_time", "reconciliation_records",
                        ["agreement_id", "detected_at"])
        op.create_index("ix_reconciliation_business", "reconciliation_records", ["business_id"])

    # One contract instance can hold only one *funded* agreement. Draft
    # agreements may share the configured contract id. Refuse to apply the
    # constraint if existing data already violates it; never repair financial
    # records silently.
    if "payment_agreements" in existing:
        indexes = _indexes("payment_agreements")
        if "uq_agreement_funded_contract" not in indexes:
            bind = op.get_bind()
            duplicates = bind.execute(
                sa.text(
                    "SELECT COUNT(*) FROM (SELECT escrow_contract_id FROM payment_agreements "
                    "WHERE escrow_contract_id IS NOT NULL AND fund_transaction_hash IS NOT NULL "
                    "GROUP BY escrow_contract_id HAVING COUNT(*) > 1) AS dup"
                )
            ).scalar_one()
            if duplicates:
                raise RuntimeError(
                    f"{duplicates} escrow contract(s) are bound to more than one funded "
                    "agreement. Resolve manually before upgrading; no record was modified."
                )
            op.create_index(
                "uq_agreement_funded_contract", "payment_agreements",
                ["escrow_contract_id"], unique=True,
                sqlite_where=sa.text("fund_transaction_hash IS NOT NULL"),
                postgresql_where=sa.text("fund_transaction_hash IS NOT NULL"),
            )


def downgrade() -> None:
    existing = _tables()
    if "reconciliation_records" in existing:
        op.drop_index("ix_reconciliation_business", table_name="reconciliation_records")
        op.drop_index("ix_reconciliation_agreement_time", table_name="reconciliation_records")
        op.drop_table("reconciliation_records")
    if "payment_agreements" in existing:
        indexes = _indexes("payment_agreements")
        if "uq_agreement_funded_contract" in indexes:
            op.drop_index("uq_agreement_funded_contract", table_name="payment_agreements")
