"""add knowledge_chunks (pgvector RAG knowledge base)

Revision ID: d1f6a3b8c4e2
Revises: a4d9e6f18c02
Create Date: 2026-07-12

"""
from typing import Sequence, Union

import pgvector.sqlalchemy
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "d1f6a3b8c4e2"
down_revision: Union[str, Sequence[str], None] = "a4d9e6f18c02"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Must match app.constants.KNOWLEDGE_EMBEDDING_DIM (BAAI/bge-small-en-v1.5 via fastembed).
EMBEDDING_DIM = 384


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    op.create_table(
        "knowledge_chunks",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("book_title", sa.Text(), nullable=False),
        sa.Column("author", sa.Text(), nullable=False),
        sa.Column("chapter_title", sa.Text(), nullable=True),
        sa.Column("page_start", sa.Integer(), nullable=False),
        sa.Column("page_end", sa.Integer(), nullable=False),
        sa.Column("chunk_text", sa.Text(), nullable=False),
        sa.Column("embedding", pgvector.sqlalchemy.Vector(EMBEDDING_DIM), nullable=False),
        sa.Column(
            "topic_tags", postgresql.JSONB(astext_type=sa.Text()), server_default=sa.text("'[]'::jsonb"), nullable=False
        ),
        sa.Column("created_at", postgresql.TIMESTAMP(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    # HNSW over IVFFlat -- doesn't need a minimum row count / ANALYZE pass to be useful, which
    # matters here since ingestion runs book-by-book (the index is live and reasonably effective
    # from the very first row, not just after the full 5-book corpus is loaded).
    op.execute(
        "CREATE INDEX knowledge_chunks_embedding_hnsw_idx ON knowledge_chunks "
        "USING hnsw (embedding vector_cosine_ops)"
    )


def downgrade() -> None:
    op.drop_table("knowledge_chunks")
    op.execute("DROP EXTENSION IF EXISTS vector")
