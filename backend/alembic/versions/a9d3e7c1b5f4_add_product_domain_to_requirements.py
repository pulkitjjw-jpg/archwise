"""add product_domain to requirements (domain-awareness feature)

Revision ID: a9d3e7c1b5f4
Revises: f7c2b91a5d3e
Create Date: 2026-07-12

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "a9d3e7c1b5f4"
down_revision: Union[str, Sequence[str], None] = "f7c2b91a5d3e"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "requirements",
        sa.Column(
            "product_domain",
            postgresql.JSONB(astext_type=sa.Text()),
            # The backslash before :null escapes SQLAlchemy text()'s bind-parameter syntax.
            server_default=sa.text(r"""'{"category":"other","rationale":"","referenceSystem"\:null}'::jsonb"""),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("requirements", "product_domain")
