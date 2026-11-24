"""Ensure blockchain_transactions.updated_at exists.

Revision ID: 0003_blockchain_updated_at
Revises: 0002_revoked_tokens

The column was originally created by this revision on databases that predated
``0001_initial``. ``0001_initial`` now creates it directly, so this migration
must be a no-op on fresh databases while remaining reversible on upgraded ones.
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0003_blockchain_updated_at"
down_revision = "0002_revoked_tokens"
branch_labels = None
depends_on = None

TABLE = "blockchain_transactions"
COLUMN = "updated_at"


def _has_column() -> bool:
    columns = sa.inspect(op.get_bind()).get_columns(TABLE)
    return any(column["name"] == COLUMN for column in columns)


def upgrade() -> None:
    if _has_column():
        return
    op.add_column(
        TABLE,
        sa.Column(
            COLUMN,
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )


def downgrade() -> None:
    if not _has_column():
        return
    op.drop_column(TABLE, COLUMN)
