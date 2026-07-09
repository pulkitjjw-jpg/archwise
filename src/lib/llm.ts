import { AbstractArchitecture, AbstractComponent, AbstractConnection } from "./rules-engine";

export type BrainstormResponse = {
  message: string;
  isComplete: boolean;
  stage: "brainstorm" | "requirement_gathering" | "growth_trigger";
  detectedIndustry?: "fintech" | "healthtech" | "none";
  industryRationale?: string;
};

export type ExtractedRequirements = {
  functional: string[];
  nonFunctional: {
    expectedScale: string;
    readWritePattern: string;
    dataNature: string;
    latencySensitivity: string;
    budget: string;
    teamMaturity: string;
    compliance: string;
  };
  industryContext: {
    industry: "fintech" | "healthtech" | "none";
    rationale: string;
    complianceAnswers: Array<{ question: string; answer: string }>;
    flags: {
      handlesCardDataDirectly?: boolean;
      storesPHI?: boolean;
      dataResidency?: string;
    };
  };
};

type LLMMessage = { role: string; content: string };

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "google/gemini-2.5-flash";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Gemini occasionally apologizes for a previous malformed-JSON attempt even after a
// successful retry, since the corrective note lives earlier in the same conversation.
// That apology has no business reaching the user-facing chat message.
function looksLikeLeakedApology(message: string): boolean {
  return /^\s*(apolog|i apologize|i'm sorry|my apologies|sorry[,!]? )/i.test(message);
}

/**
 * Calls OpenRouter with the given messages and parses the response as JSON, retrying on
 * both request failures and JSON parse failures (Gemini 2.5 Flash occasionally returns a
 * stray character that breaks JSON.parse despite response_format: json_object). On a parse
 * failure specifically, the retry re-sends the conversation with the model's bad output plus
 * a corrective note, rather than just repeating the original request.
 *
 * Throws a clear, human-readable error (never a raw exception) if all attempts are exhausted.
 */
async function callLLMWithRetry<T>(
  apiKey: string,
  messages: LLMMessage[],
  options: { label: string; maxAttempts?: number; retryDelayMs?: number }
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 500;

  let currentMessages = messages;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let contentStr: string | undefined;
    try {
      const response = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "X-Title": "AI Cloud Architecture Generator",
        },
        body: JSON.stringify({
          model: MODEL,
          messages: currentMessages,
          response_format: { type: "json_object" },
        }),
      });

      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`OpenRouter API error: ${response.status} - ${errBody}`);
      }

      const data = await response.json();
      const raw: string = data.choices[0].message.content.trim();
      contentStr = raw;

      try {
        return JSON.parse(raw) as T;
      } catch {
        const cleaned = raw
          .replace(/^```json\s*/i, "")
          .replace(/^```\s*/i, "")
          .replace(/\s*```$/, "")
          .trim();
        return JSON.parse(cleaned) as T;
      }
    } catch (err) {
      lastError = err;
      const isParseFailure = contentStr !== undefined;
      console.error(
        `[${options.label}] Attempt ${attempt}/${maxAttempts} failed (${isParseFailure ? "JSON parse error" : "request error"}):`,
        err
      );

      if (attempt < maxAttempts) {
        if (isParseFailure) {
          // Show the model its own bad output plus a corrective note, rather than just
          // blindly repeating the same prompt and risking the same mistake again.
          currentMessages = [
            ...messages,
            { role: "assistant", content: contentStr! },
            {
              role: "user",
              content:
                "Your previous response could not be parsed as valid JSON. Return ONLY a single valid JSON object — no markdown code fences, no commentary, and no extra characters before or after the JSON.",
            },
          ];
        } else {
          currentMessages = messages;
        }
        await sleep(retryDelayMs);
      }
    }
  }

  const reason = lastError instanceof Error ? lastError.message : "the AI model did not return a valid response";
  throw new Error(`${options.label} failed after ${maxAttempts} attempts: ${reason}. Please try again.`);
}

export async function getNextBrainstormTurn(
  history: Array<{ role: string; message: string; stage: string }>,
  projectName: string
): Promise<BrainstormResponse> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY environment variable is not defined");
  }

  const isGrowthPhase = history.some((h) => h.stage === "growth_trigger");

  const systemInstruction = isGrowthPhase
    ? `
You are a senior cloud systems architect processing a growth trigger or requirement change for a project named "${projectName}".
The initial discovery brainstorm was already completed. The user is now reporting a change to their project's requirements (e.g., new scale, new features, budget changes).

Evaluate the user's reported changes:
1. If the reported changes are clear and you have enough details to update the requirements, respond with a confirmation message outlining what you've understood and state that you are updating the design. In this case, set "isComplete" to true and transition "stage" to "requirement_gathering".
2. If some aspects are unclear or you need more context (e.g., they ask for real-time notifications but you don't know the expected throughput, or they mention scaling but no user count), ask exactly ONE follow-up question to clarify. Set "isComplete" to false and keep "stage" as "growth_trigger".

Never apologize or reference previous attempts, formatting issues, or corrections in your response — respond naturally as if this is the only attempt.

You MUST respond with a raw JSON object matching this TypeScript structure:
{
  "message": string (your conversational follow-up question or update confirmation),
  "isComplete": boolean (set to true ONLY when you have enough details or are transitioning to requirement_gathering),
  "stage": "growth_trigger" | "requirement_gathering" (set to "requirement_gathering" when isComplete is true, otherwise "growth_trigger"),
  "detectedIndustry": "fintech" | "healthtech" | "none",
  "industryRationale": string (one short sentence — reuse your prior assessment if nothing new changes it)
}
Do not include markdown code block formatting (like \`\`\`json) in your raw response, return only the JSON object.
`
    : `
You are a senior cloud systems architect conducting a discovery and brainstorming session with a client for a project named "${projectName}".
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

You MUST respond with a raw JSON object matching this TypeScript structure:
{
  "message": string (your conversational follow-up question or concluding summary),
  "isComplete": boolean (set to true ONLY when you have enough details or are wrapping up after max turns),
  "stage": "brainstorm" | "requirement_gathering" (set to "requirement_gathering" when isComplete is true, otherwise "brainstorm"),
  "detectedIndustry": "fintech" | "healthtech" | "none",
  "industryRationale": string (one short sentence explaining the classification, even if "none")
}
Do not include markdown code block formatting (like \`\`\`json) in your raw response, return only the JSON object.
`;

  const messagesForApi = [
    { role: "system", content: systemInstruction },
    ...history.map((h) => ({
      role: h.role === "user" ? "user" : "assistant",
      content: h.message,
    })),
  ];

  try {
    let result = await callLLMWithRetry<BrainstormResponse>(apiKey, messagesForApi, {
      label: "Brainstorm turn generation",
    });

    if (looksLikeLeakedApology(result.message)) {
      console.error(
        "[Brainstorm turn generation] Detected leaked apology text in response, re-requesting with a clean prompt"
      );
      result = await callLLMWithRetry<BrainstormResponse>(apiKey, messagesForApi, {
        label: "Brainstorm turn generation (apology cleanup)",
      });
    }

    return result;
  } catch (err) {
    console.error("Brainstorm turn generation exhausted all retries, falling back to a generic question:", err);
    return {
      message: "Thank you for the details. Could you share a bit more about your scaling or compliance requirements?",
      isComplete: history.length >= 6,
      stage: history.length >= 6 ? "requirement_gathering" : "brainstorm",
    };
  }
}

export async function extractRequirementsFromHistory(
  history: Array<{ role: string; message: string }>
): Promise<ExtractedRequirements> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY environment variable is not defined");
  }

  const systemInstruction = `
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
Do not include markdown code block formatting (like \`\`\`json) in your response, return only the raw JSON.
`;

  const messagesForApi = [
    { role: "system", content: systemInstruction },
    ...history.map((h) => ({
      role: h.role === "user" ? "user" : "assistant",
      content: h.message,
    })),
  ];

  return callLLMWithRetry<ExtractedRequirements>(apiKey, messagesForApi, {
    label: "Requirement extraction",
  });
}

export async function validateAndGenerateArchitecture(
  projectName: string,
  requirements: ExtractedRequirements,
  baseline: {
    components: any[];
    connections: any[];
  },
  providerCosts: {
    aws: { min: number; max: number };
    azure: { min: number; max: number };
    gcp: { min: number; max: number };
  },
  prevHldComponents?: any[] | null
): Promise<{
  components: any[];
  connections: any[];
  assumptions: string[];
  risks: string[];
  recommendation: {
    recommendedProvider: "aws" | "azure" | "gcp";
    rationale: string;
    keyTradeoffs: string[];
  };
}> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY environment variable is not defined");
  }

  const systemInstruction = `
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
Do not use markdown code block formatting (like \`\`\`json) in your response, return only the raw JSON.
`;

  const inputContext = {
    projectName,
    requirements,
    baselineArchitecture: baseline,
    providerCosts,
    previousArchitectureComponents: prevHldComponents || null,
  };

  const messagesForApi = [
    { role: "system", content: systemInstruction },
    { role: "user", content: JSON.stringify(inputContext) },
  ];

  return callLLMWithRetry(apiKey, messagesForApi, {
    label: "Architecture generation",
  });
}
