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
  }
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

    case "compute":
      const isWorker = componentId === "worker";
      const isServerless = isLowBudget && (teamLower.includes("junior") || teamLower.includes("small") || teamLower === "not_specified");

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

    case "database":
      const isRelational =
        nfr.dataNature.toLowerCase().includes("relational") ||
        nfr.dataNature.toLowerCase().includes("sql") ||
        nfr.dataNature.toLowerCase().includes("invoice");

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

    default:
      config.genericType = "Generic Config";
      reasoning.genericType = "Standard deployment config.";
      break;
  }

  return { config, reasoning };
}
