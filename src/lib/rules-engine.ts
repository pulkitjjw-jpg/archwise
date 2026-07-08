export type AbstractComponent = {
  id: string;
  name: string;
  type: string;
  description: string;
  rulesFired: string[];
  reasoning: string;
};

export type AbstractConnection = {
  from: string;
  to: string;
  protocol?: string;
};

export type AbstractArchitecture = {
  components: AbstractComponent[];
  connections: AbstractConnection[];
  rulesTrace: string[];
};

export function runRulesEngine(requirements: {
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
}): AbstractArchitecture {
  const components: AbstractComponent[] = [];
  const connections: AbstractConnection[] = [];
  const rulesTrace: string[] = [];

  const nfr = requirements.nonFunctional;
  const funcStr = requirements.functional.join(" ").toLowerCase();

  // 1. Content Delivery Network (CDN)
  const needsCDN =
    nfr.latencySensitivity.toLowerCase().includes("high") ||
    nfr.expectedScale.toLowerCase().includes("high") ||
    funcStr.includes("image") ||
    funcStr.includes("file") ||
    funcStr.includes("media") ||
    funcStr.includes("picture") ||
    funcStr.includes("video") ||
    funcStr.includes("pdf");

  if (needsCDN) {
    components.push({
      id: "cdn",
      name: "Content Delivery Network",
      type: "cdn",
      description: "Distributes static assets and uploads, offloading pressure from primary API servers.",
      rulesFired: ["Rule-CDN-HighScale-Or-Media: Latency sensitivity is high or workload includes media uploads."],
      reasoning: "Suggested by CDN rule based on latency or media requirements.",
    });
    rulesTrace.push("Rule-CDN-HighScale-Or-Media");
  }

  // 2. Compute (Serverless vs Containers)
  const budgetLower = nfr.budget.toLowerCase();
  const isBudgetTight =
    budgetLower.includes("low") ||
    budgetLower.includes("50") ||
    budgetLower.includes("10") ||
    budgetLower.includes("tight") ||
    budgetLower === "not_specified";

  const teamLower = nfr.teamMaturity.toLowerCase();
  const isTeamJunior =
    teamLower.includes("junior") ||
    teamLower.includes("small") ||
    teamLower === "not_specified";

  if (isBudgetTight && isTeamJunior) {
    components.push({
      id: "compute",
      name: "Managed Serverless Compute",
      type: "compute",
      description: "Executes API and business logic on-demand without managing server instances, minimizing costs.",
      rulesFired: ["Rule-Compute-Serverless: Tight budget and small team maturity trigger serverless architecture."],
      reasoning: "Suggested by Serverless Compute rule for low cost and minimal operations overhead.",
    });
    rulesTrace.push("Rule-Compute-Serverless");
  } else {
    components.push({
      id: "compute",
      name: "API Container Service",
      type: "compute",
      description: "Runs API containers in a managed orchestration cluster for consistent execution and long-running requests.",
      rulesFired: ["Rule-Compute-Container: Higher team maturity or budget accommodates container-based microservices."],
      reasoning: "Suggested by Container Compute rule for stable request execution.",
    });
    rulesTrace.push("Rule-Compute-Container");
  }

  if (needsCDN) {
    connections.push({ from: "cdn", to: "compute", protocol: "HTTPS" });
  }

  // 3. Storage & Database
  const dataLower = nfr.dataNature.toLowerCase();
  const isRelational =
    dataLower.includes("relational") ||
    dataLower.includes("transaction") ||
    dataLower.includes("invoice") ||
    dataLower.includes("sql") ||
    funcStr.includes("invoice") ||
    funcStr.includes("transaction");

  if (isRelational) {
    components.push({
      id: "database",
      name: "Relational Database",
      type: "database",
      description: "Stores transactional records with strict ACID consistency.",
      rulesFired: ["Rule-DB-Relational: Relational or transactional data characteristics mandate ACID properties."],
      reasoning: "Suggested by Relational Database rule to preserve structural data consistency.",
    });
    rulesTrace.push("Rule-DB-Relational");
  } else {
    components.push({
      id: "database",
      name: "Document Database",
      type: "database",
      description: "A flexible document store for unstructured schema-less data.",
      rulesFired: ["Rule-DB-Document: Unstructured or key-value data characteristics map to NoSQL document store."],
      reasoning: "Suggested by Document Database rule for schema flexibility.",
    });
    rulesTrace.push("Rule-DB-Document");
  }
  connections.push({ from: "compute", to: "database", protocol: "SQL/TCP" });

  // 4. Object Storage (if upload media)
  const needsObjectStore =
    dataLower.includes("media") ||
    dataLower.includes("file") ||
    dataLower.includes("pdf") ||
    funcStr.includes("upload") ||
    funcStr.includes("file") ||
    funcStr.includes("picture") ||
    funcStr.includes("pdf");

  if (needsObjectStore) {
    components.push({
      id: "storage",
      name: "Object Storage Bucket",
      type: "storage",
      description: "Stores unstructured media uploads, invoices, and static blobs durably and cheaply.",
      rulesFired: ["Rule-Storage-Object: System requires file/media storage capacity."],
      reasoning: "Suggested by Object Storage rule for file/media persistence.",
    });
    rulesTrace.push("Rule-Storage-Object");
    connections.push({ from: "compute", to: "storage", protocol: "HTTPS" });
    if (needsCDN) {
      connections.push({ from: "cdn", to: "storage", protocol: "HTTPS" });
    }
  }

  // 5. Caching
  const readWriteLower = nfr.readWritePattern.toLowerCase();
  const needsCache =
    readWriteLower.includes("read-heavy") ||
    readWriteLower.includes("cache") ||
    nfr.expectedScale.toLowerCase().includes("high");

  if (needsCache) {
    components.push({
      id: "cache",
      name: "In-Memory Cache",
      type: "cache",
      description: "Speeds up read accesses for repetitive database queries and active sessions.",
      rulesFired: ["Rule-Cache-ReadHeavy: Read-heavy pattern or high expected scale warrants caching layer."],
      reasoning: "Suggested by In-Memory Cache rule to buffer database read load.",
    });
    rulesTrace.push("Rule-Cache-ReadHeavy");
    connections.push({ from: "compute", to: "cache", protocol: "Redis/TCP" });
  }

  // 6. Queue & Worker
  const needsQueue =
    readWriteLower.includes("async") ||
    funcStr.includes("background") ||
    funcStr.includes("queue") ||
    funcStr.includes("async") ||
    funcStr.includes("worker") ||
    funcStr.includes("upload"); // files are typically processed asynchronously

  if (needsQueue) {
    components.push({
      id: "queue",
      name: "Message Queue",
      type: "queue",
      description: "Buffers spikes in incoming events/tasks and decouples asynchronous background tasks.",
      rulesFired: ["Rule-Queue-Async: Asynchronous requirements or background jobs request event buffering."],
      reasoning: "Suggested by Message Queue rule to decouple request handling.",
    });
    components.push({
      id: "worker",
      name: "Background Compute Worker",
      type: "compute",
      description: "Processes queued background tasks, such as generating PDF reports or resizing uploads.",
      rulesFired: ["Rule-Worker-Async: Decoupled workers execute background jobs asynchronously."],
      reasoning: "Suggested by Background Compute Worker rule to execute async workloads.",
    });
    rulesTrace.push("Rule-Queue-Worker");

    connections.push({ from: "compute", to: "queue", protocol: "AMQP/HTTP" });
    connections.push({ from: "queue", to: "worker", protocol: "Poll" });
    connections.push({ from: "worker", to: "database", protocol: "SQL/TCP" });
    if (needsObjectStore) {
      connections.push({ from: "worker", to: "storage", protocol: "HTTPS" });
    }
  }

  // 7. Security / Authentication component if compliance specifies audit/encryption/GDPR
  const complianceLower = nfr.compliance.toLowerCase();
  const needsAuth =
    complianceLower.includes("gdpr") ||
    complianceLower.includes("encrypt") ||
    complianceLower.includes("security") ||
    complianceLower.includes("auth") ||
    funcStr.includes("auth") ||
    funcStr.includes("login") ||
    funcStr.includes("signin");

  if (needsAuth) {
    components.push({
      id: "auth",
      name: "Authentication & Identity Provider",
      type: "auth",
      description: "Handles user sessions, token issuance, encryption logs, and access control lists.",
      rulesFired: ["Rule-Auth-Compliance: Security requirements or login actions require user authentication."],
      reasoning: "Suggested by Authentication rule to enforce data security controls.",
    });
    rulesTrace.push("Rule-Auth-Compliance");
    connections.push({ from: "compute", to: "auth", protocol: "OIDC/HTTPS" });
  }

  return { components, connections, rulesTrace };
}
