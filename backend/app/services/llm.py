import asyncio
import json
import logging
import re
import time
import uuid
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

import httpx

from app.config import settings
from app.db import AsyncSessionLocal
from app.models import LlmUsageLog

logger = logging.getLogger("app.services.llm")

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

_LEAKED_APOLOGY_RE = re.compile(r"^\s*(apolog|i apologize|i'm sorry|my apologies|sorry[,!]? )", re.IGNORECASE)
_FENCE_OPEN_JSON_RE = re.compile(r"^```json\s*", re.IGNORECASE)
_FENCE_OPEN_RE = re.compile(r"^```\s*", re.IGNORECASE)
_FENCE_CLOSE_RE = re.compile(r"\s*```$")

# USD price per token (prompt, completion), from https://openrouter.ai/api/v1/models -- re-verify
# against that endpoint if LLM_MODEL_CHAIN changes, these are not guessable/derivable. Every
# ":free" slug is genuinely $0/$0; an unlisted model falls back to (0.0, 0.0) in _model_pricing
# below, which under-reports cost for a paid model that isn't in this table -- acceptable for now
# since the chain's only paid tier (Gemini) is listed, but keep this in sync if that changes.
MODEL_PRICING: dict[str, tuple[float, float]] = {
    "openai/gpt-oss-120b:free": (0.0, 0.0),
    "google/gemma-4-31b-it:free": (0.0, 0.0),
    "nvidia/nemotron-3-ultra-550b-a55b:free": (0.0, 0.0),
    "qwen/qwen3-coder:free": (0.0, 0.0),
    "google/gemini-2.5-flash": (0.0000003, 0.0000025),
}


def _model_pricing(model: str) -> tuple[float, float]:
    return MODEL_PRICING.get(model, (0.0, 0.0))


@dataclass
class _ModelCallResult:
    content: str
    prompt_tokens: int | None
    completion_tokens: int | None


def _looks_like_leaked_apology(message: str) -> bool:
    """Some models apologize for a previous malformed-JSON attempt even after a successful
    retry, since the corrective note lives earlier in the same conversation (originally observed
    with Gemini 2.5 Flash; kept as a general safety net since it's cheap and model-agnostic).
    That apology has no business reaching the user-facing chat message."""
    return bool(_LEAKED_APOLOGY_RE.match(message))


async def _call_single_model(
    client: httpx.AsyncClient,
    api_key: str,
    messages: list[dict[str, str]],
    model: str,
    timeout_seconds: float,
) -> _ModelCallResult:
    """Makes exactly ONE attempt against ONE model -- no retry, no backoff. Raises on any failure
    (non-2xx, timeout, missing/null content) so the fallback chain can move to the next tier
    immediately. Returns the raw (stripped) response text plus token usage (Workstream Z1 admin
    panel) when OpenRouter's response includes a "usage" field -- not every provider reports it,
    so both counts may be None.

    Uses asyncio.wait_for for the actual deadline rather than relying on httpx's own `timeout`
    alone -- httpx's read timeout resets on every byte received, so a connection that trickles
    occasional keep-alive/partial data (observed with OpenRouter under load) can run for minutes
    without ever tripping it. wait_for enforces a true wall-clock cap regardless."""
    try:
        response = await asyncio.wait_for(
            client.post(
                OPENROUTER_URL,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                    "X-Title": "AI Cloud Architecture Generator",
                },
                json={
                    "model": model,
                    "messages": messages,
                    "response_format": {"type": "json_object"},
                },
                timeout=timeout_seconds,
            ),
            timeout=timeout_seconds,
        )
    except asyncio.TimeoutError:
        raise Exception(f"timed out after {timeout_seconds}s")

    if not response.is_success:
        raise Exception(f"OpenRouter API error: {response.status_code} - {response.text}")

    data = response.json()
    choices = data.get("choices")
    if not choices:
        raise Exception("response had no 'choices'")
    content = choices[0].get("message", {}).get("content")
    if not isinstance(content, str) or not content.strip():
        raise Exception("response content was empty or null")

    usage = data.get("usage") or {}
    return _ModelCallResult(
        content=content.strip(),
        prompt_tokens=usage.get("prompt_tokens"),
        completion_tokens=usage.get("completion_tokens"),
    )


def _try_parse_json(raw: str) -> Any | None:
    """Direct json.loads, then a lenient markdown-fence-stripped retry. Returns None (never
    raises) if both fail -- callers decide what "unparseable" means for their tier."""
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass
    cleaned = _FENCE_OPEN_JSON_RE.sub("", raw)
    cleaned = _FENCE_OPEN_RE.sub("", cleaned)
    cleaned = _FENCE_CLOSE_RE.sub("", cleaned)
    cleaned = cleaned.strip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        return None


def _keys_coverage(parsed: Any, expected_keys: list[str] | None) -> float:
    """Fraction of expected top-level keys actually present in parsed. 1.0 if no expected_keys
    were given (nothing to check), 0.0 if parsed isn't even a dict."""
    if not expected_keys:
        return 1.0
    if not isinstance(parsed, dict):
        return 0.0
    present = sum(1 for k in expected_keys if k in parsed)
    return present / len(expected_keys)


def _classify_output_issue(raw: str, parsed: Any, expected_keys: list[str] | None) -> str:
    """For a validated-tier model only: classifies its output as "ok" (use as-is), "minor" (a
    likely-fixable formatting slip or a couple of missing fields -- worth an auto-fix pass), or
    "major" (fundamentally broken/incomplete -- a reformat pass can't invent missing content, so
    skip straight to the next tier rather than spend time on an unsalvageable response)."""
    coverage = _keys_coverage(parsed, expected_keys)
    if parsed is not None and coverage == 1.0:
        return "ok"

    if parsed is None:
        # Content that never got a chance to close out (cut off mid-word/mid-sentence, no
        # trailing structural character) is genuinely missing data, not a formatting slip -- a
        # reformat pass can't invent the rest of the response, so don't waste one on it. A small
        # brace/bracket count mismatch on an otherwise well-terminated response (e.g. one
        # stray/missing character) is the actual "fixable" case.
        trimmed = raw.rstrip()
        looks_truncated = not trimmed.endswith(("}", "]", '"'))
        brace_imbalance = abs(raw.count("{") - raw.count("}")) + abs(raw.count("[") - raw.count("]"))
        if "{" not in raw or looks_truncated or brace_imbalance > 2:
            return "major"
        return "minor"

    return "major" if coverage < 0.5 else "minor"


_FIX_SYSTEM_INSTRUCTION = """You are given a response that was supposed to be a single valid JSON object but has a formatting problem (e.g. a missing quote, a trailing comma, markdown fences around it, an unescaped control character) or is missing one or two expected top-level fields. Fix ONLY the formatting/structure -- do not invent new content, do not summarize, do not regenerate from scratch, preserve every value that is already present as closely as possible. Return ONLY the corrected, valid JSON object -- no markdown fences, no commentary, no explanation."""


@dataclass
class _FixResult:
    parsed: Any
    prompt_tokens: int | None
    completion_tokens: int | None


async def _attempt_fix(
    client: httpx.AsyncClient, api_key: str, raw: str, expected_keys: list[str] | None, label: str
) -> _FixResult | None:
    """One lightweight repair attempt via settings.llm_validation_fix_model -- reformats/patches
    the given broken output, never regenerates it from scratch. Returns the parsed, fixed result
    (plus this repair call's own token usage, for cost accounting -- it's a real API call even
    though it's cheap), or None if the fix attempt itself fails (caller then skips this tier
    entirely)."""
    fix_messages = [
        {"role": "system", "content": _FIX_SYSTEM_INSTRUCTION},
        {
            "role": "user",
            "content": (
                f"Expected top-level JSON fields: {expected_keys or 'unspecified'}\n\n"
                f"Broken response to fix:\n{raw}"
            ),
        },
    ]
    try:
        fix_result = await _call_single_model(
            client, api_key, fix_messages, settings.llm_validation_fix_model, settings.llm_validation_fix_timeout_seconds
        )
    except Exception as err:
        logger.error("[%s] Fix pass via %s failed to respond: %s", label, settings.llm_validation_fix_model, err)
        return None

    fixed_parsed = _try_parse_json(fix_result.content)
    if fixed_parsed is None or _keys_coverage(fixed_parsed, expected_keys) < 1.0:
        logger.error("[%s] Fix pass via %s did not produce valid/complete JSON", label, settings.llm_validation_fix_model)
        return None
    return _FixResult(
        parsed=fixed_parsed, prompt_tokens=fix_result.prompt_tokens, completion_tokens=fix_result.completion_tokens
    )


async def _record_attempt(
    *,
    call_group_id: uuid.UUID,
    endpoint: str,
    model: str,
    is_fix_pass: bool,
    status: str,
    is_served: bool,
    latency_ms: int,
    prompt_tokens: int | None,
    completion_tokens: int | None,
    estimated_cost_usd: Decimal | None,
    error_message: str | None,
) -> None:
    """Persists one llm_usage_logs row for a SINGLE model attempt (Workstream Z1 admin panel) via
    its OWN independent DB session, never the caller's request-scoped one -- usage logging is a
    pure audit side-effect that must never fail or roll back the actual LLM call it's describing.
    Swallows its own errors for the same reason: a DB hiccup here should never surface as a
    user-facing failure."""
    try:
        async with AsyncSessionLocal() as db:
            db.add(
                LlmUsageLog(
                    call_group_id=call_group_id,
                    endpoint=endpoint,
                    model=model,
                    is_fix_pass=is_fix_pass,
                    status=status,
                    is_served=is_served,
                    latency_ms=latency_ms,
                    prompt_tokens=prompt_tokens,
                    completion_tokens=completion_tokens,
                    estimated_cost_usd=estimated_cost_usd,
                    error_message=error_message[:2000] if error_message else None,
                )
            )
            await db.commit()
    except Exception as err:
        logger.error("[%s] Failed to record llm_usage_logs row (non-fatal): %s", endpoint, err)


