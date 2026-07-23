"""HTTP-level tests for app/routers/admin.py: require_admin gating on every route, promote/demote
with real AuditLog verification (old/new values), and app-settings update."""

import uuid

import pytest
from sqlalchemy import select

from app.models import AuditLog

pytestmark = pytest.mark.asyncio


async def test_non_admin_is_rejected_from_every_admin_route(as_user, make_user):
    user = await make_user(is_admin=False)
    client = as_user(user)

    resp = await client.get("/api/v1/admin/users")

    assert resp.status_code == 403


async def test_admin_can_list_users(as_user, make_user):
    admin = await make_user(is_admin=True)
    await make_user()
    client = as_user(admin)

    resp = await client.get("/api/v1/admin/users")

    assert resp.status_code == 200
    assert resp.json()["users"]


async def test_promote_user_to_admin_writes_correct_audit_log(as_user, make_user, db_session):
    admin = await make_user(is_admin=True)
    target = await make_user(is_admin=False)
    client = as_user(admin)

    resp = await client.patch(f"/api/v1/admin/users/{target.id}", json={"isAdmin": True})

    assert resp.status_code == 200
    assert resp.json()["isAdmin"] is True

    logs = (
        await db_session.execute(
            select(AuditLog).where(AuditLog.target_id == str(target.id), AuditLog.action == "user.promoted_to_admin")
        )
    ).scalars().all()
    assert len(logs) == 1
    log = logs[0]
    assert log.actor_user_id == admin.id
    assert log.target_type == "user"
    assert log.extra_data == {"old": {"isAdmin": False}, "new": {"isAdmin": True}}


async def test_demote_user_writes_correct_audit_log(as_user, make_user, db_session):
    admin = await make_user(is_admin=True)
    target = await make_user(is_admin=True)
    client = as_user(admin)

    resp = await client.patch(f"/api/v1/admin/users/{target.id}", json={"isAdmin": False})

    assert resp.status_code == 200
    logs = (
        await db_session.execute(
            select(AuditLog).where(AuditLog.target_id == str(target.id), AuditLog.action == "user.demoted_from_admin")
        )
    ).scalars().all()
    assert len(logs) == 1
    assert logs[0].extra_data == {"old": {"isAdmin": True}, "new": {"isAdmin": False}}


async def test_admin_cannot_demote_self(as_user, make_user):
    admin = await make_user(is_admin=True)
    client = as_user(admin)

    resp = await client.patch(f"/api/v1/admin/users/{admin.id}", json={"isAdmin": False})

    assert resp.status_code == 400


async def test_promote_unknown_user_404s(as_user, make_user):
    admin = await make_user(is_admin=True)
    client = as_user(admin)

    resp = await client.patch(f"/api/v1/admin/users/{uuid.uuid4()}", json={"isAdmin": True})

    assert resp.status_code == 404


async def test_update_app_settings_writes_audit_log_with_old_and_new_names(as_user, make_user, db_session):
    admin = await make_user(is_admin=True)
    client = as_user(admin)

    resp1 = await client.put("/api/v1/admin/settings", json={"appName": "First Name"})
    assert resp1.status_code == 200
    assert resp1.json()["appName"] == "First Name"

    resp2 = await client.put("/api/v1/admin/settings", json={"appName": "Second Name"})
    assert resp2.status_code == 200
    assert resp2.json()["appName"] == "Second Name"

    logs = (
        await db_session.execute(
            select(AuditLog).where(AuditLog.action == "app_setting.updated").order_by(AuditLog.created_at.asc())
        )
    ).scalars().all()
    assert len(logs) == 2
    assert logs[0].extra_data == {"old": {"appName": "Archwise"}, "new": {"appName": "First Name"}}
    assert logs[1].extra_data == {"old": {"appName": "First Name"}, "new": {"appName": "Second Name"}}


async def test_update_app_settings_is_admin_only(as_user, make_user):
    user = await make_user(is_admin=False)
    client = as_user(user)

    resp = await client.put("/api/v1/admin/settings", json={"appName": "Hacked Name"})

    assert resp.status_code == 403


async def test_usage_summary_is_admin_only(as_user, make_user):
    user = await make_user(is_admin=False)
    client = as_user(user)

    resp = await client.get("/api/v1/admin/usage-summary")

    assert resp.status_code == 403


