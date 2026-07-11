"""add knowledge_level to projects

Revision ID: e27a463290ac
Revises: cc02e5909673
Create Date: 2026-07-11

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e27a463290ac"
down_revision: Union[str, Sequence[str], None] = "cc02e5909673"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "projects",
        sa.Column("knowledge_level", sa.Text(), nullable=False, server_default="unknown"),
    )


def downgrade() -> None:
    op.drop_column("projects", "knowledge_level")