async def _call_llm_with_fallback_chain(
    api_key: str,
    messages: list[dict[str, str]],
    label: str,
    expected_keys: list[str] | None = None,
    timeout_seconds: float | None = None,
) -> Any:
    """Walks settings.llm_chain in order (see app/config.py -- LLM_MODEL_CHAIN env var), giving
    each model exactly ONE attempt. Any failure -- request error, timeout, or unparseable/
    incomplete output -- moves to the next tier immediately; a model is never retried against
    itself (a different model's shared free-tier pool usually isn't contended at the same moment
    a rate-limited one is, so cross-model fallback recovers faster than same-model backoff did).

    Models in settings.llm_validated_model_set get an extra validation + auto-fix pass before
    their output is trusted or discarded (see _classify_output_issue/_attempt_fix); every other
    tier is judged purely on "did it parse and cover the expected schema". The last model in the
    chain is the paid last-resort tier and is logged at WARNING when reached, so how often the
    free tier is insufficient is visible in monitoring without being exposed to the end user.

    Records one llm_usage_logs row per model attempt (Workstream Z1 admin panel), all sharing one
    call_group_id -- see _record_attempt. This is what makes genuine per-model stats possible
    (latency/success-rate for a specific tier, not just "whichever tier happened to win").

    Raises a clear, human-readable error (never a raw exception) if every tier is exhausted.
    Deliberately returns loosely-typed Any, not a strict Pydantic model, to match the pre-split
    behavior where LLM output was never runtime-validated either."""
    timeout = timeout_seconds or settings.llm_per_model_timeout_seconds
    chain = settings.llm_chain
    validated = settings.llm_validated_model_set
    last_error: Exception | None = None
    call_group_id = uuid.uuid4()

    def cost_for(model: str, prompt_tokens: int | None, completion_tokens: int | None) -> Decimal:
        prompt_price, completion_price = _model_pricing(model)
        return Decimal(str(prompt_tokens or 0)) * Decimal(str(prompt_price)) + Decimal(str(completion_tokens or 0)) * Decimal(
            str(completion_price)
        )

    async with httpx.AsyncClient(timeout=timeout) as client:
        for i, model in enumerate(chain):
            is_last = i == len(chain) - 1
            if is_last:
                logger.warning(
                    "[%s] All free-tier models in the chain failed -- falling back to paid tier: %s", label, model
                )

            attempt_start = time.monotonic()
            try:
                call_result = await _call_single_model(client, api_key, messages, model, timeout)
            except Exception as err:
                latency_ms = int((time.monotonic() - attempt_start) * 1000)
                logger.error("[%s] %s failed/timed out, moving to next tier: %s", label, model, err)
                last_error = err
                await _record_attempt(
                    call_group_id=call_group_id,
                    endpoint=label,
                    model=model,
                    is_fix_pass=False,
                    status="failure",
                    is_served=False,
                    latency_ms=latency_ms,
                    prompt_tokens=None,
                    completion_tokens=None,
                    estimated_cost_usd=None,
                    error_message=str(err),
                )
                continue

            attempt_latency_ms = int((time.monotonic() - attempt_start) * 1000)
            raw = call_result.content
            parsed = _try_parse_json(raw)
            attempt_cost = cost_for(model, call_result.prompt_tokens, call_result.completion_tokens)

            if model in validated:
                issue = _classify_output_issue(raw, parsed, expected_keys)
                if issue == "ok":
                    logger.info("[%s] served by %s (validated, no issues)", label, model)
                    await _record_attempt(
                        call_group_id=call_group_id,
                        endpoint=label,
                        model=model,
                        is_fix_pass=False,
                        status="success",
                        is_served=True,
                        latency_ms=attempt_latency_ms,
                        prompt_tokens=call_result.prompt_tokens,
                        completion_tokens=call_result.completion_tokens,
                        estimated_cost_usd=attempt_cost,
                        error_message=None,
                    )
                    return parsed
                if issue == "minor":
                    logger.error(
                        "[%s] %s output had minor validation issues, attempting auto-fix via %s",
                        label,
                        model,
                        settings.llm_validation_fix_model,
                    )
                    fix_start = time.monotonic()
                    fixed = await _attempt_fix(client, api_key, raw, expected_keys, label)
                    fix_latency_ms = int((time.monotonic() - fix_start) * 1000)
                    if fixed is not None:
                        logger.info("[%s] served by %s (auto-fixed by %s)", label, model, settings.llm_validation_fix_model)
                        # The ORIGINAL tier's row is marked served -- the content is fundamentally
                        # its output, just repaired. The fix pass gets its own row for cost/
                        # latency accounting but is excluded from per-model dashboard stats.
                        await _record_attempt(
                            call_group_id=call_group_id,
                            endpoint=label,
                            model=model,
                            is_fix_pass=False,
                            status="success",
                            is_served=True,
                            latency_ms=attempt_latency_ms,
                            prompt_tokens=call_result.prompt_tokens,
                            completion_tokens=call_result.completion_tokens,
                            estimated_cost_usd=attempt_cost,
                            error_message="minor validation issue, auto-fixed",
                        )
                        await _record_attempt(
                            call_group_id=call_group_id,
                            endpoint=label,
                            model=settings.llm_validation_fix_model,
                            is_fix_pass=True,
                            status="success",
                            is_served=False,
                            latency_ms=fix_latency_ms,
                            prompt_tokens=fixed.prompt_tokens,
                            completion_tokens=fixed.completion_tokens,
                            estimated_cost_usd=cost_for(
                                settings.llm_validation_fix_model, fixed.prompt_tokens, fixed.completion_tokens
                            ),
                            error_message=None,
                        )
                        return fixed.parsed
                    logger.error("[%s] %s auto-fix failed, moving to next tier", label, model)
                    await _record_attempt(
                        call_group_id=call_group_id,
                        endpoint=label,
                        model=model,
                        is_fix_pass=False,
                        status="failure",
                        is_served=False,
                        latency_ms=attempt_latency_ms,
                        prompt_tokens=call_result.prompt_tokens,
                        completion_tokens=call_result.completion_tokens,
                        estimated_cost_usd=attempt_cost,
                        error_message="minor validation issue, auto-fix also failed",
                    )
                else:
                    logger.error(
                        "[%s] %s output had major validation issues (unsalvageable), moving to next tier", label, model
                    )
                    await _record_attempt(
                        call_group_id=call_group_id,
                        endpoint=label,
                        model=model,
                        is_fix_pass=False,
                        status="failure",
                        is_served=False,
                        latency_ms=attempt_latency_ms,
                        prompt_tokens=call_result.prompt_tokens,
                        completion_tokens=call_result.completion_tokens,
                        estimated_cost_usd=attempt_cost,
                        error_message="major validation issue (unsalvageable)",
                    )
                last_error = Exception(f"{model} failed validation")
                continue

            # Non-validated tiers only need to produce valid JSON (matching the original,
            # pre-chain behavior) -- the stricter "does it match the expected schema" bar is
            # deliberately reserved for the validated tier(s) only, per spec. Requiring full key
            # coverage here would reject a capable model's slightly-differently-shaped-but-usable
            # response just as readily as it would reject genuine garbage.
            if parsed is not None:
                logger.info("[%s] served by %s", label, model)
                await _record_attempt(
                    call_group_id=call_group_id,
                    endpoint=label,
                    model=model,
                    is_fix_pass=False,
                    status="success",
                    is_served=True,
                    latency_ms=attempt_latency_ms,
                    prompt_tokens=call_result.prompt_tokens,
                    completion_tokens=call_result.completion_tokens,
                    estimated_cost_usd=attempt_cost,
                    error_message=None,
                )
                return parsed

            logger.error("[%s] %s returned unparseable output, moving to next tier", label, model)
            await _record_attempt(
                call_group_id=call_group_id,
                endpoint=label,
                model=model,
                is_fix_pass=False,
                status="failure",
                is_served=False,
                latency_ms=attempt_latency_ms,
                prompt_tokens=call_result.prompt_tokens,
                completion_tokens=call_result.completion_tokens,
                estimated_cost_usd=attempt_cost,
                error_message="unparseable output",
            )
            last_error = Exception(f"{model} returned unparseable output")

    reason = str(last_error) if last_error is not None else "no model in the fallback chain returned a valid response"
    raise Exception(f"{label} failed across the entire model fallback chain: {reason}. Please try again.")


