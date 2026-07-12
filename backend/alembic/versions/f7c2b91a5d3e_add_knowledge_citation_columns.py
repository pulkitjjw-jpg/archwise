"""add knowledge-base citation sidecar columns

Revision ID: f7c2b91a5d3e
Revises: d1f6a3b8c4e2
Create Date: 2026-07-12

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "f7c2b91a5d3e"
down_revision: Union[str, Sequence[str], None] = "d1f6a3b8c4e2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "requirements",
        sa.Column("conversation_summary_sources", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.add_column(
        "architectures",
        sa.Column(
            "flow_story_sources",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("architectures", "flow_story_sources")
    op.drop_column("requirements", "conversation_summary_sources")
