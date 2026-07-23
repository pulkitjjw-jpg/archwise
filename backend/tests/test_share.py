"""HTTP-level tests for app/routers/share.py -- had ZERO test coverage before this (a real,
pre-existing gap, not introduced here), surfaced while adding rate limiting to every route in
this file (the production-readiness audit flagged GET /share/{token} specifically as the one
fully public, unauthenticated read in the whole app with no rate limiting at all, unlike every
other real endpoint). These tests confirm the actual CRUD/ownership/visibility behavior still
works with the added `request: Request` params and `@limiter.limit(...)` decorators.
"""

import pytest

pytestmark = pytest.mark.asyncio


async def _make_architecture(db_session, project, version="0.1.0"):
    from app.models import Architecture

    arch = Architecture(
        project_id=project.id,
        version=version,
        hld={"components": [], "connections": []},
        reasoning={"decisions": [], "assumptions": [], "risks": [], "recommendation": None, "diff": None},
    )
    db_session.add(arch)
    await db_session.commit()
    return arch


async def test_create_share_link_for_owned_project(as_user, make_user, make_project):
    owner = await make_user()
    project = await make_project(user=owner)
    client = as_user(owner)

    resp = await client.post(f"/api/v1/projects/{project.id}/share-links")

    assert resp.status_code == 201
    link = resp.json()["shareLink"]
    assert link["projectId"] == str(project.id)
    assert link["isActive"] is True
    assert len(link["token"]) > 20  # real high-entropy token, not a placeholder


async def test_create_share_link_404s_for_a_non_owner(as_user, make_user, make_project):
    owner = await make_user()
    project = await make_project(user=owner)
    stranger = await make_user()
    client = as_user(stranger)

    resp = await client.post(f"/api/v1/projects/{project.id}/share-links")

    assert resp.status_code == 404


async def test_list_share_links_returns_newest_first(as_user, make_user, make_project):
    owner = await make_user()
    project = await make_project(user=owner)
    client = as_user(owner)

    first = (await client.post(f"/api/v1/projects/{project.id}/share-links")).json()["shareLink"]
    second = (await client.post(f"/api/v1/projects/{project.id}/share-links")).json()["shareLink"]

    resp = await client.get(f"/api/v1/projects/{project.id}/share-links")

    assert resp.status_code == 200
    tokens = [link["token"] for link in resp.json()["shareLinks"]]
    assert tokens == [second["token"], first["token"]]


async def test_revoke_share_link_makes_it_immediately_inaccessible(as_user, make_user, make_project, db_session):
    owner = await make_user()
    project = await make_project(user=owner)
    await _make_architecture(db_session, project)
    client = as_user(owner)

    link = (await client.post(f"/api/v1/projects/{project.id}/share-links")).json()["shareLink"]
    token = link["token"]

    # Works while active.
    assert (await client.get(f"/api/v1/share/{token}")).status_code == 200

    revoke_resp = await client.delete(f"/api/v1/projects/{project.id}/share-links/{link['id']}")
    assert revoke_resp.status_code == 200
    assert revoke_resp.json()["shareLink"]["isActive"] is False

    # 404s immediately after revoke, not just delisted.
    assert (await client.get(f"/api/v1/share/{token}")).status_code == 404


async def test_revoke_share_link_404s_for_wrong_project(as_user, make_user, make_project):
    owner = await make_user()
    project_a = await make_project(user=owner, name="A")
    project_b = await make_project(user=owner, name="B")
    client = as_user(owner)

    link = (await client.post(f"/api/v1/projects/{project_a.id}/share-links")).json()["shareLink"]

    resp = await client.delete(f"/api/v1/projects/{project_b.id}/share-links/{link['id']}")

    assert resp.status_code == 404


async def test_get_shared_architecture_is_public_no_auth_needed(client, make_user, make_project, db_session):
    """The one deliberately public, unauthenticated route in this router -- uses the raw `client`
    fixture (no as_user override) to prove it, matching test_public_api.py's own precedent for
    testing an auth-path distinctly from the Clerk-session default."""
    from app.models import ShareLink

    owner = await make_user()
    project = await make_project(user=owner, name="Publicly Shared Project")
    await _make_architecture(db_session, project)
    link = ShareLink(project_id=project.id, token="a-real-looking-public-token")
    db_session.add(link)
    await db_session.commit()

    resp = await client.get("/api/v1/share/a-real-looking-public-token")

    assert resp.status_code == 200
    assert resp.json()["projectName"] == "Publicly Shared Project"


async def test_get_shared_architecture_404s_for_unknown_token(client):
    resp = await client.get("/api/v1/share/not-a-real-token-at-all")
    assert resp.status_code == 404


async def test_get_shared_architecture_404s_when_no_architecture_generated_yet(client, make_user, make_project, db_session):
    from app.models import ShareLink

    owner = await make_user()
    project = await make_project(user=owner)
    link = ShareLink(project_id=project.id, token="a-token-with-no-architecture-yet")
    db_session.add(link)
    await db_session.commit()

    resp = await client.get("/api/v1/share/a-token-with-no-architecture-yet")

    assert resp.status_code == 404