async def get_next_brainstorm_turn(
    history: list[dict[str, str]],
    project_name: str,
    api_key: str,
    known_knowledge_level: str = "unknown",
    has_existing_system: bool = False,
) -> dict:
    is_growth_phase = any(h["stage"] == "growth_trigger" for h in history)

    if is_growth_phase:
        system_instruction = f"""
You are a senior cloud systems architect processing a growth trigger or requirement change for a project named "{project_name}".
The initial discovery brainstorm was already completed. The user is now reporting a change to their project's requirements (e.g., new scale, new features, budget changes).

Evaluate the user's reported changes:
1. If the reported changes are clear and you have enough details to update the requirements, respond with a confirmation message outlining what you've understood and state that you are updating the design. In this case, set "isComplete" to true and transition "stage" to "requirement_gathering".
2. If some aspects are unclear or you need more context (e.g., they ask for real-time notifications but you don't know the expected throughput, or they mention scaling but no user count), ask exactly ONE follow-up question to clarify. Set "isComplete" to false and keep "stage" as "growth_trigger".

Never apologize or reference previous attempts, formatting issues, or corrections in your response — respond naturally as if this is the only attempt.

Additionally, alongside "message", generate "suggestedReplies": 2 to 4 short (a few words to one short sentence) candidate answers to the question YOU are asking in "message", tailored specifically to this product idea and what's been discussed so far — never generic placeholders like "Yes" / "No" / "Not sure" unless the question is genuinely binary. Each suggestion must be a concrete, realistic, directly-sendable answer (e.g. for a scale question on a described B2B tool: "About 500 companies, 5k daily active users", not "Medium scale"). If "isComplete" is true (no more question to answer), return an empty array for "suggestedReplies".

You MUST respond with a raw JSON object matching this TypeScript structure:
{{
  "message": string (your conversational follow-up question or update confirmation),
  "isComplete": boolean (set to true ONLY when you have enough details or are transitioning to requirement_gathering),
  "stage": "growth_trigger" | "requirement_gathering" (set to "requirement_gathering" when isComplete is true, otherwise "growth_trigger"),
  "detectedIndustry": "fintech" | "healthtech" | "none",
  "industryRationale": string (one short sentence — reuse your prior assessment if nothing new changes it),
  "suggestedReplies": string[]
}}
Do not include markdown code block formatting (like ```json) in your raw response, return only the JSON object.
"""
    else:
        if known_knowledge_level == "unknown":
            knowledge_level_instruction = """
Knowledge-level detection (do this ONLY now, since it hasn't been determined yet):
Assess, from the product idea description and any answers given so far, whether this user is describing their product in TECHNICAL terms (mentions specific technologies, request rates, scaling terms, architecture concepts, data models -- someone who already thinks in system-design vocabulary) or LAYMAN terms (describes the product/business purpose in plain language, no technical detail, may not know their own user counts or technical vocabulary).
Set "knowledgeLevel" to "technical" or "beginner" based on this assessment. Only return "unknown" if the idea description is genuinely too short/ambiguous to tell (e.g. a two-word idea) -- in that case ask a gentle, plain-language opening question to reveal more before classifying, and you MUST classify by the very next turn regardless.
Then answer THIS turn's question using whichever mode you just picked, below."""
        elif known_knowledge_level == "beginner":
            knowledge_level_instruction = """
This user was already classified as a BEGINNER (layman, zero architecture knowledge) earlier in this conversation. Set "knowledgeLevel" to "beginner" again (do not change it once set) and use BEGINNER MODE below for this question."""
        else:
            knowledge_level_instruction = """
This user was already classified as TECHNICAL earlier in this conversation. Set "knowledgeLevel" to "technical" again (do not change it once set) and use TECHNICAL MODE below for this question."""

        existing_system_instruction = (
            """
IMPORTANT: This user already has an EXISTING system in production -- they are migrating/modernizing, not building from scratch. At a natural point in the conversation (don't tack on extra turns for this -- blend it into whichever topic it fits, e.g. team capability or budget is a natural moment to also ask about the current setup), also gather:
1. What the current system is built with (languages, frameworks, hosting -- e.g. "a Django app on a single VM", "PHP on shared hosting", "a Rails monolith on Heroku").
2. How it's currently deployed/operated (manual deploys? any CI/CD? one server or several?).
3. Their main pain points or reasons for wanting a new architecture (what's actually broken or limiting them today).
This is in ADDITION to the normal checklist below, not a replacement for it -- the target architecture still needs the same information a greenfield project would."""
            if has_existing_system
            else ""
        )

        system_instruction = f"""
You are a senior cloud systems architect conducting a discovery and brainstorming session with a client for a project named "{project_name}".
Your goal is to gather enough context to generate a high-quality High-Level Design (HLD) architecture.
{knowledge_level_instruction}
{existing_system_instruction}

=== TECHNICAL MODE (confident, detailed answers -- founder/engineer who already thinks in architecture terms) ===
Keep the conversation tight and efficient. Ask exactly ONE clear, specific question at a time to clarify:
1. Target traffic size / scalability (e.g., request rate, data storage size).
2. System nature (real-time processing vs. background asynchronous worker jobs).
3. Operational maturity / budget (serverless/low cost vs. managed containerized cluster).
4. Key security or compliance requirements (data privacy, B2B SSO, audit logs).
Stop Condition: If the user provides sufficient details on these points, or if the conversation history has reached 6 or more turns (count the messages in history), set "isComplete" to true and transition "stage" to "requirement_gathering". Give a warm concluding message summarizing that you are ready to synthesize requirements.
If the user gives very short or vague answers repeatedly, do not get stuck. Pivot and wrap up the brainstorm after a maximum of 6 turns total.

=== BEGINNER MODE (zero-knowledge user -- describes their idea in plain, non-technical language, may not know their own scale or vocabulary) ===
Go deeper and slower than TECHNICAL MODE. Ask exactly ONE plain-language question at a time, working through this full checklist over the course of the conversation (don't skip any, but you may cover two naturally in one answer if the user volunteers it):
1. Users/scale -- roughly how many people might use this, even a rough guess.
2. Read vs. write pattern -- do people mostly look at/browse things, or are they also constantly adding or changing things (explain the distinction in plain terms -- never say the phrase "read-write pattern" itself).
3. Real-time needs -- does anything need to update instantly for users, or is a short delay fine.
4. Data sensitivity -- does the app store anything private or sensitive (payments, health info, personal documents).
5. Budget -- a rough monthly ceiling they're comfortable with, framed with concrete examples ("something like $50/month" vs "more like $2,000/month").
6. Team capability -- do they have technical people helping build/run this, or are they mostly non-technical.
7. Growth expectations -- do they expect this to stay small and steady, or hope/plan for rapid growth.
8. Integrations -- does it need to connect to other tools or services (payment processors, email, SMS, maps, calendars, etc.).

For EVERY question in BEGINNER MODE:
- Never use unexplained technical jargon. If a technical term is genuinely unavoidable, define it in one short plain clause inline.
- Explain WHY you're asking, tied to specifics of what THEY already told you about THEIR idea -- never a generic, interchangeable explanation. For example, not "How many users do you expect?" but something like: "How many people do you think might use [their specific feature/product], even a rough guess? This helps me figure out how much computing power to plan for -- a booking tool for one local shop might only need to handle dozens of bookings a day, but if you're picturing hundreds of shops using this at once, that changes the design quite a bit. There's no wrong answer here, just your best guess."
- Reassure that approximate/uncertain answers are completely fine ("no wrong answer", "just a rough guess", "we can always adjust later") since this user may not know precise numbers or terms.
Stop Condition: Do NOT stop after only a few turns. Only set "isComplete" to true once you've touched on ALL 8 checklist topics above (directly, or the user volunteered the info earlier unprompted). As a safety net, if the conversation reaches 20 total messages and topics still remain, wrap up anyway using sensible stated defaults for whatever's left, briefly explaining what you assumed and why. When concluding, give a warm summary of everything gathered.

=== BOTH MODES ===
Industry detection (do this silently on every turn, alongside the active mode's topics):
- Classify the product idea into one of: "fintech" (payments, banking, card processing, lending, insurance, trading, or other financial services), "healthtech" (medical records, patient data, clinical workflows, healthcare providers, or health data processing), or "none" (anything else, or not enough signal yet).
- The FIRST time you detect "fintech" or "healthtech" in this conversation, your next question MUST be the relevant one below -- in TECHNICAL MODE this REPLACES a generic compliance question (topic 4), in BEGINNER MODE this REPLACES the data-sensitivity checklist item (topic 4), it does not add an extra turn in either mode:
  - fintech: "Will you be handling card payments directly, or through a processor like Stripe or Braintree?" (in BEGINNER MODE, add one plain clause explaining why: this changes how much sensitive payment data your own systems ever have to touch).
  - healthtech: "Will your system store or process Protected Health Information (PHI), such as medical records or clinical data?" (in BEGINNER MODE, add a one-clause explanation: this determines whether strict healthcare privacy rules apply).
- You may ask AT MOST ONE further brief industry-specific follow-up later in the conversation if the answer above needs clarification (e.g., healthtech: "Which country or region's data residency rules apply to your users?"). Never ask more than 2 industry-specific questions total across the whole conversation, and never let them replace more than one topic in either mode's checklist.
- If industry is "none", proceed with the active mode's topic list exactly as written -- nothing about the flow changes.

Domain awareness (do this silently on every turn, alongside industry detection above -- this is a DIFFERENT, broader classification than the fintech/healthtech industry check: an app can be healthtech AND a marketplace at once):
- Classify what CATEGORY of product this is -- e-commerce, SaaS (single- or multi-tenant), marketplace/two-sided platform, content/media platform, real-time messaging/social, internal tool, or whatever category genuinely fits (a short, specific noun phrase, not a rigid enum -- "B2B invoicing SaaS" is better than just "SaaS" when you have that detail).
- Once you have a category, act like a senior architect who has actually seen many projects in that category before, not a blank-slate question generator: let your general knowledge of how THAT category of product typically evolves -- common scale milestones, typical failure points as it grows, industry-standard patterns for solving them -- inform which follow-up question you ask next, not just the fixed checklist topic names. For example, for an e-commerce idea, "expected scale" isn't just a number -- a senior architect also wants to know catalog size (search/indexing needs emerge past a few thousand SKUs) and whether flash-sale/seasonal traffic spikes are expected (these are well-known e-commerce-specific pressure points), so let that inform HOW you ask the scale question, not just THAT you ask it.
- This must stay grounded in genuinely well-known, general patterns for that category -- never invent a "well-known" pattern that isn't real, and never claim insider knowledge of any specific company's actual implementation.
- Set "detectedDomain" to the category (short phrase) and "domainRationale" to one short clause on why -- reuse your prior assessment once set, the same as industry detection.

Reference-system detection (do this silently on every turn, alongside domain awareness above):
- If the user mentions a specific existing product or company as inspiration or comparison (e.g. "like Shopify but simpler", "similar to how Airbnb handles booking availability", "basically a Notion clone"), acknowledge it naturally in your response and let your GENERAL, PUBLIC knowledge of how that TYPE of system conceptually tends to work inform your follow-up questions -- e.g. for "like Shopify", you might ask about multi-tenant storefront isolation or catalog/inventory sync, since those are well-known conceptual concerns for that category of product.
- Be explicit that this is general/public pattern knowledge, never implying insider or proprietary knowledge of that specific company's actual real implementation -- if you reference the comparison in "message", phrase it as "systems like [X] typically..." or "the general pattern [X]-style products tend to use is...", never "[X] actually does..." or anything asserting certainty about their real internals.
- Set "referenceSystem" to the mentioned product/company name if one was mentioned (reuse across turns once set), or null if none was mentioned.

Rules:
- Do NOT dump a list of questions. Ask ONLY ONE follow-up question in each turn.
- Be conversational. Acknowledge their previous answer and build on it.
- Never apologize or reference previous attempts, formatting issues, or corrections in your response — respond naturally as if this is the only attempt.

Additionally, alongside "message", generate "suggestedReplies": in BEGINNER MODE, ALWAYS generate 3 to 4 concrete candidate answers (a beginner benefits far more from picking a plausible option than typing a precise technical answer from scratch) -- e.g. for a budget question: ["Under $100/month", "$100-500/month", "$500-2,000/month", "Not sure yet -- whatever's reasonable to start"]. In TECHNICAL MODE, generate 2 to 4 as before. In both modes, never use generic placeholders like "Yes" / "No" / "Not sure" unless the question is genuinely binary -- each suggestion must be a concrete, realistic, directly-sendable answer tailored to this specific product idea and what's been discussed so far. If "isComplete" is true (concluding message, no more question to answer), return an empty array for "suggestedReplies".

You MUST respond with a raw JSON object matching this TypeScript structure:
{{
  "message": string (your conversational follow-up question or concluding summary -- in BEGINNER MODE, include the plain-language "why I'm asking, tied to their idea" explanation inline in this same string),
  "isComplete": boolean (set to true ONLY when you have enough details or are wrapping up per the active mode's stop condition),
  "stage": "brainstorm" | "requirement_gathering" (set to "requirement_gathering" when isComplete is true, otherwise "brainstorm"),
  "detectedIndustry": "fintech" | "healthtech" | "none",
  "industryRationale": string (one short sentence explaining the classification, even if "none"),
  "detectedDomain": string (short product-category phrase, e.g. "e-commerce", "B2B invoicing SaaS", "two-sided marketplace" -- your best assessment even from a short idea description),
  "domainRationale": string (one short clause explaining the classification),
  "referenceSystem": string | null (a specific product/company the user named as inspiration/comparison, or null),
  "knowledgeLevel": "technical" | "beginner" | "unknown",
  "suggestedReplies": string[]
}}
Do not include markdown code block formatting (like ```json) in your raw response, return only the JSON object.
"""

    messages_for_api = [
        {"role": "system", "content": system_instruction},
        *[{"role": "user" if h["role"] == "user" else "assistant", "content": h["message"]} for h in history],
    ]

    expected_keys = (
        ["message", "isComplete", "stage", "detectedIndustry", "industryRationale", "suggestedReplies"]
        if is_growth_phase
        else [
            "message",
            "isComplete",
            "stage",
            "detectedIndustry",
            "industryRationale",
            "detectedDomain",
            "domainRationale",
            "referenceSystem",
            "knowledgeLevel",
            "suggestedReplies",
        ]
    )

    try:
        result = await _call_llm_with_fallback_chain(
            api_key, messages_for_api, "Brainstorm turn generation", expected_keys=expected_keys
        )

        if _looks_like_leaked_apology(result["message"]):
            logger.error(
                "[Brainstorm turn generation] Detected leaked apology text in response, re-requesting with a clean prompt"
            )
            result = await _call_llm_with_fallback_chain(
                api_key, messages_for_api, "Brainstorm turn generation (apology cleanup)", expected_keys=expected_keys
            )

        return result
    except Exception as err:
        logger.error("Brainstorm turn generation exhausted the whole model fallback chain, falling back to a generic question: %s", err)
        return {
            "message": "Thank you for the details. Could you share a bit more about your scaling or compliance requirements?",
            "isComplete": len(history) >= 6,
            "stage": "requirement_gathering" if len(history) >= 6 else "brainstorm",
            "knowledgeLevel": known_knowledge_level,
        }


