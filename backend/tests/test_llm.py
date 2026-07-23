import json

import httpx
import pytest
import respx

from app.config import settings
from app.services.llm import GEMINI_DIRECT_URL, OPENROUTER_URL, _call_llm_with_fallback_chain, get_next_brainstorm_turn

pytestmark = pytest.mark.asyncio


def _openrouter_response(content: str) -> dict:
    return {"choices": [{"message": {"content": content}}]}


def _use_chain(monkeypatch, *models: str, validated: tuple[str, ...] = (), fix_model: str | None = None) -> None:
    """_call_llm_with_fallback_chain reads settings.llm_chain / settings.llm_validated_model_set,
    both computed @properties over the underlying comma-separated string fields -- monkeypatching
    those fields (not the properties) is what actually takes effect on every access."""
    monkeypatch.setattr(settings, "llm_model_chain", ",".join(models))
    monkeypatch.setattr(settings, "llm_validated_models", ",".join(validated))
    if fix_model:
        monkeypatch.setattr(settings, "llm_validation_fix_model", fix_model)


@respx.mock
async def test_first_model_succeeds_returns_parsed_json_single_call(monkeypatch):
    _use_chain(monkeypatch, "test/model-a")
    route = respx.post(OPENROUTER_URL)
    route.side_effect = [httpx.Response(200, json=_openrouter_response('{"ok": true}'))]

    result = await _call_llm_with_fallback_chain(
        "test-key", [{"role": "user", "content": "hello"}], "Test label"
    )

    assert result == {"ok": True}
    assert route.call_count == 1


@respx.mock
async def test_first_model_fails_falls_back_to_next_model_in_chain(monkeypatch):
    _use_chain(monkeypatch, "test/model-a", "test/model-b")
    route = respx.post(OPENROUTER_URL)
    route.side_effect = [
        httpx.Response(500, text="internal error"),
        httpx.Response(200, json=_openrouter_response('{"ok": true}')),
    ]

    result = await _call_llm_with_fallback_chain(
        "test-key", [{"role": "user", "content": "hello"}], "Test label"
    )

    assert result == {"ok": True}
    assert route.call_count == 2


@respx.mock
async def test_markdown_fenced_json_parsed_leniently_without_extra_call(monkeypatch):
    _use_chain(monkeypatch, "test/model-a")
    route = respx.post(OPENROUTER_URL)
    route.side_effect = [httpx.Response(200, json=_openrouter_response('```json\n{"ok": true}\n```'))]

    result = await _call_llm_with_fallback_chain(
        "test-key", [{"role": "user", "content": "hello"}], "Test label"
    )

    assert result == {"ok": True}
    assert route.call_count == 1


@respx.mock
async def test_validated_tier_minor_issue_triggers_auto_fix_and_returns_fixed_result(monkeypatch):
    _use_chain(monkeypatch, "test/model-a", validated=("test/model-a",), fix_model="test/fix-model")
    route = respx.post(OPENROUTER_URL)
    route.side_effect = [
        # model-a's own response is valid JSON but only covers 1 of the 2 expected keys --
        # _classify_output_issue calls that "minor" (coverage 0.5), which triggers the auto-fix
        # pass rather than an immediate fallback to the next tier.
        httpx.Response(200, json=_openrouter_response('{"ok": true}')),
        httpx.Response(200, json=_openrouter_response('{"ok": true, "extra": "value"}')),
    ]

    result = await _call_llm_with_fallback_chain(
        "test-key", [{"role": "user", "content": "hello"}], "Test label", expected_keys=["ok", "extra"]
    )

    assert result == {"ok": True, "extra": "value"}
    assert route.call_count == 2
    # The fix pass targets settings.llm_validation_fix_model, not the original tier.
    assert route.calls[1].request.content.count(b"test/fix-model") == 1


