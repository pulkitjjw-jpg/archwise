"""migrate users to clerk

Revision ID: 7aaaa82be061
Revises: 0a9a9a9853b4
Create Date: 2026-07-15 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '7aaaa82be061'
down_revision: Union[str, Sequence[str], None] = '0a9a9a9853b4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema.

    Deliberately wipes existing `users` rows rather than backfilling clerk_user_id -- there is no
    way to derive a Clerk identity from a bcrypt password hash, and per an explicit product
    decision this migration starts fresh rather than building a real user-migration path (same
    call as the earlier backend-split decision). `ON DELETE CASCADE` on projects.user_id (and
    onward through conversations/requirements/architectures/share_links) means this also clears
    every project that belonged to a real user; projects with user_id already NULL (pre-auth
    legacy rows) are untouched, same as they always were.
    """
    op.execute("DELETE FROM users")
    op.drop_column('users', 'password_hash')
    op.add_column('users', sa.Column('clerk_user_id', sa.Text(), nullable=False))
    op.create_unique_constraint('uq_users_clerk_user_id', 'users', ['clerk_user_id'])


def downgrade() -> None:
    """Downgrade schema.

    Best-effort structural reversal only -- the DELETE FROM users in upgrade() is not
    recoverable, and password_hash is re-added with no way to repopulate real hashes.
    """
    op.drop_constraint('uq_users_clerk_user_id', 'users', type_='unique')
    op.drop_column('users', 'clerk_user_id')
    op.add_column('users', sa.Column('password_hash', sa.Text(), nullable=False, server_default=''))
