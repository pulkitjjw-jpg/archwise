"""HTTP-level tests for app/routers/projects.py's core CRUD, driven through the real FastAPI app
via httpx.AsyncClient + ASGITransport, with get_current_user overridden to a fake authenticated
User (see conftest.py's `as_user` fixture) instead of a real Clerk JWT.

create_project calls get_next_brainstorm_turn (an LLM call) -- monkeypatched at its import site in
app.routers.projects so these tests exercise the route's own CRUD/usage-cap logic without making a
real network call, same "mock the boundary, not the thing under test" precedent as test_llm.py's
respx mocking of the OpenRouter HTTP boundary.
"""

from datetime import UTC, datetime, timedelta

import pytest

from app.config import settings
from app.db import AsyncSessionLocal
from app.services.usage_limits import get_or_create_usage_counter

pytestmark = pytest.mark.asyncio


async def _mock_brainstorm_turn(monkeypatch):
    async def _fake_turn(*args, **kwargs):
        return {"message": "What's your expected traffic?", "suggestedReplies": ["Low", "High"], "knowledgeLevel": "beginner"}

    monkeypatch.setattr("app.routers.projects.get_next_brainstorm_turn", _fake_turn)


async def test_create_project_succeeds_and_returns_a_project_id(as_user, make_user, monkeypatch):
    await _mock_brainstorm_turn(monkeypatch)
    user = await make_user()
    client = as_user(user)

    resp = await client.post(
        "/api/v1/projects", json={"name": "My App", "ideaText": "A todo app for teams", "hasExistingSystem": False}
    )

    assert resp.status_code == 201
    body = resp.json()
    assert "projectId" in body


async def test_create_project_requires_name_and_idea_text(as_user, make_user, monkeypatch):
    await _mock_brainstorm_turn(monkeypatch)
    user = await make_user()
    client = as_user(user)

    resp = await client.post("/api/v1/projects", json={"name": "", "ideaText": ""})

    assert resp.status_code == 400


async def test_list_projects_only_returns_the_current_users_own_projects(as_user, make_user, make_project):
    owner = await make_user()
    other = await make_user()
    await make_project(user=owner, name="Owner's project")
    await make_project(user=other, name="Someone else's project")

    client = as_user(owner)
    resp = await client.get("/api/v1/projects")

    assert resp.status_code == 200
    names = [p["name"] for p in resp.json()["projects"]]
    assert names == ["Owner's project"]


async def test_get_project_returns_project_for_owner(as_user, make_user, make_project):
    owner = await make_user()
    project = await make_project(user=owner)

    client = as_user(owner)
    resp = await client.get(f"/api/v1/projects/{project.id}")

    assert resp.status_code == 200
    assert resp.json()["project"]["id"] == str(project.id)


async def test_get_project_404s_for_a_non_member(as_user, make_user, make_project):
    owner = await make_user()
    project = await make_project(user=owner)
    stranger = await make_user()

    client = as_user(stranger)
    resp = await client.get(f"/api/v1/projects/{project.id}")

    assert resp.status_code == 404


async def test_get_project_404s_for_unauthenticated_style_missing_project(as_user, make_user):
    import uuid

    user = await make_user()
    client = as_user(user)
    resp = await client.get(f"/api/v1/projects/{uuid.uuid4()}")

    assert resp.status_code == 404


async def test_create_project_free_tier_cap_sixth_succeeds_seventh_is_rejected(as_user, make_user, monkeypatch):
    """End-to-end proof of the usage cap wired through the real route, not just the service
    function in isolation (see test_usage_limits.py for the unit-level version) -- 6 successful
    project creations, then a 402 on the 7th, with no project row created for the rejected one.
    check_and_increment now no-ops outside production (see usage_limits.py), so this test must
    force settings.environment to "production" to still exercise real enforcement."""
    monkeypatch.setattr(settings, "environment", "production")
    await _mock_brainstorm_turn(monkeypatch)
    user = await make_user()
    client = as_user(user)

    for _ in range(6):
        resp = await client.post(
            "/api/v1/projects", json={"name": "P", "ideaText": "idea", "hasExistingSystem": False}
        )
        assert resp.status_code == 201

    resp = await client.get("/api/v1/projects")
    assert len(resp.json()["projects"]) == 6

    resp = await client.post("/api/v1/projects", json={"name": "P7", "ideaText": "idea", "hasExistingSystem": False})
    assert resp.status_code == 402

    resp = await client.get("/api/v1/projects")
    assert len(resp.json()["projects"]) == 6


