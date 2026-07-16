"""HTTP-level tests for app/routers/requirements.py's non-LLM CRUD surface: GET (read latest) and
PUT (save_requirements, versioned insert). The LLM-calling endpoints (POST extract, /suggestions,
/summary) are out of scope for this pass -- see the task's own scoping around app/services/llm.py.
"""

import pytest

pytestmark = pytest.mark.asyncio


async def test_get_requirements_returns_null_when_none_exist_yet(as_user, make_user, make_project):
    owner = await make_user()
    project = await make_project(user=owner)
    client = as_user(owner)

    resp = await client.get(f"/api/v1/projects/{project.id}/requirements")

    assert resp.status_code == 200
    assert resp.json()["requirements"] is None


async def test_save_requirements_creates_version_1_then_2(as_user, make_user, make_project):
    owner = await make_user()
    project = await make_project(user=owner)
    client = as_user(owner)

    resp1 = await client.put(
        f"/api/v1/projects/{project.id}/requirements",
        json={"functional": ["Users can sign up"], "nonFunctional": {"scale": "1000 users"}},
    )
    assert resp1.status_code == 200
    assert resp1.json()["requirements"]["version"] == 1

    resp2 = await client.put(
        f"/api/v1/projects/{project.id}/requirements",
        json={"functional": ["Users can sign up", "Users can log in"], "nonFunctional": {"scale": "1000 users"}},
    )
    assert resp2.status_code == 200
    assert resp2.json()["requirements"]["version"] == 2

    # GET always returns the LATEST version.
    resp_get = await client.get(f"/api/v1/projects/{project.id}/requirements")
    assert resp_get.json()["requirements"]["version"] == 2
    assert resp_get.json()["requirements"]["functional"] == ["Users can sign up", "Users can log in"]


async def test_save_requirements_rejects_empty_functional_or_nonfunctional(as_user, make_user, make_project):
    owner = await make_user()
    project = await make_project(user=owner)
    client = as_user(owner)

    resp = await client.put(
        f"/api/v1/projects/{project.id}/requirements", json={"functional": [], "nonFunctional": {}}
    )

    assert resp.status_code == 400


async def test_save_requirements_carries_industry_context_forward_when_omitted(as_user, make_user, make_project):
    """save_requirements's own documented behavior: a manual edit that omits industryContext must
    inherit the PREVIOUS version's value rather than silently resetting it to the default."""
    owner = await make_user()
    project = await make_project(user=owner)
    client = as_user(owner)

    custom_context = {"industry": "fintech", "rationale": "handles payments", "complianceAnswers": [], "flags": {}}
    resp1 = await client.put(
        f"/api/v1/projects/{project.id}/requirements",
        json={
            "functional": ["Process payments"],
            "nonFunctional": {"scale": "small"},
            "industryContext": custom_context,
        },
    )
    assert resp1.json()["requirements"]["industryContext"]["industry"] == "fintech"

    resp2 = await client.put(
        f"/api/v1/projects/{project.id}/requirements",
        json={"functional": ["Process payments", "Refund payments"], "nonFunctional": {"scale": "small"}},
    )
    assert resp2.json()["requirements"]["industryContext"]["industry"] == "fintech"


async def test_get_requirements_403_style_hidden_for_non_member(as_user, make_user, make_project):
    owner = await make_user()
    project = await make_project(user=owner)
    stranger = await make_user()
    client = as_user(stranger)

    resp = await client.get(f"/api/v1/projects/{project.id}/requirements")

    assert resp.status_code == 404


async def test_save_requirements_403s_for_a_viewer(as_user, make_user, make_project, db_session):
    from app.models import ProjectMembership

    owner = await make_user()
    project = await make_project(user=owner)
    viewer = await make_user()
    db_session.add(ProjectMembership(project_id=project.id, user_id=viewer.id, role="viewer"))
    await db_session.commit()

    client = as_user(viewer)
    resp = await client.put(
        f"/api/v1/projects/{project.id}/requirements", json={"functional": ["x"], "nonFunctional": {"a": "b"}}
    )

    assert resp.status_code == 403


async def test_save_requirements_allowed_for_an_editor(as_user, make_user, make_project, db_session):
    from app.models import ProjectMembership

    owner = await make_user()
    project = await make_project(user=owner)
    editor = await make_user()
    db_session.add(ProjectMembership(project_id=project.id, user_id=editor.id, role="editor"))
    await db_session.commit()

    client = as_user(editor)
    resp = await client.put(
        f"/api/v1/projects/{project.id}/requirements", json={"functional": ["x"], "nonFunctional": {"a": "b"}}
    )

    assert resp.status_code == 200
