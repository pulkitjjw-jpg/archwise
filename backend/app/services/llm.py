import asyncio
import json
import logging
import re
from typing import Any

import httpx

logger = logging.getLogger("app.services.llm")

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
MODEL = "google/gemini-2.5-flash"

_LEAKED_APOLOGY_RE = re.compile(r"^\s*(apolog|i apologize|i'm sorry|my apologies|sorry[,!]? )", re.IGNORECASE)
_FENCE_OPEN_JSON_RE = re.compile(r"^```json\s*", re.IGNORECASE)
_FENCE_OPEN_RE = re.compile(r"^```\s*", re.IGNORECASE)
_FENCE_CLOSE_RE = re.compile(r"\s*```$")


def _looks_like_leaked_apology(message: str) -> bool:
    """Gemini occasionally apologizes for a previous malformed-JSON attempt even after a
    successful retry, since the corrective note lives earlier in the same conversation. That
    apology has no business reaching the user-facing chat message."""
    return bool(_LEAKED_APOLOGY_RE.match(message))


async def _call_llm_with_retry(
    api_key: str,
    messages: list[dict[str, str]],
    label: str,
    max_attempts: int = 3,
    retry_delay_ms: int = 500,
) -> Any:
    """Calls OpenRouter with the given messages and parses the response as JSON, retrying on
    both request failures and JSON parse failures (Gemini 2.5 Flash occasionally returns a
    stray character that breaks json.loads despite response_format: json_object). On a parse
    failure specifically, the retry re-sends the conversation with the model's bad output plus
    a corrective note, rather than just repeating the original request.

    Raises a clear, human-readable error (never a raw exception) if all attempts are
    exhausted. Deliberately returns loosely-typed Any, not a strict Pydantic model, to match
    the pre-split behavior where LLM output was never runtime-validated either."""
    current_messages = messages
    last_error: Exception | None = None

    async with httpx.AsyncClient(timeout=60.0) as client:
        for attempt in range(1, max_attempts + 1):
            content_str: str | None = None
            try:
                response = await client.post(
                    OPENROUTER_URL,
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                        "X-Title": "AI Cloud Architecture Generator",
                    },
                    json={
                        "model": MODEL,
                        "messages": current_messages,
                        "response_format": {"type": "json_object"},
                    },
                )

                if not response.is_success:
                    err_body = response.text
                    raise Exception(f"OpenRouter API error: {response.status_code} - {err_body}")

                data = response.json()
                raw = data["choices"][0]["message"]["content"].strip()
                content_str = raw

                try:
                    return json.loads(raw)
                except json.JSONDecodeError:
                    cleaned = _FENCE_OPEN_JSON_RE.sub("", raw)
                    cleaned = _FENCE_OPEN_RE.sub("", cleaned)
                    cleaned = _FENCE_CLOSE_RE.sub("", cleaned)
                    cleaned = cleaned.strip()
                    return json.loads(cleaned)
            except Exception as err:
                last_error = err
                is_parse_failure = content_str is not None
                logger.error(
                    "[%s] Attempt %d/%d failed (%s): %s",
                    label,
                    attempt,
                    max_attempts,
                    "JSON parse error" if is_parse_failure else "request error",
                    err,
                )

                if attempt < max_attempts:
                    if is_parse_failure:
                        # Show the model its own bad output plus a corrective note, rather than
                        # just blindly repeating the same prompt and risking the same mistake
                        # again.
                        current_messages = [
                            *messages,
                            {"role": "assistant", "content": content_str},
                            {
                                "role": "user",
                                "content": "Your previous response could not be parsed as valid JSON. Return ONLY a single valid JSON object — no markdown code fences, no commentary, and no extra characters before or after the JSON.",
                            },
                        ]
                    else:
                        current_messages = messages
                    await asyncio.sleep(retry_delay_ms / 1000)

    reason = str(last_error) if last_error is not None else "the AI model did not return a valid response"
    raise Exception(f"{label} failed after {max_attempts} attempts: {reason}. Please try again.")


