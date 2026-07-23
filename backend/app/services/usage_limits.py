import uuid
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models import UsageCounter, User
from app.services.app_settings import get_or_create_app_settings

# Reference only -- what the migration's server defaults encode (see f61856b2a418's/
# 9f3be55c4f66's AppSetting columns). Runtime enforcement never reads these constants directly; it
# always reads the live AppSetting row, since the whole point of this pass is that an admin can
# change these numbers from the admin panel without a code deploy. Free numbers are unchanged from
# before this pass (6/2/2) -- only the reset semantics changed (lifetime -> weekly). Paid core
# numbers are 5/10/15, not a flat 5/5/5 -- reasoned from a real architect's work day: regenerating/
# iterating an existing project happens far more often than starting brand-new ones.
DEFAULT_FREE_TIER_LIMITS = {
    "brainstorm_sessions": 6,
    "architecture_generations": 2,
    "growth_trigger_updates": 2,
}
DEFAULT_PAID_TIER_LIMITS = {
    "brainstorm_sessions": 5,
    "architecture_generations": 10,
    "growth_trigger_updates": 15,
}

# "Advanced" AI features -- hard-blocked for free tier entirely (see check_feature_access), not
# just limited, so there is no free-tier number for any of these. Each is a genuinely uncached,
# real-LLM-cost-per-call action (confirmed by reading every route: generate_flow_story/
# generate_user_journey/generate_migration_roadmap/generate_conversation_summary are all cached on
# the Architecture/Requirement row and excluded from this list on purpose -- repeat calls to those
# cost nothing, so metering them would just be friction with no cost-control benefit).
DEFAULT_ADVANCED_FEATURE_LIMITS = {
    "whatif_simulator": 15,
    "component_suggestions": 15,
    "chat_proposals": 15,
    "proposal_refinements": 25,
    "requirement_suggestions": 20,
    "executive_summary_exports": 5,
}

# Maps counter_field -> the AppSetting column name holding that plan tier's limit for it.
_LIMIT_COLUMNS = {
    "free": {
        "brainstorm_sessions": "free_brainstorm_sessions_limit",
        "architecture_generations": "free_architecture_generations_limit",
        "growth_trigger_updates": "free_growth_trigger_updates_limit",
    },
    "paid": {
        "brainstorm_sessions": "paid_brainstorm_sessions_limit",
        "architecture_generations": "paid_architecture_generations_limit",
        "growth_trigger_updates": "paid_growth_trigger_updates_limit",
    },
}
_ADVANCED_LIMIT_COLUMNS = {
    "whatif_simulator": "paid_whatif_simulator_limit",
    "component_suggestions": "paid_component_suggestions_limit",
    "chat_proposals": "paid_chat_proposals_limit",
    "proposal_refinements": "paid_proposal_refinements_limit",
    "requirement_suggestions": "paid_requirement_suggestions_limit",
    "executive_summary_exports": "paid_executive_summary_exports_limit",
}
# Rolling-window length per plan tier -- free renews weekly (generous enough to try every main
# feature once and see the product's value), paid renews daily (a real but small daily allowance,
# not the unconditional bypass it used to be). Advanced features are paid-only, so they always use
# the "paid" (1 day) window.
_WINDOW_DAYS = {"free": 7, "paid": 1}

_FIELD_LABELS = {
    "brainstorm_sessions": "planning sessions",
    "architecture_generations": "architecture generations",
    "growth_trigger_updates": "architecture updates",
    "whatif_simulator": "What-If Simulator suggestions",
    "component_suggestions": "component suggestions",
    "chat_proposals": "change proposals",
    "proposal_refinements": "proposal refinements",
    "requirement_suggestions": "requirement suggestions",
    "executive_summary_exports": "executive summary exports",
}

_ALL_COUNTER_FIELDS = tuple(DEFAULT_FREE_TIER_LIMITS) + tuple(DEFAULT_ADVANCED_FEATURE_LIMITS)


def _cap_message(counter_field: str, limit: int, window_days: int) -> str:
    label = _FIELD_LABELS[counter_field]
    period = "day" if window_days == 1 else f"{window_days} days"
    return f"You've used all {limit} of your {label} for this period -- it resets every {period}."


