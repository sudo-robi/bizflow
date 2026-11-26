"""Record the payer derived from the escrow contract during binding.

Revision ID: 0008_escrow_binding
Revises: 0007_member_invites

The contract id and numeric agreement id are stored by the bind-contract
endpoint; the payer is stored here too so later settlement and reconciliation
can compare event topics with the trusted binding rather than client input.
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0008_escrow_binding"
down_revision = "0007_member_invites"
branch_labels = None
depends_on = None


def _has_column() -> bool:
    return any(
        column["name"] == "escrow_payer"
        for column in sa.inspect(op.get_bind()).get_columns("payment_agreements")
    )


def upgrade() -> None:
    if _has_column():
        return
    op.add_column("payment_agreements", sa.Column("escrow_payer", sa.String(56), nullable=True))


def downgrade() -> None:
    if _has_column():
        op.drop_column("payment_agreements", "escrow_payer")
