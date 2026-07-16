import uuid

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import UsageCounter

# The free tier's lifetime caps, sourced verbatim from src/app/pricing/page.tsx's FREE_FEATURES
# list ("3 planning conversations (brainstorming + requirements)", "1 architecture generation",
# "1 architecture update when your app needs to scale up") -- module-level so a future pricing
# change is a one-line edit here, not a hunt through call sites. Keys match UsageCounter's
# `*_used` column name prefixes so check_and_increment's counter_field param maps directly onto
# both this dict and the model attribute.
FREE_TIER_LIMITS = {
    "brainstorm_sessions": 3,
    "architecture_generations": 1,
    "growth_trigger_updates": 1,
}

# Friendly, cap-specific copy consistent with the pricing page's "enough to fully experience the
# product once" framing -- deliberately NOT a generic "limit exceeded" message. There's no real
# paid tier to upgrade to yet (see the docstring precedent on UsageCounter in models.py), so
# these messages describe what happened and why, without promising an upgrade path that doesn't
# exist.
_CAP_MESSAGES = {
    "brainstorm_sessions": (
        "You've used all 3 free planning sessions -- enough to fully experience how this app turns "
        "an idea into requirements. Paid plans with unlimited sessions are coming soon."
    ),
    "architecture_generations": (
        "You've used your 1 free architecture generation. Paid plans with unlimited generations are "
        "coming soon."
    ),
    "growth_trigger_updates": (
        "You've used your 1 free architecture update. Paid plans with unlimited updates are coming "
        "soon."
    ),
}


async def get_or_create_usage_counter(db: AsyncSession, user_id: uuid.UUID) -> UsageCounter:
    """Lazily creates a user's UsageCounter row on first use -- same lazy-creation pattern as
    app/services/clerk_sync.py's get_or_create_user_by_clerk_id. Must db.commit() unconditionally
    (not just flush()) for the exact same reason documented there: get_db()'s session has no
    auto-commit-on-clean-exit, so a bare flush() here is only visible within THIS request's own
    transaction -- a GET-only or otherwise read-scoped request might never trigger any other
    commit, silently losing the newly-created row on every subsequent request."""
    counter = (await db.execute(select(UsageCounter).where(UsageCounter.user_id == user_id))).scalar_one_or_none()
    if counter:
        return counter

    counter = UsageCounter(user_id=user_id)
    db.add(counter)
    try:
        await db.commit()
    except IntegrityError:
        # Two concurrent first-requests from the same user (e.g. two rapid actions before either
        # commits) can both reach here before either commits -- the unique constraint on user_id
        # is the real guard, this just avoids surfacing that race as a 500. Re-fetch the row the
        # other request created. Same precedent as clerk_sync.py's IntegrityError handling.
        await db.rollback()
        counter = (await db.execute(select(UsageCounter).where(UsageCounter.user_id == user_id))).scalar_one_or_none()
        if not counter:
            raise
    return counter


async def check_and_increment(db: AsyncSession, user_id: uuid.UUID, counter_field: str) -> None:
    """Enforces one free-tier lifetime cap. Raises HTTPException(402, ...) if the user is on the
    free plan and already at the cap for `counter_field` (one of FREE_TIER_LIMITS' keys);
    otherwise increments the corresponding UsageCounter column in place.

    402 Payment Required is the semantically correct status for "you've used your free
    allocation" -- even though there's no real payment flow behind it yet (no Stripe in this
    pass), it's the honest HTTP-status expression of the situation, and distinguishes this from a
    plain 400 (bad request) or 403 (permission denied) a client might otherwise conflate with an
    auth/validation failure.

    Deliberately does NOT commit -- same reasoning as app/services/audit.py's write_audit_log:
    this is always called at the top of a route that goes on to do its own real work and commit
    later in the same transaction. Committing here would persist the increment even if the
    route's later work fails and rolls back, leaving a phantom increment for a request that never
    actually completed.
    """
    if counter_field not in FREE_TIER_LIMITS:
        raise ValueError(f"Unknown usage counter field: {counter_field!r}")

    counter = await get_or_create_usage_counter(db, user_id)

    if counter.plan != "free":
        # Paid = unlimited. No real paid plan exists yet (see UsageCounter's docstring), but this
        # makes the intent unambiguous for whenever billing actually lands.
        return

    used_attr = f"{counter_field}_used"
    limit = FREE_TIER_LIMITS[counter_field]
    used = getattr(counter, used_attr)

    if used >= limit:
        raise HTTPException(status_code=402, detail=_CAP_MESSAGES[counter_field])

    setattr(counter, used_attr, used + 1)
