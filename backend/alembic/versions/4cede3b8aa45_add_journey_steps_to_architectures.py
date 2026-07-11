"""add journey_steps to architectures

Revision ID: 4cede3b8aa45
Revises: e27a463290ac
Create Date: 2026-07-11

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "4cede3b8aa45"
down_revision: Union[str, Sequence[str], None] = "e27a463290ac"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "architectures",
        sa.Column("journey_steps", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default="{}"),
    )


def downgrade() -> None:
    op.drop_column("architectures", "journey_steps")
