import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import AuditLog


async def write_audit_log(
    db: AsyncSession,
    actor_user_id: uuid.UUID | None,
    action: str,
    target_type: str,
    target_id: str | None = None,
    extra_data: dict[str, Any] | None = None,
) -> None:
    """Records one AuditLog row for a sensitive/destructive action (admin promote/demote, app
    settings changes, self-service account deletion, ...). `action` is a free-form namespaced
    string (e.g. "user.promoted_to_admin") -- see AuditLog's own docstring in app/models.py.

    Deliberately `db.add()`, NOT a commit -- same commit-vs-flush precedent already learned the
    hard way in app/services/clerk_sync.py, just the opposite lesson: clerk_sync.py must commit
    unconditionally because it may be the ONLY write in a read-only request. This helper is the
    opposite case -- it's always called mid-request from inside a route that goes on to make its
    own real, meaningful commit (the promote/demote, the settings update, the account deletion)
    a few lines later. Committing here too would split that into two transactions for no reason,
    and would persist the audit row even if the route's own change later failed/rolled back before
    reaching its own commit -- the log would then describe something that never actually happened.
    Let the caller's own `await db.commit()` cover this row in the same transaction.
    """
    db.add(
        AuditLog(
            actor_user_id=actor_user_id,
            action=action,
            target_type=target_type,
            target_id=target_id,
            extra_data=extra_data,
        )
    )