async def test_usage_summary_returns_zeroed_totals_with_no_data(as_user, make_user):
    admin = await make_user(is_admin=True)
    client = as_user(admin)

    resp = await client.get("/api/v1/admin/usage-summary")

    assert resp.status_code == 200
    body = resp.json()
    assert body["totalCalls"] == 0
    assert body["totalSuccess"] == 0


async def test_list_users_includes_plan_and_usage_fields(as_user, make_user):
    admin = await make_user(is_admin=True)
    await make_user()
    client = as_user(admin)

    resp = await client.get("/api/v1/admin/users")

    assert resp.status_code == 200
    users = resp.json()["users"]
    assert len(users) == 2
    for u in users:
        assert u["plan"] == "free"
        assert u["bypassLimits"] is False
        assert u["usage"] == {"brainstormSessions": 0, "architectureGenerations": 0, "growthTriggerUpdates": 0}
        assert u["advancedUsage"] == {
            "whatifSimulator": 0,
            "componentSuggestions": 0,
            "chatProposals": 0,
            "proposalRefinements": 0,
            "requirementSuggestions": 0,
            "executiveSummaryExports": 0,
        }


async def test_usage_override_is_admin_only(as_user, make_user):
    user = await make_user(is_admin=False)
    target = await make_user()
    client = as_user(user)

    resp = await client.patch(f"/api/v1/admin/users/{target.id}/usage-override", json={"bypassLimits": True})

    assert resp.status_code == 403


async def test_usage_override_grants_and_revokes_writes_audit_log(as_user, make_user, db_session):
    admin = await make_user(is_admin=True)
    target = await make_user()
    client = as_user(admin)

    resp = await client.patch(f"/api/v1/admin/users/{target.id}/usage-override", json={"bypassLimits": True})
    assert resp.status_code == 200
    assert resp.json()["bypassLimits"] is True

    resp = await client.patch(f"/api/v1/admin/users/{target.id}/usage-override", json={"bypassLimits": False})
    assert resp.status_code == 200
    assert resp.json()["bypassLimits"] is False

    logs = (
        await db_session.execute(
            select(AuditLog).where(AuditLog.target_id == str(target.id)).order_by(AuditLog.created_at.asc())
        )
    ).scalars().all()
    assert [log.action for log in logs] == ["user.usage_override_enabled", "user.usage_override_disabled"]
    assert logs[0].extra_data == {"old": {"bypassLimits": False}, "new": {"bypassLimits": True}}
    assert logs[1].extra_data == {"old": {"bypassLimits": True}, "new": {"bypassLimits": False}}


async def test_usage_override_unknown_user_404s(as_user, make_user):
    admin = await make_user(is_admin=True)
    client = as_user(admin)

    resp = await client.patch(f"/api/v1/admin/users/{uuid.uuid4()}/usage-override", json={"bypassLimits": True})

    assert resp.status_code == 404


async def test_usage_reset_is_admin_only(as_user, make_user):
    user = await make_user(is_admin=False)
    target = await make_user()
    client = as_user(user)

    resp = await client.post(f"/api/v1/admin/users/{target.id}/usage-reset")

    assert resp.status_code == 403


async def test_usage_reset_zeroes_counters_and_writes_audit_log(as_user, make_user, db_session):
    from app.services.usage_limits import get_or_create_usage_counter

    admin = await make_user(is_admin=True)
    target = await make_user()
    counter = await get_or_create_usage_counter(db_session, target.id)
    counter.brainstorm_sessions_used = 4
    counter.architecture_generations_used = 2
    await db_session.commit()
    client = as_user(admin)

    resp = await client.post(f"/api/v1/admin/users/{target.id}/usage-reset")

    assert resp.status_code == 200
    assert resp.json()["usage"] == {"brainstormSessions": 0, "architectureGenerations": 0, "growthTriggerUpdates": 0}

    logs = (
        await db_session.execute(
            select(AuditLog).where(AuditLog.target_id == str(target.id), AuditLog.action == "user.usage_reset")
        )
    ).scalars().all()
    assert len(logs) == 1
    assert logs[0].extra_data == {
        "old": {
            "brainstormSessions": 4,
            "architectureGenerations": 2,
            "growthTriggerUpdates": 0,
            "whatifSimulator": 0,
            "componentSuggestions": 0,
            "chatProposals": 0,
            "proposalRefinements": 0,
            "requirementSuggestions": 0,
            "executiveSummaryExports": 0,
        }
    }


