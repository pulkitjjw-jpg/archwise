"""app/services/usage_limits.py -- the free-tier cap enforcement (3 brainstorm sessions / 1
architecture generation / 1 growth-trigger update, lifetime, per user). Exercises the real
check_and_increment function directly against a real UsageCounter row, matching the live-verified
behavior from this session: the 3rd call succeeds, the 4th 402s, and a rejected call never
increments the counter.
"""

import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.models import UsageCounter
from app.services.usage_limits import (
    FREE_TIER_LIMITS,
    check_and_increment,
    get_or_create_usage_counter,
)

pytestmark = pytest.mark.asyncio


async def test_get_or_create_usage_counter_creates_a_zeroed_row_on_first_call(db_session, make_user):
    user = await make_user()

    counter = await get_or_create_usage_counter(db_session, user.id)

    assert counter.user_id == user.id
    assert counter.brainstorm_sessions_used == 0
    assert counter.plan == "free"


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


async def test_brainstorm_sessions_cap_third_succeeds_fourth_is_rejected_and_not_incremented(db_session, make_user):
    """Mirrors this session's own live-verified behavior: FREE_TIER_LIMITS["brainstorm_sessions"]
    is 3 -- calls 1-3 must succeed and increment; call 4 must 402 and leave the counter untouched
    at 3, not silently increment to 4 before rejecting."""
    user = await make_user()
    assert FREE_TIER_LIMITS["brainstorm_sessions"] == 3

    for expected_used_after in (1, 2, 3):
        await check_and_increment(db_session, user.id, "brainstorm_sessions")
        await db_session.commit()
        counter = await get_or_create_usage_counter(db_session, user.id)
        assert counter.brainstorm_sessions_used == expected_used_after

    with pytest.raises(HTTPException) as exc_info:
        await check_and_increment(db_session, user.id, "brainstorm_sessions")
    assert exc_info.value.status_code == 402

    # check_and_increment raises BEFORE ever calling setattr on the rejected 4th attempt (see its
    # own docstring), so nothing was mutated and there's nothing to roll back -- re-reading the
    # counter (a plain committed SELECT, no rollback/expire involved) must still show exactly 3.
    counter = await get_or_create_usage_counter(db_session, user.id)
    assert counter.brainstorm_sessions_used == 3


@pytest.mark.parametrize("field", ["architecture_generations", "growth_trigger_updates"])
async def test_single_use_caps_reject_the_second_call(db_session, make_user, field):
    user = await make_user()
    assert FREE_TIER_LIMITS[field] == 1

    await check_and_increment(db_session, user.id, field)
    await db_session.commit()

    with pytest.raises(HTTPException) as exc_info:
        await check_and_increment(db_session, user.id, field)
    assert exc_info.value.status_code == 402

    counter = await get_or_create_usage_counter(db_session, user.id)
    assert getattr(counter, f"{field}_used") == 1


async def test_paid_plan_is_never_capped(db_session, make_user):
    user = await make_user()
    counter = await get_or_create_usage_counter(db_session, user.id)
    counter.plan = "paid"
    counter.brainstorm_sessions_used = 999
    await db_session.commit()

    # Should not raise and should not increment further -- paid is unlimited, not "a very high
    # limit".
    await check_and_increment(db_session, user.id, "brainstorm_sessions")
    await db_session.commit()

    await db_session.refresh(counter)
    assert counter.brainstorm_sessions_used == 999


async def test_usage_counters_are_independent_per_user(db_session, make_user):
    user_a = await make_user()
    user_b = await make_user()

    await check_and_increment(db_session, user_a.id, "architecture_generations")
    await db_session.commit()

    with pytest.raises(HTTPException):
        await check_and_increment(db_session, user_a.id, "architecture_generations")

    # user_b's own cap is untouched by user_a's usage.
    await check_and_increment(db_session, user_b.id, "architecture_generations")
    await db_session.commit()
    counter_b = await get_or_create_usage_counter(db_session, user_b.id)
    assert counter_b.architecture_generations_used == 1