async def test_create_project_cap_resets_after_the_weekly_window_elapses(as_user, make_user, monkeypatch):
    """The cap is a rolling 7-day window now, not a lifetime cap -- rolling window_started_at back
    past 7 days must let the 7th creation through instead of staying capped forever."""
    monkeypatch.setattr(settings, "environment", "production")
    await _mock_brainstorm_turn(monkeypatch)
    user = await make_user()
    client = as_user(user)

    for _ in range(6):
        resp = await client.post(
            "/api/v1/projects", json={"name": "P", "ideaText": "idea", "hasExistingSystem": False}
        )
        assert resp.status_code == 201

    resp = await client.post("/api/v1/projects", json={"name": "P7", "ideaText": "idea", "hasExistingSystem": False})
    assert resp.status_code == 402

    async with AsyncSessionLocal() as db:
        counter = await get_or_create_usage_counter(db, user.id)
        counter.window_started_at = datetime.now(UTC) - timedelta(days=7, minutes=1)
        await db.commit()

    resp = await client.post("/api/v1/projects", json={"name": "P7", "ideaText": "idea", "hasExistingSystem": False})
    assert resp.status_code == 201

    resp = await client.get("/api/v1/projects")
    assert len(resp.json()["projects"]) == 7


async def test_delete_project_succeeds_for_owner(as_user, make_user, make_project):
    owner = await make_user()
    project = await make_project(user=owner)
    client = as_user(owner)

    resp = await client.delete(f"/api/v1/projects/{project.id}")

    assert resp.status_code == 200
    assert resp.json() == {"ok": True}

    resp = await client.get(f"/api/v1/projects/{project.id}")
    assert resp.status_code == 404


async def test_delete_project_404s_for_a_non_owner(as_user, make_user, make_project):
    owner = await make_user()
    other = await make_user()
    project = await make_project(user=owner)
    client = as_user(other)

    resp = await client.delete(f"/api/v1/projects/{project.id}")

    assert resp.status_code == 404

    # Untouched -- the owner can still fetch it.
    owner_client = as_user(owner)
    resp = await owner_client.get(f"/api/v1/projects/{project.id}")
    assert resp.status_code == 200


async def test_delete_project_404s_for_unknown_project(as_user, make_user):
    import uuid

    user = await make_user()
    client = as_user(user)

    resp = await client.delete(f"/api/v1/projects/{uuid.uuid4()}")

    assert resp.status_code == 404


async def test_delete_project_writes_audit_log(as_user, make_user, make_project, db_session):
    from sqlalchemy import select

    from app.models import AuditLog

    owner = await make_user()
    project = await make_project(user=owner, name="Throwaway")
    client = as_user(owner)

    resp = await client.delete(f"/api/v1/projects/{project.id}")
    assert resp.status_code == 200

    logs = (
        await db_session.execute(
            select(AuditLog).where(AuditLog.target_id == str(project.id), AuditLog.action == "project.deleted")
        )
    ).scalars().all()
    assert len(logs) == 1
    assert logs[0].actor_user_id == owner.id
    assert logs[0].extra_data == {"name": "Throwaway"}


async def test_delete_project_cascades_to_conversations(as_user, make_user, make_project, db_session):
    from sqlalchemy import select

    from app.models import Conversation

    owner = await make_user()
    project = await make_project(user=owner)
    db_session.add(Conversation(project_id=project.id, role="user", message="hi", stage="intake"))
    await db_session.commit()
    client = as_user(owner)

    resp = await client.delete(f"/api/v1/projects/{project.id}")
    assert resp.status_code == 200

    remaining = (
        await db_session.execute(select(Conversation).where(Conversation.project_id == project.id))
    ).scalars().all()
    assert remaining == []
