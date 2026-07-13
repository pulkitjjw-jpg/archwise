import logging

from fastapi import APIRouter, Depends, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import get_db

logger = logging.getLogger("app.routers.admin")

# Workstream Z1 -- the app's first admin surface. No auth of any kind yet (the app has none
# anywhere), but deliberately kept under its own /admin path prefix (not mixed into /projects,
# /requirements, etc.) so gating everything under this router behind an admin-only check later
# is a one-line addition (a dependency on this router, or a path-prefix check in a middleware)
# rather than an audit of which individual routes need it.
router = APIRouter()

_ALLOWED_GRANULARITY = {"hour", "day"}
_ALLOWED_SORT_COLUMNS = {"started_at", "total_latency_ms", "total_cost_usd"}


@router.get("/admin/usage-summary")
async def get_usage_summary(db: AsyncSession = Depends(get_db)) -> dict:
    """Overall totals plus per-model rollups, computed fresh on every request -- this table is
    one row per model ATTEMPT (see app/models.py's LlmUsageLog), so every aggregate here either
    explicitly counts DISTINCT call_group_id (one real user-facing LLM request) or filters
    is_fix_pass=false (excludes the Gemma-validation repair calls from being double-counted as
    their own "tier")."""
    totals = (
        await db.execute(
            text(
                """
                SELECT
                    COUNT(DISTINCT call_group_id) AS total_calls,
                    COUNT(DISTINCT call_group_id) FILTER (WHERE is_served) AS total_success,
                    COALESCE(SUM(estimated_cost_usd), 0) AS total_cost_usd
                FROM llm_usage_logs
                """
            )
        )
    ).mappings().one()
    total_calls = int(totals["total_calls"])
    total_success = int(totals["total_success"])

    # "Served" breakdown -- which model actually produced the response for each successful call.
    # This is the basis for both "total calls per model (%)" and the fallback-tier stat below.
    served_rows = (
        await db.execute(
            text(
                """
                SELECT model, COUNT(*) AS served_count
                FROM llm_usage_logs
                WHERE is_served = true
                GROUP BY model
                """
            )
        )
    ).mappings().all()
    served_counts = {row["model"]: int(row["served_count"]) for row in served_rows}

    # Attempt-level stats (excludes fix-pass rows -- those aren't a "real" chain tier in their
    # own right, just a repair sub-step of the Gemma tier's attempt).
    attempt_rows = (
        await db.execute(
            text(
                """
                SELECT
                    model,
                    COUNT(*) AS attempt_count,
                    COUNT(*) FILTER (WHERE status = 'success') AS success_count,
                    AVG(latency_ms) FILTER (WHERE status = 'success') AS avg_success_latency_ms,
                    COALESCE(SUM(estimated_cost_usd), 0) AS total_cost_usd
                FROM llm_usage_logs
                WHERE is_fix_pass = false
                GROUP BY model
                """
            )
        )
    ).mappings().all()

    chain = settings.llm_chain
    attempt_stats_by_model = {row["model"]: row for row in attempt_rows}

    # Walk the CURRENTLY CONFIGURED chain (settings.llm_chain), not just whatever models happen
    # to already have log rows -- a tier that's never been reached yet (e.g. the paid last-resort
    # tier, when the free tier has been holding up fine) is itself meaningful information for
    # this dashboard ("0 attempts, 100% free-tier coverage"), not something to silently omit. Any
    # model that appears in the logs but has since been removed from the chain still gets shown
    # (tier=None) so historical data isn't dropped out from under a config change.
    per_model = []
    seen_models = set()
    for i, model in enumerate(chain):
        seen_models.add(model)
        row = attempt_stats_by_model.get(model)
        attempt_count = int(row["attempt_count"]) if row else 0
        success_count = int(row["success_count"]) if row else 0
        served_count = served_counts.get(model, 0)
        per_model.append(
            {
                "model": model,
                "tier": i + 1,
                "servedCount": served_count,
                "servedPercent": round(100 * served_count / total_success, 1) if total_success else 0.0,
                "attemptCount": attempt_count,
                "successRate": round(100 * success_count / attempt_count, 1) if attempt_count else 0.0,
                "avgLatencyMs": (
                    round(row["avg_success_latency_ms"])
                    if row and row["avg_success_latency_ms"] is not None
                    else None
                ),
                "totalCostUsd": float(row["total_cost_usd"]) if row else 0.0,
            }
        )
    for row in attempt_rows:
        if row["model"] in seen_models:
            continue
        model = row["model"]
        attempt_count = int(row["attempt_count"])
        success_count = int(row["success_count"])
        per_model.append(
            {
                "model": model,
                "tier": None,
                "servedCount": served_counts.get(model, 0),
                "servedPercent": round(100 * served_counts.get(model, 0) / total_success, 1) if total_success else 0.0,
                "attemptCount": attempt_count,
                "successRate": round(100 * success_count / attempt_count, 1) if attempt_count else 0.0,
                "avgLatencyMs": round(row["avg_success_latency_ms"]) if row["avg_success_latency_ms"] is not None else None,
                "totalCostUsd": float(row["total_cost_usd"]),
            }
        )
    # Chain order, not call volume -- an admin scanning this wants to see "is tier 1 still doing
    # most of the work" read top-to-bottom in the order it's actually tried, not sorted by whoever
    # happens to have the most calls today.
    per_model.sort(key=lambda m: (m["tier"] is None, m["tier"]))

    return {
        "totalCalls": total_calls,
        "totalSuccess": total_success,
        "totalFailure": total_calls - total_success,
        "successRate": round(100 * total_success / total_calls, 1) if total_calls else 0.0,
        "totalCostUsd": float(totals["total_cost_usd"]),
        "paidFallbackModel": chain[-1] if chain else None,
        "perModel": per_model,
    }


