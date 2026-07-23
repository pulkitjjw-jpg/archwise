"""HTTP-level tests for app/routers/requirements.py's non-LLM CRUD surface: GET (read latest) and
PUT (save_requirements, versioned insert). The LLM-calling endpoints (/suggestions, /summary) are
out of scope for this pass -- see the task's own scoping around app/services/llm.py. POST extract
(extract_requirements) IS covered below -- a real live run surfaced a genuine bug in its
industry_context handling (see TestExtractRequirements' own docstring), worth a dedicated
regression test even though the rest of the LLM-calling surface stays out of scope.
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


class TestExtractRequirements:
    """Regression coverage for a real, confirmed bug: extract_requirements_from_history can
    return a wholesale-degenerate response -- "industryContext": {}, "nonFunctional": {}, and
    "productDomain": {} all empty at once, caught live on one single real extraction call, not a
    theoretical gap. This endpoint used to save every one of those three as-is with no fallback,
    unlike the OTHER industry_context write paths in this same file (save_requirements/
    update_industry_context already fall back to DEFAULT_INDUSTRY_CONTEXT). The frontend then
    crashed hard on every single load of that project -- first on RequirementsPanel's industry
    badge (assumed "industry" was always present), then, once that was fixed, on a SECOND crash
    in renderNFRField/ArchitectureWorkspace's isScaleUnspecified-family checks (assumed every
    nonFunctional key was always present) -- a malformed extraction should never be able to brick
    a project this permanently, so all three fields now fall back the same way."""

    def _mock_extract(self, monkeypatch, *, industry_context=None, non_functional=None, product_domain=None):
        async def _fake_extract(*args, **kwargs):
            return {
                "functional": ["Users can do a thing"],
                "nonFunctional": {"expectedScale": "not_specified"} if non_functional is None else non_functional,
                "industryContext": {} if industry_context is None else industry_context,
                "productDomain": (
                    {"category": "other", "rationale": "", "referenceSystem": None}
                    if product_domain is None
                    else product_domain
                ),
                "existingSystem": None,
            }

        monkeypatch.setattr("app.routers.requirements.extract_requirements_from_history", _fake_extract)

    async def test_empty_industry_context_falls_back_to_the_default_not_saved_as_is(
        self, as_user, make_user, make_project, monkeypatch
    ):
        self._mock_extract(monkeypatch, industry_context={})
        owner = await make_user()
        project = await make_project(user=owner)
        client = as_user(owner)

        resp = await client.post(f"/api/v1/projects/{project.id}/requirements")

        assert resp.status_code == 201
        industry_context = resp.json()["requirements"]["industryContext"]
        assert industry_context["industry"] == "none"
        assert industry_context["flags"] == {}

    async def test_empty_non_functional_fills_every_key_with_not_specified(
        self, as_user, make_user, make_project, monkeypatch
    ):
        self._mock_extract(monkeypatch, non_functional={})
        owner = await make_user()
        project = await make_project(user=owner)
        client = as_user(owner)

        resp = await client.post(f"/api/v1/projects/{project.id}/requirements")

        assert resp.status_code == 201
        non_functional = resp.json()["requirements"]["nonFunctional"]
        for key in ("expectedScale", "readWritePattern", "dataNature", "latencySensitivity", "budget", "teamMaturity", "compliance"):
            assert non_functional[key] == "not_specified"

    async def test_partial_non_functional_keeps_real_values_and_fills_only_missing_ones(
        self, as_user, make_user, make_project, monkeypatch
    ):
        self._mock_extract(monkeypatch, non_functional={"budget": "$5,000/month", "teamMaturity": "senior engineers"})
        owner = await make_user()
        project = await make_project(user=owner)
        client = as_user(owner)

        resp = await client.post(f"/api/v1/projects/{project.id}/requirements")

        assert resp.status_code == 201
        non_functional = resp.json()["requirements"]["nonFunctional"]
        assert non_functional["budget"] == "$5,000/month"
        assert non_functional["teamMaturity"] == "senior engineers"
        assert non_functional["expectedScale"] == "not_specified"

    async def test_empty_product_domain_falls_back_to_the_default(self, as_user, make_user, make_project, monkeypatch):
        self._mock_extract(monkeypatch, product_domain={})
        owner = await make_user()
        project = await make_project(user=owner)
        client = as_user(owner)

        resp = await client.post(f"/api/v1/projects/{project.id}/requirements")

        assert resp.status_code == 201
        assert resp.json()["requirements"]["productDomain"] == {
            "category": "other",
            "rationale": "",
            "referenceSystem": None,
        }

    async def test_a_real_industry_context_is_saved_unchanged(self, as_user, make_user, make_project, monkeypatch):
        real_context = {
            "industry": "fintech",
            "rationale": "Processes card payments directly.",
            "complianceAnswers": [],
            "flags": {"handlesCardDataDirectly": True},
        }
        self._mock_extract(monkeypatch, industry_context=real_context)
        owner = await make_user()
        project = await make_project(user=owner)
        client = as_user(owner)

        resp = await client.post(f"/api/v1/projects/{project.id}/requirements")

        assert resp.status_code == 201
        assert resp.json()["requirements"]["industryContext"] == real_context