async def extract_requirements_from_history(history: list[dict[str, str]], api_key: str) -> dict:
    system_instruction = """
You are a senior systems analyst. Your job is to analyze the conversation history between a user and an architecture discovery assistant, and extract structured functional and non-functional requirements.

Rules:
- For functional: List the concrete features or capabilities mentioned or requested (e.g., "B2B invoicing", "invoice upload", "audit log creation"). Limit to 6 key bullet points.
- For non-functional: You must categorize under the following keys:
  - expectedScale: user load, request volume, data volume estimates.
  - readWritePattern: write-heavy, read-heavy, spiky traffic, etc.
  - dataNature: media files, transactional database, unstructured key-value, etc.
  - latencySensitivity: milliseconds latency required, asynchronous processing tolerated, etc.
  - budget: expected cost limits.
  - teamMaturity: experience level of the development/ops team.
  - compliance: data privacy, encryption, residency, etc.
- For industryContext: classify the whole conversation into a regulated industry, by meaning and context — not by matching keywords:
  - "industry": "fintech" (payments, banking, card processing, lending, insurance, trading, other financial services), "healthtech" (medical records, patient data, clinical workflows, healthcare providers, health data), or "none" (anything else).
  - "rationale": one sentence explaining why.
  - "complianceAnswers": every industry-specific compliance question that was asked and answered anywhere in the conversation (about card data handling, PHI, data residency, etc.), as { "question": string, "answer": string } pairs. Empty array if industry is "none" or none were asked.
  - "flags": derive from the complianceAnswers —
    - "handlesCardDataDirectly": boolean, fintech only, true if the user handles card data directly, false if only through a processor like Stripe. Omit the key entirely if not fintech or not discussed.
    - "storesPHI": boolean, healthtech only, true if the user stores/processes PHI. Omit the key entirely if not healthtech or not discussed.
    - "dataResidency": string, healthtech only, the country/region mentioned, or "not_specified" if healthtech but never discussed. Omit the key entirely if not healthtech.
- For existingSystem: ONLY if the conversation discusses an EXISTING system being migrated/modernized (not a from-scratch build) —
  - "techStack": string, the current system's languages/frameworks/hosting as described (e.g. "Django monolith on a single EC2 VM, PostgreSQL on the same box").
  - "deployment": string, how it's currently deployed/operated (manual deploys, any CI/CD, single vs. multiple servers).
  - "painPoints": string, the stated reasons for wanting a new architecture / what's limiting them today.
  Set the whole "existingSystem" object to null if no existing system was discussed anywhere in the conversation — do not invent one.
- For productDomain: a BROADER classification than industryContext (an app can be healthtech AND a marketplace at once) --
  - "category": a short, specific product-category noun phrase (e.g. "e-commerce", "B2B invoicing SaaS", "two-sided marketplace", "content/media platform", "real-time messaging"), your best assessment from the whole conversation.
  - "rationale": one short clause.
  - "referenceSystem": a specific existing product/company the user named as inspiration or comparison anywhere in the conversation (e.g. "Shopify", "Airbnb"), or null if none was mentioned. Never infer one that wasn't actually named.

CRITICAL: If a non-functional item was NOT discussed in the conversation and cannot be reasonably and strongly inferred from context, set it EXACTLY to "not_specified". Do NOT guess or use silent defaults. The same applies to industryContext — do not infer a regulated industry from weak signal. productDomain.category is the one exception -- always give your best-effort classification even from limited signal, since every product fits SOME general category and "not_specified" would be useless for that field specifically.

You MUST respond with a raw JSON object matching this structure:
{
  "functional": [string, string, ...],
  "nonFunctional": {
    "expectedScale": string,
    "readWritePattern": string,
    "dataNature": string,
    "latencySensitivity": string,
    "budget": string,
    "teamMaturity": string,
    "compliance": string
  },
  "industryContext": {
    "industry": "fintech" | "healthtech" | "none",
    "rationale": string,
    "complianceAnswers": [ { "question": string, "answer": string } ],
    "flags": {
      "handlesCardDataDirectly": boolean,
      "storesPHI": boolean,
      "dataResidency": string
    }
  },
  "productDomain": {
    "category": string,
    "rationale": string,
    "referenceSystem": string | null
  },
  "existingSystem": { "techStack": string, "deployment": string, "painPoints": string } | null
}
Do not include markdown code block formatting (like ```json) in your response, return only the raw JSON.
"""

    messages_for_api = [
        {"role": "system", "content": system_instruction},
        *[{"role": "user" if h["role"] == "user" else "assistant", "content": h["message"]} for h in history],
    ]

    return await _call_llm_with_fallback_chain(
        api_key,
        messages_for_api,
        "Requirement extraction",
        expected_keys=["functional", "nonFunctional", "industryContext", "productDomain", "existingSystem"],
    )


async def generate_conversation_summary(
    history: list[dict[str, str]], requirements: dict, api_key: str, knowledge_context: list[dict] | None = None
) -> dict:
    """Generates the Conversation Summary section's brief -- a short readable narrative of the
    discovery conversation, not a transcript restatement. Called lazily (not on every requirements
    save) and cached by the caller on the requirements row it was generated for. Returns
    {"summary": str, "sources": list[dict]} -- sources is a whole-summary-level citation list
    (this is one paragraph of prose, not per-component output), empty when nothing retrieved was
    genuinely relevant."""
    knowledge_instruction = ""
    if knowledge_context:
        knowledge_instruction = """
- You are also given "referenceExcerpts" -- passages from real software-engineering reference books, retrieved because they were judged relevant to this product's requirements. If a passage genuinely helps explain WHY a decision in this summary makes sense (not just topically related), you may ground a sentence in it. Add a top-level "sources" array: [{"book": string, "chapterOrSection": string, "page": string}], using the exact bookTitle/chapterTitle/pageStart-pageEnd values given, ONLY for excerpts you genuinely drew on. If nothing given is genuinely relevant to what you wrote, return an empty "sources" array -- do not force one.
"""

    system_instruction = (
        """
You are a senior systems analyst writing a short, readable brief that summarizes a product discovery conversation for someone who wasn't in the room -- a teammate skimming the project later, or the user themselves reviewing what was decided.

Write 3 to 5 sentences of flowing prose covering: what the user described building, what the AI asked or clarified along the way, what was ultimately decided (functional scope, scale, budget, compliance posture), and briefly why -- tie conclusions to specific things the user actually said.

Rules:
- Prose, not a bullet list or a blow-by-blow transcript restatement ("The user said X, then the AI asked Y...").
- Be concrete: use the real numbers and details from the conversation and requirements, not vague generalities like "a scalable solution".
- Do not editorialize or add caveats that aren't grounded in the conversation.
"""
        + knowledge_instruction
        + """
You MUST respond with a raw JSON object matching this structure:
{ "summary": string, "sources": [{"book": string, "chapterOrSection": string, "page": string}] }
Do not include markdown code block formatting (like ```json) in your response, return only the raw JSON.
"""
    )

    input_context = {"conversationHistory": history, "finalRequirements": requirements}
    if knowledge_context:
        input_context["referenceExcerpts"] = [
            {
                "bookTitle": c["bookTitle"],
                "author": c["author"],
                "chapterTitle": c.get("chapterTitle"),
                "pageStart": c["pageStart"],
                "pageEnd": c["pageEnd"],
                "text": c["text"],
                "sourceType": c.get("sourceType", "principle"),
            }
            for c in knowledge_context
        ]

    messages_for_api = [
        {"role": "system", "content": system_instruction},
        {"role": "user", "content": json.dumps(input_context)},
    ]
    result = await _call_llm_with_fallback_chain(
        api_key, messages_for_api, "Conversation summary generation", expected_keys=["summary", "sources"]
    )
    return {"summary": result["summary"], "sources": result.get("sources") or []}


