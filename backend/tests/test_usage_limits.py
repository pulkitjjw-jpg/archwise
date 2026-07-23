"""app/services/usage_limits.py -- rolling-window usage caps (6 brainstorm sessions / 2
architecture generations / 2 growth-trigger updates per week for free, 5 of each per day for
paid), plus the admin and per-user bypasses. Exercises the real check_and_increment function
directly against a real UsageCounter row.
"""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.config import settings
from app.models import UsageCounter
from app.services.usage_limits import (
    DEFAULT_ADVANCED_FEATURE_LIMITS,
    DEFAULT_FREE_TIER_LIMITS,
    DEFAULT_PAID_TIER_LIMITS,
    check_and_increment,
    check_feature_access,
    get_or_create_usage_counter,
)

pytestmark = pytest.mark.asyncio


@pytest.fixture(autouse=True)
def _production_environment(monkeypatch):
    """check_and_increment's real enforcement logic is production-only (it no-ops entirely
    outside production -- see usage_limits.py's own docstring, so local/dev testing is never
    capped by limits meant for real end users). Every test in this module below is about that real
    enforcement logic, so force settings.environment to "production" by default; the dedicated
    TestEnvironmentGatedBypass class below explicitly overrides this back to a non-production value
    to test the bypass itself."""
    monkeypatch.setattr(settings, "environment", "production")


async def test_get_or_create_usage_counter_creates_a_zeroed_row_on_first_call(db_session, make_user):
    user = await make_user()

    counter = await get_or_create_usage_counter(db_session, user.id)

    assert counter.user_id == user.id
    assert counter.brainstorm_sessions_used == 0
    assert counter.plan == "free"
    assert counter.bypass_limits is False


async def test_get_or_create_usage_counter_returns_the_same_row_on_repeat_calls(db_session, make_user):
    user = await make_user()

    first = await get_or_create_usage_counter(db_session, user.id)
    second = await get_or_create_usage_counter(db_session, user.id)

    assert first.id == second.id
    rows = (await db_session.execute(select(UsageCounter).where(UsageCounter.user_id == user.id))).scalars().all()
    assert len(rows) == 1


async def test_check_and_increment_rejects_unknown_counter_field(db_session, make_user):
    user = await make_user()
    with pytest.raises(ValueError):
        await check_and_increment(db_session, user.id, "not_a_real_field")


async def test_brainstorm_sessions_cap_sixth_succeeds_seventh_is_rejected_and_not_incremented(db_session, make_user):
    """DEFAULT_FREE_TIER_LIMITS["brainstorm_sessions"] is 6 -- calls 1-6 must succeed and
    increment; call 7 must 402 and leave the counter untouched at 6, not silently increment to 7
    before rejecting."""
    user = await make_user()
    assert DEFAULT_FREE_TIER_LIMITS["brainstorm_sessions"] == 6

    for expected_used_after in (1, 2, 3, 4, 5, 6):
        await check_and_increment(db_session, user.id, "brainstorm_sessions")
        await db_session.commit()
        counter = await get_or_create_usage_counter(db_session, user.id)
        assert counter.brainstorm_sessions_used == expected_used_after

    with pytest.raises(HTTPException) as exc_info:
        await check_and_increment(db_session, user.id, "brainstorm_sessions")
    assert exc_info.value.status_code == 402

    # check_and_increment raises BEFORE ever calling setattr on the rejected 7th attempt (see its
    # own docstring), so nothing was mutated and there's nothing to roll back -- re-reading the
    # counter (a plain committed SELECT, no rollback/expire involved) must still show exactly 6.
    counter = await get_or_create_usage_counter(db_session, user.id)
    assert counter.brainstorm_sessions_used == 6


@pytest.mark.parametrize("field", ["architecture_generations", "growth_trigger_updates"])
async def test_double_use_caps_reject_the_third_call(db_session, make_user, field):
    user = await make_user()
    assert DEFAULT_FREE_TIER_LIMITS[field] == 2

    await check_and_increment(db_session, user.id, field)
    await db_session.commit()
    await check_and_increment(db_session, user.id, field)
    await db_session.commit()

    with pytest.raises(HTTPException) as exc_info:
        await check_and_increment(db_session, user.id, field)
    assert exc_info.value.status_code == 402

    counter = await get_or_create_usage_counter(db_session, user.id)
    assert getattr(counter, f"{field}_used") == 2


async def test_free_tier_window_resets_after_seven_days(db_session, make_user):
    """The core new behavior: a lapsed rolling window resets ALL THREE counters together and lets
    the next call through, rather than staying capped forever (the old lifetime-cap behavior)."""
    user = await make_user()

    for _ in range(6):
        await check_and_increment(db_session, user.id, "brainstorm_sessions")
        await db_session.commit()
    await check_and_increment(db_session, user.id, "architecture_generations")
    await db_session.commit()

    with pytest.raises(HTTPException):
        await check_and_increment(db_session, user.id, "brainstorm_sessions")

    # Roll the window back as if 7 days have already elapsed.
    counter = await get_or_create_usage_counter(db_session, user.id)
    counter.window_started_at = datetime.now(UTC) - timedelta(days=7, minutes=1)
    await db_session.commit()

    await check_and_increment(db_session, user.id, "brainstorm_sessions")
    await db_session.commit()

    counter = await get_or_create_usage_counter(db_session, user.id)
    assert counter.brainstorm_sessions_used == 1
    # architecture_generations_used was reset to 0 too, even though this call was only for
    # brainstorm_sessions -- the window is shared across all 3 counters.
    assert counter.architecture_generations_used == 0


