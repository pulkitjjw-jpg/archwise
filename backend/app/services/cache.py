"""Short-TTL caching for a small, deliberately narrow set of public, stable, frequently-hit reads
-- NOT a general-purpose cache layer. Every LLM call site in llm.py is chat-history or
architecture-state dependent (near-unique input per call), so there is no real cache-hit
opportunity there; forcing it would add risk for no benefit. The two things actually worth
caching here are read-heavy and cheap to get slightly stale: the public app-name setting (hit on
every page load) and a shared architecture's public read (hit repeatedly by anyone with the link).

Reuses the SAME Redis pool as app/services/jobs.py's arq connection (get_redis_pool) -- this is
not a second Redis dependency, just a second use of the one already required for slowapi's rate
limiter and arq's job queue.
"""

import json
from typing import Any

from fastapi.encoders import jsonable_encoder

from app.services.jobs import get_redis_pool

_PREFIX = "cache:"

# Shared between routers/settings.py (reads/populates) and routers/admin.py (invalidates on
# write) -- defined here, not in either router, so neither router imports from the other.
SETTINGS_CACHE_KEY = "settings:app"
SETTINGS_CACHE_TTL_SECONDS = 60


async def get_cached_json(key: str) -> dict[str, Any] | None:
    redis = await get_redis_pool()
    raw = await redis.get(_PREFIX + key)
    if raw is None:
        return None
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8")
    return json.loads(raw)


async def set_cached_json(key: str, value: dict[str, Any], ttl_seconds: int) -> None:
    """jsonable_encoder first (same precedent as jobs.py's set_job_status) -- callers can hand
    this a raw response dict containing datetimes/UUIDs/etc. without pre-serializing it
    themselves."""
    redis = await get_redis_pool()
    await redis.set(_PREFIX + key, json.dumps(jsonable_encoder(value)), ex=ttl_seconds)


async def delete_cached(key: str) -> None:
    """Active invalidation for the one case where correctness depends on it, not just TTL expiry
    -- an admin changing a setting shouldn't need to wait out the TTL to see it reflected."""
    redis = await get_redis_pool()
    await redis.delete(_PREFIX + key)