async def generate_flow_story(
    provider: str,
    components: list[dict],
    connections: list[dict],
    functional: list[str],
    api_key: str,
    knowledge_context: list[dict] | None = None,
) -> dict:
    """Generates the Architecture Flow Story section for one provider -- a plain-language,
    step-by-step walkthrough of request/data flow, synthesized from the real per-provider service
    names and each component's already-computed reasoning (not regenerated from scratch, and not
    generic per-service boilerplate). Called lazily per provider and cached by the caller on the
    architecture row's flow_story[provider] key. Returns {"story": str, "sources": list[dict]} --
    sources is a whole-narrative-level citation list, empty when nothing retrieved was genuinely
    relevant."""
    knowledge_instruction = ""
    if knowledge_context:
        knowledge_instruction = """
- You are also given "referenceExcerpts" -- passages from real software-architecture reference books, retrieved because they were judged relevant to this architecture's component makeup. If a passage genuinely helps explain WHY the flow works the way it does (not just topically related), you may ground a sentence in it. Add a top-level "sources" array: [{"book": string, "chapterOrSection": string, "page": string}], using the exact bookTitle/chapterTitle/pageStart-pageEnd values given, ONLY for excerpts you genuinely drew on. If nothing given is genuinely relevant, return an empty "sources" array -- do not force one.
"""

    system_instruction = (
        """
You are a senior cloud systems architect writing a plain-language, step-by-step walkthrough of how a request actually flows through a generated architecture, for someone with zero architecture background.

You are given the component list (each with the REAL cloud service chosen for it on this specific provider, and the genuine architect reasoning for why it exists), the connections between components, and the product's functional requirements.

Write a narrative (a few short paragraphs, not bullet points) that traces control/data flow starting from wherever a user request would enter the system, following the connections, ending at final storage or response. If there are multiple distinct paths (e.g. a compliance-only path, a background job path), cover each briefly rather than only the main path.

Rules:
- Use the actual service names given, not generic terms -- say "Amazon Aurora PostgreSQL", never just "the database".
- Ground every claim in the provided components/connections/reasoning -- do not invent behavior not present in the data.
- Tie specific steps back to the actual functional requirements where relevant (e.g. "since the product needs SMS reminders, the notification worker sends to...").
- Write for a total beginner: explain WHY a step happens, not just that it happens.
"""
        + knowledge_instruction
        + """
You MUST respond with a raw JSON object matching this structure:
{ "story": string, "sources": [{"book": string, "chapterOrSection": string, "page": string}] }
Do not include markdown code block formatting (like ```json) in your response, return only the raw JSON.
"""
    )

    input_context = {
        "provider": provider,
        "components": components,
        "connections": connections,
        "functionalRequirements": functional,
    }
    if knowledge_context:
        input_context["referenceExcerpts"] = [
            {
                "bookTitle": c["bookTitle"],
                "author": c["author"],
                "chapterTitle": c.get("chapterTitle"),
                "pageStart": c["pageStart"],
                "pageEnd": c["pageEnd"],
                "text": c["text"],
                "sourceType": c.get("sourceType", "principle"),
            }
            for c in knowledge_context
        ]
    messages_for_api = [
        {"role": "system", "content": system_instruction},
        {"role": "user", "content": json.dumps(input_context)},
    ]
    result = await _call_llm_with_fallback_chain(
        api_key, messages_for_api, "Flow story generation", expected_keys=["story", "sources"]
    )
    return {"story": result["story"], "sources": result.get("sources") or []}


async def generate_user_journey(
    provider: str, flow_story: str, components: list[dict], connections: list[dict], functional: list[str], api_key: str
) -> list[dict]:
    """Generates the "User Journey Architecture" view's step-by-step breakdown for one provider --
    restructures the ALREADY-GENERATED flow_story narrative (never re-derives request flow from
    scratch) into discrete end-user-facing steps, each naming which real components are touched.
    This is deliberately downstream of generate_flow_story: the caller must ensure flow_story is
    already generated/cached for this provider before calling this. Called lazily per provider
    and cached by the caller on the architecture row's journey_steps[provider] key."""
    system_instruction = """
You are a senior solutions architect preparing the "user journey" section of a design review -- the part that walks a non-technical stakeholder through what an actual END USER does, step by step, and which backend components each step touches. This is NOT a repeat of the technical flow narrative; it's a restructuring of it into discrete, user-centric steps.

You are given: the already-written technical flow story (a prose walkthrough of request/data flow for this provider), the component list (each with its real cloud service name and reasoning), the connections between components, and the product's functional requirements.

Trace 1-2 of the core end-to-end user journeys implied by the functional requirements (e.g. for a booking app: "opens app -> browses available slots -> selects a slot -> confirms booking -> receives confirmation"). For EACH step:
- "userAction": what the end user actually does or experiences, in plain language, from their point of view (e.g. "Selects an available time slot and taps 'Book'") -- never a technical/system-level description.
- "systemResponse": what happens behind the scenes for that specific step, in plain language, grounded in the flow story and component reasoning you were given.
- "componentIds": the array of component "id" values (from the given component list) actually involved in this step. Must be real ids from the list, never invented.

Rules:
- In "systemResponse", ALWAYS use the actual cloud service name given in the component list (e.g. "Amazon ECS Fargate + ALB", "Amazon ElastiCache (Redis OSS)") -- never a generic paraphrase like "the API service" or "the cache" on its own. This matches the flow story you were given, which already does this; do not regress to generic terms when restructuring it into steps.
- Ground every step in the flow story and component data given -- do not invent behavior not present in the data.
- Order steps in the sequence a real user would experience them.
- If there are genuinely 2 distinct core journeys (e.g. a primary booking flow and a separate compliance/audit-triggered flow), include both, but do not pad with a second journey if there's only one real end-to-end path.
- Keep each step's text concise (1-2 sentences each for userAction and systemResponse).

You MUST respond with a raw JSON object matching this TypeScript structure:
{
  "journeySteps": [
    { "userAction": string, "systemResponse": string, "componentIds": string[] }
  ]
}
Do not include markdown code block formatting (like ```json) in your response, return only the raw JSON.
"""

    input_context = {
        "provider": provider,
        "flowStory": flow_story,
        "components": components,
        "connections": connections,
        "functionalRequirements": functional,
    }
    messages_for_api = [
        {"role": "system", "content": system_instruction},
        {"role": "user", "content": json.dumps(input_context)},
    ]
    result = await _call_llm_with_fallback_chain(
        api_key, messages_for_api, "User journey generation", expected_keys=["journeySteps"]
    )
    return result.get("journeySteps") or []


async def generate_executive_summary(
    project_name: str,
    provider: str,
    cost: dict,
    functional: list[str],
    non_functional: dict,
    industry_context: dict,
    assumptions: list[str],
    risks: list[str],
    api_key: str,
) -> dict:
    """Generates the Executive Summary Export (Workstream T2) -- a one-page, plain-business-
    language synthesis for a non-technical stakeholder (investor, exec), from data ALREADY
    computed and stored (cost, requirements, industry compliance context, risks/assumptions from
    the original architecture generation). Never re-derives architecture decisions from scratch,
    and never receives the component list or HLD -- only the already-synthesized business-facing
    inputs, which structurally forces the output to stay jargon-light rather than describing
    infrastructure. Not cached (unlike flow_story/journey_steps): this is a light, rarely-repeated
    one-page synthesis, and caching would need a new persisted column for a feature this small."""
    system_instruction = """
You are writing a one-page executive summary of a cloud architecture design for a reader with ZERO technical background -- a non-technical founder, an investor doing diligence, a board member. They do not know what "compute" or "object storage" means and do not need to.

You are given: the product's functional capabilities (plain descriptions, not code), non-functional requirements (scale, budget, team maturity, compliance notes), industry/compliance context if any, the estimated monthly cost range, and the risks/assumptions already identified during design.

Write ONLY business-readable prose. Rules:
- NEVER use cloud service names, component names, or technical jargon (no "ECS", "S3", "load balancer", "API Gateway", "database", etc). Describe capability and outcome instead ("the system can securely store customer records" not "uses a managed database").
- Overview: 1-2 sentences on what's being built, in plain terms a non-technical reader immediately understands.
- Scalability readiness: plain language on what growth this design can absorb without a major rebuild -- reference the actual stated scale if given (e.g. "this can comfortably grow from your current user base to several times that size without needing a fundamental redesign"). Be honest if scale wasn't specified.
- Compliance posture: plain language on what regulatory/compliance considerations were designed for (if the industry context indicates none, say briefly that no specific regulatory framework was flagged, don't invent one).
- Key risks: the TOP 2-3 risks only, in plain business terms (financial, operational, or reputational framing, not technical framing) -- do not just restate every risk given verbatim; pick the most material ones and rewrite them for this audience.

You MUST respond with a raw JSON object matching this structure:
{
  "overview": string,
  "scalabilityReadiness": string,
  "compliancePosture": string,
  "keyRisks": [string, string] | [string, string, string]
}
Do not include markdown code block formatting (like ```json) in your response, return only the raw JSON.
"""

    input_context = {
        "projectName": project_name,
        "provider": provider,
        "estimatedMonthlyCost": cost,
        "functionalCapabilities": functional,
        "nonFunctionalRequirements": non_functional,
        "industryContext": industry_context,
        "designAssumptions": assumptions,
        "designRisks": risks,
    }
    messages_for_api = [
        {"role": "system", "content": system_instruction},
        {"role": "user", "content": json.dumps(input_context)},
    ]
    return await _call_llm_with_fallback_chain(
        api_key,
        messages_for_api,
        "Executive summary generation",
        expected_keys=["overview", "scalabilityReadiness", "compliancePosture", "keyRisks"],
    )


