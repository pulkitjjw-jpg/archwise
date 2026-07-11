"""add layout_overrides to architectures

Revision ID: 0959f09b00f6
Revises: 4cede3b8aa45
Create Date: 2026-07-11

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "0959f09b00f6"
down_revision: Union[str, Sequence[str], None] = "4cede3b8aa45"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "architectures",
        sa.Column("layout_overrides", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default="{}"),
    )


def downgrade() -> None:
    op.drop_column("architectures", "layout_overrides")