def _reset_window_if_elapsed(counter: UsageCounter, plan: str) -> int:
    """Shared by check_and_increment and check_feature_access -- every counter on the row (core
    AND advanced) shares ONE window per user, so whichever check happens to notice the window has
    elapsed resets everything together, not just the field it was called for. Returns the
    applicable window length in days so callers don't have to look it up twice."""
    window_days = _WINDOW_DAYS[plan]
    now = datetime.now(UTC)
    if now - counter.window_started_at >= timedelta(days=window_days):
        for field in _ALL_COUNTER_FIELDS:
            setattr(counter, f"{field}_used", 0)
        counter.window_started_at = now
    return window_days


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
    """Enforces one rolling-window usage cap on a CORE action (brainstorm/generate/update -- every
    plan gets these, just at different limits/windows). Raises HTTPException(402, ...) if the user
    is over their plan's cap for `counter_field` for the current window; otherwise increments the
    corresponding UsageCounter column in place.

    Bypass order, each checked before the next:
      1. Non-production environment -- no-op entirely (unchanged from before this pass; local/dev
         testing has never been rationed and still isn't).
      2. Admin (`User.is_admin`) -- unconditional bypass, including in production. Resolved via its
         own lookup here (not a caller-supplied User object), since every real call site
         (routers/projects.py, routers/architectures.py) only has a bare user_id at hand.
      3. Per-user override (`UsageCounter.bypass_limits`) -- the same unconditional bypass, granted
         per-user by an admin for non-admin testers (friends/colleagues trying the product
         pre-launch) without giving them real /admin/* access.
      4. Otherwise: the plan-appropriate limit (from the live AppSetting row, never a hardcoded
         constant -- admin-editable without a code deploy) and rolling window (7 days free, 1 day
         paid -- see _WINDOW_DAYS) are enforced. Every counter on the row shares ONE window per
         user (see _reset_window_if_elapsed); when it elapses, everything resets together.

    402 Payment Required is the semantically correct status for "you've used your allocation for
    this period" -- distinguishes this from a plain 400 (bad request) or 403 (permission denied).

    Deliberately does NOT commit -- same reasoning as app/services/audit.py's write_audit_log:
    this is always called at the top of a route that goes on to do its own real work and commit
    later in the same transaction. Committing here would persist the increment (and any window
    reset) even if the route's later work fails and rolls back, leaving a phantom state change for
    a request that never actually completed.
    """
    if settings.environment != "production":
        return

    if counter_field not in DEFAULT_FREE_TIER_LIMITS:
        raise ValueError(f"Unknown usage counter field: {counter_field!r}")

    user = await db.get(User, user_id)
    if user is not None and user.is_admin:
        return

    counter = await get_or_create_usage_counter(db, user_id)

    if counter.bypass_limits:
        return

    plan = counter.plan if counter.plan in _LIMIT_COLUMNS else "free"
    app_setting = await get_or_create_app_settings(db)
    limit = getattr(app_setting, _LIMIT_COLUMNS[plan][counter_field])

    window_days = _reset_window_if_elapsed(counter, plan)

    used_attr = f"{counter_field}_used"
    used = getattr(counter, used_attr)

    if used >= limit:
        raise HTTPException(status_code=402, detail=_cap_message(counter_field, limit, window_days))

    setattr(counter, used_attr, used + 1)


async def check_feature_access(db: AsyncSession, user_id: uuid.UUID, feature: str) -> None:
    """Gates one of the "advanced" AI features (What-If Simulator, manual-editor component
    suggestions, chat-based change proposals and their refinement, per-field requirement
    suggestions, executive-summary exports) -- these are hard-blocked for free-tier users
    entirely, not just rationed, since the free plan's pitch is specifically "brainstorm,
    generate, update" and nothing more. Paid users get a real daily allowance per feature, admin-
    editable exactly like check_and_increment's core caps.

    Bypass order is identical to check_and_increment (non-production no-op, admin, then per-user
    override) -- only the branch after that differs: there is no free-tier number to check against
    at all, so a non-paid, non-bypassed user is rejected outright instead of being compared to a
    limit.
    """
    if settings.environment != "production":
        return

    if feature not in DEFAULT_ADVANCED_FEATURE_LIMITS:
        raise ValueError(f"Unknown advanced feature: {feature!r}")

    user = await db.get(User, user_id)
    if user is not None and user.is_admin:
        return

    counter = await get_or_create_usage_counter(db, user_id)

    if counter.bypass_limits:
        return

    if counter.plan != "paid":
        raise HTTPException(
            status_code=402,
            detail="This feature is available on the paid plan. Upgrade to unlock it.",
        )

    app_setting = await get_or_create_app_settings(db)
    limit = getattr(app_setting, _ADVANCED_LIMIT_COLUMNS[feature])

    window_days = _reset_window_if_elapsed(counter, "paid")

    used_attr = f"{feature}_used"
    used = getattr(counter, used_attr)

    if used >= limit:
        raise HTTPException(status_code=402, detail=_cap_message(feature, limit, window_days))

    setattr(counter, used_attr, used + 1)
