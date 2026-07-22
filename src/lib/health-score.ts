// Architecture Health Score (Workstream T3) -- a deterministic, rule-based 0-100 grade across 4
// dimensions, computed entirely client-side from data already loaded (components, requirements,
// and the Security Findings already computed server-side by run_security_rules). Deliberately NOT
// another LLM guess -- same "rules decide, never a model" philosophy as diagram-layout.ts/
// journey-verification.ts. Loose duck-typed inputs (not imported from ArchitectureWorkspace.tsx)
// so this stays a standalone, easily-testable pure module, matching journey-verification.ts's
// existing pattern of defining its own minimal shapes rather than reaching into a component file.

type HSComponent = {
  id: string;
  name: string;
  type: string;
  cloudMappings?: Record<string, { lld?: { config?: Record<string, string> } } | undefined>;
};

type HSConnection = { from: string; to: string };

export type SecurityFindingSeverity = "high" | "medium" | "low";
type HSSecurityFinding = { severity: SecurityFindingSeverity; title: string };

export type HealthScoreDimension = {
  score: number; // 0-100
  reasoning: string[];
};

export type HealthScore = {
  overall: number;
  costEfficiency: HealthScoreDimension;
  scalability: HealthScoreDimension;
  security: HealthScoreDimension;
  vendorLockIn: HealthScoreDimension;
};

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function lldConfig(c: HSComponent, provider: string): Record<string, string> {
  return c.cloudMappings?.[provider]?.lld?.config || {};
}

// --- Cost Efficiency ---------------------------------------------------------------------------
// Compares actual estimated cost against the stated budget (a free-text NFR string, e.g.
// "$500/mo" or "under $2,000 per month") -- parsed with a simple regex since there's no
// structured budget field anywhere in the data model. Without a stated budget there's no target
// to judge efficiency against, so a neutral baseline score is used instead of guessing.
function scoreCostEfficiency(budget: string | undefined, costMin: number, costMax: number): HealthScoreDimension {
  const reasoning: string[] = [];
  const budgetStr = (budget || "").trim();
  const isUnspecified = !budgetStr || budgetStr.toLowerCase().replace(/_/g, " ") === "not specified";
  const match = budgetStr.match(/[\d,]+(\.\d+)?/);
  const budgetNumber = match ? parseFloat(match[0].replace(/,/g, "")) : null;

  if (isUnspecified || budgetNumber === null) {
    reasoning.push("No target budget was stated, so cost efficiency can't be judged against a goal -- showing a neutral baseline.");
    reasoning.push(`Estimated cost: $${costMin} - $${costMax}/mo.`);
    return { score: 65, reasoning };
  }

  const projected = costMax;
  const ratio = budgetNumber > 0 ? projected / budgetNumber : 2;
  let score: number;
  if (ratio <= 1) {
    score = 100;
    reasoning.push(`Estimated cost ($${costMin} - $${costMax}/mo) fits within the stated budget (~$${budgetNumber}/mo).`);
  } else if (ratio <= 1.2) {
    score = 75;
    reasoning.push(`Estimated cost ($${costMin} - $${costMax}/mo) is slightly above the stated budget (~$${budgetNumber}/mo).`);
  } else if (ratio <= 1.5) {
    score = 50;
    reasoning.push(`Estimated cost ($${costMin} - $${costMax}/mo) is meaningfully above the stated budget (~$${budgetNumber}/mo).`);
  } else {
    score = ratio > 2 ? 10 : 25;
    reasoning.push(`Estimated cost ($${costMin} - $${costMax}/mo) is far above the stated budget (~$${budgetNumber}/mo) -- likely over-provisioned for this budget.`);
  }
  return { score: clamp(score), reasoning };
}

// --- Scalability Readiness ----------------------------------------------------------------------
// Checks for autoscaling signal on compute (serverless concurrency, or a min/max instance range)
// and failover redundancy on databases (multiAZ), using the exact LLD config keys lld_rules.py
// actually sets -- the same fields Security Findings reads, not a separate invented schema.
function scoreScalability(components: HSComponent[], provider: string): HealthScoreDimension {
  let score = 100;
  const reasoning: string[] = [];
  const computeComponents = components.filter((c) => c.type === "compute");
  const databaseComponents = components.filter((c) => c.type === "database");

  for (const c of computeComponents) {
    const config = lldConfig(c, provider);
    const hasServerlessScaling = "concurrency" in config || "scalingPolicy" in config;
    const min = parseInt(config.minInstances || "", 10);
    const max = parseInt(config.maxInstances || "", 10);
    const hasRangedInstances = !Number.isNaN(min) && !Number.isNaN(max) && max > min;
    if (!hasServerlessScaling && !hasRangedInstances && !("minInstances" in config)) {
      score -= 25;
      reasoning.push(`"${c.name}" has no scaling configuration recorded.`);
    } else if ("minInstances" in config && !hasRangedInstances) {
      score -= 15;
      reasoning.push(`"${c.name}" runs a fixed instance count with no auto-scaling range.`);
    }
  }
  if (computeComponents.length === 1) {
    score -= 10;
    reasoning.push("Only one compute component in this design -- a single point of failure if it goes down.");
  }

  for (const c of databaseComponents) {
    const config = lldConfig(c, provider);
    if ((config.multiAZ || "").toLowerCase().startsWith("false")) {
      score -= 20;
      reasoning.push(`"${c.name}" has no failover redundancy configured (single node).`);
    }
  }

  if (reasoning.length === 0) {
    reasoning.push("Compute has scaling configured and databases have failover redundancy where present.");
  }
  return { score: clamp(score), reasoning };
}