async def test_paid_plan_is_capped_daily_not_unlimited(db_session, make_user):
    """Paid used to bypass enforcement entirely; it now gets its own (larger, admin-editable)
    daily allowance -- DEFAULT_PAID_TIER_LIMITS is 5 per metric."""
    user = await make_user()
    counter = await get_or_create_usage_counter(db_session, user.id)
    counter.plan = "paid"
    await db_session.commit()
    assert DEFAULT_PAID_TIER_LIMITS["brainstorm_sessions"] == 5

    for _ in range(5):
        await check_and_increment(db_session, user.id, "brainstorm_sessions")
        await db_session.commit()

    with pytest.raises(HTTPException) as exc_info:
        await check_and_increment(db_session, user.id, "brainstorm_sessions")
    assert exc_info.value.status_code == 402

    counter = await get_or_create_usage_counter(db_session, user.id)
    assert counter.brainstorm_sessions_used == 5


async def test_paid_plan_window_resets_after_one_day(db_session, make_user):
    user = await make_user()
    counter = await get_or_create_usage_counter(db_session, user.id)
    counter.plan = "paid"
    await db_session.commit()

    for _ in range(5):
        await check_and_increment(db_session, user.id, "brainstorm_sessions")
        await db_session.commit()
    with pytest.raises(HTTPException):
        await check_and_increment(db_session, user.id, "brainstorm_sessions")

    counter = await get_or_create_usage_counter(db_session, user.id)
    counter.window_started_at = datetime.now(UTC) - timedelta(days=1, minutes=1)
    await db_session.commit()

    await check_and_increment(db_session, user.id, "brainstorm_sessions")
    await db_session.commit()

    counter = await get_or_create_usage_counter(db_session, user.id)
    assert counter.brainstorm_sessions_used == 1


async def test_admin_user_bypasses_the_cap_entirely_in_production(db_session, make_user):
    """Admins get truly unlimited access, including in production -- the new production
    exception. No UsageCounter row should even be created, since the bypass returns before
    get_or_create_usage_counter is ever called."""
    admin = await make_user(is_admin=True)

    for _ in range(20):
        await check_and_increment(db_session, admin.id, "brainstorm_sessions")
        await db_session.commit()

    rows = (await db_session.execute(select(UsageCounter).where(UsageCounter.user_id == admin.id))).scalars().all()
    assert rows == []


async def test_bypass_limits_flag_grants_unlimited_access_without_admin(db_session, make_user):
    """The per-user override for non-admin testers -- distinct from is_admin, grants the same
    unconditional bypass."""
    user = await make_user()
    counter = await get_or_create_usage_counter(db_session, user.id)
    counter.bypass_limits = True
    await db_session.commit()

    for _ in range(20):
        await check_and_increment(db_session, user.id, "brainstorm_sessions")
        await db_session.commit()

    await db_session.refresh(counter)
    assert counter.brainstorm_sessions_used == 0


async def test_usage_counters_are_independent_per_user(db_session, make_user):
    user_a = await make_user()
    user_b = await make_user()

    await check_and_increment(db_session, user_a.id, "architecture_generations")
    await db_session.commit()
    await check_and_increment(db_session, user_a.id, "architecture_generations")
    await db_session.commit()

    with pytest.raises(HTTPException):
        await check_and_increment(db_session, user_a.id, "architecture_generations")

    # user_b's own cap is untouched by user_a's usage.
    await check_and_increment(db_session, user_b.id, "architecture_generations")
    await db_session.commit()
    counter_b = await get_or_create_usage_counter(db_session, user_b.id)
    assert counter_b.architecture_generations_used == 1


class TestEnvironmentGatedBypass:
    async def test_non_production_environment_bypasses_the_cap_entirely(self, db_session, make_user, monkeypatch):
        monkeypatch.setattr(settings, "environment", "development")
        user = await make_user()

        # Call well past every DEFAULT_FREE_TIER_LIMITS cap -- none of this should raise, and no
        # UsageCounter row should even be created, since the bypass returns before
        # get_or_create_usage_counter is ever called.
        for _ in range(5):
            await check_and_increment(db_session, user.id, "architecture_generations")
            await db_session.commit()

        rows = (
            (await db_session.execute(select(UsageCounter).where(UsageCounter.user_id == user.id))).scalars().all()
        )
        assert rows == []

    async def test_production_environment_still_enforces_the_cap(self, db_session, make_user, monkeypatch):
        # Sanity check alongside this module's autouse fixture: explicitly re-asserting
        # "production" (rather than relying only on the fixture default) documents that this is
        # the one environment value that must always enforce the cap.
        monkeypatch.setattr(settings, "environment", "production")
        user = await make_user()

        await check_and_increment(db_session, user.id, "architecture_generations")
        await db_session.commit()
        await check_and_increment(db_session, user.id, "architecture_generations")
        await db_session.commit()

        with pytest.raises(HTTPException) as exc_info:
            await check_and_increment(db_session, user.id, "architecture_generations")
        assert exc_info.value.status_code == 402


