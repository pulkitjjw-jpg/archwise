// Locally-defined mirror of the backend's IndustryContext shape (see backend/app/models.py) --
// this file stays in the frontend purely for instant client-side LLD preview in
// ArchitectureWorkspace.tsx, so it can no longer import types from the retired Drizzle schema.
export type IndustryContext = {
  industry: "fintech" | "healthtech" | "none";
  rationale: string;
  complianceAnswers: Array<{ question: string; answer: string }>;
  flags: {
    handlesCardDataDirectly?: boolean;
    storesPHI?: boolean;
    dataResidency?: string;
  };
};

export type LldConfig = {
  config: Record<string, string>;
  reasoning: Record<string, string>;
};

// AWS/Azure/GCP rule-set label per provider -- mirrors backend/app/services/lld_rules.py's
// identically-named constant exactly (see that file for why WAF is LLD-only config on the "lb"/
// "cdn" branches rather than its own component type).
const WAF_RULE_SET_BY_PROVIDER: Record<string, string> = {
  aws: "AWS Managed Rules - Core Rule Set + SQL Injection Rule Set",
  azure: "Azure-managed Default Rule Set (DRS)",
  gcp: "Google Cloud Armor - OWASP Top 10 preconfigured rules",
};

/** Shared helper for the "lb" and "cdn" cases below -- mirrors the backend's `_waf_lld_config`
 * exactly (see that function's docstring for the enablement reasoning). Returns the config/
 * reasoning key-value pairs to merge in for the wafEnabled decision. */
function wafLldConfig(
  provider: string,
  isHighScale: boolean,
  isHighSecurity: boolean,
  industryContext?: IndustryContext
): LldConfig {
  const industry = industryContext?.industry ?? "none";
  const shouldEnable = isHighScale || isHighSecurity || industry === "fintech" || industry === "healthtech";

  const config: Record<string, string> = { wafEnabled: shouldEnable ? "true" : "false" };
  const reasoning: Record<string, string> = {};

  if (shouldEnable) {
    config.wafRuleSet = WAF_RULE_SET_BY_PROVIDER[provider] ?? "Provider-managed OWASP Top 10 rule set";
    config.rateLimitPerIP = "2000 requests / 5 min";

    const reasons: string[] = [];
    if (isHighScale) {
      reasons.push(
        "the workload is high-scale, where a WAF's marginal per-request inspection cost is worth it to absorb a larger volume of malicious/bot traffic"
      );
    }
    if (isHighSecurity) {
      reasons.push(
        "the project's compliance/security posture calls for defense-in-depth at the edge, not just application-layer controls"
      );
    }
    if (industry === "fintech" || industry === "healthtech") {
      reasons.push(
        `the project is flagged as ${industry}, where a WAF in front of the public edge is close to a baseline expectation rather than optional hardening`
      );
    }
    reasoning.wafEnabled = `Enabled because ${reasons.join("; and ")}.`;
  } else {
    reasoning.wafEnabled =
      "Disabled -- at this scale and sensitivity, the added cost and operational overhead (rule tuning, false-positive management) of a WAF is a reasonable trade-off to skip for now, not a security gap. Revisit if scale or compliance requirements change.";
  }

  return { config, reasoning };
}

