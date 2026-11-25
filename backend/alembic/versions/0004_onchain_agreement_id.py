"""Track the numeric agreement id stored in the Soroban contract.

Revision ID: 0004_onchain_agreement_id
Revises: 0003_blockchain_updated_at
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0004_onchain_agreement_id"
down_revision = "0003_blockchain_updated_at"
branch_labels = None
depends_on = None


def _has_column() -> bool:
    return any(
        column["name"] == "onchain_agreement_id"
        for column in sa.inspect(op.get_bind()).get_columns("payment_agreements")
    )


def upgrade() -> None:
    if _has_column():
        return  # forward-safe for partially applied upgrades
    op.add_column(
        "payment_agreements", sa.Column("onchain_agreement_id", sa.Integer(), nullable=True)
    )


def downgrade() -> None:
    if _has_column():
        op.drop_column("payment_agreements", "onchain_agreement_id")