async def get_next_brainstorm_turn(history: list[dict[str, str]], project_name: str, api_key: str) -> dict:
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
        system_instruction = f"""
You are a senior cloud systems architect conducting a discovery and brainstorming session with a client for a project named "{project_name}".
Your goal is to gather enough context to generate a high-quality High-Level Design (HLD) architecture.

Keep the conversation focused. Ask exactly ONE clear, specific question at a time to clarify:
1. Target traffic size / scalability (e.g., request rate, data storage size).
2. System nature (real-time processing vs. background asynchronous worker jobs).
3. Operational maturity / budget (serverless/low cost vs. managed containerized cluster).
4. Key security or compliance requirements (data privacy, B2B SSO, audit logs).

Industry detection (do this silently on every turn, alongside the numbered topics above):
- Classify the product idea into one of: "fintech" (payments, banking, card processing, lending, insurance, trading, or other financial services), "healthtech" (medical records, patient data, clinical workflows, healthcare providers, or health data processing), or "none" (anything else, or not enough signal yet).
- The FIRST time you detect "fintech" or "healthtech" in this conversation, your next question MUST be the relevant one below INSTEAD OF a generic compliance question (this satisfies topic 4 above, it does not add an extra turn):
  - fintech: "Will you be handling card payments directly, or through a processor like Stripe or Braintree?"
  - healthtech: "Will your system store or process Protected Health Information (PHI), such as medical records or clinical data?"
- You may ask AT MOST ONE further brief industry-specific follow-up later in the conversation if the answer above needs clarification (e.g., healthtech: "Which country or region's data residency rules apply to your users?"). Never ask more than 2 industry-specific questions total across the whole conversation, and never let them replace more than one of the 4 numbered topics.
- If industry is "none", proceed with the 4 topics exactly as before — nothing about the flow changes.

Rules:
- Do NOT dump a list of questions. Ask ONLY ONE follow-up question in each turn.
- Be conversational. Acknowledge their previous answer and build on it.
- Stop Condition: If the user provides sufficient details on these points, or if the conversation history has reached 6 or more turns (count the messages in history), set "isComplete" to true and transition "stage" to "requirement_gathering". Give a warm concluding message summarizing that you are ready to synthesize requirements.
- If the user gives very short or vague answers repeatedly, do not get stuck. Pivot and wrap up the brainstorm after a maximum of 6 turns total.
- Never apologize or reference previous attempts, formatting issues, or corrections in your response — respond naturally as if this is the only attempt.

Additionally, alongside "message", generate "suggestedReplies": 2 to 4 short (a few words to one short sentence) candidate answers to the question YOU are asking in "message", tailored specifically to this product idea and what's been discussed so far — never generic placeholders like "Yes" / "No" / "Not sure" unless the question is genuinely binary. Each suggestion must be a concrete, realistic, directly-sendable answer (e.g. for a scale question on a described scheduling app: "Around 2,000 bookings per day at peak", not "High scale"; for a fintech compliance question: "We route all card data through Stripe, never touch it directly"). If "isComplete" is true (concluding message, no more question to answer), return an empty array for "suggestedReplies".

You MUST respond with a raw JSON object matching this TypeScript structure:
{{
  "message": string (your conversational follow-up question or concluding summary),
  "isComplete": boolean (set to true ONLY when you have enough details or are wrapping up after max turns),
  "stage": "brainstorm" | "requirement_gathering" (set to "requirement_gathering" when isComplete is true, otherwise "brainstorm"),
  "detectedIndustry": "fintech" | "healthtech" | "none",
  "industryRationale": string (one short sentence explaining the classification, even if "none"),
  "suggestedReplies": string[]
}}
Do not include markdown code block formatting (like ```json) in your raw response, return only the JSON object.
"""

    messages_for_api = [
        {"role": "system", "content": system_instruction},
        *[{"role": "user" if h["role"] == "user" else "assistant", "content": h["message"]} for h in history],
    ]

    try:
        result = await _call_llm_with_retry(api_key, messages_for_api, "Brainstorm turn generation")

        if _looks_like_leaked_apology(result["message"]):
            logger.error(
                "[Brainstorm turn generation] Detected leaked apology text in response, re-requesting with a clean prompt"
            )
            result = await _call_llm_with_retry(
                api_key, messages_for_api, "Brainstorm turn generation (apology cleanup)"
            )

        return result
    except Exception as err:
        logger.error("Brainstorm turn generation exhausted all retries, falling back to a generic question: %s", err)
        return {
            "message": "Thank you for the details. Could you share a bit more about your scaling or compliance requirements?",
            "isComplete": len(history) >= 6,
            "stage": "requirement_gathering" if len(history) >= 6 else "brainstorm",
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

CRITICAL: If a non-functional item was NOT discussed in the conversation and cannot be reasonably and strongly inferred from context, set it EXACTLY to "not_specified". Do NOT guess or use silent defaults. The same applies to industryContext — do not infer a regulated industry from weak signal.

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
  }
}
Do not include markdown code block formatting (like ```json) in your response, return only the raw JSON.
"""

    messages_for_api = [
        {"role": "system", "content": system_instruction},
        *[{"role": "user" if h["role"] == "user" else "assistant", "content": h["message"]} for h in history],
    ]

    return await _call_llm_with_retry(api_key, messages_for_api, "Requirement extraction")


async def generate_conversation_summary(history: list[dict[str, str]], requirements: dict, api_key: str) -> str:
    """Generates the Conversation Summary section's brief -- a short readable narrative of the
    discovery conversation, not a transcript restatement. Called lazily (not on every requirements
    save) and cached by the caller on the requirements row it was generated for."""
    system_instruction = """
You are a senior systems analyst writing a short, readable brief that summarizes a product discovery conversation for someone who wasn't in the room -- a teammate skimming the project later, or the user themselves reviewing what was decided.

Write 3 to 5 sentences of flowing prose covering: what the user described building, what the AI asked or clarified along the way, what was ultimately decided (functional scope, scale, budget, compliance posture), and briefly why -- tie conclusions to specific things the user actually said.

Rules:
- Prose, not a bullet list or a blow-by-blow transcript restatement ("The user said X, then the AI asked Y...").
- Be concrete: use the real numbers and details from the conversation and requirements, not vague generalities like "a scalable solution".
- Do not editorialize or add caveats that aren't grounded in the conversation.

You MUST respond with a raw JSON object matching this structure:
{ "summary": string }
Do not include markdown code block formatting (like ```json) in your response, return only the raw JSON.
"""

    input_context = {"conversationHistory": history, "finalRequirements": requirements}
    messages_for_api = [
        {"role": "system", "content": system_instruction},
        {"role": "user", "content": json.dumps(input_context)},
    ]
    result = await _call_llm_with_retry(api_key, messages_for_api, "Conversation summary generation")
    return result["summary"]


async def generate_flow_story(
    provider: str, components: list[dict], connections: list[dict], functional: list[str], api_key: str
) -> str:
    """Generates the Architecture Flow Story section for one provider -- a plain-language,
    step-by-step walkthrough of request/data flow, synthesized from the real per-provider service
    names and each component's already-computed reasoning (not regenerated from scratch, and not
    generic per-service boilerplate). Called lazily per provider and cached by the caller on the
    architecture row's flow_story[provider] key."""
    system_instruction = """
You are a senior cloud systems architect writing a plain-language, step-by-step walkthrough of how a request actually flows through a generated architecture, for someone with zero architecture background.

You are given the component list (each with the REAL cloud service chosen for it on this specific provider, and the genuine architect reasoning for why it exists), the connections between components, and the product's functional requirements.

Write a narrative (a few short paragraphs, not bullet points) that traces control/data flow starting from wherever a user request would enter the system, following the connections, ending at final storage or response. If there are multiple distinct paths (e.g. a compliance-only path, a background job path), cover each briefly rather than only the main path.

Rules:
- Use the actual service names given, not generic terms -- say "Amazon Aurora PostgreSQL", never just "the database".
- Ground every claim in the provided components/connections/reasoning -- do not invent behavior not present in the data.
- Tie specific steps back to the actual functional requirements where relevant (e.g. "since the product needs SMS reminders, the notification worker sends to...").
- Write for a total beginner: explain WHY a step happens, not just that it happens.

You MUST respond with a raw JSON object matching this structure:
{ "story": string }
Do not include markdown code block formatting (like ```json) in your response, return only the raw JSON.
"""

    input_context = {
        "provider": provider,
        "components": components,
        "connections": connections,
        "functionalRequirements": functional,
    }
    messages_for_api = [
        {"role": "system", "content": system_instruction},
        {"role": "user", "content": json.dumps(input_context)},
    ]
    result = await _call_llm_with_retry(api_key, messages_for_api, "Flow story generation")
    return result["story"]


