"""HTTP-level tests for app/routers/public_api.py -- the API-key-authenticated surface. Unlike
every other router test in this suite, these deliberately do NOT use the `as_user` get_current_
user override: the whole point of this router is the OTHER auth path (get_user_from_api_key), so
these tests send a real `Authorization: Bearer <api-key>` header and let the actual hash-lookup
logic run, proving the two auth paths (Clerk session for minting the key, API key for using it)
compose correctly end to end."""

import hashlib
import uuid

import pytest

from app.models import ApiKey

pytestmark = pytest.mark.asyncio


async def _make_api_key(db_session, user, raw_key: str = "arc_public_api_test_key") -> ApiKey:
    api_key = ApiKey(
        user_id=user.id,
        name="test key",
        key_hash=hashlib.sha256(raw_key.encode()).hexdigest(),
        key_prefix=raw_key[:12],
    )
    db_session.add(api_key)
    await db_session.commit()
    return api_key


async def test_list_my_projects_via_api_key(client, make_user, make_project, db_session):
    user = await make_user()
    await make_project(user=user, name="Via API key")
    raw_key = "arc_list_test_key"
    await _make_api_key(db_session, user, raw_key)

    resp = await client.get("/api/v1/public/projects", headers={"Authorization": f"Bearer {raw_key}"})

    assert resp.status_code == 200
    names = [p["name"] for p in resp.json()["projects"]]
    assert names == ["Via API key"]


async def test_list_my_projects_rejects_missing_key(client):
    resp = await client.get("/api/v1/public/projects")
    assert resp.status_code == 401


async def test_get_my_project_via_api_key_returns_owned_project(client, make_user, make_project, db_session):
    user = await make_user()
    project = await make_project(user=user)
    raw_key = "arc_get_test_key"
    await _make_api_key(db_session, user, raw_key)

    resp = await client.get(
        f"/api/v1/public/projects/{project.id}", headers={"Authorization": f"Bearer {raw_key}"}
    )

    assert resp.status_code == 200
    assert resp.json()["project"]["id"] == str(project.id)


async def test_get_my_project_via_api_key_404s_for_someone_elses_project(client, make_user, make_project, db_session):
    owner = await make_user()
    project = await make_project(user=owner)
    intruder = await make_user()
    raw_key = "arc_intruder_test_key"
    await _make_api_key(db_session, intruder, raw_key)

    resp = await client.get(
        f"/api/v1/public/projects/{project.id}", headers={"Authorization": f"Bearer {raw_key}"}
    )

    assert resp.status_code == 404


async def test_get_my_project_via_api_key_rejects_revoked_key(client, make_user, make_project, db_session):
    from datetime import UTC, datetime

    user = await make_user()
    project = await make_project(user=user)
    raw_key = "arc_revoked_test_key"
    api_key = await _make_api_key(db_session, user, raw_key)
    api_key.revoked_at = datetime.now(UTC)
    await db_session.commit()

    resp = await client.get(
        f"/api/v1/public/projects/{project.id}", headers={"Authorization": f"Bearer {raw_key}"}
    )

    assert resp.status_code == 401