export function runLldRulesEngine(
  provider: string,
  componentType: string,
  componentId: string,
  requirements: {
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
  },
  // When a user manually swaps a component to a specific alternative service (see
  // ArchitectureWorkspace's service-swap editor), the requirements alone no longer
  // determine which LLD shape applies (e.g. serverless vs container config keys) since
  // the requirements haven't changed, only the chosen service has. This lets the caller
  // force the correct branch based on the service name the user actually picked.
  serviceNameOverride?: string,
  // Layers compliance-mandated config on top of the scale/budget-driven baseline below —
  // see the block right before the return statement. Optional and additive: omitting it
  // (the default for every pre-Phase-4 call site) reproduces the exact prior behavior.
  industryContext?: IndustryContext
): LldConfig {
  const nfr = requirements.nonFunctional;
  const scaleLower = nfr.expectedScale.toLowerCase();
  const budgetLower = nfr.budget.toLowerCase();
  const teamLower = nfr.teamMaturity.toLowerCase();
  const complianceLower = nfr.compliance.toLowerCase();

  const isHighScale =
    scaleLower.includes("high") ||
    scaleLower.includes("million") ||
    scaleLower.includes("100,000") ||
    scaleLower.includes("10k") ||
    scaleLower.includes("50k");

  const isLowBudget =
    budgetLower.includes("low") ||
    budgetLower.includes("50") ||
    budgetLower.includes("30") ||
    budgetLower.includes("tight");

  const isHighSecurity =
    complianceLower.includes("gdpr") ||
    complianceLower.includes("hipaa") ||
    complianceLower.includes("pci") ||
    complianceLower.includes("secure") ||
    complianceLower.includes("audit") ||
    complianceLower.includes("encrypt");

  // Kubernetes and private cloud have fundamentally different LLD shapes (pod resource
  // requests/HPA/namespaces vs. instance sizes; VM sizing vs. managed-service config) — they
  // get their own dedicated rule functions below rather than being squeezed into the
  // aws/azure/gcp switch statement that follows.
  if (provider === "kubernetes") {
    return runKubernetesLld(componentType, componentId, isHighScale, isLowBudget, teamLower, isHighSecurity, industryContext);
  }
  if (provider === "private") {
    return runPrivateCloudLld(componentType, componentId, isHighScale, isHighSecurity, industryContext);
  }

  const config: Record<string, string> = {};
  const reasoning: Record<string, string> = {};

  switch (componentType) {
    case "realtime":
      config.connectionModel = "Persistent bidirectional (WebSocket)";
      config.idleTimeoutSec = "600s (10 min)";
      config.maxConcurrentConnections = isHighScale ? "10000" : "1000";
      config.messageBroadcastMode = "Fan-out via managed pub/sub backplane";

      reasoning.maxConcurrentConnections = isHighScale
        ? "Sized for a high-traffic real-time workload with many simultaneous open connections."
        : "Modest connection ceiling appropriate for lower expected concurrent real-time usage.";
      reasoning.messageBroadcastMode =
        "A managed pub/sub backplane is required once there's more than one server instance, so a message sent to one connection can still reach clients connected to a different instance.";
      break;

    case "cdn": {
      config.priceClass = isHighScale ? "PriceClass_All" : "PriceClass_100";
      config.ipv6Enabled = "true";
      config.originShield = isHighScale ? "Enabled" : "Disabled";
      config.sslProtocols = "TLSv1.2_or_Newer";

      reasoning.priceClass = isHighScale
        ? "Enabled edge locations globally to support high volume distribution."
        : "Restricted price class to US/Europe edge locations to minimize cost.";
      reasoning.originShield = isHighScale
        ? "Enabled Origin Shield to protect backend servers from high-frequency cache misses."
        : "Disabled Origin Shield as scale is moderate, avoiding extra gateway pricing.";

      const waf = wafLldConfig(provider, isHighScale, isHighSecurity, industryContext);
      Object.assign(config, waf.config);
      Object.assign(reasoning, waf.reasoning);
      break;
    }

    case "lb": {
      // Same is_serverless recompute as the "compute" case below -- a serviceNameOverride
      // (manual service-swap) or the deterministic scale/budget/team signal both need to agree on
      // whether this "lb" resolves to an ALB-style load balancer (container compute) or an
      // API-gateway-style managed gateway (serverless compute), since the two have genuinely
      // different config shapes.
      let isServerless = isLowBudget && (teamLower.includes("junior") || teamLower.includes("small") || teamLower === "not_specified");
      if (serviceNameOverride) {
        const svcLower = serviceNameOverride.toLowerCase();
        if (svcLower.includes("api gateway") || svcLower.includes("api management")) {
          isServerless = true;
        } else if (svcLower.includes("load balanc") || svcLower.includes("application gateway") || svcLower === "alb") {
          isServerless = false;
        }
      }

      if (isServerless) {
        config.gatewayType = "HTTP API (Regional)";
        config.throttlingBurstLimit = isHighScale ? "5000" : "1000";
        config.throttlingRateLimit = isHighScale ? "2000" : "500";
        config.corsPolicy = "Restricted to configured origin(s), not wildcard";
        config.tlsPolicy = "TLS 1.2+";

        reasoning.throttlingBurstLimit = isHighScale
          ? "A higher burst ceiling absorbs legitimate traffic spikes without rejecting real requests at high expected scale."
          : "A modest burst ceiling is appropriate for lower expected traffic, and doubles as a cheap first line of defense against a runaway client retry loop.";
        reasoning.corsPolicy =
          "A wildcard CORS policy on a public API gateway is a common source of unintended cross-origin access -- restricting to known origins up front is the safer default.";
        reasoning.tlsPolicy =
          "The managed gateway terminates TLS itself, so this is the one place a minimum protocol version needs to be enforced for the whole public API surface.";
      } else {
        config.healthCheckPath = "/health";
        config.healthCheckIntervalSec = isHighScale ? "15" : "30";
        config.healthCheckTimeoutSec = "5";
        config.healthyThresholdCount = "2";
        config.unhealthyThresholdCount = isHighScale ? "3" : "5";
        config.idleTimeoutSec = "60";
        config.listenerProtocol = "HTTPS";
        config.listenerPort = "443";
        config.tlsPolicy = "TLS 1.2+ (Modern Security Policy)";

        reasoning.healthCheckIntervalSec = isHighScale
          ? "More frequent health checks pull a failing instance out of rotation faster at high scale, where a slow instance affects more concurrent users."
          : "A standard interval is sufficient at lower scale, and avoids piling unnecessary health-check traffic onto each instance.";
        reasoning.unhealthyThresholdCount = isHighScale
          ? "A lower unhealthy threshold removes a failing instance from rotation faster, trading a slightly higher chance of a false-positive removal for reduced blast radius at high scale."
          : "A higher threshold avoids flapping a healthy-but-momentarily-slow instance in and out of rotation on a single transient failure.";
        reasoning.listenerProtocol =
          "TLS terminates at the load balancer rather than on individual compute instances, so the certificate is issued, rotated, and audited in exactly one place.";
      }

      const waf = wafLldConfig(provider, isHighScale, isHighSecurity, industryContext);
      Object.assign(config, waf.config);
      Object.assign(reasoning, waf.reasoning);
      break;
    }

    case "dns":
      // Deliberately does NOT include the backend's Phase 5 DR-tier-conditional
      // routingPolicy/secondaryRegion/failoverThreshold enrichment -- that depends on
      // determine_dr_strategy(), which has no client-side equivalent here (this file only ever
      // recomputes the plain scale/budget/security signals, not the DR/account-strategy NFR
      // signals layered on top in later phases). This preview always shows the "Simple" routing
      // baseline; the real persisted architecture (backend-generated) is the source of truth for
      // DR-aware routing.
      config.hostedZoneType = "Public";
      config.recordType = "Alias record to the load balancer/CDN endpoint (not a raw CNAME/IP)";
      config.routingPolicy = "Simple";
      config.ttlSeconds = "300";

      reasoning.recordType =
        "An alias-style record points directly at the managed load balancer/CDN endpoint without pinning to an IP address that provider can change at any time.";
      reasoning.routingPolicy =
        "Simple routing is correct today because there's only one region/endpoint to route traffic to.";
      reasoning.ttlSeconds =
        "A short TTL keeps DNS propagation fast if the target ever needs to change, at the cost of a modest increase in DNS query volume.";
      break;

    case "compute": {
      const isWorker = componentId === "worker";
      let isServerless = isLowBudget && (teamLower.includes("junior") || teamLower.includes("small") || teamLower === "not_specified");

      if (serviceNameOverride) {
        const svcLower = serviceNameOverride.toLowerCase();
        if (svcLower.includes("lambda") || svcLower.includes("function")) {
          isServerless = true;
        } else if (
          svcLower.includes("fargate") ||
          svcLower.includes("container app") ||
          svcLower.includes("ecs") ||
          svcLower.includes("cloud run") ||
          svcLower.includes("kubernetes") ||
          svcLower.includes("vm") ||
          svcLower.includes("app service") ||
          svcLower.includes("compute engine")
        ) {
          isServerless = false;
        }
      }

      if (isServerless && !isWorker) {
        config.memory = isHighScale ? "1024MB" : "512MB";
        config.timeout = "30s";
        config.concurrency = isHighScale ? "100" : "10";
        config.scalingPolicy = "Automatic pay-per-request concurrency scaling.";

        reasoning.memory = isHighScale
          ? "Allocated 1GB RAM to support swift cold starts under high scale demand."
          : "Allocated 512MB memory to stay within tight free-tier/budget scopes.";
        reasoning.timeout = "Standard 30s timeout configured for standard API processing.";
      } else {
        config.instanceSize = isHighScale ? "0.5 vCPU + 1GB RAM" : "0.25 vCPU + 0.5 GB RAM";
        config.minInstances = isHighScale ? "2" : "1";
        config.maxInstances = isHighScale ? "10" : "3";
        config.scalingPolicy = isHighScale
          ? "Target tracking scaling policy on CPU utilisation (>70%)."
          : "Simple scaling target on memory utilisation (>80%).";

        reasoning.minInstances = isHighScale
          ? "Configured min 2 instances to maintain multi-zone high availability."
          : "Configured min 1 instance to satisfy tight budget goals.";
        reasoning.instanceSize = isHighScale
          ? "Allocated medium container profile (0.5 vCPU) for stable API concurrency."
          : "Allocated minimum container profile to reduce idle billing.";
      }

      // Networking details nested under compute
      config.vpcSubnet = "Private App Subnets";
      config.securityGroups = "Allows HTTPS ingress from CDN, outbound access to DB/Storage.";
      reasoning.vpcSubnet = "Isolated compute components from the public internet for security.";
      break;
    }

    case "database": {
      let isRelational =
        nfr.dataNature.toLowerCase().includes("relational") ||
        nfr.dataNature.toLowerCase().includes("sql") ||
        nfr.dataNature.toLowerCase().includes("invoice");

      if (serviceNameOverride) {
        const svcLower = serviceNameOverride.toLowerCase();
        if (
          svcLower.includes("dynamo") ||
          svcLower.includes("cosmos") ||
          svcLower.includes("firestore") ||
          svcLower.includes("bigtable") ||
          svcLower.includes("documentdb")
        ) {
          isRelational = false;
        } else if (
          svcLower.includes("sql") ||
          svcLower.includes("rds") ||
          svcLower.includes("aurora") ||
          svcLower.includes("postgres") ||
          svcLower.includes("spanner")
        ) {
          isRelational = true;
        }
      }

      if (isRelational) {
        config.instanceClass = isHighScale
          ? provider === "aws" ? "db.m6g.xlarge" : provider === "azure" ? "Standard_D4ds_v5" : "db-custom-4-15360"
          : provider === "aws" ? "db.t4g.micro" : provider === "azure" ? "Standard_B1ms" : "db-f1-micro";
        config.storageSize = isHighScale ? "100GB GP3" : "20GB GP3";
        config.multiAZ = isHighScale || isHighSecurity ? "true (Primary/Standby)" : "false (Single Node)";
        config.backupRetention = isHighSecurity ? "30 Days" : "7 Days";
        config.connectionLimit = isHighScale ? "500" : "100";

        reasoning.instanceClass = isHighScale
          ? "Provisioned high performance dedicated cores to handle complex transactional scale."
          : "Provisioned burstable cores to keep postgres hosting affordable.";
        reasoning.multiAZ = isHighScale || isHighSecurity
          ? "Configured database failover replica across availability zones to prevent data loss."
          : "Disabled multi-AZ replication to minimize instance count costs.";
      } else {
        config.readCapacityUnits = isHighScale ? "1000 (Auto-Scale)" : "On-Demand";
        config.writeCapacityUnits = isHighScale ? "500 (Auto-Scale)" : "On-Demand";
        config.encryptionType = "AWS KMS Managed Encryption";
        config.globalTables = isHighScale ? "Enabled" : "Disabled";

        reasoning.readCapacityUnits = isHighScale
          ? "Auto-scaled RCU to guarantee low latency database reads under peak traffic."
          : "On-Demand billing is preferred to eliminate idle capacity costs.";
      }

      config.vpcSubnet = "Private Database Subnets";
      config.securityGroups = "Allows port 5432 ingress strictly from App Compute components.";
      reasoning.vpcSubnet = "Placed database in isolated subnets behind active security group rules.";
      break;
    }

    case "storage":
      config.bucketStructure = "Single namespace bucket with folder partition.";
      config.encryptionAlgorithm = "AES-256 (Server-Side Encryption)";
      config.lifecycleRule = isHighScale ? "Transition to Glacier Deep Archive after 90 days." : "none";
      config.versioningEnabled = isHighSecurity ? "true" : "false";

      reasoning.lifecycleRule = isHighScale
        ? "Enabled auto-archiving policy to offload old file storage costs."
        : "No lifecycle rules configured to keep implementation simple.";
      reasoning.versioningEnabled = isHighSecurity
        ? "Enabled bucket versioning to secure audit logs and prevent deletion mistakes."
        : "Disabled versioning to save space costs.";
      break;

    case "queue":
      config.queueType = isHighSecurity ? "FIFO (Strict Ordering)" : "Standard";
      config.visibilityTimeoutSec = "900s (15 Mins)";
      config.retentionDays = "4 Days";
      config.maxMessageSizeKB = "256KB";

      reasoning.queueType = isHighSecurity
        ? "Chose FIFO queue to ensure transaction logs are processed in exact linear order."
        : "Chose Standard queue for high throughput buffer support.";
      reasoning.visibilityTimeoutSec = "Set visibility timeout to match background worker task limits.";
      break;

    case "cache":
      config.nodeType = isHighScale
        ? provider === "aws" ? "cache.t4g.medium" : provider === "azure" ? "Basic C1" : "m1-redis-medium"
        : provider === "aws" ? "cache.t4g.micro" : provider === "azure" ? "Basic C0" : "m1-redis-micro";
      config.clusteringEnabled = isHighScale ? "true" : "false";
      config.evictionPolicy = "volatile-lru";

      reasoning.nodeType = isHighScale
        ? "Provisioned medium cache node to hold high volumes of active user sessions."
        : "Chose smallest burstable memory cache node to fit constraints.";
      break;

    case "auth":
      config.tokenValidityHours = "24h";
      config.mfaRequired = isHighSecurity ? "true" : "false";
      config.selfSignUpEnabled = "true";
      config.passwordStrength = "8+ characters, requires symbols/caps.";

      reasoning.mfaRequired = isHighSecurity
        ? "Enforced multi-factor authentication (MFA) to satisfy compliance guidelines."
        : "Disabled mandatory MFA to ease user onboard friction.";
      break;

    case "tokenization":
      config.encryptionStandard = "FIPS 140-2 Level 3 (HSM-backed)";
      config.tokenFormat = "Format-Preserving Encryption (FPE)";
      config.pciScope = "Isolated CDE — reduces PCI-DSS scope for connected systems";
      config.rawDataLogging = "Disabled";

      reasoning.encryptionStandard = "HSM-backed key storage is required to keep cryptographic material for cardholder data out of reach of application-layer compromise.";
      reasoning.rawDataLogging = "PCI-DSS explicitly prohibits logging full PAN (Primary Account Number) data in application or debug logs.";
      break;

    case "audit-log":
      config.retentionPeriod = isHighSecurity ? "7 Years (regulatory)" : "3 Years";
      config.immutability = "Enabled (WORM / Object Lock)";
      config.accessControl = "Write-only for application roles, read-only for auditors";

      reasoning.immutability = "Audit trails must be tamper-evident — write-once storage prevents after-the-fact edits to covers unauthorized access.";
      reasoning.retentionPeriod = isHighSecurity
        ? "Extended retention aligns with stricter regulatory record-keeping expectations."
        : "Standard multi-year retention to support incident investigation and periodic compliance review.";
      break;

    case "phi-vault":
      config.encryptionAtRest = "AES-256 (Customer-Managed KMS Key)";
      config.accessLogging = "Enabled — every read/write logged with authenticated user identity";
      config.baaRequired = "true (Business Associate Agreement with cloud provider required)";
      config.networkIsolation = "Private subnet, no direct internet route";

      reasoning.encryptionAtRest = "HIPAA's Security Rule requires PHI to be encrypted at rest using keys the covered entity controls, not just provider-managed defaults.";
      reasoning.baaRequired = "Any cloud provider processing PHI on your behalf must sign a Business Associate Agreement (BAA) before this component can legally hold real patient data.";
      break;

    case "deidentification":
      config.method = "Safe Harbor De-identification (18 HIPAA identifiers removed)";
      config.triggerMode = "Batch (nightly) — not real-time inline";

      reasoning.method = "Safe Harbor is the more auditable of HIPAA's two de-identification standards and doesn't require a statistician's expert determination.";
      break;

    case "monitoring":
      config.logRetentionDays = isHighSecurity ? "365 (regulatory)" : "30";
      config.alertingPhilosophy =
        "Alert on symptoms (error rate, latency, saturation), not causes -- paging on every CPU blip creates alert fatigue that buries the alert that actually matters.";
      config.tracingEnabled = "true";
      config.tracingSampleRate = isHighScale ? "5% (sampled)" : "100% (full trace)";
      config.metricNamespace = "app/production";

      reasoning.logRetentionDays = isHighSecurity
        ? "Extended retention aligns with regulatory record-keeping expectations for compliance-sensitive workloads."
        : "30 days is enough to debug most incidents while keeping storage costs down; extend it if a compliance requirement says otherwise.";
      reasoning.tracingSampleRate = isHighScale
        ? "Tracing every single request at high request volume gets expensive fast, both in storage and in the tracing backend's own ingestion cost -- a 5% sample still surfaces the same latency/error patterns statistically, at a fraction of the cost."
        : "Traffic is low enough that tracing every request is still cheap, and full fidelity makes debugging any single request trivial.";
      reasoning.alertingPhilosophy = "A small number of high-signal alerts that actually get acted on beats a large number that get muted.";
      break;

    case "notification": {
      const funcStr = requirements.functional.join(" ").toLowerCase();
      const channels: string[] = [];
      if (funcStr.includes("sms") || funcStr.includes("text message")) channels.push("SMS");
      if (funcStr.includes("push notification") || funcStr.includes("push")) channels.push("Push");
      if (funcStr.includes("email")) channels.push("Email");
      const inferred = channels.length > 0;
      const resolvedChannels = inferred ? channels : ["Email"];

      config.deliveryChannels = resolvedChannels.join(", ");
      config.retryPolicy = "3 attempts, exponential backoff (1m / 5m / 15m)";
      config.deadLetterHandling =
        "Failed deliveries after the final retry route to a dead-letter queue, retained 14 days for manual inspection/replay";

      reasoning.deliveryChannels = inferred
        ? "Inferred directly from the stated functional requirements' mention of these channels."
        : "Defaulted to email -- the stated functional requirements didn't call out a specific channel (SMS/push); confirm this matches the actual product need.";
      reasoning.retryPolicy = "A few retries with backoff absorb a transient provider hiccup without hammering the delivery provider over a permanent failure.";
      reasoning.deadLetterHandling =
        "A notification that fails every retry needs to land somewhere reviewable -- a silent failure here is exactly the kind of gap a user only discovers when someone complains they never got the email.";
      break;
    }

    case "search": {
      config.indexCount = isHighScale ? "Multiple indices, sharded by entity type (products, orders, etc.)" : "Single index, default sharding";
      config.shardCount = isHighScale ? "5 primary shards + 1 replica each" : "1 primary shard + 1 replica";
      config.instanceSize = isHighScale ? "3x r6g.large.search (dedicated master + data nodes)" : "1x t3.small.search (single node)";

      const industry = industryContext?.industry ?? "none";
      const needsPiiRedaction = isHighSecurity || industry === "fintech" || industry === "healthtech";
      config.piiRedactionRequired = needsPiiRedaction ? "true" : "false";

      reasoning.shardCount = isHighScale
        ? "More shards spread indexing/query load across nodes at high volume, at the cost of more per-shard overhead."
        : "A single shard is enough at this volume and avoids the per-shard overhead of an over-sharded small index.";
      reasoning.instanceSize = isHighScale
        ? "A dedicated master node keeps cluster-state management off the data nodes once query/index volume is high enough to matter."
        : "A single node is sufficient at this volume; add dedicated master nodes if the index grows.";
      reasoning.piiRedactionRequired = needsPiiRedaction
        ? "Search results surface indexed field values verbatim, so if any indexed content includes PII/PHI (e.g. user-generated reviews, support tickets), the ingestion pipeline feeding this index must redact it before indexing -- a genuinely different compliance boundary than the primary database, which has its own access controls this index doesn't inherit."
        : "No regulated/sensitive-data signal detected for this project -- revisit if indexed content later includes PII (e.g. user-generated content).";
      break;
    }

    case "analytics":
      config.scalingMode = isLowBudget
        ? "On-demand serverless (compute scales to zero between queries)"
        : "Provisioned (reserved capacity for sustained, predictable query load)";
      config.partitionStrategy = "Partitioned by ingestion date (daily), enabling partition pruning on time-range queries";
      config.retentionPolicy = isHighSecurity ? "Indefinite (regulatory/analytical history retained)" : "2 years, then archived to cold storage";
      config.etlSyncFrequency = isHighScale ? "Near-real-time change data capture (CDC) from the primary database" : "Nightly batch ETL from the primary database";

      reasoning.scalingMode = isLowBudget
        ? "On-demand serverless avoids paying for standing compute capacity on a tight budget, at the cost of less predictable per-query latency than a provisioned warehouse."
        : "Provisioned capacity gives predictable query latency for a sustained reporting workload, at the cost of paying for it whether or not queries are actually running.";
      reasoning.etlSyncFrequency = isHighScale
        ? "At this scale, a nightly batch lag is too stale for the reporting/analytics use case -- CDC keeps the warehouse close to real-time."
        : "A nightly batch sync is simple to operate and matches most reporting use cases' actual freshness requirements at this scale.";
      reasoning.retentionPolicy = isHighSecurity
        ? "Extended retention aligns with regulatory record-keeping expectations for compliance-sensitive workloads."
        : "A multi-year window balances useful trend analysis against unbounded storage growth.";
      break;

    case "ml": {
      config.instanceType = isHighScale ? "GPU-backed (e.g. ml.g5.xlarge)" : "CPU-backed (e.g. ml.m5.large)";
      config.autoScaling = isHighScale ? "Target-tracking on InvocationsPerInstance, 2-10 instances" : "Fixed 1 instance (no autoscaling)";

      const industry = industryContext?.industry ?? "none";
      const modelSeesRegulatedData = isHighSecurity || industry === "fintech" || industry === "healthtech";
      config.dataComplianceBoundary = modelSeesRegulatedData
        ? "true -- PHI/PII may reach this model, extending the compliance boundary to include the inference endpoint"
        : "false -- no regulated-data signal detected for this project";

      reasoning.instanceType = isHighScale
        ? "GPU inference cuts per-request latency materially for real-time recommendation/classification traffic at this volume, at a real cost premium over CPU."
        : "CPU inference is cheaper and sufficient for lighter models at this request volume; revisit if latency becomes a problem.";
      reasoning.autoScaling = isHighScale
        ? "Autoscaling absorbs request-volume spikes without over-provisioning for peak load at all times."
        : "A single fixed instance is simplest and cheapest at this request volume; add autoscaling once traffic grows.";
      reasoning.dataComplianceBoundary = modelSeesRegulatedData
        ? "If the features sent to this model include any PHI/PII (not just an opaque user ID), the inference endpoint itself falls inside the same compliance boundary as the database it draws from -- encryption in transit, access logging, and data-residency requirements apply here too, not just at the primary data store."
        : "No regulated-data signal detected for this project -- revisit this if the model's input features start including PHI/PII rather than anonymized/derived signals.";
      break;
    }

    case "workflow":
      config.executionType = isHighScale
        ? "Express (high-volume, short-duration, at-least-once)"
        : "Standard (durable, full execution history up to 1 year)";
      config.retryPolicy = "3 retries per state with exponential backoff; unhandled errors route to a catch-all error handler";
      config.executionHistoryRetention = isHighSecurity ? "90 days" : "30 days";

      reasoning.executionType = isHighScale
        ? "Express trades Standard's exactly-once execution history for materially lower per-execution cost, which matters once invocation volume is genuinely high."
        : "Standard's full execution history is worth the extra cost at this volume -- useful for auditing exactly what happened in a given approval/business-process run.";
      reasoning.retryPolicy = "A few retries with backoff absorb a transient failure in one step without requiring the whole process to restart from the beginning.";
      reasoning.executionHistoryRetention = isHighSecurity
        ? "Extended retention aligns with regulatory record-keeping expectations for a compliance-sensitive process."
        : "30 days is enough to debug a recent failed execution while keeping storage costs down.";
      break;

    default:
      config.genericType = "Generic Config";
      reasoning.genericType = "Standard deployment config.";
      break;
  }

  // Compliance-mandated config additions, layered on top of whatever the scale/budget-driven
  // rules above already decided. These are ADDED keys, never overrides of the existing scale
  // logic, so a generic (industryContext undefined/"none") call is byte-for-byte unaffected.
  if (industryContext && industryContext.industry !== "none") {
    const standard = industryContext.industry === "fintech" ? "PCI-DSS" : "HIPAA";

    if (["database", "storage", "cache", "analytics"].includes(componentType)) {
      config.encryptionInTransit = "TLS 1.2+ (Enforced)";
      reasoning.encryptionInTransit =
        componentType === "analytics"
          ? `Mandatory for ${standard} compliance — encryption in transit is not optional for regulated data, regardless of scale. This applies to the analytics warehouse too, since it holds a real (if delayed) copy of the same regulated data.`
          : `Mandatory for ${standard} compliance — encryption in transit is not optional for regulated data, regardless of scale.`;
    }

    if (componentType === "database" && industryContext.industry === "fintech") {
      config.multiAZ = "true (Primary/Standby)";
      reasoning.multiAZ = "Forced to enabled for PCI-DSS compliance — regulated payment workloads require high availability regardless of stated scale.";
    }
  }

  return { config, reasoning };
}

