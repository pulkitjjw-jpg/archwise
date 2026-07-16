"""HTTP-level tests for app/routers/auth.py: GET /auth/me, GDPR self-service export/delete, and
API-key / webhook self-service CRUD. All pure CRUD/data-shape logic, no LLM calls."""

import uuid

import pytest
from sqlalchemy import select

from app.models import Project, User

pytestmark = pytest.mark.asyncio


async def test_me_returns_current_user(as_user, make_user):
    user = await make_user()
    client = as_user(user)

    resp = await client.get("/api/v1/auth/me")

    assert resp.status_code == 200
    assert resp.json()["user"]["id"] == str(user.id)
    assert resp.json()["user"]["email"] == user.email


# ---------------------------------------------------------------------------
# GDPR export
# ---------------------------------------------------------------------------


async def test_export_my_data_includes_own_projects_and_nested_data(as_user, make_user, make_project, db_session):
    from app.models import Conversation

    user = await make_user()
    project = await make_project(user=user, name="Exportable")
    db_session.add(Conversation(project_id=project.id, role="user", message="hi", stage="intake"))
    await db_session.commit()

    client = as_user(user)
    resp = await client.get("/api/v1/auth/me/export")

    assert resp.status_code == 200
    body = resp.json()
    assert body["user"]["id"] == str(user.id)
    assert len(body["projects"]) == 1
    assert body["projects"][0]["name"] == "Exportable"
    assert len(body["projects"][0]["conversations"]) == 1


async def test_export_my_data_never_includes_other_users_projects(as_user, make_user, make_project):
    user = await make_user()
    other = await make_user()
    await make_project(user=other, name="Not mine")

    client = as_user(user)
    resp = await client.get("/api/v1/auth/me/export")

    assert resp.status_code == 200
    assert resp.json()["projects"] == []


# ---------------------------------------------------------------------------
# GDPR delete
# ---------------------------------------------------------------------------


async def test_delete_my_account_requires_matching_confirmation_email(as_user, make_user):
    user = await make_user(email="real@example.com")
    client = as_user(user)

    resp = await client.request(
        "DELETE", "/api/v1/auth/me", json={"confirmEmail": "wrong@example.com"}
    )

    assert resp.status_code == 400


async def test_delete_my_account_deletes_user_and_cascades_projects(as_user, make_user, make_project, db_session):
    user = await make_user(email="deleteme@example.com")
    project = await make_project(user=user)
    client = as_user(user)

    resp = await client.request("DELETE", "/api/v1/auth/me", json={"confirmEmail": "deleteme@example.com"})

    assert resp.status_code == 200
    assert resp.json()["projectsDeleted"] == 1

    # ON DELETE CASCADE (Project.user_id) means the project row must be gone too, not just the user.
    remaining_user = (await db_session.execute(select(User).where(User.id == user.id))).scalar_one_or_none()
    remaining_project = (await db_session.execute(select(Project).where(Project.id == project.id))).scalar_one_or_none()
    assert remaining_user is None
    assert remaining_project is None


# ---------------------------------------------------------------------------
# API keys
# ---------------------------------------------------------------------------


async def test_create_api_key_returns_raw_key_once(as_user, make_user):
    user = await make_user()
    client = as_user(user)

    resp = await client.post("/api/v1/auth/me/api-keys", json={"name": "CI key"})

    assert resp.status_code == 201
    body = resp.json()["apiKey"]
    assert body["name"] == "CI key"
    assert "key" in body and body["key"].startswith("arc_")
    assert body["revoked"] is False


async def test_list_api_keys_never_includes_the_raw_key(as_user, make_user):
    user = await make_user()
    client = as_user(user)
    await client.post("/api/v1/auth/me/api-keys", json={"name": "CI key"})

    resp = await client.get("/api/v1/auth/me/api-keys")

    assert resp.status_code == 200
    keys = resp.json()["apiKeys"]
    assert len(keys) == 1
    assert "key" not in keys[0]
    assert "keyHash" not in keys[0]


async def test_revoke_api_key_marks_it_revoked_and_the_key_stops_working(as_user, make_user, db_session):
    from app.dependencies import get_user_from_api_key
    from types import SimpleNamespace

    user = await make_user()
    client = as_user(user)
    create_resp = await client.post("/api/v1/auth/me/api-keys", json={"name": "Revocable"})
    raw_key = create_resp.json()["apiKey"]["key"]
    key_id = create_resp.json()["apiKey"]["id"]

    resp = await client.delete(f"/api/v1/auth/me/api-keys/{key_id}")
    assert resp.status_code == 200
    assert resp.json()["apiKey"]["revoked"] is True

    # The full real auth path (not the get_current_user override) must now reject it.
    with pytest.raises(Exception):
        await get_user_from_api_key(
            request=SimpleNamespace(state=SimpleNamespace()), authorization=f"Bearer {raw_key}", db=db_session
        )


async def test_revoke_api_key_404s_for_someone_elses_key(as_user, make_user):
    owner = await make_user()
    intruder = await make_user()
    owner_client = as_user(owner)
    create_resp = await owner_client.post("/api/v1/auth/me/api-keys", json={"name": "Owner key"})
    key_id = create_resp.json()["apiKey"]["id"]

    intruder_client = as_user(intruder)
    resp = await intruder_client.delete(f"/api/v1/auth/me/api-keys/{key_id}")

    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Webhooks
# ---------------------------------------------------------------------------


async def test_create_webhook_rejects_unknown_event_type(as_user, make_user):
    user = await make_user()
    client = as_user(user)

    resp = await client.post(
        "/api/v1/auth/me/webhooks",
        json={"url": "https://example.com/hook", "eventTypes": ["not.a.real.event"]},
    )

    assert resp.status_code == 400


async def test_create_webhook_succeeds_and_returns_secret_once(as_user, make_user):
    user = await make_user()
    client = as_user(user)

    resp = await client.post(
        "/api/v1/auth/me/webhooks",
        json={"url": "https://example.com/hook", "eventTypes": ["architecture.generated"]},
    )

    assert resp.status_code == 201
    body = resp.json()["webhook"]
    assert "secret" in body
    assert body["disabled"] is False


async def test_list_webhooks_never_includes_the_secret(as_user, make_user):
    user = await make_user()
    client = as_user(user)
    await client.post(
        "/api/v1/auth/me/webhooks",
        json={"url": "https://example.com/hook", "eventTypes": ["architecture.generated"]},
    )

    resp = await client.get("/api/v1/auth/me/webhooks")

    assert resp.status_code == 200
    assert "secret" not in resp.json()["webhooks"][0]


async def test_disable_webhook_is_idempotent(as_user, make_user):
    user = await make_user()
    client = as_user(user)
    create_resp = await client.post(
        "/api/v1/auth/me/webhooks",
        json={"url": "https://example.com/hook", "eventTypes": ["architecture.generated"]},
    )
    webhook_id = create_resp.json()["webhook"]["id"]

    resp1 = await client.delete(f"/api/v1/auth/me/webhooks/{webhook_id}")
    assert resp1.status_code == 200
    assert resp1.json()["webhook"]["disabled"] is True

    # Calling again must not error or double-log -- see disable_webhook's own idempotency guard.
    resp2 = await client.delete(f"/api/v1/auth/me/webhooks/{webhook_id}")
    assert resp2.status_code == 200
    assert resp2.json()["webhook"]["disabled"] is True


async def test_disable_webhook_404s_for_unknown_id(as_user, make_user):
    user = await make_user()
    client = as_user(user)

    resp = await client.delete(f"/api/v1/auth/me/webhooks/{uuid.uuid4()}")

    assert resp.status_code == 404
