"""add app_settings table

Revision ID: 0a9a9a9853b4
Revises: 8eb0d24f752f
Create Date: 2026-07-15 08:22:33.211669

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '0a9a9a9853b4'
down_revision: Union[str, Sequence[str], None] = '8eb0d24f752f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'app_settings',
        sa.Column('id', sa.UUID(), server_default=sa.text('gen_random_uuid()'), nullable=False),
        sa.Column('app_name', sa.Text(), server_default=sa.text("'Archwise'"), nullable=False),
        sa.Column('updated_at', postgresql.TIMESTAMP(timezone=True), server_default=sa.text('clock_timestamp()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )
    # Seed the single row up front so GET /settings never has to lazily create-on-read in the
    # common case (it still can, via _get_or_create_settings, but that's a fallback, not the path).
    op.execute("INSERT INTO app_settings (app_name) VALUES ('Archwise')")


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table('app_settings')