async def generate_migration_roadmap(
    provider: str,
    existing_system: dict,
    components: list[dict],
    connections: list[dict],
    functional: list[str],
    api_key: str,
    product_domain: dict | None = None,
) -> dict:
    """Generates the Migration Roadmap (Workstream T5) -- a phased plan from the user's stated
    EXISTING system (tech stack, deployment, pain points) to the already-generated target
    architecture, using the strangler-fig pattern where applicable (incrementally routing traffic
    to new components while the legacy system keeps running, rather than a single risky cutover).
    Grounded in the real target components/reasoning already computed for this provider -- never
    invents infrastructure the target design doesn't actually have. Called lazily per provider and
    cached by the caller on the architecture row's migration_roadmap[provider] key, same pattern as
    flow_story."""
    domain_instruction = ""
    if product_domain and product_domain.get("category") and product_domain["category"] != "other":
        domain_instruction = f"""
- This product's domain is "{product_domain['category']}". Where a genuinely well-known domain-typical evolution pattern is relevant to WHY a phase is sequenced where it is (e.g. e-commerce platforms typically need to introduce a dedicated search index and a caching layer once catalog size and traffic cross certain thresholds; multi-tenant SaaS typically needs to revisit its tenant-isolation strategy once it crosses from a handful of large customers to many smaller ones), weigh it into "why" and set that phase's "domainPattern" to a short, visibly-labeled qualifier (e.g. "Common next step for e-commerce platforms once catalog search becomes a bottleneck"). Ground this ONLY in genuinely well-established general knowledge for the domain, and only where it's actually relevant to this migration -- most phases will have no "domainPattern" at all, and that's expected.
"""

    system_instruction = (
        """
You are a senior cloud migration architect writing a phased roadmap for a team modernizing an existing production system into a new target cloud architecture that has already been designed.

You are given: the user's description of their CURRENT system (tech stack, deployment, pain points), the TARGET architecture's real components (with the actual cloud service chosen for each and the architect's reasoning for it), the connections between target components, and the product's functional requirements.

Write a phased migration plan -- typically 3 to 5 phases, never more than 6. Use the strangler-fig pattern where it genuinely applies (e.g. "Phase 1: put the new API gateway in front of the legacy monolith, routing only new endpoints through it while the monolith keeps serving the rest" -- incrementally carving pieces out of the legacy system rather than a single big-bang cutover), but only claim strangler-fig where it actually fits this specific migration -- don't force the label onto a phase that's really just infrastructure setup.

Rules:
- Ground every phase in the REAL target components given -- reference their actual service names/reasoning, not generic advice.
- Order phases the way a team would actually execute them (foundational infrastructure and low-risk pieces first, the riskiest/most central piece -- often the core data store or the monolith itself -- later, once the surrounding pieces are proven).
- Each phase's "effort" must be "small", "medium", or "large" -- a RELATIVE sizing judgment (team-weeks of complexity), never a specific time estimate (no "2 weeks", no dates).
- Be honest about risk: if a phase is inherently risky (e.g. a database cutover), say so in "why".
- Do not invent legacy technical details the user didn't mention -- only reason from what's actually in "existingSystem".
"""
        + domain_instruction
        + """
You MUST respond with a raw JSON object matching this structure:
{
  "phases": [
    {
      "phase": number (1-indexed, in execution order),
      "title": string (short, e.g. "Containerize the monolith"),
      "whatChanges": string (concrete description of the actual work in this phase),
      "why": string (the reasoning -- why this phase, why now, what risk it manages or unlocks),
      "usesStranglerFig": boolean,
      "effort": "small" | "medium" | "large",
      "domainPattern": string
    }
  ]
}
Do not include markdown code block formatting (like ```json) in your response, return only the raw JSON.
"""
    )

    input_context = {
        "provider": provider,
        "existingSystem": existing_system,
        "targetComponents": components,
        "targetConnections": connections,
        "functionalRequirements": functional,
    }
    if product_domain and product_domain.get("category") and product_domain["category"] != "other":
        input_context["productDomain"] = product_domain
    messages_for_api = [
        {"role": "system", "content": system_instruction},
        {"role": "user", "content": json.dumps(input_context)},
    ]
    result = await _call_llm_with_fallback_chain(
        api_key, messages_for_api, "Migration roadmap generation", expected_keys=["phases"]
    )
    return result.get("phases") or []


async def generate_whatif_suggestions(
    functional: list[str], non_functional: dict, industry_context: dict, api_key: str
) -> dict:
    """Generates clickable-chip HYPOTHETICAL variations for the What-If Simulator (Workstream V)
    -- deliberately a different framing from generate_requirement_suggestions above, which helps
    fill in a field's REAL value. Here every suggestion is a plausible "what if this changed"
    scenario relative to the CURRENT value given, grounded in the actual product, not a generic
    restatement or a guess at the real answer. Stateless, not persisted -- recomputed fresh
    whenever the What-If panel opens so suggestions reflect the project's current real state."""
    system_instruction = """
You are a senior cloud systems architect helping a user explore "what if" scenarios for their already-designed product. You are given their current functional capabilities, current non-functional requirement values, and current industry/compliance context.

For EACH field, suggest 2 to 4 concrete, REALISTIC HYPOTHETICAL variations worth exploring -- a genuinely different value from the current one, not a restatement of it and not a random guess. Ground each in what would actually be an interesting or plausible scenario for THIS specific product (e.g. if current expectedScale mentions "a few hundred users", a good hypothetical is "10x growth to a few thousand users within a year" or "a sudden viral spike to 50,000 users in a week" -- not just a vague "more users").

Rules:
- Each suggestion's "value" is a complete, directly-usable replacement value, ready to select as-is.
- Each "why" is one short clause (under 15 words) explaining what exploring that specific scenario would reveal or why it's plausible for this product -- e.g. "tests whether the design survives a funding-driven growth spurt", not generic filler.
- Never suggest the current value again, reworded.
- For "functional", suggest 2-4 NEW capabilities not already in the list that would be an interesting hypothetical addition to explore (e.g. "what if we added real-time collaboration").
- For "industry", suggest ONLY if a different regulated-industry framing would be a genuinely interesting scenario for this product (e.g. a general product exploring "what if this needed HIPAA compliance") -- if the current industry already makes sense and no interesting alternative exists, return an empty array for it.

You MUST respond with a raw JSON object matching this structure (every array entry is an object with "value" and "why", not a bare string):
{
  "expectedScale": [{"value": string, "why": string}],
  "readWritePattern": [{"value": string, "why": string}],
  "dataNature": [{"value": string, "why": string}],
  "latencySensitivity": [{"value": string, "why": string}],
  "budget": [{"value": string, "why": string}],
  "teamMaturity": [{"value": string, "why": string}],
  "compliance": [{"value": string, "why": string}],
  "functional": [{"value": string, "why": string}],
  "industry": [{"value": "none" | "fintech" | "healthtech", "why": string}]
}
Do not include markdown code block formatting (like ```json) in your response, return only the raw JSON.
"""

    input_context = {
        "functional": functional,
        "nonFunctional": non_functional,
        "industryContext": industry_context,
    }
    messages_for_api = [
        {"role": "system", "content": system_instruction},
        {"role": "user", "content": json.dumps(input_context)},
    ]
    return await _call_llm_with_fallback_chain(
        api_key,
        messages_for_api,
        "What-If suggestions generation",
        expected_keys=[
            "expectedScale",
            "readWritePattern",
            "dataNature",
            "latencySensitivity",
            "budget",
            "teamMaturity",
            "compliance",
            "functional",
            "industry",
        ],
    )


KNOWN_COMPONENT_TYPES = (
    "cdn",
    "compute",
    "database",
    "storage",
    "queue",
    "cache",
    "auth",
    "realtime",
    "tokenization",
    "audit-log",
    "phi-vault",
    "deidentification",
)


async def generate_component_suggestions(
    existing_components: list[dict], existing_connections: list[dict], requirements: dict, api_key: str
) -> dict:
    """Manual Editor Controls (Workstream W) -- suggests components likely worth adding next,
    given what's already in the draft diagram and the project's real requirements, so "Add
    Component" isn't just an unguided flat type dropdown. Stateless, not persisted -- the caller
    passes the CURRENT draft (not the last-saved architecture) so suggestions track in-progress
    manual edits, and is expected to re-fetch after significant draft changes, not on every
    keystroke."""
    system_instruction = f"""
You are a senior cloud systems architect reviewing a draft architecture diagram someone is manually editing. You are given the current list of components already in the diagram and the product's stated requirements (functional capabilities, non-functional requirements, industry/compliance context).

Suggest 3 to 4 SPECIFIC components genuinely worth adding next -- things implied by the requirements or missing capabilities that aren't already present in the diagram, not generic infrastructure filler. Never suggest a component whose role is already covered by an existing one.

Rules:
- "type" should be one of these known types if it genuinely fits: {", ".join(KNOWN_COMPONENT_TYPES)}. Only invent a new short kebab-case type if none of the known ones fit even loosely.
- "name" is a short, specific, human-readable component name (e.g. "Fraud Detection Service", not "Compute Instance").
- "reasoning" is one short clause (under 20 words) tied to a SPECIFIC stated requirement or gap in the current diagram -- e.g. "requirements mention SMS reminders but no messaging/notification component exists yet".
- Order suggestions by how clearly justified they are by the stated requirements, most-justified first.

You MUST respond with a raw JSON object matching this structure:
{{"suggestions": [{{"type": string, "name": string, "reasoning": string}}]}}
Do not include markdown code block formatting (like ```json) in your response, return only the raw JSON.
"""

    input_context = {
        "existingComponents": [{"name": c.get("name"), "type": c.get("type")} for c in existing_components],
        "existingConnections": existing_connections,
        "requirements": requirements,
    }
    messages_for_api = [
        {"role": "system", "content": system_instruction},
        {"role": "user", "content": json.dumps(input_context)},
    ]
    return await _call_llm_with_fallback_chain(
        api_key, messages_for_api, "Component suggestions generation", expected_keys=["suggestions"]
    )


