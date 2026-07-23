"""HTTP-level proof that check_feature_access is actually wired into each of the 6 "advanced" AI
feature routes -- free users get a clear 402 before any LLM call, paid users succeed and their
usage increments. The gate logic itself is exhaustively unit-tested in test_usage_limits.py; this
file only proves each route calls it. Every check is placed BEFORE the underlying LLM call in the
route, so the free-user-blocked cases below need no LLM mocking at all.
"""

import pytest

from app.config import settings
from app.models import Architecture, Requirement
from app.services.usage_limits import get_or_create_usage_counter

pytestmark = pytest.mark.asyncio


async def _make_requirement(db_session, project, **kwargs):
    reqs = Requirement(project_id=project.id, **kwargs)
    db_session.add(reqs)
    await db_session.commit()
    await db_session.refresh(reqs)
    return reqs


async def _make_architecture(db_session, project, version="0.1.0"):
    arch = Architecture(
        project_id=project.id,
        version=version,
        hld={"components": [], "connections": []},
        reasoning={"decisions": [], "assumptions": [], "risks": [], "recommendation": None, "diff": None},
    )
    db_session.add(arch)
    await db_session.commit()
    await db_session.refresh(arch)
    return arch


@pytest.fixture(autouse=True)
def _production_environment(monkeypatch):
    monkeypatch.setattr(settings, "environment", "production")


async def _make_paid_user(make_user, db_session):
    user = await make_user()
    counter = await get_or_create_usage_counter(db_session, user.id)
    counter.plan = "paid"
    await db_session.commit()
    return user


async def test_whatif_suggestions_blocks_free_user(as_user, make_user, make_project, db_session):
    owner = await make_user()
    project = await make_project(user=owner)
    await _make_requirement(db_session, project)
    client = as_user(owner)

    resp = await client.post(f"/api/v1/projects/{project.id}/architectures/whatif-suggestions")

    assert resp.status_code == 402


async def test_whatif_suggestions_succeeds_for_paid_user(as_user, make_user, make_project, db_session, monkeypatch):
    owner = await _make_paid_user(make_user, db_session)
    project = await make_project(user=owner)
    await _make_requirement(db_session, project)
    client = as_user(owner)

    async def _fake_suggestions(*args, **kwargs):
        return {}

    monkeypatch.setattr("app.routers.architectures.generate_whatif_suggestions", _fake_suggestions)

    resp = await client.post(f"/api/v1/projects/{project.id}/architectures/whatif-suggestions")

    assert resp.status_code == 200
    counter = await get_or_create_usage_counter(db_session, owner.id)
    assert counter.whatif_simulator_used == 1


async def test_component_suggestions_blocks_free_user(as_user, make_user, make_project, db_session):
    owner = await make_user()
    project = await make_project(user=owner)
    await _make_requirement(db_session, project)
    client = as_user(owner)

    resp = await client.post(
        f"/api/v1/projects/{project.id}/architectures/component-suggestions",
        json={"components": [], "connections": []},
    )

    assert resp.status_code == 402


async def test_propose_changes_blocks_free_user(as_user, make_user, make_project, db_session):
    owner = await make_user()
    project = await make_project(user=owner)
    await _make_requirement(db_session, project)
    arch = await _make_architecture(db_session, project)
    client = as_user(owner)

    resp = await client.post(
        f"/api/v1/projects/{project.id}/architectures/{arch.id}/propose-changes",
        json={"description": "add a cache", "provider": "aws"},
    )

    assert resp.status_code == 402


async def test_refine_proposal_blocks_free_user(as_user, make_user, make_project, db_session):
    owner = await make_user()
    project = await make_project(user=owner)
    await _make_requirement(db_session, project)
    arch = await _make_architecture(db_session, project)
    client = as_user(owner)

    resp = await client.post(
        f"/api/v1/projects/{project.id}/architectures/{arch.id}/refine-proposal",
        json={
            "provider": "aws",
            "originalProposal": {
                "action": "add",
                "componentId": "cache-1",
                "componentType": "cache",
                "componentName": "Cache",
                "reasoning": "x",
            },
            "priorMessages": [],
            "discussionMessage": "use something cheaper",
        },
    )

    assert resp.status_code == 402


async def test_requirement_suggestions_blocks_free_user(as_user, make_user, make_project):
    owner = await make_user()
    project = await make_project(user=owner)
    client = as_user(owner)

    resp = await client.post(
        f"/api/v1/projects/{project.id}/requirements/suggestions",
        json={"functional": [], "nonFunctional": {}},
    )

    assert resp.status_code == 402


async def test_requirement_suggestions_succeeds_for_paid_user(as_user, make_user, make_project, db_session, monkeypatch):
    owner = await _make_paid_user(make_user, db_session)
    project = await make_project(user=owner)
    client = as_user(owner)

    async def _fake_suggestions(*args, **kwargs):
        return {}

    monkeypatch.setattr("app.routers.requirements.generate_requirement_suggestions", _fake_suggestions)

    resp = await client.post(
        f"/api/v1/projects/{project.id}/requirements/suggestions",
        json={"functional": [], "nonFunctional": {}},
    )

    assert resp.status_code == 200
    counter = await get_or_create_usage_counter(db_session, owner.id)
    assert counter.requirement_suggestions_used == 1


async def test_executive_summary_export_job_blocks_free_user(as_user, make_user, make_project, db_session):
    owner = await make_user()
    project = await make_project(user=owner)
    await _make_architecture(db_session, project)
    client = as_user(owner)

    resp = await client.post(
        f"/api/v1/projects/{project.id}/export/jobs", json={"format": "executive-summary", "provider": "aws"}
    )

    assert resp.status_code == 402


async def test_terraform_export_job_is_not_gated_for_free_user(as_user, make_user, make_project, db_session):
    """Only executive-summary makes a real LLM call -- terraform/kubernetes stay ungated for
    every plan, confirmed by this NOT 402ing for a free user."""
    owner = await make_user()
    project = await make_project(user=owner)
    await _make_architecture(db_session, project)
    client = as_user(owner)

    resp = await client.post(
        f"/api/v1/projects/{project.id}/export/jobs", json={"format": "terraform", "provider": "aws"}
    )

    assert resp.status_code == 202


async def test_executive_summary_email_export_blocks_free_user(as_user, make_user, make_project, db_session):
    owner = await make_user()
    project = await make_project(user=owner)
    await _make_architecture(db_session, project)
    client = as_user(owner)

    resp = await client.post(
        f"/api/v1/projects/{project.id}/export/email", json={"format": "executive-summary", "provider": "aws"}
    )

    assert resp.status_code == 402