@respx.mock
async def test_all_models_exhausted_raises_readable_error_with_label_and_reason(monkeypatch):
    _use_chain(monkeypatch, "test/model-a", "test/model-b")
    route = respx.post(OPENROUTER_URL)
    route.side_effect = [
        httpx.Response(500, text="err1"),
        httpx.Response(500, text="err2"),
    ]

    with pytest.raises(Exception) as exc_info:
        await _call_llm_with_fallback_chain("test-key", [{"role": "user", "content": "hello"}], "Test label")

    assert route.call_count == 2
    assert "Test label failed across the entire model fallback chain" in str(exc_info.value)
    assert "Please try again." in str(exc_info.value)


class TestGeminiDirectRouting:
    """A "gemini-direct:" prefixed chain entry routes to Google's own OpenAI-compatible endpoint
    using settings.gemini_api_key, a dedicated per-project free quota, instead of OpenRouter's
    shared one -- see config.py's gemini_api_key docstring for why. These tests confirm the
    routing itself (right URL, right key, prefix stripped before being sent as the model name),
    not Google's actual API behavior."""

    @respx.mock
    async def test_gemini_direct_prefix_routes_to_gemini_url_with_gemini_key_and_stripped_model_name(self, monkeypatch):
        _use_chain(monkeypatch, "gemini-direct:gemini-2.5-flash-lite")
        monkeypatch.setattr(settings, "gemini_api_key", "real-gemini-key")
        openrouter_route = respx.post(OPENROUTER_URL)
        gemini_route = respx.post(GEMINI_DIRECT_URL)
        gemini_route.side_effect = [httpx.Response(200, json=_openrouter_response('{"ok": true}'))]

        result = await _call_llm_with_fallback_chain(
            "openrouter-key-should-be-ignored", [{"role": "user", "content": "hello"}], "Test label"
        )

        assert result == {"ok": True}
        assert gemini_route.call_count == 1
        assert openrouter_route.call_count == 0
        sent_body = json.loads(gemini_route.calls[0].request.content)
        assert sent_body["model"] == "gemini-2.5-flash-lite"  # prefix stripped
        assert gemini_route.calls[0].request.headers["Authorization"] == "Bearer real-gemini-key"

    @respx.mock
    async def test_empty_gemini_key_fails_that_tier_cleanly_and_falls_back(self, monkeypatch):
        _use_chain(monkeypatch, "gemini-direct:gemini-2.5-flash-lite", "test/model-b")
        monkeypatch.setattr(settings, "gemini_api_key", "")
        gemini_route = respx.post(GEMINI_DIRECT_URL)
        openrouter_route = respx.post(OPENROUTER_URL)
        openrouter_route.side_effect = [httpx.Response(200, json=_openrouter_response('{"ok": true}'))]

        result = await _call_llm_with_fallback_chain(
            "test-key", [{"role": "user", "content": "hello"}], "Test label"
        )

        assert result == {"ok": True}
        assert gemini_route.call_count == 0  # never even attempted the HTTP call
        assert openrouter_route.call_count == 1

    @respx.mock
    async def test_non_prefixed_model_still_routes_to_openrouter_as_before(self, monkeypatch):
        _use_chain(monkeypatch, "test/model-a")
        monkeypatch.setattr(settings, "gemini_api_key", "real-gemini-key")
        gemini_route = respx.post(GEMINI_DIRECT_URL)
        openrouter_route = respx.post(OPENROUTER_URL)
        openrouter_route.side_effect = [httpx.Response(200, json=_openrouter_response('{"ok": true}'))]

        result = await _call_llm_with_fallback_chain(
            "test-key", [{"role": "user", "content": "hello"}], "Test label"
        )

        assert result == {"ok": True}
        assert openrouter_route.call_count == 1
        assert gemini_route.call_count == 0