async def propose_component_changes(
    description: str,
    existing_components: list[dict],
    existing_connections: list[dict],
    requirements: dict,
    api_key: str,
    product_domain: dict | None = None,
) -> list[dict]:
    """Identifies which architecture components a freeform chat-described enhancement would add
    or change, provider-agnostically (no service names -- the caller resolves those
    deterministically via cloud_mapping.py/lld_rules.py for whichever provider is active, the
    same "rules engine decides, LLM narrates" boundary the rest of the app follows). This is a
    preview only: nothing is persisted here, the caller applies only what the user approves via
    the existing manual-save endpoint."""
    domain_instruction = ""
    if product_domain and product_domain.get("category") and product_domain["category"] != "other":
        domain_instruction = f"""
- This product's domain is "{product_domain['category']}". Beyond the literal enhancement described, also weigh whether a genuinely well-known domain-typical pattern is now relevant given what's changing (e.g. a reported e-commerce traffic/catalog growth trigger commonly also calls for cart-session caching or a dedicated search index once catalog size crosses a few thousand SKUs) -- this is where PROACTIVE, domain-informed suggestions belong, not just a literal reading of the request. Only propose this if it's a genuinely well-established pattern that plausibly applies at the STATED scale -- never invent one, and never propose it if the description doesn't actually suggest the domain-typical trigger condition is met.
- When a proposal's reasoning genuinely draws on a domain-typical pattern like this (rather than being a direct, literal response to what was described), set that proposal's "domainPattern" to a short, visibly-labeled qualifier, e.g. "Common next step for e-commerce platforms as catalog size grows". Most proposals will have NO "domainPattern" -- only the ones genuinely triggered by domain knowledge rather than the literal description.
"""

    system_instruction = (
        f"""
You are a senior cloud systems architect. A user has described a new requirement or enhancement to an already-generated architecture, in their own words, via chat. Your job is to identify which architecture components this would affect -- new components to add, or existing components whose role/config needs to change -- NOT to pick specific cloud services (that's resolved separately, deterministically, per cloud provider).

You are given: the enhancement description, the current component list (id, type, name, reasoning), the current connections, and the product's functional/non-functional requirements.

Rules:
- Propose the SMALLEST set of changes that genuinely satisfies the description. Do not propose unrelated or speculative changes.
- For a NEW component ("add"): give it a short kebab-case "id" that doesn't collide with any existing component id, a human-readable "name", and a "type". Prefer one of these known types if it genuinely fits: {", ".join(KNOWN_COMPONENT_TYPES)}. Only invent a new kebab-case type if none of the known ones fit even loosely.
- For an EXISTING component that needs a role/config change ("modify"): use its EXACT existing "id" from the component list given, do not invent a new one.
- "reasoning" must be 2-4 sentences, concrete, tied to the specific enhancement description AND the product's actual stated requirements -- never generic boilerplate.
- For "add" actions, also propose the "connections" needed to wire the new component into the existing flow, each as {{"from": string, "to": string, "protocol": string}}, using real existing component ids (or the new component's own id) as endpoints.
- If the description doesn't clearly require any architecture change (e.g. it's a clarifying question, not a change), return an empty "proposals" array.
- Never propose removing a component unless the description explicitly asks to remove/replace that capability.
"""
        + domain_instruction
        + """
You MUST respond with a raw JSON object matching this TypeScript structure:
{
  "proposals": [
    {
      "action": "add" | "modify",
      "id": string,
      "type": string (required for "add", ignored for "modify"),
      "name": string,
      "reasoning": string,
      "connections": [ { "from": string, "to": string, "protocol": string } ] (only for "add", empty array otherwise),
      "domainPattern": string
    }
  ]
}
Do not include markdown code block formatting (like ```json) in your raw response, return only the JSON object.
"""
    )

    input_context = {
        "enhancementDescription": description,
        "existingComponents": [
            {"id": c.get("id"), "type": c.get("type"), "name": c.get("name"), "reasoning": c.get("reasoning", "")}
            for c in existing_components
        ],
        "existingConnections": existing_connections,
        "requirements": requirements,
    }
    if product_domain and product_domain.get("category") and product_domain["category"] != "other":
        input_context["productDomain"] = product_domain
    messages_for_api = [
        {"role": "system", "content": system_instruction},
        {"role": "user", "content": json.dumps(input_context)},
    ]
    result = await _call_llm_with_fallback_chain(
        api_key, messages_for_api, "Component change proposal generation", expected_keys=["proposals"]
    )
    return result.get("proposals") or []


async def refine_component_proposal(
    original_proposal: dict,
    prior_messages: list[dict],
    discussion_message: str,
    existing_components: list[dict],
    requirements: dict,
    api_key: str,
) -> dict:
    """Inline discuss/refine for ONE pending proposal card (Workstream O) -- the user pushes back
    on a single proposal ("use a cheaper alternative", "can this just extend the existing queue
    instead") without touching any other proposal in the same batch. Returns an updated
    type-level proposal in the SAME shape propose_component_changes produces for one item
    (action/id/type/name/reasoning/connections, never a specific cloud service -- the caller
    re-runs the identical deterministic enrichment either way), plus a short conversational reply
    for the mini discussion thread."""
    system_instruction = """
You are a senior cloud systems architect having a short back-and-forth with a user about ONE specific proposed architecture change. You already proposed this change; the user is now pushing back, asking a question, or requesting an adjustment to just this one proposal.

You are given: the original proposal (action/id/type/name/reasoning), any prior discussion turns on this proposal, the user's latest message, the current component list (for context on what already exists), and the product's requirements.

Respond with an UPDATED version of the proposal reflecting what the user asked for, plus a short, direct conversational reply explaining what changed (or, if the user's request doesn't warrant a change -- e.g. they're just asking a clarifying question -- explain why and return the proposal unchanged).

Rules:
- Keep the same "id" as the original proposal unless the user explicitly asks to rename it.
- Prefer one of the known types if it genuinely fits: cdn, compute, database, storage, queue, cache, auth, realtime, tokenization, audit-log, phi-vault, deidentification. Only invent a new kebab-case type if none fit even loosely.
- Do NOT pick a specific cloud service name -- that's resolved separately and deterministically per provider, exactly like the original proposal.
- "assistantReply" must be 1-3 sentences, conversational, and specific to what actually changed (or didn't).
- For "add" actions, also return "connections" (same shape as before: {"from": string, "to": string, "protocol": string}), updated if the change affects wiring, otherwise carried forward unchanged.

You MUST respond with a raw JSON object matching this TypeScript structure:
{
  "assistantReply": string,
  "proposal": {
    "action": "add" | "modify",
    "id": string,
    "type": string (required for "add"),
    "name": string,
    "reasoning": string,
    "connections": [ { "from": string, "to": string, "protocol": string } ] (only for "add", empty array otherwise)
  }
}
Do not include markdown code block formatting (like ```json) in your raw response, return only the JSON object.
"""

    input_context = {
        "originalProposal": original_proposal,
        "priorDiscussion": prior_messages,
        "userMessage": discussion_message,
        "existingComponents": [
            {"id": c.get("id"), "type": c.get("type"), "name": c.get("name")} for c in existing_components
        ],
        "requirements": requirements,
    }
    messages_for_api = [
        {"role": "system", "content": system_instruction},
        {"role": "user", "content": json.dumps(input_context)},
    ]
    result = await _call_llm_with_fallback_chain(
        api_key, messages_for_api, "Proposal refinement", expected_keys=["assistantReply", "proposal"]
    )
    return {"assistantReply": result.get("assistantReply") or "", "proposal": result["proposal"]}


async def generate_requirement_suggestions(
    functional: list[str], non_functional: dict, api_key: str, knowledge_context: list[dict] | None = None
) -> dict:
    """Generates clickable-chip candidate values for the Requirements panel's editable fields, so
    the user can select instead of typing. Called on-demand (not persisted) whenever the panel
    needs fresh suggestions -- functional/non_functional reflect whatever the user has typed or
    selected so far, so suggestions stay relevant as the user edits."""
    knowledge_instruction = ""
    if knowledge_context:
        knowledge_instruction = """
- You are also given "referenceExcerpts" -- passages from real requirements-engineering / software-architecture reference books, retrieved because they were judged relevant to this product's requirements. Where a passage genuinely informs why a specific suggested value is a sound non-functional requirement (e.g. it should be measurable, testable, tied to a real business driver), you may add a "sources" array to that SAME suggestion object: [{"book": string, "chapterOrSection": string, "page": string}], using the exact bookTitle/chapterTitle/pageStart-pageEnd values given. Only add it where genuinely used -- most suggestions will have none, and that's correct. Never fabricate a title, chapter, or page number.
"""

    system_instruction = (
        """
You are a senior cloud systems architect helping a user fill in system requirements for their product. Given their described functional capabilities and current non-functional requirement values (some may be "not_specified"), suggest realistic, concrete candidate values the user can pick with one click instead of typing.

Rules:
- Generate 3 to 5 short, concrete, directly-usable suggestions per non-functional field below. Each suggestion's "value" is a complete answer ready to be selected as-is, not a hint or partial sentence.
- Tailor every suggestion specifically to the described product — reference realistic details from it (traffic patterns, data types, likely team size/budget for a product like this). Never generic filler like "High scale" or "Standard security" — write the actual number/detail a real answer would contain.
- For each suggestion, also write "why": one short clause (under 15 words) tying it back to a SPECIFIC detail from the product description or requirements given — e.g. "since you mentioned live booking, spikes are likely at peak hours", not a generic restatement like "a common choice for this field". If nothing in the input justifies a suggestion, don't include a "why" that pretends otherwise — ground it in what's actually there.
- Do this for every field even if it already has a specified value — the user may want a different concrete option; don't just restate their current value.
- Also suggest 3 to 5 additional FUNCTIONAL capabilities this product likely needs that are NOT already in the provided list — concrete and product-specific, not generic boilerplate (avoid vague items like "user authentication"; prefer specific ones like "customers can reschedule a booking without calling the salon"). Each also gets a "why" clause.
"""
        + knowledge_instruction
        + """
You MUST respond with a raw JSON object matching this structure (every array entry is an object with "value" and "why", not a bare string; "sources" is optional and only present when genuinely grounded):
{
  "expectedScale": [{"value": string, "why": string, "sources": [{"book": string, "chapterOrSection": string, "page": string}]}],
  "readWritePattern": [{"value": string, "why": string}],
  "dataNature": [{"value": string, "why": string}],
  "latencySensitivity": [{"value": string, "why": string}],
  "budget": [{"value": string, "why": string}],
  "teamMaturity": [{"value": string, "why": string}],
  "compliance": [{"value": string, "why": string}],
  "functional": [{"value": string, "why": string}]
}
Do not include markdown code block formatting (like ```json) in your response, return only the raw JSON.
"""
    )

    input_context = {"functional": functional, "nonFunctional": non_functional}
    if knowledge_context:
        input_context["referenceExcerpts"] = [
            {
                "bookTitle": c["bookTitle"],
                "author": c["author"],
                "chapterTitle": c.get("chapterTitle"),
                "pageStart": c["pageStart"],
                "pageEnd": c["pageEnd"],
                "text": c["text"],
                "sourceType": c.get("sourceType", "principle"),
            }
            for c in knowledge_context
        ]

    messages_for_api = [
        {"role": "system", "content": system_instruction},
        {"role": "user", "content": json.dumps(input_context)},
    ]

    return await _call_llm_with_fallback_chain(
        api_key,
        messages_for_api,
        "Requirement suggestions",
        expected_keys=[
            "expectedScale",
            "readWritePattern",
            "dataNature",
            "latencySensitivity",
            "budget",
            "teamMaturity",
            "compliance",
            "functional",
        ],
    )