function runKubernetesLld(
  componentType: string,
  componentId: string,
  isHighScale: boolean,
  isLowBudget: boolean,
  teamLower: string,
  isHighSecurity: boolean,
  industryContext?: IndustryContext
): LldConfig {
  const isLowOpsCapacity =
    isLowBudget || teamLower.includes("junior") || teamLower.includes("small") || teamLower === "not_specified";

  const config: Record<string, string> = {};
  const reasoning: Record<string, string> = {};

  switch (componentType) {
    case "realtime":
      config.replicas = isHighScale ? "4" : "2";
      config.namespace = "app";
      config.sessionAffinity = "ClientIP (sticky sessions required for WebSocket)";
      config.backplane = "Redis Pub/Sub (cross-pod message fan-out)";
      reasoning.sessionAffinity =
        "A WebSocket connection is stateful and pinned to one pod — without sticky sessions, the Ingress could route a client's next request to a pod it has no open connection with.";
      reasoning.backplane = "A shared pub/sub backplane lets a message published from any pod reach clients connected to any other pod.";
      break;

    case "cdn":
      config.ingressClass = "nginx";
      config.tlsMode = "cert-manager (Let's Encrypt)";
      config.replicas = "2";
      config.namespace = "ingress-system";
      reasoning.replicas = "Two Ingress-NGINX replicas avoid a single point of failure for all cluster traffic entry.";
      reasoning.tlsMode = "cert-manager automates certificate issuance and renewal rather than requiring manual cert rotation.";
      config.wafNote =
        "Not natively available -- consider a self-hosted ModSecurity/ingress-level WAF (e.g. OWASP CRS via ModSecurity-nginx) if this workload's scale/compliance profile warrants it.";
      break;

    case "lb":
      config.replicas = isHighScale ? "3" : "2";
      config.namespace = "ingress-system";
      config.healthCheckPath = "/healthz";
      config.idleTimeoutSec = "60";
      config.tlsMode = "cert-manager (Let's Encrypt)";
      reasoning.replicas = isHighScale
        ? "Three replicas spread across nodes tolerate a node failure without dropping the cluster's single entry point for all traffic."
        : "Two replicas is the minimum that avoids the Ingress controller itself becoming a single point of failure.";
      reasoning.healthCheckPath =
        "Ingress-NGINX health-checks each backend Service's endpoints directly via Kubernetes readiness probes, not a separate synthetic external check.";
      config.wafNote =
        "Not natively available -- consider a self-hosted ModSecurity/ingress-level WAF (e.g. OWASP CRS via ModSecurity-nginx) if this workload's scale/compliance profile warrants it.";
      break;

    case "dns":
      config.deploymentMode = "ExternalDNS Operator (In-Cluster)";
      config.namespace = "ingress-system";
      config.syncPolicy = "upsert-only (never deletes records it didn't create)";
      reasoning.deploymentMode =
        "ExternalDNS watches Ingress/Service resources and syncs their hostnames to an external DNS provider automatically -- the standard Kubernetes-native way to avoid manually updating DNS records on every deploy.";
      reasoning.syncPolicy = "upsert-only is the safer default -- it will never delete a DNS record it doesn't already track as its own, even if the matching Ingress is removed.";
      break;

    case "compute": {
      const isWorker = componentId === "worker";
      if (isWorker) {
        config.replicas = "2";
        config.resourceRequests = "250m CPU / 256Mi Memory";
        config.resourceLimits = "500m CPU / 512Mi Memory";
        config.kedaMinReplicas = "0";
        config.kedaMaxReplicas = isHighScale ? "15" : "5";
        config.kedaTriggerType = "Queue depth (RabbitMQ/NATS)";
        config.namespace = "app";

        reasoning.kedaMinReplicas = "Scaling to zero when the queue is empty avoids paying for idle worker capacity.";
        reasoning.kedaMaxReplicas = isHighScale
          ? "Higher ceiling to absorb large batch/reconciliation spikes at scale."
          : "Modest ceiling appropriate for lower expected background job volume.";
      } else {
        config.replicas = isHighScale ? "4" : "2";
        config.resourceRequests = isHighScale ? "500m CPU / 512Mi Memory" : "250m CPU / 256Mi Memory";
        config.resourceLimits = isHighScale ? "1000m CPU / 1Gi Memory" : "500m CPU / 512Mi Memory";
        config.hpaMinReplicas = isHighScale ? "4" : "2";
        config.hpaMaxReplicas = isHighScale ? "20" : "6";
        config.hpaTargetCPU = "70%";
        config.namespace = "app";
        config.networkPolicy = "Allow ingress from ingress-nginx namespace only; allow egress to data namespace only";

        reasoning.hpaMinReplicas = isHighScale
          ? "Minimum 4 replicas spread across nodes for multi-zone-equivalent availability under high scale."
          : "Minimum 2 replicas is the smallest count that still tolerates a single pod eviction without downtime.";
        reasoning.networkPolicy = "Default-deny network policy scoped to only the traffic paths this component actually needs, limiting lateral movement if a pod is compromised.";
      }
      break;
    }

    case "database": {
      if (isLowOpsCapacity) {
        config.deploymentMode = "External (ExternalName Service + Secret)";
        config.namespace = "data";
        reasoning.deploymentMode = "Given the team's low operational maturity/tight budget, the database runs outside the cluster on a managed service — self-managing a stateful database's failover, backups, and patching on Kubernetes is a significant ops burden this avoids.";
      } else {
        config.replicas = isHighScale ? "3 (Primary + 2 Replicas)" : "1 (Single Instance)";
        config.storageSize = isHighScale ? "100Gi" : "20Gi";
        config.storageClass = "ssd-retain (Retain reclaim policy)";
        config.resourceRequests = isHighScale ? "1000m CPU / 2Gi Memory" : "500m CPU / 1Gi Memory";
        config.namespace = "data";
        config.networkPolicy = "Allow ingress from app namespace only; deny all else";

        reasoning.storageClass = "A Retain reclaim policy prevents the underlying volume from being deleted if the StatefulSet or PVC is accidentally removed — data loss protection for a self-managed database.";
        reasoning.replicas = isHighScale
          ? "Primary plus two read replicas for both read scaling and failover capacity."
          : "Single instance keeps operational surface minimal; acceptable only because ops capacity was assessed as adequate to handle its own failover.";
      }
      break;
    }

    case "storage":
      config.replicas = isHighScale ? "4 (Distributed Mode)" : "1 (Standalone)";
      config.storageSize = isHighScale ? "500Gi" : "100Gi";
      config.namespace = "data";
      reasoning.replicas = isHighScale
        ? "MinIO distributed mode (4+ nodes) provides erasure coding for durability at this scale."
        : "Standalone MinIO is sufficient for lower storage volumes, at the cost of no built-in redundancy.";
      break;

    case "queue":
      config.replicas = "3 (Clustered)";
      config.storageSize = isHighScale ? "50Gi" : "10Gi";
      config.namespace = "data";
      reasoning.replicas = "A 3-node cluster is the minimum for RabbitMQ quorum queues to survive a single node failure.";
      break;

    case "cache":
      config.replicas = isHighScale ? "3 (Cluster Mode)" : "1 (Standalone)";
      config.namespace = "data";
      reasoning.replicas = isHighScale
        ? "Redis Cluster mode shards data across nodes to handle higher throughput."
        : "Standalone Redis is sufficient for lower cache volumes; a node failure means a cold cache, not data loss, since this is a cache.";
      break;

    case "auth":
      config.replicas = "2";
      config.namespace = "identity";
      reasoning.replicas = "Two replicas avoid identity/login becoming a single point of failure for the whole application.";
      break;

    case "tokenization":
      config.replicas = "3 (Vault Raft HA)";
      config.namespace = "security";
      config.networkPolicy = "Only the app namespace may reach Vault; no direct external ingress permitted";
      reasoning.replicas = "Vault's Raft integrated storage needs an odd number of nodes (3 minimum) to maintain quorum during a node failure.";
      reasoning.networkPolicy = "Narrowing which namespaces can reach the tokenization boundary is itself a PCI-DSS-relevant network segmentation control.";
      break;

    case "audit-log":
      config.deploymentMode = "DaemonSet (Falco — one pod per node)";
      config.namespace = "monitoring";
      reasoning.deploymentMode = "Falco must run on every node as a DaemonSet to observe syscall-level activity across the whole cluster, not just within one namespace.";
      break;

    case "phi-vault":
      config.storageClass = "encrypted-retain";
      config.namespace = "data-phi";
      config.networkPolicy = "Only the app namespace may reach phi-vault; deny all else";
      reasoning.namespace = "A dedicated namespace (separate from the general 'data' namespace) keeps the HIPAA compliance boundary enforceable via namespace-scoped RBAC and network policy.";
      reasoning.storageClass = "An encrypted StorageClass with a Retain policy ensures PHI is encrypted at the volume level and cannot be silently deleted by a PVC/StatefulSet mistake.";
      break;

    case "deidentification":
      config.deploymentMode = "CronJob (nightly)";
      config.namespace = "data";
      reasoning.deploymentMode = "Runs as a scheduled batch job against new PHI records rather than an always-on Deployment, since de-identification doesn't need to be real-time.";
      break;

    case "monitoring":
      config.namespace = "monitoring";
      config.deploymentMode = "kube-prometheus-stack (Helm chart: Prometheus + Grafana + Alertmanager)";
      config.retentionDays = isHighSecurity ? "90" : "15";
      config.tracingSampleRate = isHighScale ? "5% (sampled, via OpenTelemetry Collector)" : "100% (full trace)";
      reasoning.retentionDays = isHighSecurity
        ? "Extended in-cluster retention for compliance-sensitive workloads -- consider remote-writing to a long-term store (e.g. Thanos/Mimir) beyond this window."
        : "Short retention keeps Prometheus' local storage footprint small; extend it or add remote-write if longer history is needed.";
      reasoning.tracingSampleRate = isHighScale
        ? "Sampling keeps the OpenTelemetry Collector's ingestion volume manageable at high request rates."
        : "Full-fidelity tracing is still cheap to store at this request volume.";
      break;

    case "notification":
      config.namespace = "app";
      config.deploymentMode =
        "NATS JetStream (Helm chart) + a small notification-dispatch Deployment calling the external delivery provider's API";
      config.retryPolicy = "3 attempts, exponential backoff";
      reasoning.deploymentMode =
        "JetStream durably queues the fan-out event; the dispatch Deployment is what actually calls the configured external email/SMS/push provider, since nothing in-cluster can deliver to an end-user inbox or phone directly.";
      break;

    case "search":
      config.replicas = isHighScale ? "3 (multi-node cluster, quorum-based)" : "1 (single node)";
      config.storageSize = isHighScale ? "200Gi" : "50Gi";
      config.namespace = "data";
      reasoning.replicas = isHighScale
        ? "A 3-node cluster tolerates a single node failure without losing quorum for index writes."
        : "A single node is sufficient at this volume; a node failure means reindexing from the source of truth, not permanent data loss, since this is a derived index.";
      break;

    case "analytics":
      config.deploymentMode = "External (ExternalName Service + Secret) -- no in-cluster analytics/data-warehouse equivalent";
      config.namespace = "data";
      reasoning.deploymentMode =
        "A real OLAP data warehouse is a genuinely different, heavier stateful workload than anything else this cluster self-hosts -- this is modeled as a network destination outside the cluster (a managed warehouse or an existing enterprise one), reached via a Kubernetes Secret holding its connection credentials.";
      break;

    case "ml":
      config.deploymentMode = "KServe InferenceService (or Seldon Core)";
      config.replicas = isHighScale ? "2" : "1";
      config.namespace = "ml";
      reasoning.deploymentMode =
        "KServe wraps model serving in a Kubernetes-native CRD with built-in autoscaling (including scale-to-zero), so the endpoint doesn't need a hand-rolled Deployment + HPA.";
      reasoning.namespace = "A dedicated 'ml' namespace keeps GPU-scheduling and model-serving RBAC scoped separately from the general 'app' namespace.";
      break;

    case "workflow":
      config.deploymentMode = "Argo Workflows (Helm chart)";
      config.namespace = "workflows";
      reasoning.deploymentMode =
        "Argo Workflows defines each step as a Kubernetes-native CRD (a real pod per step), so retries/error-handling/execution history live in cluster-native resources rather than an external managed service.";
      reasoning.namespace = "A dedicated 'workflows' namespace keeps the orchestrator's own controller/RBAC scoped separately from the workloads it triggers.";
      break;

    default:
      config.genericType = "Generic in-cluster workload";
      config.namespace = "app";
      reasoning.genericType = "Standard deployment config.";
      break;
  }

  if (industryContext && industryContext.industry !== "none") {
    const standard = industryContext.industry === "fintech" ? "PCI-DSS" : "HIPAA";
    if (["database", "storage", "cache", "queue"].includes(componentType)) {
      config.mtls = "Enabled (service mesh or cert-manager-issued pod certs)";
      reasoning.mtls = `Mandatory for ${standard} compliance — encryption in transit between pods is not optional for regulated data, regardless of scale.`;
    }
  }

  return { config, reasoning };
}