async def generate_requirement_suggestions(functional: list[str], non_functional: dict, api_key: str) -> dict:
    """Generates clickable-chip candidate values for the Requirements panel's editable fields, so
    the user can select instead of typing. Called on-demand (not persisted) whenever the panel
    needs fresh suggestions -- functional/non_functional reflect whatever the user has typed or
    selected so far, so suggestions stay relevant as the user edits."""
    system_instruction = """
You are a senior cloud systems architect helping a user fill in system requirements for their product. Given their described functional capabilities and current non-functional requirement values (some may be "not_specified"), suggest realistic, concrete candidate values the user can pick with one click instead of typing.

Rules:
- Generate 3 to 5 short, concrete, directly-usable suggestions per non-functional field below. Each suggestion's "value" is a complete answer ready to be selected as-is, not a hint or partial sentence.
- Tailor every suggestion specifically to the described product — reference realistic details from it (traffic patterns, data types, likely team size/budget for a product like this). Never generic filler like "High scale" or "Standard security" — write the actual number/detail a real answer would contain.
- For each suggestion, also write "why": one short clause (under 15 words) tying it back to a SPECIFIC detail from the product description or requirements given — e.g. "since you mentioned live booking, spikes are likely at peak hours", not a generic restatement like "a common choice for this field". If nothing in the input justifies a suggestion, don't include a "why" that pretends otherwise — ground it in what's actually there.
- Do this for every field even if it already has a specified value — the user may want a different concrete option; don't just restate their current value.
- Also suggest 3 to 5 additional FUNCTIONAL capabilities this product likely needs that are NOT already in the provided list — concrete and product-specific, not generic boilerplate (avoid vague items like "user authentication"; prefer specific ones like "customers can reschedule a booking without calling the salon"). Each also gets a "why" clause.

You MUST respond with a raw JSON object matching this structure (every array entry is an object with "value" and "why", not a bare string):
{
  "expectedScale": [{"value": string, "why": string}],
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

    input_context = {"functional": functional, "nonFunctional": non_functional}

    messages_for_api = [
        {"role": "system", "content": system_instruction},
        {"role": "user", "content": json.dumps(input_context)},
    ]

    return await _call_llm_with_retry(api_key, messages_for_api, "Requirement suggestions")


async def validate_and_generate_architecture(
    project_name: str,
    requirements: dict,
    baseline: dict,
    provider_costs: dict,
    api_key: str,
    prev_hld_components: list[dict] | None = None,
) -> dict:
    system_instruction = """
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
    "keyTradeoffs": [string, string, ...]
  }
}
Do not use markdown code block formatting (like ```json) in your response, return only the raw JSON.
"""

    input_context = {
        "projectName": project_name,
        "requirements": requirements,
        "baselineArchitecture": baseline,
        "providerCosts": provider_costs,
        "previousArchitectureComponents": prev_hld_components or None,
    }

    messages_for_api = [
        {"role": "system", "content": system_instruction},
        {"role": "user", "content": json.dumps(input_context)},
    ]

    return await _call_llm_with_retry(api_key, messages_for_api, "Architecture generation")
