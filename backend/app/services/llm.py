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
  "knowledgeLevel": "technical" | "beginner" | "unknown",
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
  },
  "existingSystem": { "techStack": string, "deployment": string, "painPoints": string } | null
}
Do not include markdown code block formatting (like ```json) in your response, return only the raw JSON.
"""

    messages_for_api = [
        {"role": "system", "content": system_instruction},
        *[{"role": "user" if h["role"] == "user" else "assistant", "content": h["message"]} for h in history],
    ]

    return await _call_llm_with_retry(api_key, messages_for_api, "Requirement extraction")


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
            }
            for c in knowledge_context
        ]

    messages_for_api = [
        {"role": "system", "content": system_instruction},
        {"role": "user", "content": json.dumps(input_context)},
    ]
    result = await _call_llm_with_retry(api_key, messages_for_api, "Conversation summary generation")
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
            }
            for c in knowledge_context
        ]
    messages_for_api = [
        {"role": "system", "content": system_instruction},
        {"role": "user", "content": json.dumps(input_context)},
    ]
    result = await _call_llm_with_retry(api_key, messages_for_api, "Flow story generation")
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
    result = await _call_llm_with_retry(api_key, messages_for_api, "User journey generation")
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
    return await _call_llm_with_retry(api_key, messages_for_api, "Executive summary generation")


async def generate_migration_roadmap(
    provider: str,
    existing_system: dict,
    components: list[dict],
    connections: list[dict],
    functional: list[str],
    api_key: str,
) -> dict:
    """Generates the Migration Roadmap (Workstream T5) -- a phased plan from the user's stated
    EXISTING system (tech stack, deployment, pain points) to the already-generated target
    architecture, using the strangler-fig pattern where applicable (incrementally routing traffic
    to new components while the legacy system keeps running, rather than a single risky cutover).
    Grounded in the real target components/reasoning already computed for this provider -- never
    invents infrastructure the target design doesn't actually have. Called lazily per provider and
    cached by the caller on the architecture row's migration_roadmap[provider] key, same pattern as
    flow_story."""
    system_instruction = """
You are a senior cloud migration architect writing a phased roadmap for a team modernizing an existing production system into a new target cloud architecture that has already been designed.

You are given: the user's description of their CURRENT system (tech stack, deployment, pain points), the TARGET architecture's real components (with the actual cloud service chosen for each and the architect's reasoning for it), the connections between target components, and the product's functional requirements.

Write a phased migration plan -- typically 3 to 5 phases, never more than 6. Use the strangler-fig pattern where it genuinely applies (e.g. "Phase 1: put the new API gateway in front of the legacy monolith, routing only new endpoints through it while the monolith keeps serving the rest" -- incrementally carving pieces out of the legacy system rather than a single big-bang cutover), but only claim strangler-fig where it actually fits this specific migration -- don't force the label onto a phase that's really just infrastructure setup.

Rules:
- Ground every phase in the REAL target components given -- reference their actual service names/reasoning, not generic advice.
- Order phases the way a team would actually execute them (foundational infrastructure and low-risk pieces first, the riskiest/most central piece -- often the core data store or the monolith itself -- later, once the surrounding pieces are proven).
- Each phase's "effort" must be "small", "medium", or "large" -- a RELATIVE sizing judgment (team-weeks of complexity), never a specific time estimate (no "2 weeks", no dates).
- Be honest about risk: if a phase is inherently risky (e.g. a database cutover), say so in "why".
- Do not invent legacy technical details the user didn't mention -- only reason from what's actually in "existingSystem".

You MUST respond with a raw JSON object matching this structure:
{
  "phases": [
    {
      "phase": number (1-indexed, in execution order),
      "title": string (short, e.g. "Containerize the monolith"),
      "whatChanges": string (concrete description of the actual work in this phase),
      "why": string (the reasoning -- why this phase, why now, what risk it manages or unlocks),
      "usesStranglerFig": boolean,
      "effort": "small" | "medium" | "large"
    }
  ]
}
Do not include markdown code block formatting (like ```json) in your response, return only the raw JSON.
"""

    input_context = {
        "provider": provider,
        "existingSystem": existing_system,
        "targetComponents": components,
        "targetConnections": connections,
        "functionalRequirements": functional,
    }
    messages_for_api = [
        {"role": "system", "content": system_instruction},
        {"role": "user", "content": json.dumps(input_context)},
    ]
    result = await _call_llm_with_retry(api_key, messages_for_api, "Migration roadmap generation")
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
    return await _call_llm_with_retry(api_key, messages_for_api, "What-If suggestions generation")


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
    return await _call_llm_with_retry(api_key, messages_for_api, "Component suggestions generation")


async def propose_component_changes(
    description: str,
    existing_components: list[dict],
    existing_connections: list[dict],
    requirements: dict,
    api_key: str,
) -> list[dict]:
    """Identifies which architecture components a freeform chat-described enhancement would add
    or change, provider-agnostically (no service names -- the caller resolves those
    deterministically via cloud_mapping.py/lld_rules.py for whichever provider is active, the
    same "rules engine decides, LLM narrates" boundary the rest of the app follows). This is a
    preview only: nothing is persisted here, the caller applies only what the user approves via
    the existing manual-save endpoint."""
    system_instruction = f"""
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