@router.get("/admin/usage-timeseries")
async def get_usage_timeseries(
    granularity: str = Query("day", pattern="^(hour|day)$"), db: AsyncSession = Depends(get_db)
) -> dict:
    """Calls per hour/day, counted per logical request (DISTINCT call_group_id) not per attempt
    row. `granularity` is validated against a hard allowlist before use -- date_trunc's unit
    argument can't be a bound parameter in a prepared statement, so this is the injection guard."""
    unit = granularity if granularity in _ALLOWED_GRANULARITY else "day"
    result = await db.execute(
        text(
            f"""
            SELECT
                date_trunc('{unit}', created_at) AS bucket,
                COUNT(DISTINCT call_group_id) AS call_count,
                COUNT(DISTINCT call_group_id) FILTER (WHERE is_served) AS success_count
            FROM llm_usage_logs
            GROUP BY bucket
            ORDER BY bucket
            """
        )
    )
    points = [
        {
            "bucket": row["bucket"],
            "callCount": int(row["call_count"]),
            "successCount": int(row["success_count"]),
        }
        for row in result.mappings()
    ]
    return {"granularity": unit, "points": points}


@router.get("/admin/usage-calls")
async def get_usage_calls(
    status: str | None = Query(None, pattern="^(success|failure)$"),
    model: str | None = None,
    endpoint: str | None = None,
    sort: str = Query("started_at", pattern="^(started_at|total_latency_ms|total_cost_usd)$"),
    order: str = Query("desc", pattern="^(asc|desc)$"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """One row per logical call (grouped by call_group_id, excluding fix-pass attempt rows),
    matching what the "recent calls" table needs -- endpoint, which model actually served it (or
    NULL if every tier failed), status, total latency, cost, timestamp. Filters/sort are all bound
    parameters or validated against the Query() regex allowlists above -- never raw string
    interpolation of caller input."""
    sort_column = sort if sort in _ALLOWED_SORT_COLUMNS else "started_at"
    order_dir = "ASC" if order == "asc" else "DESC"

    where_clauses = ["is_fix_pass = false"]
    params: dict = {"limit": limit, "offset": offset}
    if status == "success":
        where_clauses.append("call_group_id IN (SELECT call_group_id FROM llm_usage_logs WHERE is_served)")
    elif status == "failure":
        where_clauses.append("call_group_id NOT IN (SELECT call_group_id FROM llm_usage_logs WHERE is_served)")
    if model:
        where_clauses.append("call_group_id IN (SELECT call_group_id FROM llm_usage_logs WHERE model = :model)")
        params["model"] = model
    if endpoint:
        where_clauses.append("endpoint = :endpoint")
        params["endpoint"] = endpoint
    where_sql = " AND ".join(where_clauses)

    count_result = await db.execute(
        text(f"SELECT COUNT(DISTINCT call_group_id) FROM llm_usage_logs WHERE {where_sql}"), params
    )
    total = int(count_result.scalar_one())

    rows = (
        await db.execute(
            text(
                f"""
                SELECT
                    call_group_id,
                    MIN(created_at) AS started_at,
                    MIN(endpoint) AS endpoint,
                    (
                        SELECT model FROM llm_usage_logs sub
                        WHERE sub.call_group_id = grp.call_group_id AND sub.is_served = true
                        LIMIT 1
                    ) AS served_model,
                    (
                        SELECT model FROM llm_usage_logs sub
                        WHERE sub.call_group_id = grp.call_group_id
                        ORDER BY sub.created_at ASC LIMIT 1
                    ) AS requested_model,
                    bool_or(is_served) AS succeeded,
                    SUM(latency_ms) AS total_latency_ms,
                    COALESCE(SUM(estimated_cost_usd), 0) AS total_cost_usd
                FROM llm_usage_logs grp
                WHERE {where_sql}
                GROUP BY call_group_id
                ORDER BY {sort_column} {order_dir}
                LIMIT :limit OFFSET :offset
                """
            ),
            params,
        )
    ).mappings().all()

    calls = [
        {
            "callGroupId": str(row["call_group_id"]),
            "startedAt": row["started_at"],
            "endpoint": row["endpoint"],
            "requestedModel": row["requested_model"],
            "servedModel": row["served_model"],
            "status": "success" if row["succeeded"] else "failure",
            "totalLatencyMs": int(row["total_latency_ms"]),
            "totalCostUsd": float(row["total_cost_usd"]),
        }
        for row in rows
    ]
    return {"calls": calls, "total": total, "limit": limit, "offset": offset}
