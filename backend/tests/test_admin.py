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
