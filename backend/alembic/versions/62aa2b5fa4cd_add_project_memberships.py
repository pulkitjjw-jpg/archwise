"""add project_memberships table

Revision ID: 62aa2b5fa4cd
Revises: c5c74f583463
Create Date: 2026-07-16

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "62aa2b5fa4cd"
down_revision: Union[str, Sequence[str], None] = "c5c74f583463"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "project_memberships",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("role", sa.Text(), nullable=False),
        sa.Column("invited_by_user_id", sa.UUID(), nullable=True),
        sa.Column("created_at", postgresql.TIMESTAMP(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["invited_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    # A user can't have two memberships on the same project; also covers "list members of a
    # project" lookups via the leading column.
    op.create_unique_constraint(
        "uq_project_memberships_project_id_user_id", "project_memberships", ["project_id", "user_id"]
    )
    # "which projects am I a member of" lookups filter by user_id.
    op.create_index("ix_project_memberships_user_id", "project_memberships", ["user_id"])


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("ix_project_memberships_user_id", table_name="project_memberships")
    op.drop_constraint("uq_project_memberships_project_id_user_id", "project_memberships", type_="unique")
    op.drop_table("project_memberships")
