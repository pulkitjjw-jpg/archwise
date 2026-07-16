import pytest

pytestmark = pytest.mark.asyncio


async def test_health_requires_internal_auth_header(client):
    # No override needed -- health is unauthenticated but still behind require_internal_auth,
    # which `client` already carries by default.
    resp = await client.get("/api/health")
    assert resp.status_code == 200


async def test_missing_internal_auth_header_is_rejected(client):
    client.headers.pop("x-internal-auth", None)
    resp = await client.get("/api/health")
    assert resp.status_code == 401


async def test_make_user_and_project_fixtures_work(make_user, make_project):
    user = await make_user()
    project = await make_project(user=user)
    assert project.user_id == user.id
