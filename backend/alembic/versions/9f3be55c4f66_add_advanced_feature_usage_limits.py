"""add advanced-feature usage counters and paid limits, revise paid core defaults

Revision ID: 9f3be55c4f66
Revises: c72bfcc1a994
Create Date: 2026-07-23

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "9f3be55c4f66"
down_revision: Union[str, Sequence[str], None] = "c72bfcc1a994"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "usage_counters",
        sa.Column("whatif_simulator_used", sa.Integer(), server_default=sa.text("0"), nullable=False),
    )
    op.add_column(
        "usage_counters",
        sa.Column("component_suggestions_used", sa.Integer(), server_default=sa.text("0"), nullable=False),
    )
    op.add_column(
        "usage_counters",
        sa.Column("chat_proposals_used", sa.Integer(), server_default=sa.text("0"), nullable=False),
    )
    op.add_column(
        "usage_counters",
        sa.Column("proposal_refinements_used", sa.Integer(), server_default=sa.text("0"), nullable=False),
    )
    op.add_column(
        "usage_counters",
        sa.Column("requirement_suggestions_used", sa.Integer(), server_default=sa.text("0"), nullable=False),
    )
    op.add_column(
        "usage_counters",
        sa.Column("executive_summary_exports_used", sa.Integer(), server_default=sa.text("0"), nullable=False),
    )

    op.add_column(
        "app_settings",
        sa.Column("paid_whatif_simulator_limit", sa.Integer(), server_default=sa.text("15"), nullable=False),
    )
    op.add_column(
        "app_settings",
        sa.Column("paid_component_suggestions_limit", sa.Integer(), server_default=sa.text("15"), nullable=False),
    )
    op.add_column(
        "app_settings",
        sa.Column("paid_chat_proposals_limit", sa.Integer(), server_default=sa.text("15"), nullable=False),
    )
    op.add_column(
        "app_settings",
        sa.Column("paid_proposal_refinements_limit", sa.Integer(), server_default=sa.text("25"), nullable=False),
    )
    op.add_column(
        "app_settings",
        sa.Column("paid_requirement_suggestions_limit", sa.Integer(), server_default=sa.text("20"), nullable=False),
    )
    op.add_column(
        "app_settings",
        sa.Column("paid_executive_summary_exports_limit", sa.Integer(), server_default=sa.text("5"), nullable=False),
    )

    # Revised paid core defaults (5/5/5 -> 5/10/15) -- see models.py's AppSetting docstring for the
    # reasoning. ALTER COLUMN ... SET DEFAULT only changes the default for future inserts; existing
    # rows are explicitly UPDATEd too so a fresh install and this upgrade path end up identical.
    op.alter_column("app_settings", "paid_architecture_generations_limit", server_default=sa.text("10"))
    op.alter_column("app_settings", "paid_growth_trigger_updates_limit", server_default=sa.text("15"))
    op.execute("UPDATE app_settings SET paid_architecture_generations_limit = 10 WHERE paid_architecture_generations_limit = 5")
    op.execute("UPDATE app_settings SET paid_growth_trigger_updates_limit = 15 WHERE paid_growth_trigger_updates_limit = 5")


def downgrade() -> None:
    """Downgrade schema."""
    op.alter_column("app_settings", "paid_growth_trigger_updates_limit", server_default=sa.text("5"))
    op.alter_column("app_settings", "paid_architecture_generations_limit", server_default=sa.text("5"))

    op.drop_column("app_settings", "paid_executive_summary_exports_limit")
    op.drop_column("app_settings", "paid_requirement_suggestions_limit")
    op.drop_column("app_settings", "paid_proposal_refinements_limit")
    op.drop_column("app_settings", "paid_chat_proposals_limit")
    op.drop_column("app_settings", "paid_component_suggestions_limit")
    op.drop_column("app_settings", "paid_whatif_simulator_limit")

    op.drop_column("usage_counters", "executive_summary_exports_used")
    op.drop_column("usage_counters", "requirement_suggestions_used")
    op.drop_column("usage_counters", "proposal_refinements_used")
    op.drop_column("usage_counters", "chat_proposals_used")
    op.drop_column("usage_counters", "component_suggestions_used")
    op.drop_column("usage_counters", "whatif_simulator_used")