// --- Security Posture ---------------------------------------------------------------------------
// Directly derived from the Security Findings already computed server-side (run_security_rules,
// Workstream T4) -- explicitly sharing the same checks per the spec, not a second parallel audit.
function scoreSecurity(findings: HSSecurityFinding[]): HealthScoreDimension {
  const DEDUCTION: Record<SecurityFindingSeverity, number> = { high: 15, medium: 8, low: 3 };
  let score = 100;
  const reasoning: string[] = [];
  for (const f of findings) {
    score -= DEDUCTION[f.severity];
    reasoning.push(`[${f.severity}] ${f.title}`);
  }
  if (reasoning.length === 0) {
    reasoning.push("No security findings from the automated audit.");
  }
  return { score: clamp(score), reasoning };
}

// --- Vendor Lock-in Risk --------------------------------------------------------------------------
// Self-hosted targets (Kubernetes/private cloud) carry minimal cloud-vendor lock-in almost by
// definition. For a managed cloud provider, portability is approximated per component TYPE (there
// is no structured "proprietary vs standard" flag anywhere in the data model) -- e.g. a relational
// database or managed identity service is comparatively hard to migrate away from; object storage
// and container compute are comparatively portable thanks to widely-shared API conventions.
const PORTABILITY_BY_TYPE: Record<string, number> = {
  cdn: 70,
  compute: 70,
  database: 50,
  storage: 75,
  queue: 60,
  cache: 75,
  auth: 30,
  realtime: 40,
  tokenization: 35,
  "audit-log": 45,
  "phi-vault": 35,
  deidentification: 45,
  // Load balancing and DNS are both widely standardized concepts (every provider's LB/API-gateway
  // maps onto the same basic model, and DNS itself is a standard protocol) -- comparatively
  // portable, similar to cdn/compute above.
  lb: 65,
  dns: 80,
  // Monitoring/notification: the underlying pattern (metrics/logs/traces; fan-out to email/SMS/
  // push) is portable, but the actual managed-service integration and dashboards/alert rules are
  // provider-specific and need real rework to migrate -- moderate portability.
  monitoring: 60,
  notification: 55,
  // Search (OpenSearch/Elasticsearch) is itself a portable open-source technology used across
  // every provider (including self-hosted) -- comparatively portable, similar to queue/cache.
  search: 65,
  // Analytics warehouses (Redshift/Synapse/BigQuery) differ meaningfully in SQL dialect, pricing
  // model, and ingestion mechanics -- moderate lock-in, similar to a relational database.
  analytics: 45,
  // ML inference endpoints (SageMaker/Azure ML/Vertex AI) are quite provider-specific in their
  // deployment/serving APIs even though the underlying model format may be portable -- comparable
  // lock-in to a managed identity service.
  ml: 35,
  // Workflow orchestrators (Step Functions/Logic Apps/Cloud Workflows) each use their own
  // proprietary state-machine definition language -- among the more locked-in component types.
  workflow: 30,
};

function scoreVendorLockIn(components: HSComponent[], provider: string): HealthScoreDimension {
  const reasoning: string[] = [];
  if (provider === "kubernetes" || provider === "private") {
    reasoning.push("Self-hosted deployment target -- minimal cloud-vendor lock-in regardless of component types.");
    return { score: 95, reasoning };
  }
  if (components.length === 0) {
    return { score: 100, reasoning: ["No components to assess."] };
  }

  const scored = components.map((c) => ({ c, portability: PORTABILITY_BY_TYPE[c.type] ?? 55 }));
  const avg = scored.reduce((sum, s) => sum + s.portability, 0) / scored.length;

  const lowest = [...scored].sort((a, b) => a.portability - b.portability).slice(0, 2);
  for (const { c, portability } of lowest) {
    if (portability < 55) {
      reasoning.push(`"${c.name}" uses a comparatively provider-specific service, adding migration effort if this ever needs to move providers.`);
    }
  }
  if (reasoning.length === 0) {
    reasoning.push("Most components use widely-portable service categories (containers, object storage, standard databases).");
  }
  return { score: clamp(avg), reasoning };
}

export function computeHealthScore(
  components: HSComponent[],
  _connections: HSConnection[],
  budget: string | undefined,
  securityFindings: HSSecurityFinding[],
  provider: string,
  costMin: number,
  costMax: number
): HealthScore {
  const costEfficiency = scoreCostEfficiency(budget, costMin, costMax);
  const scalability = scoreScalability(components, provider);
  const security = scoreSecurity(securityFindings);
  const vendorLockIn = scoreVendorLockIn(components, provider);
  const overall = clamp((costEfficiency.score + scalability.score + security.score + vendorLockIn.score) / 4);
  return { overall, costEfficiency, scalability, security, vendorLockIn };
}
