import httpx
import pytest
import respx

from app.config import settings
from app.services.llm import OPENROUTER_URL, _call_llm_with_fallback_chain

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
