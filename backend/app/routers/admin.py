import logging
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import get_db
from app.dependencies import require_admin
from app.models import AppSetting, User
from app.schemas import (
    UpdateAppSettingsRequest,
    UpdateUsageLimitsRequest,
    UpdateUserAdminRequest,
    UpdateUserUsageOverrideRequest,
)
from app.services.app_settings import get_or_create_app_settings as _get_or_create_settings
from app.services.audit import write_audit_log
from app.services.cache import SETTINGS_CACHE_KEY, delete_cached
from app.services.usage_limits import get_or_create_usage_counter

logger = logging.getLogger("app.routers.admin")

# Workstream Z1 -- the app's first admin surface, kept under its own /admin path prefix (not
# mixed into /projects, /requirements, etc.). Now gated behind require_admin (Phase B, Milestone
# 1) on every route in this router -- see app/dependencies.py. The first admin account is
# promoted with a one-off `UPDATE users SET is_admin = true WHERE email = '...'`; there's no
# self-serve promotion UI for a single-admin setup.
router = APIRouter()

_ALLOWED_GRANULARITY = {"hour", "day"}
_ALLOWED_SORT_COLUMNS = {"started_at", "total_latency_ms", "total_cost_usd"}


@router.get("/admin/usage-summary")
async def get_usage_summary(db: AsyncSession = Depends(get_db), _admin: User = Depends(require_admin)) -> dict:
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
    granularity: str = Query("day", pattern="^(hour|day)$"),
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_admin),
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
    _admin: User = Depends(require_admin),
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


@router.put("/admin/settings")
async def update_settings(
    payload: UpdateAppSettingsRequest, db: AsyncSession = Depends(get_db), _admin: User = Depends(require_admin)
) -> dict:
    setting = await _get_or_create_settings(db)
    old_app_name = setting.app_name
    setting.app_name = payload.appName
    await write_audit_log(
        db,
        actor_user_id=_admin.id,
        action="app_setting.updated",
        target_type="app_setting",
        target_id=str(setting.id),
        extra_data={"old": {"appName": old_app_name}, "new": {"appName": setting.app_name}},
    )
    await db.commit()
    await delete_cached(SETTINGS_CACHE_KEY)
    return {"appName": setting.app_name}


@router.get("/admin/users")
async def list_users(db: AsyncSession = Depends(get_db), _admin: User = Depends(require_admin)) -> dict:
    """Project count via a LEFT JOIN + GROUP BY (not a per-user N+1 query) -- same aggregation
    shape as projects.py's list_projects, just keyed by user instead of by project. Also joins
    usage_counters so the admin panel can show plan/bypass/usage without a second round-trip per
    user -- COALESCE'd since a user with no UsageCounter row yet (never triggered
    get_or_create_usage_counter) should read as the same defaults that row would have had."""
    rows = (
        await db.execute(
            text(
                """
                SELECT
                    u.id,
                    u.email,
                    u.is_admin,
                    u.created_at,
                    COUNT(p.id) AS project_count,
                    COALESCE(uc.plan, 'free') AS plan,
                    COALESCE(uc.bypass_limits, false) AS bypass_limits,
                    COALESCE(uc.brainstorm_sessions_used, 0) AS brainstorm_sessions_used,
                    COALESCE(uc.architecture_generations_used, 0) AS architecture_generations_used,
                    COALESCE(uc.growth_trigger_updates_used, 0) AS growth_trigger_updates_used,
                    COALESCE(uc.whatif_simulator_used, 0) AS whatif_simulator_used,
                    COALESCE(uc.component_suggestions_used, 0) AS component_suggestions_used,
                    COALESCE(uc.chat_proposals_used, 0) AS chat_proposals_used,
                    COALESCE(uc.proposal_refinements_used, 0) AS proposal_refinements_used,
                    COALESCE(uc.requirement_suggestions_used, 0) AS requirement_suggestions_used,
                    COALESCE(uc.executive_summary_exports_used, 0) AS executive_summary_exports_used,
                    uc.window_started_at
                FROM users u
                LEFT JOIN projects p ON p.user_id = u.id
                LEFT JOIN usage_counters uc ON uc.user_id = u.id
                GROUP BY u.id, u.email, u.is_admin, u.created_at, uc.plan, uc.bypass_limits,
                         uc.brainstorm_sessions_used, uc.architecture_generations_used,
                         uc.growth_trigger_updates_used, uc.whatif_simulator_used,
                         uc.component_suggestions_used, uc.chat_proposals_used,
                         uc.proposal_refinements_used, uc.requirement_suggestions_used,
                         uc.executive_summary_exports_used, uc.window_started_at
                ORDER BY u.created_at DESC
                """
            )
        )
    ).mappings().all()
    return {
        "users": [
            {
                "id": str(row["id"]),
                "email": row["email"],
                "isAdmin": row["is_admin"],
                "createdAt": row["created_at"],
                "projectCount": int(row["project_count"]),
                "plan": row["plan"],
                "bypassLimits": row["bypass_limits"],
                "usage": {
                    "brainstormSessions": int(row["brainstorm_sessions_used"]),
                    "architectureGenerations": int(row["architecture_generations_used"]),
                    "growthTriggerUpdates": int(row["growth_trigger_updates_used"]),
                },
                "advancedUsage": {
                    "whatifSimulator": int(row["whatif_simulator_used"]),
                    "componentSuggestions": int(row["component_suggestions_used"]),
                    "chatProposals": int(row["chat_proposals_used"]),
                    "proposalRefinements": int(row["proposal_refinements_used"]),
                    "requirementSuggestions": int(row["requirement_suggestions_used"]),
                    "executiveSummaryExports": int(row["executive_summary_exports_used"]),
                },
                "windowStartedAt": row["window_started_at"],
            }
            for row in rows
        ]
    }