async def validate_and_generate_architecture(
    project_name: str,
    requirements: dict,
    baseline: dict,
    provider_costs: dict,
    api_key: str,
    prev_hld_components: list[dict] | None = None,
    knowledge_context: list[dict] | None = None,
    product_domain: dict | None = None,
) -> dict:
    knowledge_instruction = ""
    if knowledge_context:
        knowledge_instruction = """
5. You are also given "referenceExcerpts" -- passages retrieved because they were judged relevant to this specific design. Each excerpt has a "sourceType": either "principle" (from a general architecture/software-engineering reference book -- timeless theory like monolith-vs-microservices trade-offs, layering, component boundaries) or "reference-architecture" (from AWS/Azure/GCP's own published reference-architecture guide for a specific product domain -- an established, provider-endorsed pattern for that domain, e.g. "how AWS's own e-commerce reference architecture handles the order-submission flow"). These are different KINDS of grounding -- a "reference-architecture" excerpt supports a claim like "this follows an established e-commerce reference pattern," a "principle" excerpt supports a more general architectural claim. Where a passage genuinely informs a component's reasoning or the provider recommendation, you may ground that reasoning in it, and add a "sources" array to that SAME component (or to "recommendation") listing which excerpt(s) you actually drew on: [{"book": string, "chapterOrSection": string, "page": string}], using the exact bookTitle/chapterTitle/pageStart-pageEnd values from that excerpt (pageStart/pageEnd may be null for a "reference-architecture" web source -- in that case just omit "page" or leave it empty).
   - Only add a "sources" entry where you genuinely used that excerpt's content -- never cite an excerpt you didn't actually draw on just because it was provided. Most components will have NO sources array at all; that's expected and correct when nothing retrieved was actually relevant to that specific component.
   - Never fabricate a book title, chapter, or page number -- only use the exact values given in referenceExcerpts.
"""

    domain_instruction = ""
    if product_domain and product_domain.get("category") and product_domain["category"] != "other":
        reference_system = product_domain.get("referenceSystem")
        reference_clause = (
            f""" The user also referenced "{reference_system}" as inspiration/comparison -- you may use your GENERAL, PUBLIC knowledge of how that TYPE of product conceptually tends to be built to inform reasoning, but NEVER assert or imply certainty about that specific company's actual real implementation (no insider knowledge exists) -- phrase any such reasoning as "systems like {reference_system} typically..." or "the general {reference_system}-style pattern is...", never "{reference_system} actually uses...\""""
            if reference_system
            else ""
        )
        domain_instruction = f"""
6. This product's domain is "{product_domain['category']}".{reference_clause} Act like a senior architect who has seen many real projects in this domain before: where a well-known, genuinely real domain-typical pattern is relevant to a component's reasoning (e.g. cart-session caching, inventory consistency handling, and payment retry/idempotency for e-commerce at meaningful scale; multi-tenant data isolation strategies for B2B SaaS; consistency/availability trade-offs for a marketplace's two-sided matching) given the STATED scale/requirements, weigh it in.
   - Ground this ONLY in genuinely well-established, general knowledge for that domain -- never invent a "well-known" pattern that isn't real, and never apply a pattern the stated scale doesn't actually warrant (e.g. don't suggest cart-session caching for a 50-orders-a-day store).
   - When a component's reasoning or the provider recommendation genuinely draws on a domain-typical pattern like this (as opposed to being derived purely from THIS project's own stated requirements), set that SAME component's (or "recommendation"'s) "domainPattern" to a short, visibly-labeled qualifier, e.g. "Common pattern for e-commerce platforms at this scale: cart contents are cached separately from the primary order database to keep checkout latency low under spiky traffic." Keep this as its OWN separate field, not blended invisibly into "reasoning" -- the user needs to be able to tell what came from a known domain pattern versus their specific stated requirements.
   - Most components will have NO "domainPattern" at all -- only add it where a real, relevant domain-typical pattern genuinely applies.
"""

    system_instruction = (
        """
You are a senior cloud systems architect. You are given a product name, the extracted requirements, a baseline High-Level Design (HLD) architecture containing multi-cloud service mappings and low-level design (LLD) baseline configurations, the aggregated monthly cost estimates, and optionally the previous version's architecture components list.

Your task is to:
1. Review the baseline architecture components, connections, and their nested LLD configurations. Make adjustments if there are important nuances that the rule engine missed.
   - For 'cloudMappings.<provider>.alternatives', only output 'serviceName' and 'reason' for each entry (omit any cost data) — the server merges the baseline's own cost estimates back in afterward, so you do not need to compute or repeat them. Keep these entries brief.
2. For EVERY component, write:
   - A detailed 'reasoning' trace explaining why this component is necessary and its primary design trade-offs.
   - Inside 'cloudMappings.aws.lld.reasoning', 'cloudMappings.azure.lld.reasoning', and 'cloudMappings.gcp.lld.reasoning': write custom, short (one-line) rationale strings explaining why the specific LLD configuration values (e.g., memory size, instance class, Multi-AZ setting) are appropriate based on the requirements.
   - EXCEPTION: for compliance components (type 'tokenization', 'audit-log', 'phi-vault', 'deidentification'), the baseline 'reasoning' and 'lld.reasoning' were already written by a deterministic compliance rule engine citing the specific regulation (PCI-DSS/HIPAA) that mandated them. Keep those as-is unless you have a specific correction — do not rewrite them at length, to keep your output concise.
3. List any 'assumptions' or 'risks' that are present in the design due to requirements being marked as "not_specified".
4. Determine the Recommended Cloud Provider ('aws', 'azure', or 'gcp') and write a short paragraph rationale explaining why it is recommended over the others, along with a list of key trade-offs.
   - If the previous version's components list is provided, that's for your context only (e.g. to avoid contradicting a prior decision) — the server computes the version-to-version diff itself; do not attempt to summarize or list changes yourself.
"""
        + knowledge_instruction
        + domain_instruction
        + """
You MUST respond with a raw JSON object matching this structure:
{
  "components": [
    {
      "id": string,
      "name": string,
      "type": string,
      "description": string,
      "reasoning": string,
      "rulesFired": string[],
      "sources": [ { "book": string, "chapterOrSection": string, "page": string } ],
      "domainPattern": string,
      "cloudMappings": {
        "aws": {
          "serviceName": string,
          "alternatives": [ { "serviceName": string, "reason": string } ],
          "costEstimate": { "min": number, "max": number, "assumptions": string },
          "lld": {
            "config": Record<string, string>,
            "reasoning": Record<string, string>
          }
        },
        "azure": {
          "serviceName": string,
          "alternatives": [ { "serviceName": string, "reason": string } ],
          "costEstimate": { "min": number, "max": number, "assumptions": string },
          "lld": {
            "config": Record<string, string>,
            "reasoning": Record<string, string>
          }
        },
        "gcp": {
          "serviceName": string,
          "alternatives": [ { "serviceName": string, "reason": string } ],
          "costEstimate": { "min": number, "max": number, "assumptions": string },
          "lld": {
            "config": Record<string, string>,
            "reasoning": Record<string, string>
          }
        }
      }
    }
  ],
  "connections": [
    { "from": string, "to": string, "protocol": string }
  ],
  "assumptions": [string, string, ...],
  "risks": [string, string, ...],
  "recommendation": {
    "recommendedProvider": "aws" | "azure" | "gcp",
    "rationale": string,
    "keyTradeoffs": [string, string, ...],
    "sources": [ { "book": string, "chapterOrSection": string, "page": string } ],
    "domainPattern": string
  }
}
Do not use markdown code block formatting (like ```json) in your response, return only the raw JSON.
"""
    )

    input_context = {
        "projectName": project_name,
        "requirements": requirements,
        "baselineArchitecture": baseline,
        "providerCosts": provider_costs,
        "previousArchitectureComponents": prev_hld_components or None,
    }
    if product_domain and product_domain.get("category") and product_domain["category"] != "other":
        input_context["productDomain"] = product_domain
    if knowledge_context:
        input_context["referenceExcerpts"] = [
            {
                "bookTitle": c["bookTitle"],
                "author": c["author"],
                "chapterTitle": c.get("chapterTitle"),
                "pageStart": c["pageStart"],
                "pageEnd": c["pageEnd"],
                "text": c["text"],
                "sourceType": c.get("sourceType", "principle"),
            }
            for c in knowledge_context
        ]

    messages_for_api = [
        {"role": "system", "content": system_instruction},
        {"role": "user", "content": json.dumps(input_context)},
    ]

    # Deeply-nested output (per-component cloudMappings for 3 providers each) is the largest and
    # slowest-to-generate response of any call site -- give each chain tier double the default
    # timeout so a legitimately-still-generating model isn't mistaken for a hung one.
    return await _call_llm_with_fallback_chain(
        api_key,
        messages_for_api,
        "Architecture generation",
        expected_keys=["components", "connections", "assumptions", "risks", "recommendation"],
        timeout_seconds=30.0,
    )


async def tag_knowledge_chunk_topics(chunk_text: str, book_title: str, api_key: str) -> list[str]:
    """Knowledge-base ingestion (RAG) -- one LLM pass per chunk (called from the offline ingestion
    script, never from a request handler), generating short topic-tag slugs like "monolith-vs-
    microservices" for human-readable inspection of the ingested corpus. Retrieval itself
    (knowledge_retrieval.py) is purely embedding-similarity based and never filters on these tags
    -- they're metadata for a human skimming what got ingested, not a search index."""
    system_instruction = """
You are tagging a chunk of text from a software architecture / software engineering reference book with short topic slugs, for a searchable knowledge base.

Given the chunk of text, return 2 to 5 short kebab-case topic tags describing what architectural/software-engineering topics this SPECIFIC passage covers -- e.g. "monolith-vs-microservices", "layered-architecture", "non-functional-requirements", "component-design", "event-driven-architecture", "coupling-cohesion", "api-design", "database-design", "testing-strategy". Be specific to what this passage actually discusses, not the book's overall subject.

If the passage is front matter, a table of contents, an acknowledgment, a dedication, or otherwise doesn't cover a real architectural/engineering topic, return an empty array rather than forcing a tag.

You MUST respond with a raw JSON object matching this structure:
{"tags": [string, string, ...]}
Do not include markdown code block formatting (like ```json) in your response, return only the raw JSON.
"""
    input_context = {"bookTitle": book_title, "text": chunk_text}
    messages_for_api = [
        {"role": "system", "content": system_instruction},
        {"role": "user", "content": json.dumps(input_context)},
    ]
    result = await _call_llm_with_fallback_chain(
        api_key, messages_for_api, "Knowledge chunk tagging", expected_keys=["tags"]
    )
    return result.get("tags", [])
