"""add migration path generator columns

Revision ID: f3a71c9e5b21
Revises: b9e9dc2cd283
Create Date: 2026-07-12 18:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = 'f3a71c9e5b21'
down_revision: Union[str, Sequence[str], None] = 'b9e9dc2cd283'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('projects', sa.Column('has_existing_system', sa.Boolean(), server_default=sa.text('false'), nullable=False))
    op.add_column('requirements', sa.Column('existing_system', postgresql.JSONB(astext_type=sa.Text()), nullable=True))
    op.add_column('architectures', sa.Column('migration_roadmap', postgresql.JSONB(astext_type=sa.Text()), server_default=sa.text("'{}'::jsonb"), nullable=False))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('architectures', 'migration_roadmap')
    op.drop_column('requirements', 'existing_system')
    op.drop_column('projects', 'has_existing_system')
