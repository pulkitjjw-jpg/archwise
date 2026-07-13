"""conversations.created_at uses clock_timestamp(), not now()

Revision ID: 48d9c802a8a8
Revises: cc9e3536d012
Create Date: 2026-07-13

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "48d9c802a8a8"
down_revision: Union[str, Sequence[str], None] = "cc9e3536d012"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # now()/CURRENT_TIMESTAMP is frozen to transaction start in Postgres -- a conversation turn's
    # user row and its assistant reply are inserted in the same transaction (often 10-90+ seconds
    # apart across an LLM call), so they got IDENTICAL created_at values, making their relative
    # order undefined for any ORDER BY created_at query. clock_timestamp() returns the real
    # wall-clock time at each individual statement instead.
    op.execute("ALTER TABLE conversations ALTER COLUMN created_at SET DEFAULT clock_timestamp()")


def downgrade() -> None:
    """Downgrade schema."""
    op.execute("ALTER TABLE conversations ALTER COLUMN created_at SET DEFAULT now()")