class TestGetNextBrainstormTurn:
    """Regression coverage for a real, confirmed bug: only the validated-tier model gets a
    schema check inside _call_llm_with_fallback_chain -- every other tier (including the FIRST
    one tried by default) only needs to produce valid JSON, so it could return well-formed JSON
    missing "stage" entirely, which the caller (this router path) used to access unguarded,
    silently landing on a stuck-forever generic fallback with no error surfaced anywhere. See
    get_next_brainstorm_turn's own comment on the fix: validate "message"/"stage" presence and a
    valid "stage" value here, converting a bad response into the SAME already-correct internal
    fallback path (which computes stage/isComplete from history length) rather than letting it
    leak through as if it were a normal, complete response."""

    def _valid_brainstorm_response(self, **overrides) -> dict:
        base = {
            "message": "What's your expected scale?",
            "isComplete": False,
            "stage": "brainstorm",
            "detectedIndustry": "none",
            "industryRationale": "No signal yet.",
            "detectedDomain": "SaaS",
            "domainRationale": "General SaaS product.",
            "referenceSystem": None,
            "knowledgeLevel": "technical",
            "suggestedReplies": ["100 users", "10,000 users"],
        }
        base.update(overrides)
        return base

    @respx.mock
    async def test_normal_valid_response_is_returned_as_is(self, monkeypatch):

        _use_chain(monkeypatch, "test/model-a")
        route = respx.post(OPENROUTER_URL)
        route.side_effect = [
            httpx.Response(200, json=_openrouter_response(json.dumps(self._valid_brainstorm_response())))
        ]

        result = await get_next_brainstorm_turn([{"role": "user", "stage": "brainstorm", "message": "hi"}], "Proj", "test-key")

        assert result["message"] == "What's your expected scale?"
        assert result["stage"] == "brainstorm"
        assert "degraded" not in result

    @respx.mock
    async def test_response_missing_stage_falls_back_instead_of_leaking_through(self, monkeypatch):

        _use_chain(monkeypatch, "test/model-a")
        route = respx.post(OPENROUTER_URL)
        broken = self._valid_brainstorm_response()
        del broken["stage"]
        route.side_effect = [httpx.Response(200, json=_openrouter_response(json.dumps(broken)))]

        history = [{"role": "user", "stage": "brainstorm", "message": "hi"}]
        result = await get_next_brainstorm_turn(history, "Proj", "test-key")

        assert result["degraded"] is True
        assert result["stage"] == "brainstorm"
        assert result["isComplete"] is False

    @respx.mock
    async def test_response_with_invalid_stage_value_falls_back(self, monkeypatch):

        _use_chain(monkeypatch, "test/model-a")
        route = respx.post(OPENROUTER_URL)
        broken = self._valid_brainstorm_response(stage="not_a_real_stage")
        route.side_effect = [httpx.Response(200, json=_openrouter_response(json.dumps(broken)))]

        result = await get_next_brainstorm_turn(
            [{"role": "user", "stage": "brainstorm", "message": "hi"}], "Proj", "test-key"
        )

        assert result["degraded"] is True
        assert result["stage"] == "brainstorm"

    @respx.mock
    async def test_fallback_preserves_growth_trigger_stage_not_reset_to_brainstorm(self, monkeypatch):
        """Regression: the original fallback hardcoded "brainstorm" for the non-complete case
        regardless of phase -- a real, separate latent bug fixed alongside the main one, since a
        growth-trigger conversation whose LLM call failed would otherwise get silently kicked back
        to looking like a fresh brainstorm on the next turn."""

        _use_chain(monkeypatch, "test/model-a")
        route = respx.post(OPENROUTER_URL)
        broken = {"message": "ok", "isComplete": False}  # missing "stage" entirely
        route.side_effect = [httpx.Response(200, json=_openrouter_response(json.dumps(broken)))]

        history = [{"role": "user", "stage": "growth_trigger", "message": "we need more scale now"}]
        result = await get_next_brainstorm_turn(history, "Proj", "test-key")

        assert result["degraded"] is True
        assert result["stage"] == "growth_trigger"

    @respx.mock
    async def test_entire_chain_exhausted_still_returns_a_usable_degraded_fallback(self, monkeypatch):
        _use_chain(monkeypatch, "test/model-a")
        route = respx.post(OPENROUTER_URL)
        route.side_effect = [httpx.Response(500, text="down")]

        result = await get_next_brainstorm_turn(
            [{"role": "user", "stage": "brainstorm", "message": "hi"}], "Proj", "test-key"
        )

        assert result["degraded"] is True
        assert result["stage"] == "brainstorm"
        assert isinstance(result["message"], str) and len(result["message"]) > 0


