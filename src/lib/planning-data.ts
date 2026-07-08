import type { PlanningArtifactContent } from "@/db/schema";

export type PlanningArtifactSeed = {
  slug: string;
  title: string;
  priority: string;
  summary: string;
  displayOrder: number;
  content: PlanningArtifactContent;
};

export const productContext = {
  name: "AI Cloud Architecture Generator",
  concept:
    "A SaaS product that turns a plain-language product idea into validated requirements, MVP-level HLD/LLD architecture, cloud service recommendations, cost estimates, IaC, ADRs, and versioned architecture deltas as the product grows.",
  journey: [
    "Idea intake",
    "Idea-specific brainstorm and validation",
    "Functional and non-functional requirement structuring",
    "Decision engine with rules plus LLM reasoning and trade-off explanations",
    "Abstract HLD generation",
    "Multi-cloud service mapping",
    "LLD generation",
    "Output package with diagrams, Terraform, cost estimate, and ADR",
    "Living document and growth loop",
  ],
  modules: [
    "Conversational Orchestrator",
    "Knowledge Base",
    "Reasoning Core",
    "Multi-cloud Service Catalog",
    "HLD/LLD Diagram Generator",
    "IaC Generator",
    "Cost Estimator",
    "Living Architecture Store",
    "Human Review Layer",
  ],
};