class TestCheckFeatureAccess:
    """check_feature_access -- the "advanced" AI features (What-If Simulator, component
    suggestions, chat proposals/refinements, requirement suggestions, executive summary exports)
    that free tier is hard-blocked from entirely, not just rationed."""

    async def test_free_user_is_blocked_regardless_of_window_state(self, db_session, make_user):
        user = await make_user()

        with pytest.raises(HTTPException) as exc_info:
            await check_feature_access(db_session, user.id, "whatif_simulator")
        assert exc_info.value.status_code == 402

        # Nothing was incremented -- a free user rejected outright never touches the counter.
        counter = await get_or_create_usage_counter(db_session, user.id)
        assert counter.whatif_simulator_used == 0

    async def test_unknown_feature_rejected(self, db_session, make_user):
        user = await make_user()
        with pytest.raises(ValueError):
            await check_feature_access(db_session, user.id, "not_a_real_feature")

    async def test_paid_user_gets_the_daily_cap_then_402s(self, db_session, make_user):
        user = await make_user()
        counter = await get_or_create_usage_counter(db_session, user.id)
        counter.plan = "paid"
        await db_session.commit()
        assert DEFAULT_ADVANCED_FEATURE_LIMITS["executive_summary_exports"] == 5

        for _ in range(5):
            await check_feature_access(db_session, user.id, "executive_summary_exports")
            await db_session.commit()

        with pytest.raises(HTTPException) as exc_info:
            await check_feature_access(db_session, user.id, "executive_summary_exports")
        assert exc_info.value.status_code == 402

        counter = await get_or_create_usage_counter(db_session, user.id)
        assert counter.executive_summary_exports_used == 5

    async def test_paid_user_window_resets_after_one_day(self, db_session, make_user):
        user = await make_user()
        counter = await get_or_create_usage_counter(db_session, user.id)
        counter.plan = "paid"
        await db_session.commit()

        for _ in range(5):
            await check_feature_access(db_session, user.id, "executive_summary_exports")
            await db_session.commit()
        with pytest.raises(HTTPException):
            await check_feature_access(db_session, user.id, "executive_summary_exports")

        counter = await get_or_create_usage_counter(db_session, user.id)
        counter.window_started_at = datetime.now(UTC) - timedelta(days=1, minutes=1)
        await db_session.commit()

        await check_feature_access(db_session, user.id, "executive_summary_exports")
        await db_session.commit()

        counter = await get_or_create_usage_counter(db_session, user.id)
        assert counter.executive_summary_exports_used == 1

    async def test_admin_bypasses_advanced_feature_gate_entirely(self, db_session, make_user):
        admin = await make_user(is_admin=True)

        for _ in range(20):
            await check_feature_access(db_session, admin.id, "whatif_simulator")
            await db_session.commit()

        rows = (
            (await db_session.execute(select(UsageCounter).where(UsageCounter.user_id == admin.id))).scalars().all()
        )
        assert rows == []

    async def test_bypass_limits_flag_grants_advanced_access_without_paid_plan(self, db_session, make_user):
        user = await make_user()
        counter = await get_or_create_usage_counter(db_session, user.id)
        counter.bypass_limits = True
        await db_session.commit()

        for _ in range(20):
            await check_feature_access(db_session, user.id, "whatif_simulator")
            await db_session.commit()

        await db_session.refresh(counter)
        assert counter.whatif_simulator_used == 0

    async def test_core_and_advanced_counters_share_one_window(self, db_session, make_user):
        """Using an advanced feature and a core action both draw against the SAME window -- when
        it resets, everything resets together, confirming _reset_window_if_elapsed covers all 9
        fields, not just the 3 it originally covered."""
        user = await make_user()
        counter = await get_or_create_usage_counter(db_session, user.id)
        counter.plan = "paid"
        await db_session.commit()

        await check_and_increment(db_session, user.id, "brainstorm_sessions")
        await db_session.commit()
        await check_feature_access(db_session, user.id, "whatif_simulator")
        await db_session.commit()

        counter = await get_or_create_usage_counter(db_session, user.id)
        assert counter.brainstorm_sessions_used == 1
        assert counter.whatif_simulator_used == 1

        counter.window_started_at = datetime.now(UTC) - timedelta(days=1, minutes=1)
        await db_session.commit()

        await check_feature_access(db_session, user.id, "component_suggestions")
        await db_session.commit()

        counter = await get_or_create_usage_counter(db_session, user.id)
        assert counter.brainstorm_sessions_used == 0
        assert counter.whatif_simulator_used == 0
        assert counter.component_suggestions_used == 1