class TestMissingSuggestedRepliesRetry:
    """Regression coverage for a real, confirmed bug: a genuinely valid, on-topic, non-concluding
    question can still come back with an empty "suggestedReplies" despite the prompt explicitly
    requiring 2-4 whenever isComplete is false -- confirmed live via a real conversation (stage
    stayed "brainstorm", message was a real detailed follow-up question, but
    suggested_replies was persisted as []). This must re-request once for a compliant response,
    and must NOT fall into the generic-filler fallback over it (that would discard a perfectly
    good message just to "fix" a missing quick-reply-chip list, and the filler itself has no
    suggestedReplies either -- a strictly worse outcome)."""

    def _valid_response(self, **overrides) -> dict:
        base = {
            "message": "How are you planning to handle geospatial indexing for driver locations?",
            "isComplete": False,
            "stage": "brainstorm",
            "detectedIndustry": "fintech",
            "industryRationale": "Processes card payments via Stripe.",
            "detectedDomain": "ride-sharing",
            "domainRationale": "Real-time logistics matching.",
            "referenceSystem": None,
            "knowledgeLevel": "technical",
            "suggestedReplies": [],
        }
        base.update(overrides)
        return base

    @respx.mock
    async def test_empty_suggested_replies_on_non_concluding_turn_triggers_one_retry(self, monkeypatch):
        _use_chain(monkeypatch, "test/model-a")
        route = respx.post(OPENROUTER_URL)
        route.side_effect = [
            httpx.Response(200, json=_openrouter_response(json.dumps(self._valid_response()))),
            httpx.Response(
                200,
                json=_openrouter_response(
                    json.dumps(self._valid_response(suggestedReplies=["Redis geospatial index", "PostGIS"]))
                ),
            ),
        ]

        result = await get_next_brainstorm_turn(
            [{"role": "user", "stage": "brainstorm", "message": "hi"}], "Proj", "test-key"
        )

        assert route.call_count == 2
        assert result["suggestedReplies"] == ["Redis geospatial index", "PostGIS"]

    @respx.mock
    async def test_retry_still_empty_keeps_the_original_valid_message_not_the_generic_filler(self, monkeypatch):
        _use_chain(monkeypatch, "test/model-a")
        route = respx.post(OPENROUTER_URL)
        route.side_effect = [
            httpx.Response(200, json=_openrouter_response(json.dumps(self._valid_response()))),
            httpx.Response(200, json=_openrouter_response(json.dumps(self._valid_response()))),
        ]

        result = await get_next_brainstorm_turn(
            [{"role": "user", "stage": "brainstorm", "message": "hi"}], "Proj", "test-key"
        )

        assert route.call_count == 2
        assert result["message"] == self._valid_response()["message"]
        assert "degraded" not in result  # NOT the generic-filler fallback path
        assert result["suggestedReplies"] == []

    @respx.mock
    async def test_populated_suggested_replies_never_triggers_a_retry(self, monkeypatch):
        _use_chain(monkeypatch, "test/model-a")
        route = respx.post(OPENROUTER_URL)
        route.side_effect = [
            httpx.Response(
                200, json=_openrouter_response(json.dumps(self._valid_response(suggestedReplies=["A", "B"])))
            )
        ]

        result = await get_next_brainstorm_turn(
            [{"role": "user", "stage": "brainstorm", "message": "hi"}], "Proj", "test-key"
        )

        assert route.call_count == 1
        assert result["suggestedReplies"] == ["A", "B"]

    @respx.mock
    async def test_empty_suggested_replies_on_a_concluding_turn_never_triggers_a_retry(self, monkeypatch):
        _use_chain(monkeypatch, "test/model-a")
        route = respx.post(OPENROUTER_URL)
        route.side_effect = [
            httpx.Response(
                200,
                json=_openrouter_response(
                    json.dumps(self._valid_response(isComplete=True, stage="requirement_gathering", suggestedReplies=[]))
                ),
            )
        ]

        result = await get_next_brainstorm_turn(
            [{"role": "user", "stage": "brainstorm", "message": "hi"}], "Proj", "test-key"
        )

        assert route.call_count == 1
        assert result["suggestedReplies"] == []
