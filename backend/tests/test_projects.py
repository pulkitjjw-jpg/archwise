"""HTTP-level tests for app/routers/projects.py's core CRUD, driven through the real FastAPI app
via httpx.AsyncClient + ASGITransport, with get_current_user overridden to a fake authenticated
User (see conftest.py's `as_user` fixture) instead of a real Clerk JWT.

create_project calls get_next_brainstorm_turn (an LLM call) -- monkeypatched at its import site in
app.routers.projects so these tests exercise the route's own CRUD/usage-cap logic without making a
real network call, same "mock the boundary, not the thing under test" precedent as test_llm.py's
respx mocking of the OpenRouter HTTP boundary.
"""

import pytest

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


async def test_create_project_free_tier_cap_third_succeeds_fourth_is_rejected(as_user, make_user, monkeypatch):
    """End-to-end proof of the usage cap wired through the real route, not just the service
    function in isolation (see test_usage_limits.py for the unit-level version) -- 3 successful
    project creations, then a 402 on the 4th, with no project row created for the rejected one."""
    await _mock_brainstorm_turn(monkeypatch)
    user = await make_user()
    client = as_user(user)

    for _ in range(3):
        resp = await client.post(
            "/api/v1/projects", json={"name": "P", "ideaText": "idea", "hasExistingSystem": False}
        )
        assert resp.status_code == 201

    resp = await client.get("/api/v1/projects")
    assert len(resp.json()["projects"]) == 3

    resp = await client.post("/api/v1/projects", json={"name": "P4", "ideaText": "idea", "hasExistingSystem": False})
    assert resp.status_code == 402

    resp = await client.get("/api/v1/projects")
    assert len(resp.json()["projects"]) == 3