function runPrivateCloudLld(
  componentType: string,
  componentId: string,
  isHighScale: boolean,
  isHighSecurity: boolean,
  industryContext?: IndustryContext
): LldConfig {
  const config: Record<string, string> = {};
  const reasoning: Record<string, string> = {};

  switch (componentType) {
    case "realtime":
      config.vmSize = "4 vCPU / 8GB RAM";
      config.vmCount = isHighScale ? "3 (clustered, sticky-session reverse proxy)" : "2";
      config.scalingMode = "Manual (no autoscaler) — capacity must be pre-provisioned for peak concurrent connections";
      reasoning.scalingMode =
        "Private infrastructure has no elastic capacity pool — the number of simultaneously open WebSocket connections is capped by whatever's pre-provisioned.";
      break;

    case "cdn":
      config.vmSize = "2 vCPU / 4GB RAM";
      config.scalingMode = "Manual (no autoscaler)";
      reasoning.scalingMode = "No CDN edge network on-premises — traffic capacity is whatever the reverse-proxy VM(s) can handle, sized ahead of time.";
      config.wafNote =
        "Not natively available -- consider a self-hosted ModSecurity/ingress-level WAF (e.g. OWASP CRS via ModSecurity-nginx) if this workload's scale/compliance profile warrants it.";
      break;

    case "lb":
      config.vmSize = "4 vCPU / 8GB RAM";
      config.vmCount = "2 (active/passive failover pair)";
      config.healthCheckPath = "/health";
      config.haMode = "Manual failover (keepalived/VRRP, or a documented manual DNS cutover)";
      reasoning.haMode =
        "On-premises load balancer HA requires a manually configured VRRP/keepalived pair or a documented, tested failover runbook — nothing here does this automatically.";
      config.wafNote =
        "Not natively available -- consider a self-hosted ModSecurity/ingress-level WAF (e.g. OWASP CRS via ModSecurity-nginx) if this workload's scale/compliance profile warrants it.";
      break;

    case "dns":
      config.deploymentMode = "Manual record management against the existing corporate DNS/BIND server";
      config.ttlSeconds = "300";
      reasoning.deploymentMode =
        "Flagging explicitly: there is no automation syncing load balancer/VM changes to DNS records here — every change, including any future failover routing, is a manual step against the existing DNS server.";
      break;

    case "compute": {
      const isWorker = componentId === "worker";
      config.vmSize = isHighScale ? "8 vCPU / 16GB RAM" : "4 vCPU / 8GB RAM";
      config.vmCount = isWorker ? (isHighScale ? "3" : "2") : (isHighScale ? "4" : "2");
      config.scalingMode = "Manual (no autoscaler) — capacity must be pre-provisioned for peak load";
      reasoning.scalingMode = "Private infrastructure has no elastic capacity pool — under-provisioning means dropped requests at peak, not an autoscale event.";
      break;
    }

    case "database":
      config.vmSize = isHighScale ? "16 vCPU / 64GB RAM" : "8 vCPU / 32GB RAM";
      config.storageSize = isHighScale ? "1TB (SAN-backed)" : "200GB (SAN-backed)";
      config.haMode = "Manual failover (no managed failover available)";
      reasoning.haMode = "On-premises database HA requires manually configured streaming replication and a documented, tested failover runbook — nothing here does this automatically.";
      break;

    case "storage":
      config.storageAllocation = isHighScale ? "5TB" : "1TB";
      config.replicationMode = "Manual (backup job to secondary array or off-site)";
      break;

    case "queue":
      config.vmCount = "1 (no managed HA)";
      config.opsFlag = "No managed queue on-premises — requires dedicated ops capacity for clustering, HA, and upgrades";
      reasoning.opsFlag = "Flagging explicitly: a managed cloud queue absorbs clustering/HA/patching automatically, this does not.";
      break;

    case "cache":
      config.vmSize = "4 vCPU / 8GB RAM";
      config.haMode = "Manual failover";
      break;

    case "auth":
      config.vmCount = "1-2 (manual load balancing)";
      break;

    case "tokenization":
      config.vmCount = "3 (manual HA cluster)";
      config.hsmRecommended = isHighSecurity ? "true — dedicated HSM appliance recommended at this compliance level" : "false — software-based key storage acceptable";
      break;

    case "audit-log":
      config.storageMode = "WORM-capable storage array required for true immutability";
      reasoning.storageMode = "Standard on-prem storage can be overwritten by anyone with array access — immutability requires a storage array or archive tier that explicitly supports write-once semantics.";
      break;

    case "phi-vault":
      config.encryptionMode = "Manual key management (HSM appliance recommended)";
      config.baaFlag = "A Business Associate Agreement is still required from any third party hosting/maintaining this hardware";
      break;

    case "deidentification":
      config.vmSize = "4 vCPU / 8GB RAM";
      config.schedulingMode = "Scheduled batch job (cron)";
      break;

    case "monitoring":
      config.vmSize = "4 vCPU / 8GB RAM";
      config.deploymentMode = "Self-hosted Prometheus + Grafana (or ELK), dedicated VM";
      config.retentionDays = isHighSecurity ? "90" : "15";
      reasoning.deploymentMode = "No managed observability platform on-premises -- log/metric storage capacity must be sized and monitored like any other stateful service here.";
      break;

    case "notification":
      config.vmCount = "1-2 (self-managed message bus)";
      config.retryPolicy = "3 attempts, exponential backoff";
      config.externalDependencyFlag = "An external delivery provider (email/SMS/push gateway) is required -- nothing on-premises can deliver directly to end users";
      reasoning.externalDependencyFlag = "Flagging explicitly: the message bus only handles internal fan-out; actual delivery to a real inbox/phone always exits through an external provider.";
      break;

    case "search":
      config.vmSize = isHighScale ? "8 vCPU / 32GB RAM" : "4 vCPU / 16GB RAM";
      config.vmCount = isHighScale ? "3 (clustered)" : "1";
      reasoning.vmCount = "A 3-node cluster tolerates a single node failure; a single node at lower scale means reindexing from the source of truth on failure, not permanent data loss.";
      break;

    case "analytics":
      config.deploymentMode =
        "No managed equivalent on-premises -- typically a network destination reached over the corporate network/VPN (e.g. an existing enterprise data warehouse appliance)";
      reasoning.deploymentMode =
        "Flagging explicitly: this design does not provision analytics/data-warehouse hardware -- it assumes one already exists on the corporate network, or that provisioning it is a separate, larger undertaking outside this architecture's scope.";
      break;

    case "ml":
      config.vmSize = isHighScale ? "GPU-equipped VM (e.g. NVIDIA T4/A10) recommended" : "CPU-only VM acceptable at this request volume";
      config.deploymentMode = "Self-hosted inference server (e.g. NVIDIA Triton), no managed equivalent";
      reasoning.deploymentMode =
        "On-premises has no managed autoscaling or model-versioning tooling -- capacity must be pre-provisioned for peak inference load, and deployment/rollback is a manual operational process.";
      break;

    case "workflow":
      config.deploymentMode = "Self-hosted orchestrator (e.g. Apache Airflow / Temporal) on dedicated VM(s)";
      config.vmCount = isHighScale ? "2 (HA pair)" : "1";
      reasoning.vmCount = "An HA pair avoids the orchestrator itself becoming a single point of failure for every process it coordinates once scale is high enough to matter.";
      break;

    default:
      config.genericType = "Generic on-premises component";
      break;
  }

  if (industryContext && industryContext.industry !== "none") {
    const standard = industryContext.industry === "fintech" ? "PCI-DSS" : "HIPAA";
    if (["database", "storage", "cache", "queue"].includes(componentType)) {
      config.networkSegmentation = "Dedicated VLAN, firewalled from general corporate network";
      reasoning.networkSegmentation = `Mandatory for ${standard} compliance — regulated data stores must be network-isolated from the general corporate network, not just access-controlled.`;
    }
  }

  return { config, reasoning };
}
