"""add reference-architecture source support to knowledge_chunks (Part 2)

Revision ID: e2b4f6a8c0d1
Revises: a9d3e7c1b5f4
Create Date: 2026-07-12

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "e2b4f6a8c0d1"
down_revision: Union[str, Sequence[str], None] = "a9d3e7c1b5f4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Web-sourced reference-architecture chunks have no page concept -- only PDF sources
    # (the 5 books, plus any PDF-based reference-architecture doc) set these.
    op.alter_column("knowledge_chunks", "page_start", existing_type=sa.Integer(), nullable=True)
    op.alter_column("knowledge_chunks", "page_end", existing_type=sa.Integer(), nullable=True)

    op.add_column(
        "knowledge_chunks",
        sa.Column("source_type", sa.Text(), server_default=sa.text("'principle'"), nullable=False),
    )
    op.add_column(
        "knowledge_chunks",
        sa.Column(
            "domain_tags", postgresql.JSONB(astext_type=sa.Text()), server_default=sa.text("'[]'::jsonb"), nullable=False
        ),
    )
    op.add_column("knowledge_chunks", sa.Column("source_url", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("knowledge_chunks", "source_url")
    op.drop_column("knowledge_chunks", "domain_tags")
    op.drop_column("knowledge_chunks", "source_type")
    op.alter_column("knowledge_chunks", "page_end", existing_type=sa.Integer(), nullable=False)
    op.alter_column("knowledge_chunks", "page_start", existing_type=sa.Integer(), nullable=False)