async def test_get_limits_is_admin_only(as_user, make_user):
    user = await make_user(is_admin=False)
    client = as_user(user)

    resp = await client.get("/api/v1/admin/limits")

    assert resp.status_code == 403


async def test_get_limits_returns_the_current_defaults(as_user, make_user):
    admin = await make_user(is_admin=True)
    client = as_user(admin)

    resp = await client.get("/api/v1/admin/limits")

    assert resp.status_code == 200
    body = resp.json()
    assert body["free"] == {"brainstormSessions": 6, "architectureGenerations": 2, "growthTriggerUpdates": 2}
    assert body["paid"] == {"brainstormSessions": 5, "architectureGenerations": 10, "growthTriggerUpdates": 15}
    assert body["paidAdvanced"] == {
        "whatifSimulator": 15,
        "componentSuggestions": 15,
        "chatProposals": 15,
        "proposalRefinements": 25,
        "requirementSuggestions": 20,
        "executiveSummaryExports": 5,
    }


async def test_update_limits_persists_and_writes_audit_log(as_user, make_user, db_session):
    admin = await make_user(is_admin=True)
    client = as_user(admin)

    payload = {
        "freeBrainstormSessions": 10,
        "freeArchitectureGenerations": 3,
        "freeGrowthTriggerUpdates": 3,
        "paidBrainstormSessions": 8,
        "paidArchitectureGenerations": 8,
        "paidGrowthTriggerUpdates": 8,
        "paidWhatifSimulator": 30,
        "paidComponentSuggestions": 30,
        "paidChatProposals": 30,
        "paidProposalRefinements": 40,
        "paidRequirementSuggestions": 35,
        "paidExecutiveSummaryExports": 10,
    }
    resp = await client.put("/api/v1/admin/limits", json=payload)

    assert resp.status_code == 200
    assert resp.json()["free"]["brainstormSessions"] == 10
    assert resp.json()["paid"]["brainstormSessions"] == 8
    assert resp.json()["paidAdvanced"]["whatifSimulator"] == 30

    resp = await client.get("/api/v1/admin/limits")
    assert resp.json()["free"]["brainstormSessions"] == 10
    assert resp.json()["paidAdvanced"]["executiveSummaryExports"] == 10

    logs = (
        await db_session.execute(select(AuditLog).where(AuditLog.action == "app_setting.limits_updated"))
    ).scalars().all()
    assert len(logs) == 1


async def test_update_limits_rejects_negative_numbers(as_user, make_user):
    admin = await make_user(is_admin=True)
    client = as_user(admin)

    resp = await client.put(
        "/api/v1/admin/limits",
        json={
            "freeBrainstormSessions": -1,
            "freeArchitectureGenerations": 3,
            "freeGrowthTriggerUpdates": 3,
            "paidBrainstormSessions": 8,
            "paidArchitectureGenerations": 8,
            "paidGrowthTriggerUpdates": 8,
            "paidWhatifSimulator": 30,
            "paidComponentSuggestions": 30,
            "paidChatProposals": 30,
            "paidProposalRefinements": 40,
            "paidRequirementSuggestions": 35,
            "paidExecutiveSummaryExports": 10,
        },
    )

    assert resp.status_code == 400


async def test_list_feedback_is_admin_only(as_user, make_user):
    user = await make_user(is_admin=False)
    client = as_user(user)

    resp = await client.get("/api/v1/admin/feedback")

    assert resp.status_code == 403


async def test_list_feedback_returns_submissions_newest_first(as_user, make_user):
    admin = await make_user(is_admin=True)
    user = await make_user()
    client = as_user(user)

    await client.post("/api/v1/feedback", json={"message": "first"})
    await client.post("/api/v1/feedback", json={"message": "second", "category": "bug"})

    admin_client = as_user(admin)
    resp = await admin_client.get("/api/v1/admin/feedback")

    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2
    assert [f["message"] for f in body["feedback"]] == ["second", "first"]
    assert body["feedback"][0]["category"] == "bug"
    assert body["feedback"][0]["email"] == user.email
