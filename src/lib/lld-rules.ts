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
    case "cdn":
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

    if (["database", "storage", "cache"].includes(componentType)) {
      config.encryptionInTransit = "TLS 1.2+ (Enforced)";
      reasoning.encryptionInTransit = `Mandatory for ${standard} compliance — encryption in transit is not optional for regulated data, regardless of scale.`;
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
    case "cdn":
      config.ingressClass = "nginx";
      config.tlsMode = "cert-manager (Let's Encrypt)";
      config.replicas = "2";
      config.namespace = "ingress-system";
      reasoning.replicas = "Two Ingress-NGINX replicas avoid a single point of failure for all cluster traffic entry.";
      reasoning.tlsMode = "cert-manager automates certificate issuance and renewal rather than requiring manual cert rotation.";
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
    case "cdn":
      config.vmSize = "2 vCPU / 4GB RAM";
      config.scalingMode = "Manual (no autoscaler)";
      reasoning.scalingMode = "No CDN edge network on-premises — traffic capacity is whatever the reverse-proxy VM(s) can handle, sized ahead of time.";
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