@router.patch("/admin/users/{user_id}")
async def update_user_admin_status(
    user_id: uuid.UUID,
    payload: UpdateUserAdminRequest,
    db: AsyncSession = Depends(get_db),
    admin_user: User = Depends(require_admin),
) -> dict:
    if user_id == admin_user.id and not payload.isAdmin:
        # A lone admin demoting themselves would lock the whole admin panel behind a manual
        # DB UPDATE again -- the exact one-off step this endpoint exists to avoid repeating.
        raise HTTPException(status_code=400, detail="You cannot remove your own admin access")
    target = await db.get(User, user_id)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    old_is_admin = target.is_admin
    target.is_admin = payload.isAdmin
    await write_audit_log(
        db,
        actor_user_id=admin_user.id,
        action="user.promoted_to_admin" if payload.isAdmin else "user.demoted_from_admin",
        target_type="user",
        target_id=str(target.id),
        extra_data={"old": {"isAdmin": old_is_admin}, "new": {"isAdmin": target.is_admin}},
    )
    await db.commit()
    return {"id": str(target.id), "email": target.email, "isAdmin": target.is_admin}


@router.patch("/admin/users/{user_id}/usage-override")
async def update_user_usage_override(
    user_id: uuid.UUID,
    payload: UpdateUserUsageOverrideRequest,
    db: AsyncSession = Depends(get_db),
    admin_user: User = Depends(require_admin),
) -> dict:
    """Grants/revokes unrationed feature access to a non-admin user -- for friends/colleagues
    testing pre-launch. Deliberately a separate flag from is_admin (update_user_admin_status
    above): this never grants /admin/* access, only bypasses usage_limits.py's enforcement (see
    check_and_increment's bypass order)."""
    target = await db.get(User, user_id)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    counter = await get_or_create_usage_counter(db, target.id)
    old_bypass = counter.bypass_limits
    counter.bypass_limits = payload.bypassLimits
    await write_audit_log(
        db,
        actor_user_id=admin_user.id,
        action="user.usage_override_enabled" if payload.bypassLimits else "user.usage_override_disabled",
        target_type="user",
        target_id=str(target.id),
        extra_data={"old": {"bypassLimits": old_bypass}, "new": {"bypassLimits": counter.bypass_limits}},
    )
    await db.commit()
    return {"id": str(target.id), "bypassLimits": counter.bypass_limits}


@router.post("/admin/users/{user_id}/usage-reset")
async def reset_user_usage(
    user_id: uuid.UUID, db: AsyncSession = Depends(get_db), admin_user: User = Depends(require_admin)
) -> dict:
    """Zeroes a user's usage counters and restarts their rolling window immediately -- lets an
    admin (or a tester the admin is helping) keep testing without waiting for the natural
    weekly/daily reset."""
    target = await db.get(User, user_id)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    counter = await get_or_create_usage_counter(db, target.id)
    old_usage = {
        "brainstormSessions": counter.brainstorm_sessions_used,
        "architectureGenerations": counter.architecture_generations_used,
        "growthTriggerUpdates": counter.growth_trigger_updates_used,
        "whatifSimulator": counter.whatif_simulator_used,
        "componentSuggestions": counter.component_suggestions_used,
        "chatProposals": counter.chat_proposals_used,
        "proposalRefinements": counter.proposal_refinements_used,
        "requirementSuggestions": counter.requirement_suggestions_used,
        "executiveSummaryExports": counter.executive_summary_exports_used,
    }
    counter.brainstorm_sessions_used = 0
    counter.architecture_generations_used = 0
    counter.growth_trigger_updates_used = 0
    counter.whatif_simulator_used = 0
    counter.component_suggestions_used = 0
    counter.chat_proposals_used = 0
    counter.proposal_refinements_used = 0
    counter.requirement_suggestions_used = 0
    counter.executive_summary_exports_used = 0
    counter.window_started_at = datetime.now(UTC)
    await write_audit_log(
        db,
        actor_user_id=admin_user.id,
        action="user.usage_reset",
        target_type="user",
        target_id=str(target.id),
        extra_data={"old": old_usage},
    )
    await db.commit()
    return {
        "id": str(target.id),
        "usage": {"brainstormSessions": 0, "architectureGenerations": 0, "growthTriggerUpdates": 0},
        "advancedUsage": {
            "whatifSimulator": 0,
            "componentSuggestions": 0,
            "chatProposals": 0,
            "proposalRefinements": 0,
            "requirementSuggestions": 0,
            "executiveSummaryExports": 0,
        },
        "windowStartedAt": counter.window_started_at,
    }


