"""HTTP-level tests for app/routers/conversations.py's create_conversation_turn -- specifically
the "degraded" field it forwards to the frontend (never persisted to the DB) so the chat can show
a clear "I had trouble with that" state instead of silently presenting a generic fallback question
as if it were a normal, complete turn. This is the router half of a real, confirmed bug fix -- see
test_llm.py's TestGetNextBrainstormTurn for the get_next_brainstorm_turn half.
"""

import pytest

pytestmark = pytest.mark.asyncio


async def _make_project_with_requirements_setup(make_user, make_project):
    owner = await make_user()
    project = await make_project(user=owner)
    return owner, project


async def test_normal_turn_is_not_marked_degraded(as_user, make_user, make_project, monkeypatch):
    async def _fake_turn(*args, **kwargs):
        return {
            "message": "What's your expected scale?",
            "stage": "brainstorm",
            "suggestedReplies": ["100 users", "10,000 users"],
            "isComplete": False,
        }

    monkeypatch.setattr("app.routers.conversations.get_next_brainstorm_turn", _fake_turn)

    owner, project = await _make_project_with_requirements_setup(make_user, make_project)
    client = as_user(owner)

    resp = await client.post(
        f"/api/v1/projects/{project.id}/conversations",
        json={"role": "user", "message": "It's a todo app", "stage": "brainstorm"},
    )

    assert resp.status_code == 201
    body = resp.json()
    assert body["degraded"] is False
    assert body["assistantConversation"]["message"] == "What's your expected scale?"
    assert body["assistantConversation"]["stage"] == "brainstorm"


async def test_llm_returning_degraded_fallback_is_forwarded_as_degraded(as_user, make_user, make_project, monkeypatch):
    """get_next_brainstorm_turn's own internal fallback (a bad/missing-field response, or the
    whole model chain failing) now returns {"degraded": True, ...} instead of raising -- the
    router must forward that flag through to the API response untouched."""

    async def _fake_turn(*args, **kwargs):
        return {
            "message": "I had some trouble processing that last message clearly -- could you tell me a bit more, or try rephrasing it?",
            "stage": "brainstorm",
            "isComplete": False,
            "degraded": True,
        }

    monkeypatch.setattr("app.routers.conversations.get_next_brainstorm_turn", _fake_turn)

    owner, project = await _make_project_with_requirements_setup(make_user, make_project)
    client = as_user(owner)

    resp = await client.post(
        f"/api/v1/projects/{project.id}/conversations",
        json={"role": "user", "message": "uh i dunno", "stage": "brainstorm"},
    )

    assert resp.status_code == 201
    body = resp.json()
    assert body["degraded"] is True
    # The friendlier, honest fallback message reaches the client verbatim -- not silently
    # swapped for something that reads like an ordinary follow-up question.
    assert "trouble processing" in body["assistantConversation"]["message"]


async def test_get_next_brainstorm_turn_raising_outright_is_also_marked_degraded(as_user, make_user, make_project, monkeypatch):
    """The router's own outer except (a last-resort safety net for something failing OUTSIDE the
    LLM call itself, since get_next_brainstorm_turn's own internal fallback should catch nearly
    everything now) must still mark the turn degraded, never silently succeed."""

    async def _raising_turn(*args, **kwargs):
        raise RuntimeError("unexpected failure")

    monkeypatch.setattr("app.routers.conversations.get_next_brainstorm_turn", _raising_turn)

    owner, project = await _make_project_with_requirements_setup(make_user, make_project)
    client = as_user(owner)

    resp = await client.post(
        f"/api/v1/projects/{project.id}/conversations",
        json={"role": "user", "message": "hello", "stage": "brainstorm"},
    )

    assert resp.status_code == 201
    body = resp.json()
    assert body["degraded"] is True


async def test_router_fallback_preserves_growth_trigger_stage(as_user, make_user, make_project, db_session, monkeypatch):
    """Regression: the router's OWN default fallback (used only if get_next_brainstorm_turn
    raises outright) previously hardcoded stage="brainstorm" unconditionally -- a growth-trigger
    conversation whose call failed would get silently kicked back to looking like a fresh
    brainstorm. It must now stay "growth_trigger" when the history is already in that phase."""
    from app.models import Conversation

    async def _raising_turn(*args, **kwargs):
        raise RuntimeError("unexpected failure")

    monkeypatch.setattr("app.routers.conversations.get_next_brainstorm_turn", _raising_turn)

    owner, project = await _make_project_with_requirements_setup(make_user, make_project)
    db_session.add(
        Conversation(project_id=project.id, role="user", message="please add SMS notifications", stage="growth_trigger")
    )
    await db_session.commit()

    client = as_user(owner)
    resp = await client.post(
        f"/api/v1/projects/{project.id}/conversations",
        json={"role": "user", "message": "also needs to scale to 1M users", "stage": "growth_trigger"},
    )

    assert resp.status_code == 201
    body = resp.json()
    assert body["degraded"] is True
    assert body["assistantConversation"]["stage"] == "growth_trigger"
