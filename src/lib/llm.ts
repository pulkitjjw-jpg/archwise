import { AbstractArchitecture, AbstractComponent, AbstractConnection } from "./rules-engine";

export type BrainstormResponse = {
  message: string;
  isComplete: boolean;
  stage: "brainstorm" | "requirement_gathering" | "growth_trigger";
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
};

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

You MUST respond with a raw JSON object matching this TypeScript structure:
{
  "message": string (your conversational follow-up question or update confirmation),
  "isComplete": boolean (set to true ONLY when you have enough details or are transitioning to requirement_gathering),
  "stage": "growth_trigger" | "requirement_gathering" (set to "requirement_gathering" when isComplete is true, otherwise "growth_trigger")
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

Rules:
- Do NOT dump a list of questions. Ask ONLY ONE follow-up question in each turn.
- Be conversational. Acknowledge their previous answer and build on it.
- Stop Condition: If the user provides sufficient details on these points, or if the conversation history has reached 6 or more turns (count the messages in history), set "isComplete" to true and transition "stage" to "requirement_gathering". Give a warm concluding message summarizing that you are ready to synthesize requirements.
- If the user gives very short or vague answers repeatedly, do not get stuck. Pivot and wrap up the brainstorm after a maximum of 6 turns total.

You MUST respond with a raw JSON object matching this TypeScript structure:
{
  "message": string (your conversational follow-up question or concluding summary),
  "isComplete": boolean (set to true ONLY when you have enough details or are wrapping up after max turns),
  "stage": "brainstorm" | "requirement_gathering" (set to "requirement_gathering" when isComplete is true, otherwise "brainstorm")
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

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Title": "AI Cloud Architecture Generator",
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages: messagesForApi,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`OpenRouter API error: ${response.status} - ${errBody}`);
  }

  const data = await response.json();
  const contentStr = data.choices[0].message.content.trim();

  try {
    const parsed: BrainstormResponse = JSON.parse(contentStr);
    return parsed;
  } catch (err) {
    console.error("Failed to parse JSON from LLM response:", contentStr);
    const cleanStr = contentStr.replace(/^```json\s*/i, "").replace(/\s*```$/, "");
    try {
      const parsed: BrainstormResponse = JSON.parse(cleanStr);
      return parsed;
    } catch {
      return {
        message: contentStr || "Thank you for the details. I am ready to prepare your architecture blueprint.",
        isComplete: history.length >= 6,
        stage: history.length >= 6 ? "requirement_gathering" : "brainstorm",
      };
    }
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
  
CRITICAL: If a non-functional item was NOT discussed in the conversation and cannot be reasonably and strongly inferred from context, set it EXACTLY to "not_specified". Do NOT guess or use silent defaults.

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

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Title": "AI Cloud Architecture Generator",
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages: messagesForApi,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`OpenRouter API error: ${response.status} - ${errBody}`);
  }

  const data = await response.json();
  const contentStr = data.choices[0].message.content.trim();

  try {
    const parsed: ExtractedRequirements = JSON.parse(contentStr);
    return parsed;
  } catch (err) {
    console.error("Failed to parse JSON from LLM response:", contentStr);
    const cleanStr = contentStr.replace(/^```json\s*/i, "").replace(/\s*```$/, "");
    try {
      const parsed: ExtractedRequirements = JSON.parse(cleanStr);
      return parsed;
    } catch {
      throw new Error("Failed to extract valid JSON requirements from LLM output");
    }
  }
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
  diff?: {
    added: Array<{ id: string; name: string; type: string; reasoning: string }>;
    removed: Array<{ id: string; name: string; type: string }>;
    modified: Array<{
      id: string;
      name: string;
      type: string;
      changes: Array<{ parameter: string; oldVal: string; newVal: string; reasoning: string }>;
    }>;
    costDelta: {
      aws: { min: number; max: number };
      azure: { min: number; max: number };
      gcp: { min: number; max: number };
    };
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
2. For EVERY component, write:
   - A detailed 'reasoning' trace explaining why this component is necessary and its primary design trade-offs.
   - Inside 'cloudMappings.aws.lld.reasoning', 'cloudMappings.azure.lld.reasoning', and 'cloudMappings.gcp.lld.reasoning': write custom, short (one-line) rationale strings explaining why the specific LLD configuration values (e.g., memory size, instance class, Multi-AZ setting) are appropriate based on the requirements.
3. List any 'assumptions' or 'risks' that are present in the design due to requirements being marked as "not_specified".
4. Determine the Recommended Cloud Provider ('aws', 'azure', or 'gcp') and write a short paragraph rationale explaining why it is recommended over the others, along with a list of key trade-offs.
5. If the previous version's components list is provided:
   - Compare the newly generated architecture components against the previous ones by matching their component 'id'.
   - Identify structural and configuration changes and output a 'diff' block:
     * 'added': components present in the new set but not in the previous set. Provide a 'reasoning' string explaining why this new component was introduced in response to the user's growth trigger.
     * 'removed': components present in the previous set but not in the new set.
     * 'modified': components present in both, but where cloud service names, cost bands, or LLD configuration parameters (like instances, memory size) have changed. Compile a list of these 'changes', detailing the parameter name, old value, new value, and a short 'reasoning' explaining why it was modified (e.g. "Scaled instances to handle 10x traffic increase").
     * 'costDelta': Calculate the monthly cost difference (New Min - Prev Min, New Max - Prev Max) for each of the three cloud providers.

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
  },
  "diff": {
    "added": [ { "id": string, "name": string, "type": string, "reasoning": string } ],
    "removed": [ { "id": string, "name": string, "type": string } ],
    "modified": [
      {
        "id": string,
        "name": string,
        "type": string,
        "changes": [
          { "parameter": string, "oldVal": string, "newVal": string, "reasoning": string }
        ]
      }
    ],
    "costDelta": {
      "aws": { "min": number, "max": number },
      "azure": { "min": number, "max": number },
      "gcp": { "min": number, "max": number }
    }
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

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Title": "AI Cloud Architecture Generator",
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages: [
        { role: "system", content: systemInstruction },
        { role: "user", content: JSON.stringify(inputContext) },
      ],
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`OpenRouter API error: ${response.status} - ${errBody}`);
  }

  const data = await response.json();
  const contentStr = data.choices[0].message.content.trim();

  try {
    const parsed = JSON.parse(contentStr);
    return parsed;
  } catch (err) {
    console.error("Failed to parse JSON from architecture LLM response:", contentStr);
    const cleanStr = contentStr.replace(/^```json\s*/i, "").replace(/\s*```$/, "");
    try {
      const parsed = JSON.parse(cleanStr);
      return parsed;
    } catch {
      throw new Error("Failed to validate and generate architecture using LLM");
    }
  }
}