export const planningArtifacts: PlanningArtifactSeed[] = [
  {
    slug: "context-confirmation",
    title: "Context confirmation",
    priority: "Foundation",
    summary:
      "The product direction is clear; no blocking ambiguity exists for Phase 1 planning. The only choices that can be deferred are commercial packaging, exact LLM vendor, and full multi-cloud parity.",
    displayOrder: 1,
    content: {
      sections: [
        {
          heading: "What is already clear",
          body:
            "The product is not a generic diagram generator. It is a guided architecture copilot that captures requirements, reasons about trade-offs, produces an MVP architecture, maps the architecture to cloud services, and keeps the architecture alive as the real product evolves.",
          bullets: [
            "The first durable artifact should be a versioned architecture record, not a one-off chat transcript.",
            "Every recommendation must include a why/trade-off so users can trust the decision engine.",
            "Phase 1 should deliberately narrow the service mapping to AWS while keeping the internal model cloud-neutral.",
          ],
        },
        {
          heading: "Assumptions to proceed without blocking",
          body:
            "The safest engineering assumption is to build Phase 1 around a single architecture workspace per project with structured requirement capture, deterministic baseline rules, and LLM-assisted narrative generation. This preserves optionality for Azure/GCP and later delta updates.",
          bullets: [
            "Use AWS as the first concrete provider only at the mapping layer.",
            "Represent HLD components abstractly before binding them to AWS services.",
            "Store decisions and requirements as first-class records so future versions can diff them.",
          ],
        },
      ],
    },
  },
  {
    slug: "recommended-priority",
    title: "Recommended current priority",
    priority: "Phase 1 technical specification",
    summary:
      "Start with the Phase 1 technical spec, API contracts, and database model because every other module depends on stable structured inputs and outputs.",
    displayOrder: 2,
    content: {
      sections: [
        {
          heading: "Why this should come first",
          body:
            "If the requirement model is weak, the decision engine, HLD generator, cost estimator, and future delta engine will all become brittle. A strong Phase 1 spec creates the canonical language for the system before adding complex multi-cloud logic.",
          bullets: [
            "The chat experience can stay flexible while persisting normalized requirements behind the scenes.",
            "Decision rules can be tested with fixtures before LLM calls are introduced in production paths.",
            "AWS mapping can be implemented as provider data rather than hardcoded prose, making Phase 2 easier.",
          ],
        },
        {
          heading: "Non-goals for the first implementation slice",
          body:
            "Avoid trying to generate complete Terraform, exact pricing, or multi-cloud comparisons in the first slice. Instead, produce structured placeholders and a reliable architecture recommendation pipeline that can be expanded.",
          bullets: [
            "No full Azure/GCP parity yet.",
            "No automatic production-grade security policy synthesis yet.",
            "No autonomous architecture replacement; only produce explicit versioned recommendations.",
          ],
        },
      ],
      tasks: [
        {
          phase: "Immediate build order",
          items: [
            "Create project/workspace model and idea intake form.",
            "Generate and persist idea-specific brainstorm questions.",
            "Normalize answers into requirement records.",
            "Run rules-based decision engine to create abstract HLD components.",
            "Map HLD components to AWS service candidates with trade-offs.",
            "Generate an architecture version containing HLD, mapping, cost bands, and ADR summary.",
          ],
        },
      ],
    },
  },
  {
    slug: "phase-1-data-model",
    title: "Phase 1 data model",
    priority: "Database schema",
    summary:
      "Persist projects, conversation turns, structured requirements, architecture versions, decisions, components, service mappings, and cost estimates separately so the product can support auditability and deltas later.",
    displayOrder: 3,
    content: {
      sections: [
        {
          heading: "Core entities",
          body:
            "The data model should separate raw conversation from normalized architecture facts. Raw chat helps explain provenance, while structured records make rules, diffs, and exports reliable.",
          bullets: [
            "Project: owner, product idea, industry, target launch stage, preferred region, budget posture.",
            "ConversationTurn: role, content, extracted signals, linked project.",
            "Requirement: category, name, value, confidence, source turn, version applicability.",
            "ArchitectureVersion: semantic version, status, generated summary, previous version pointer.",
            "ArchitectureComponent: abstract HLD component such as API compute, primary database, cache, queue, CDN, auth.",
            "DecisionRecord: decision, rationale, alternatives, trade-offs, confidence, rule/LLM provenance.",
            "CloudServiceMapping: provider, service, fit score, cost band, lock-in risk, operational complexity.",
            "CostEstimate: monthly range, assumptions, usage inputs, provider references.",
          ],
        },
        {
          heading: "Why not store only generated markdown",
          body:
            "Markdown is good for exports but bad for iteration. The living architecture loop requires machine-readable components, decisions, and assumptions so v2 can explain what changed instead of regenerating a disconnected document.",
        },
      ],
      tables: [
        {
          title: "Minimum viable relational schema",
          columns: ["Table", "Purpose", "Important fields"],
          rows: [
            ["projects", "Top-level product workspace", "id, user_id, name, idea_text, industry, status, created_at"],
            ["conversation_turns", "Auditable brainstorm history", "id, project_id, role, content, extracted_json, created_at"],
            ["requirements", "Normalized functional/NFR facts", "id, project_id, category, key, value_json, confidence, source_turn_id"],
            ["architecture_versions", "Versioned output package", "id, project_id, version_number, status, summary, previous_version_id"],
            ["components", "Cloud-neutral HLD nodes", "id, architecture_version_id, type, name, responsibilities_json"],
            ["decision_records", "Reasoned architecture decisions", "id, architecture_version_id, decision, rationale, tradeoffs_json"],
            ["service_mappings", "AWS mapping in Phase 1", "id, component_id, provider, service_name, fit_score, notes"],
            ["cost_estimates", "Ranged cost output", "id, architecture_version_id, provider, low_usd, high_usd, assumptions_json"],
          ],
        },
      ],
    },
  },
  {
    slug: "api-contracts",
    title: "Phase 1 API contracts",
    priority: "Backend interfaces",
    summary:
      "Expose narrow, typed endpoints around project creation, brainstorm question generation, requirement normalization, and architecture version generation.",
    displayOrder: 4,
    content: {
      sections: [
        {
          heading: "API boundaries",
          body:
            "Keep LLM calls behind server-side endpoints and persist both prompts and structured outputs for traceability. The frontend should never call the model provider directly.",
          bullets: [
            "POST /api/projects creates a workspace from a raw idea.",
            "POST /api/projects/:id/brainstorm generates contextual questions and stores them as assistant turns.",
            "POST /api/projects/:id/requirements normalizes user answers into structured requirements.",
            "POST /api/projects/:id/architecture-versions generates a Phase 1 AWS architecture package.",
            "GET /api/projects/:id/architecture-versions/:version exports HLD, mappings, cost estimate, and ADR content.",
          ],
        },
        {
          heading: "Structured LLM output strategy",
          body:
            "Ask the LLM for strict JSON objects aligned to internal schemas, then validate and repair or reject invalid results. The rules engine should provide deterministic candidate decisions before the LLM writes user-facing explanations.",
          bullets: [
            "Question generation output: question id, prompt, reason, answer type, requirement key it probes.",
            "Requirement extraction output: category, key, value, confidence, source quote.",
            "Architecture generation output: components, decisions, assumptions, risks, unknowns.",
          ],
        },
      ],
      tables: [
        {
          title: "Endpoint contract summary",
          columns: ["Endpoint", "Input", "Output", "Why"],
          rows: [
            ["POST /api/projects", "name, ideaText", "projectId, nextStep", "Creates a durable workspace before any AI work."],
            ["POST /api/projects/:id/brainstorm", "optional focus areas", "questions[]", "Turns an idea into targeted discovery."],
            ["POST /api/projects/:id/requirements", "answers[]", "requirements[], missingSignals[]", "Makes downstream reasoning deterministic."],
            ["POST /api/projects/:id/architecture-versions", "targetProvider=aws", "versionId, components[], decisions[]", "Creates the first living architecture version."],
            ["GET /api/projects/:id/export", "format=markdown|json", "document", "Supports handoff to Claude Code, engineers, or reviewers."],
          ],
        },
      ],
    },
  },
  {
    slug: "decision-rules",
    title: "Knowledge base and decision rules",
    priority: "Reasoning core",
    summary:
      "Use deterministic rule packs for baseline architecture choices, then ask the LLM to explain and adapt them instead of letting the model invent infrastructure from scratch.",
    displayOrder: 5,
    content: {
      sections: [
        {
          heading: "Rule pack structure",
          body:
            "Each rule should include conditions, recommendations, rejected alternatives, trade-offs, confidence, and evidence links. This makes recommendations explainable and testable.",
          bullets: [
            "Example: if expected users are low and team maturity is small, prefer managed serverless compute to reduce operational load.",
            "Example: if data is relational and consistency-sensitive, prefer a managed relational database over NoSQL for the MVP.",
            "Example: if workload has bursty asynchronous tasks, add queue plus worker rather than scaling the synchronous API path.",
          ],
        },
        {
          heading: "AWS Phase 1 mapping defaults",
          body:
            "The AWS mapper should use simple, well-understood defaults for MVPs but include upgrade paths. The goal is credible initial architecture, not premature hyperscale complexity.",
          bullets: [
            "Frontend/CDN: S3 + CloudFront or Amplify Hosting depending on framework and team skill.",
            "API compute: Lambda + API Gateway for spiky/unknown traffic; ECS Fargate when long-running services or container parity matter.",
            "Database: RDS PostgreSQL for relational workloads; DynamoDB only when access patterns are simple and high-scale key-value/document access is dominant.",
            "Cache: ElastiCache only when read pressure, expensive queries, or session/cache requirements justify added operations.",
            "Queue: SQS for decoupled jobs; EventBridge for event routing across domains.",
            "Auth: Cognito for fastest AWS-native MVP; external auth if developer experience or B2B SSO is the differentiator.",
          ],
        },
      ],
      tables: [
        {
          title: "Initial decision criteria",
          columns: ["Signal", "Recommendation impact", "Trade-off"],
          rows: [
            ["Small team / low ops maturity", "Prefer managed/serverless services", "Less control and possible lock-in."],
            ["Strict relational consistency", "Prefer PostgreSQL/RDS", "Scaling writes may require later read replicas or sharding strategy."],
            ["Unpredictable traffic", "Prefer autoscaling or serverless compute", "Cold starts and pricing variability need monitoring."],
            ["Budget constrained MVP", "Avoid optional cache/search/event mesh initially", "May need quick refactor if traction arrives."],
            ["Compliance-sensitive data", "Add encryption, audit logs, private networking earlier", "Higher initial complexity and cost."],
          ],
        },
      ],
    },
  },
  {
    slug: "implementation-plan",
    title: "Step-by-step implementation plan",
    priority: "Claude Code handoff",
    summary:
      "Build the MVP as a thin vertical slice: idea intake through generated AWS HLD package, with persistence and deterministic fixtures before introducing paid LLM calls.",
    displayOrder: 6,
    content: {
      sections: [
        {
          heading: "Vertical slice strategy",
          body:
            "A vertical slice reduces risk because each module proves one piece of the final journey. The first successful demo should create a project, ask tailored questions, collect answers, generate HLD components, map them to AWS, and display an ADR-style explanation.",
          bullets: [
            "Implement mock/deterministic LLM adapters first, then swap in Claude/Gemini behind the same interface.",
            "Use schema validation at every AI boundary.",
            "Persist intermediate artifacts so failures can be retried without losing context.",
          ],
        },
        {
          heading: "Testing plan",
          body:
            "Test the reasoning core with representative product ideas, not just unit-level functions. The key quality metric is whether the generated questions and architecture choices change appropriately when the idea changes.",
          bullets: [
            "Fixture 1: B2B SaaS analytics dashboard with relational data and moderate traffic.",
            "Fixture 2: Consumer media upload app with bursty storage and CDN needs.",
            "Fixture 3: Fintech workflow with audit, compliance, and strict consistency.",
            "Fixture 4: Marketplace with search, notifications, payments, and asynchronous jobs.",
          ],
        },
      ],
      tasks: [
        {
          phase: "Sprint 1: Foundations",
          items: [
            "Create database tables for projects, turns, requirements, versions, components, decisions, mappings, and estimates.",
            "Build idea intake UI and project detail page.",
            "Add server-side LLM adapter interface with deterministic mock provider.",
          ],
        },
        {
          phase: "Sprint 2: Brainstorm and requirements",
          items: [
            "Generate contextual questions from idea text.",
            "Store answers as conversation turns.",
            "Extract normalized functional and non-functional requirements.",
          ],
        },
        {
          phase: "Sprint 3: HLD and AWS mapping",
          items: [
            "Implement abstract component generator using rule packs.",
            "Create AWS service catalog seed data.",
            "Map components to AWS services with fit score and trade-off notes.",
          ],
        },
        {
          phase: "Sprint 4: Output package",
          items: [
            "Render HLD diagram from component graph data.",
            "Generate ADR markdown from decision records.",
            "Create basic cost range from assumptions and provider service bands.",
          ],
        },
      ],
    },
  },
];
