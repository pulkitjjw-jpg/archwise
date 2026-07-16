"""add usage_counters table

Revision ID: a9893b8ef523
Revises: 237f1a45049d
Create Date: 2026-07-16

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "a9893b8ef523"
down_revision: Union[str, Sequence[str], None] = "237f1a45049d"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "usage_counters",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("brainstorm_sessions_used", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("architecture_generations_used", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("growth_trigger_updates_used", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("plan", sa.Text(), server_default=sa.text("'free'"), nullable=False),
        sa.Column("updated_at", postgresql.TIMESTAMP(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_unique_constraint("uq_usage_counters_user_id", "usage_counters", ["user_id"])


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint("uq_usage_counters_user_id", "usage_counters", type_="unique")
    op.drop_table("usage_counters")