You MUST respond with a raw JSON object matching this TypeScript structure:
{{
  "proposals": [
    {{
      "action": "add" | "modify",
      "id": string,
      "type": string (required for "add", ignored for "modify"),
      "name": string,
      "reasoning": string,
      "connections": [ {{ "from": string, "to": string, "protocol": string }} ] (only for "add", empty array otherwise)
    }}
  ]
}}
Do not include markdown code block formatting (like ```json) in your raw response, return only the JSON object.
"""

    input_context = {
        "enhancementDescription": description,
        "existingComponents": [
            {"id": c.get("id"), "type": c.get("type"), "name": c.get("name"), "reasoning": c.get("reasoning", "")}
            for c in existing_components
        ],
        "existingConnections": existing_connections,
        "requirements": requirements,
    }
    messages_for_api = [
        {"role": "system", "content": system_instruction},
        {"role": "user", "content": json.dumps(input_context)},
    ]
    result = await _call_llm_with_retry(api_key, messages_for_api, "Component change proposal generation")
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
    result = await _call_llm_with_retry(api_key, messages_for_api, "Proposal refinement")
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
            }
            for c in knowledge_context
        ]

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
    knowledge_context: list[dict] | None = None,
) -> dict:
    knowledge_instruction = ""
    if knowledge_context:
        knowledge_instruction = """
5. You are also given "referenceExcerpts" -- passages retrieved from real architecture/software-engineering reference books because they were judged relevant to this specific design (e.g. monolith-vs-microservices trade-offs, layering, component boundaries). Where a passage genuinely informs a component's reasoning or the provider recommendation, you may ground that reasoning in it and cite it naturally in the prose (e.g. "as [Book Title] notes, ..."), and add a "sources" array to that SAME component (or to "recommendation") listing which excerpt(s) you actually drew on: [{"book": string, "chapterOrSection": string, "page": string}], using the exact bookTitle/chapterTitle/pageStart-pageEnd values from that excerpt.
   - Only add a "sources" entry where you genuinely used that excerpt's content -- never cite an excerpt you didn't actually draw on just because it was provided. Most components will have NO sources array at all; that's expected and correct when nothing retrieved was actually relevant to that specific component.
   - Never fabricate a book title, chapter, or page number -- only use the exact values given in referenceExcerpts.
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
    "sources": [ { "book": string, "chapterOrSection": string, "page": string } ]
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
    if knowledge_context:
        input_context["referenceExcerpts"] = [
            {
                "bookTitle": c["bookTitle"],
                "author": c["author"],
                "chapterTitle": c.get("chapterTitle"),
                "pageStart": c["pageStart"],
                "pageEnd": c["pageEnd"],
                "text": c["text"],
            }
            for c in knowledge_context
        ]

    messages_for_api = [
        {"role": "system", "content": system_instruction},
        {"role": "user", "content": json.dumps(input_context)},
    ]

    return await _call_llm_with_retry(api_key, messages_for_api, "Architecture generation")


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
    result = await _call_llm_with_retry(api_key, messages_for_api, "Knowledge chunk tagging")
    return result.get("tags", [])
