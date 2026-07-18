// Resolves a real, service-specific Iconify icon id for whatever `serviceName` string
// cloud-mapping.ts already returns (e.g. "Amazon RDS PostgreSQL (db.t4g.micro)"). Pure
// presentational lookup — reads no new data, requires no backend/API changes.
//
// Priority: exact/substring match against known service keywords (most specific first),
// then a generic per-component-type fallback so every node always renders a real icon.

type IconMatch = { keywords: string[]; icon: string };

// Checked one at a time, in order -- first keyword match wins. Keep specific services
// before generic ones (e.g. "Aurora" before a bare "RDS").
const SERVICE_ICON_RULES: IconMatch[] = [
  // --- AWS ---
  { keywords: ["lambda"], icon: "logos:aws-lambda" },
  { keywords: ["fargate"], icon: "logos:aws-fargate" },
  { keywords: ["ec2"], icon: "logos:aws-ec2" },
  { keywords: ["eks"], icon: "logos:aws-eks" },
  { keywords: ["ecs"], icon: "logos:aws-ecs" },
  { keywords: ["aurora"], icon: "logos:aws-aurora" },
  { keywords: ["dynamodb"], icon: "logos:aws-dynamodb" },
  { keywords: ["documentdb"], icon: "logos:aws-documentdb" },
  { keywords: ["rds"], icon: "logos:aws-rds" },
  { keywords: ["s3"], icon: "logos:aws-s3" },
  { keywords: ["efs"], icon: "mdi:folder-network-outline" },
  { keywords: ["sqs"], icon: "logos:aws-sqs" },
  { keywords: ["msk", "kafka"], icon: "logos:kafka" },
  { keywords: ["cognito"], icon: "logos:aws-cognito" },
  { keywords: ["cloudfront"], icon: "logos:aws-cloudfront" },
  { keywords: ["global accelerator"], icon: "mdi:transit-connection-variant" },
  { keywords: ["elasticache", "dax"], icon: "logos:aws-elasticache" },
  { keywords: ["kms"], icon: "logos:aws-kms" },
  { keywords: ["cloudtrail"], icon: "logos:aws-cloudtrail" },
  { keywords: ["application load balancer", "alb"], icon: "mdi:scale-balance" },
  { keywords: ["api gateway", "api management"], icon: "mdi:api" },
  { keywords: ["route 53"], icon: "logos:aws-route53" },
  { keywords: ["healthlake"], icon: "mdi:hospital-box-outline" },
  { keywords: ["comprehend"], icon: "mdi:text-search" },
  { keywords: ["qldb"], icon: "mdi:book-lock-outline" },
  { keywords: ["glue"], icon: "mdi:broom" },

  // --- Azure --- (package only ships the generic Azure mark, no per-service icons)
  { keywords: ["cosmos db"], icon: "logos:microsoft-azure" },
  { keywords: ["azure"], icon: "logos:microsoft-azure" },
  { keywords: ["entra"], icon: "logos:microsoft-azure" },

  // --- GCP --- (per-service icons limited to functions/run in this package)
  { keywords: ["cloud functions"], icon: "logos:google-cloud-functions" },
  { keywords: ["cloud run"], icon: "logos:google-cloud-run" },
  { keywords: ["gke", "kubernetes engine"], icon: "logos:google-cloud" },
  { keywords: ["firestore", "bigtable", "spanner", "cloud sql", "pub/sub", "memorystore", "cloud tasks", "cloud storage", "filestore", "dlp api", "healthcare api", "cloud logging", "google cloud"], icon: "logos:google-cloud" },
  { keywords: ["firebase"], icon: "logos:firebase" },

  // --- Cross-cloud / generic technology (used by AWS, Azure, GCP, and self-hosted alike) ---
  { keywords: ["postgres"], icon: "logos:postgresql" },
  { keywords: ["mongodb", "documentdb (mongodb"], icon: "logos:mongodb" },
  { keywords: ["redis"], icon: "logos:redis" },
  { keywords: ["rabbitmq"], icon: "logos:rabbitmq" },
  { keywords: ["nats"], icon: "logos:nats-icon" },
  { keywords: ["nginx", "haproxy", "reverse proxy"], icon: "logos:nginx" },
  { keywords: ["vault", "hsm", "key management"], icon: "logos:vault-icon" },
  { keywords: ["keycloak"], icon: "mdi:key-chain-variant" },
  { keywords: ["auth0", "clerk", "oidc"], icon: "mdi:account-key-outline" },
  { keywords: ["presidio", "de-identif", "masking", "anonymiz"], icon: "mdi:eye-off-outline" },
  { keywords: ["siem", "wazuh", "audit"], icon: "mdi:clipboard-text-clock-outline" },
  { keywords: ["minio", "object storage", "san/nas", "nas gateway"], icon: "mdi:nas" },
  { keywords: ["helm", "statefulset", "deployment", "cronjob", "keda", "horizontalpodautoscaler", "hpa", "knative", "ingress-nginx", "cert-manager"], icon: "mdi:kubernetes" },
  { keywords: ["vmware", "vsphere"], icon: "logos:vmware" },
  { keywords: ["openstack", "nova"], icon: "logos:openstack-icon" },
  { keywords: ["oracle"], icon: "logos:oracle" },
  { keywords: ["bare-metal", "dedicated vm", "virtual machine", "vm pool", "compute pool"], icon: "mdi:server" },
  { keywords: ["externaldns"], icon: "mdi:dns-outline" },
  { keywords: ["application gateway", "load balancing", "load balancer"], icon: "mdi:scale-balance" },
  { keywords: ["dns"], icon: "mdi:dns-outline" },
];

const TYPE_FALLBACK_ICON: Record<string, string> = {
  cdn: "mdi:transit-connection-variant",
  compute: "mdi:function-variant",
  database: "mdi:database",
  storage: "mdi:archive-outline",
  queue: "mdi:tray-full",
  cache: "mdi:lightning-bolt-outline",
  auth: "mdi:account-key-outline",
  lb: "mdi:scale-balance",
  dns: "mdi:dns-outline",
  tokenization: "mdi:key-chain-variant",
  "audit-log": "mdi:clipboard-text-clock-outline",
  "phi-vault": "mdi:hospital-box-outline",
  deidentification: "mdi:eye-off-outline",
};

export function resolveServiceIcon(serviceName: string | undefined, componentType: string): string {
  const name = (serviceName || "").toLowerCase();
  for (const rule of SERVICE_ICON_RULES) {
    if (rule.keywords.some((kw) => name.includes(kw))) {
      return rule.icon;
    }
  }
  return TYPE_FALLBACK_ICON[componentType] || "mdi:cube-outline";
}
