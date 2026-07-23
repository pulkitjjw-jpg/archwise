"""add usage_counters window/bypass columns and app_settings limit columns

Revision ID: f61856b2a418
Revises: 23d128cad90e
Create Date: 2026-07-23

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "f61856b2a418"
down_revision: Union[str, Sequence[str], None] = "23d128cad90e"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "usage_counters",
        sa.Column("bypass_limits", sa.Boolean(), server_default=sa.text("false"), nullable=False),
    )
    op.add_column(
        "usage_counters",
        sa.Column(
            "window_started_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    op.add_column(
        "app_settings",
        sa.Column("free_brainstorm_sessions_limit", sa.Integer(), server_default=sa.text("6"), nullable=False),
    )
    op.add_column(
        "app_settings",
        sa.Column("free_architecture_generations_limit", sa.Integer(), server_default=sa.text("2"), nullable=False),
    )
    op.add_column(
        "app_settings",
        sa.Column("free_growth_trigger_updates_limit", sa.Integer(), server_default=sa.text("2"), nullable=False),
    )
    op.add_column(
        "app_settings",
        sa.Column("paid_brainstorm_sessions_limit", sa.Integer(), server_default=sa.text("5"), nullable=False),
    )
    op.add_column(
        "app_settings",
        sa.Column("paid_architecture_generations_limit", sa.Integer(), server_default=sa.text("5"), nullable=False),
    )
    op.add_column(
        "app_settings",
        sa.Column("paid_growth_trigger_updates_limit", sa.Integer(), server_default=sa.text("5"), nullable=False),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("app_settings", "paid_growth_trigger_updates_limit")
    op.drop_column("app_settings", "paid_architecture_generations_limit")
    op.drop_column("app_settings", "paid_brainstorm_sessions_limit")
    op.drop_column("app_settings", "free_growth_trigger_updates_limit")
    op.drop_column("app_settings", "free_architecture_generations_limit")
    op.drop_column("app_settings", "free_brainstorm_sessions_limit")
    op.drop_column("usage_counters", "window_started_at")
    op.drop_column("usage_counters", "bypass_limits")
