"""HTTP-level tests for the non-LLM, non-rules-engine slice of app/routers/architectures.py:
listing (GET, with and without ?all=true) and the layout-override PATCH. Everything else in that
router either calls the LLM fallback chain or the deterministic rules/cloud-mapping engines, both
explicitly out of scope for this pass (see the task's own scoping).
"""

import uuid

import pytest

from app.models import Architecture

pytestmark = pytest.mark.asyncio


async def _make_architecture(db_session, project, version="0.1.0", **kwargs):
    arch = Architecture(
        project_id=project.id,
        version=version,
        hld={"components": [], "connections": []},
        reasoning={"decisions": [], "assumptions": [], "risks": [], "recommendation": None, "diff": None},
        **kwargs,
    )
    db_session.add(arch)
    await db_session.commit()
    await db_session.refresh(arch)
    return arch


async def test_list_architectures_returns_null_when_none_exist(as_user, make_user, make_project):
    owner = await make_user()
    project = await make_project(user=owner)
    client = as_user(owner)

    resp = await client.get(f"/api/v1/projects/{project.id}/architectures")

    assert resp.status_code == 200
    assert resp.json()["architecture"] is None


async def test_list_architectures_returns_latest_by_default(as_user, make_user, make_project, db_session):
    owner = await make_user()
    project = await make_project(user=owner)
    await _make_architecture(db_session, project, version="0.1.0")
    latest = await _make_architecture(db_session, project, version="0.1.1")

    client = as_user(owner)
    resp = await client.get(f"/api/v1/projects/{project.id}/architectures")

    assert resp.status_code == 200
    assert resp.json()["architecture"]["id"] == str(latest.id)


async def test_list_architectures_with_all_true_returns_every_version(as_user, make_user, make_project, db_session):
    owner = await make_user()
    project = await make_project(user=owner)
    await _make_architecture(db_session, project, version="0.1.0")
    await _make_architecture(db_session, project, version="0.1.1")

    client = as_user(owner)
    resp = await client.get(f"/api/v1/projects/{project.id}/architectures?all=true")

    assert resp.status_code == 200
    assert len(resp.json()["architectures"]) == 2


async def test_list_architectures_404s_for_a_non_member(as_user, make_user, make_project):
    owner = await make_user()
    project = await make_project(user=owner)
    stranger = await make_user()

    client = as_user(stranger)
    resp = await client.get(f"/api/v1/projects/{project.id}/architectures")

    assert resp.status_code == 404


async def test_update_layout_override_merges_into_existing_overrides(as_user, make_user, make_project, db_session):
    owner = await make_user()
    project = await make_project(user=owner)
    arch = await _make_architecture(db_session, project, layout_overrides={"comp-1": {"x": 1.0, "y": 2.0}})

    client = as_user(owner)
    resp = await client.patch(
        f"/api/v1/projects/{project.id}/architectures/{arch.id}/layout",
        json={"componentId": "comp-2", "x": 10.0, "y": 20.0},
    )

    assert resp.status_code == 200
    overrides = resp.json()["layoutOverrides"]
    # The new key was merged in, and the PRE-EXISTING key survived -- this is a merge, not a
    # replace (see update_layout_override's own docstring/implementation).
    assert overrides["comp-1"] == {"x": 1.0, "y": 2.0}
    assert overrides["comp-2"] == {"x": 10.0, "y": 20.0}


async def test_update_layout_override_404s_for_wrong_project(as_user, make_user, make_project, db_session):
    owner = await make_user()
    project_a = await make_project(user=owner, name="A")
    project_b = await make_project(user=owner, name="B")
    arch = await _make_architecture(db_session, project_a)

    client = as_user(owner)
    # architecture belongs to project_a, but the URL references project_b -- must not be found.
    resp = await client.patch(
        f"/api/v1/projects/{project_b.id}/architectures/{arch.id}/layout",
        json={"componentId": "comp-1", "x": 1.0, "y": 1.0},
    )

    assert resp.status_code == 404


async def test_update_layout_override_404s_for_nonexistent_architecture(as_user, make_user, make_project):
    owner = await make_user()
    project = await make_project(user=owner)
    client = as_user(owner)

    resp = await client.patch(
        f"/api/v1/projects/{project.id}/architectures/{uuid.uuid4()}/layout",
        json={"componentId": "comp-1", "x": 1.0, "y": 1.0},
    )

    assert resp.status_code == 404


async def test_update_layout_override_403s_for_a_viewer(as_user, make_user, make_project, db_session):
    from app.models import ProjectMembership

    owner = await make_user()
    project = await make_project(user=owner)
    arch = await _make_architecture(db_session, project)
    viewer = await make_user()
    db_session.add(ProjectMembership(project_id=project.id, user_id=viewer.id, role="viewer"))
    await db_session.commit()

    client = as_user(viewer)
    resp = await client.patch(
        f"/api/v1/projects/{project.id}/architectures/{arch.id}/layout",
        json={"componentId": "comp-1", "x": 1.0, "y": 1.0},
    )

    assert resp.status_code == 403
