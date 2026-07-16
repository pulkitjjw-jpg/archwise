"""projects.user_id not null

Revision ID: 23d128cad90e
Revises: 666de2b686c2
Create Date: 2026-07-16

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "23d128cad90e"
down_revision: Union[str, Sequence[str], None] = "666de2b686c2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema.

    projects.user_id has been nullable since before Clerk auth existed (see
    8eb0d24f752f_add_users_table_and_project_user_id.py) -- pre-auth rows had no concept of a
    user and were left with user_id=NULL rather than backfilled, since there's no real owner to
    backfill them to. Verified against the live dev DB immediately before writing this migration:
    `SELECT count(*) FROM projects WHERE user_id IS NULL` returned 18 (of 32 total projects).

    Per this app's own established precedent for exactly this situation (7aaaa82be061's Clerk
    migration wiped the entire pre-Clerk `users` table on the explicit basis that "existing
    project data is not preserved -- starting fresh once the new backend is live"), these 18
    orphaned rows are deleted here rather than backfilled to a synthetic owner or left as a
    permanent nullable escape hatch. `ON DELETE CASCADE` on conversations/requirements/
    architectures/share_links.project_id (already established, not new in this migration) means
    each deleted project also takes its conversations, requirements, architectures, and share
    links with it.
    """
    op.execute("DELETE FROM projects WHERE user_id IS NULL")
    op.alter_column("projects", "user_id", existing_type=sa.UUID(), nullable=False)


def downgrade() -> None:
    """Downgrade schema.

    Best-effort structural reversal only -- the DELETE FROM projects in upgrade() is not
    recoverable, same caveat as 7aaaa82be061's downgrade.
    """
    op.alter_column("projects", "user_id", existing_type=sa.UUID(), nullable=True)
