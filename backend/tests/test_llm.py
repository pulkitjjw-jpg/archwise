import httpx
import pytest
import respx

from app.services.llm import OPENROUTER_URL, _call_llm_with_retry

pytestmark = pytest.mark.asyncio


def _openrouter_response(content: str) -> dict:
    return {"choices": [{"message": {"content": content}}]}


@respx.mock
async def test_parse_fail_then_success_resends_bad_output_with_corrective_note():
    route = respx.post(OPENROUTER_URL)
    route.side_effect = [
        httpx.Response(200, json=_openrouter_response("not valid json {{{")),
        httpx.Response(200, json=_openrouter_response('{"ok": true}')),
    ]

    original_messages = [{"role": "system", "content": "sys"}, {"role": "user", "content": "hello"}]
    result = await _call_llm_with_retry(
        "test-key", original_messages, "Test label", max_attempts=3, retry_delay_ms=0
    )

    assert result == {"ok": True}
    assert route.call_count == 2

    second_call_body = route.calls[1].request.content
    import json

    sent_messages = json.loads(second_call_body)["messages"]
    assert sent_messages == [
        *original_messages,
        {"role": "assistant", "content": "not valid json {{{"},
        {
            "role": "user",
            "content": "Your previous response could not be parsed as valid JSON. Return ONLY a single valid JSON object — no markdown code fences, no commentary, and no extra characters before or after the JSON.",
        },
    ]


@respx.mock
async def test_request_error_then_success_resends_original_messages_unmodified():
    route = respx.post(OPENROUTER_URL)
    route.side_effect = [
        httpx.Response(500, text="internal error"),
        httpx.Response(200, json=_openrouter_response('{"ok": true}')),
    ]

    original_messages = [{"role": "system", "content": "sys"}, {"role": "user", "content": "hello"}]
    result = await _call_llm_with_retry(
        "test-key", original_messages, "Test label", max_attempts=3, retry_delay_ms=0
    )

    assert result == {"ok": True}
    assert route.call_count == 2

    import json

    second_call_body = route.calls[1].request.content
    sent_messages = json.loads(second_call_body)["messages"]
    assert sent_messages == original_messages


@respx.mock
async def test_exhausted_retries_raises_with_readable_message_and_exact_attempt_count():
    route = respx.post(OPENROUTER_URL)
    route.side_effect = [
        httpx.Response(500, text="err1"),
        httpx.Response(500, text="err2"),
        httpx.Response(500, text="err3"),
    ]

    original_messages = [{"role": "user", "content": "hello"}]

    with pytest.raises(Exception) as exc_info:
        await _call_llm_with_retry("test-key", original_messages, "Test label", max_attempts=3, retry_delay_ms=0)

    assert route.call_count == 3
    assert "Test label failed after 3 attempts" in str(exc_info.value)
    assert "Please try again." in str(exc_info.value)


@respx.mock
async def test_markdown_fence_stripped_within_same_attempt_no_extra_call():
    route = respx.post(OPENROUTER_URL)
    route.side_effect = [
        httpx.Response(200, json=_openrouter_response('```json\n{"ok": true}\n```')),
    ]

    result = await _call_llm_with_retry(
        "test-key", [{"role": "user", "content": "hi"}], "Test label", max_attempts=3, retry_delay_ms=0
    )

    assert result == {"ok": True}
    assert route.call_count == 1