def _serialize_limits(s: AppSetting) -> dict:
    return {
        "free": {
            "brainstormSessions": s.free_brainstorm_sessions_limit,
            "architectureGenerations": s.free_architecture_generations_limit,
            "growthTriggerUpdates": s.free_growth_trigger_updates_limit,
        },
        "paid": {
            "brainstormSessions": s.paid_brainstorm_sessions_limit,
            "architectureGenerations": s.paid_architecture_generations_limit,
            "growthTriggerUpdates": s.paid_growth_trigger_updates_limit,
        },
        # Advanced AI features -- paid-only (see check_feature_access), no "free" section since
        # free tier is hard-blocked from all of these rather than given a number.
        "paidAdvanced": {
            "whatifSimulator": s.paid_whatif_simulator_limit,
            "componentSuggestions": s.paid_component_suggestions_limit,
            "chatProposals": s.paid_chat_proposals_limit,
            "proposalRefinements": s.paid_proposal_refinements_limit,
            "requirementSuggestions": s.paid_requirement_suggestions_limit,
            "executiveSummaryExports": s.paid_executive_summary_exports_limit,
        },
    }


@router.get("/admin/limits")
async def get_usage_limits(db: AsyncSession = Depends(get_db), _admin: User = Depends(require_admin)) -> dict:
    s = await _get_or_create_settings(db)
    return _serialize_limits(s)


@router.put("/admin/limits")
async def update_usage_limits(
    payload: UpdateUsageLimitsRequest, db: AsyncSession = Depends(get_db), admin_user: User = Depends(require_admin)
) -> dict:
    s = await _get_or_create_settings(db)
    old = _serialize_limits(s)
    s.free_brainstorm_sessions_limit = payload.freeBrainstormSessions
    s.free_architecture_generations_limit = payload.freeArchitectureGenerations
    s.free_growth_trigger_updates_limit = payload.freeGrowthTriggerUpdates
    s.paid_brainstorm_sessions_limit = payload.paidBrainstormSessions
    s.paid_architecture_generations_limit = payload.paidArchitectureGenerations
    s.paid_growth_trigger_updates_limit = payload.paidGrowthTriggerUpdates
    s.paid_whatif_simulator_limit = payload.paidWhatifSimulator
    s.paid_component_suggestions_limit = payload.paidComponentSuggestions
    s.paid_chat_proposals_limit = payload.paidChatProposals
    s.paid_proposal_refinements_limit = payload.paidProposalRefinements
    s.paid_requirement_suggestions_limit = payload.paidRequirementSuggestions
    s.paid_executive_summary_exports_limit = payload.paidExecutiveSummaryExports
    await write_audit_log(
        db,
        actor_user_id=admin_user.id,
        action="app_setting.limits_updated",
        target_type="app_setting",
        target_id=str(s.id),
        extra_data={"old": old, "new": _serialize_limits(s)},
    )
    await db.commit()
    return await get_usage_limits(db, admin_user)


@router.get("/admin/feedback")
async def list_feedback(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_admin),
) -> dict:
    """Paginated, same limit/offset/total shape as get_usage_calls above."""
    total = (await db.execute(text("SELECT COUNT(*) FROM feedback"))).scalar_one()
    rows = (
        await db.execute(
            text(
                """
                SELECT id, user_id, email, category, message, created_at
                FROM feedback
                ORDER BY created_at DESC
                LIMIT :limit OFFSET :offset
                """
            ),
            {"limit": limit, "offset": offset},
        )
    ).mappings().all()
    return {
        "feedback": [
            {
                "id": str(row["id"]),
                "userId": str(row["user_id"]) if row["user_id"] else None,
                "email": row["email"],
                "category": row["category"],
                "message": row["message"],
                "createdAt": row["created_at"],
            }
            for row in rows
        ],
        "total": int(total),
        "limit": limit,
        "offset": offset,
    }
