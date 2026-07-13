"""add users table and project user_id

Revision ID: 8eb0d24f752f
Revises: 48d9c802a8a8
Create Date: 2026-07-13 18:08:39.765587

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '8eb0d24f752f'
down_revision: Union[str, Sequence[str], None] = '48d9c802a8a8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'users',
        sa.Column('id', sa.UUID(), server_default=sa.text('gen_random_uuid()'), nullable=False),
        sa.Column('email', sa.Text(), nullable=False),
        sa.Column('password_hash', sa.Text(), nullable=False),
        sa.Column('is_admin', sa.Boolean(), server_default=sa.text('false'), nullable=False),
        sa.Column('created_at', postgresql.TIMESTAMP(timezone=True), server_default=sa.text('clock_timestamp()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('email'),
    )
    op.add_column('projects', sa.Column('user_id', sa.UUID(), nullable=True))
    op.create_foreign_key('fk_projects_user_id_users', 'projects', 'users', ['user_id'], ['id'], ondelete='CASCADE')
    # Every project-scoped route now filters WHERE user_id = :current_user_id on essentially every
    # request -- worth a dedicated index rather than relying on a sequential scan.
    op.create_index('ix_projects_user_id', 'projects', ['user_id'])


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('ix_projects_user_id', table_name='projects')
    op.drop_constraint('fk_projects_user_id_users', 'projects', type_='foreignkey')
    op.drop_column('projects', 'user_id')
    op.drop_table('users')
