"""One-time membership invitations for business members.

Revision ID: 0007_member_invites
Revises: 0006_reconciliation

Adds nullable invitation fields to ``business_members``. Rows already in
``pending`` state are intentionally left as-is: registration no longer activates
them, so they grant no membership and must be re-invited explicitly. New
invitations use status ``invited`` with a SHA-256 token digest and a 7-day
expiry; acceptance requires the authenticated email to match the invite.
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0007_member_invites"
down_revision = "0006_reconciliation"
branch_labels = None
depends_on = None


def upgrade() -> None:
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("business_members")}
    if "invitation_token" not in columns:
        op.add_column("business_members", sa.Column("invitation_token", sa.String(64), nullable=True))
    if "invitation_expires_at" not in columns:
        op.add_column(
            "business_members",
            sa.Column("invitation_expires_at", sa.DateTime(timezone=True), nullable=True),
        )
    # No backfill: legacy "pending" rows stay pending forever and are never
    # activated by registration. They confer no privileges; re-invite instead.


def downgrade() -> None:
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("business_members")}
    if "invitation_expires_at" in columns:
        op.drop_column("business_members", "invitation_expires_at")
    if "invitation_token" in columns:
        op.drop_column("business_members", "invitation_token")
