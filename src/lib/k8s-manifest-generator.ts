export type K8sManifestFileSet = Record<string, string>;

type IndustryContextForExport = {
  industry: "fintech" | "healthtech" | "none";
  rationale?: string;
  flags?: {
    handlesCardDataDirectly?: boolean;
    storesPHI?: boolean;
    dataResidency?: string;
  };
} | null | undefined;

const STATEFUL_TYPES = ["database", "storage", "queue", "cache", "tokenization", "phi-vault"];
const HELM_CHART_SERVICE_HINTS: Record<string, string> = {
  cache: "bitnami/redis",
  queue: "bitnami/rabbitmq",
  auth: "bitnami/keycloak (or the Keycloak Operator)",
  storage: "bitnami/minio",
  tokenization: "hashicorp/vault",
};

function getK8sMapping(c: any) {
  return c.cloudMappings?.kubernetes || { serviceName: c.name, alternatives: [], costEstimate: { min: 0, max: 0, assumptions: "" }, lld: { config: {}, reasoning: {} } };
}

function buildLldComments(cfg: Record<string, string>, reasoning: Record<string, string>, keys: string[]): string {
  return keys
    .filter((k) => cfg[k] !== undefined)
    .map((k) => `    # ${k}: ${cfg[k]}${reasoning[k] ? ` — ${reasoning[k]}` : ""}`)
    .join("\n");
}

function parseResourceString(value: string | undefined, fallbackCpu: string, fallbackMem: string): { cpu: string; memory: string } {
  if (!value) return { cpu: fallbackCpu, memory: fallbackMem };
  const [cpu, memory] = value.split("/").map((s) => s.trim().split(" ")[0]);
  return { cpu: cpu || fallbackCpu, memory: memory || fallbackMem };
}

export function generateKubernetesManifests(
  projectName: string,
  components: any[],
  connections: any[],
  industryContext?: IndustryContextForExport
): K8sManifestFileSet {
  const files: K8sManifestFileSet = {};
  const safeName = projectName.toLowerCase().replace(/[^a-z0-9]/g, "-");
  const helmComponents: Array<{ name: string; chart: string; namespace: string; values: Record<string, string> }> = [];

  // ---- Namespaces ----
  const namespaces = new Set<string>();
  components.forEach((c) => {
    const ns = getK8sMapping(c).lld?.config?.namespace;
    if (ns) namespaces.add(ns);
  });
  if (namespaces.size === 0) namespaces.add("app");

  files["k8s/00-namespaces.yaml"] = [...namespaces]
    .map(
      (ns) => `apiVersion: v1
kind: Namespace
metadata:
  name: ${ns}
  labels:
    app.kubernetes.io/part-of: ${safeName}
`
    )
    .join("---\n");

  // ---- Per-component manifests ----
  components.forEach((c) => {
    const k8s = getK8sMapping(c);
    const cfg: Record<string, string> = k8s.lld?.config || {};
    const reasoning: Record<string, string> = k8s.lld?.reasoning || {};
    const ns = cfg.namespace || "app";
    const id = c.id;
    const isExternal = (cfg.deploymentMode || "").startsWith("External");

    if (c.type === "compute" || c.type === "auth") {
      const isWorker = id === "worker";
      const replicas = cfg.replicas || "2";
      const resources = parseResourceString(cfg.resourceRequests, "250m", "256Mi");
      const limits = parseResourceString(cfg.resourceLimits, "500m", "512Mi");

      files[`k8s/${id}-deployment.yaml`] = `# ${k8s.serviceName}
${buildLldComments(cfg, reasoning, ["replicas", "resourceRequests", "resourceLimits"])}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${safeName}-${id}
  namespace: ${ns}
  labels:
    app: ${id}
spec:
  replicas: ${replicas.match(/\d+/)?.[0] || "2"}
  selector:
    matchLabels:
      app: ${id}
  template:
    metadata:
      labels:
        app: ${id}
    spec:
      containers:
        - name: ${id}
          image: "your-registry/${safeName}-${id}:latest"
          resources:
            requests:
              cpu: "${resources.cpu}"
              memory: "${resources.memory}"
            limits:
              cpu: "${limits.cpu}"
              memory: "${limits.memory}"
          envFrom:
            - configMapRef:
                name: ${safeName}-app-config
`;

      if (!isWorker && c.type === "compute") {
        files[`k8s/${id}-service.yaml`] = `apiVersion: v1
kind: Service
metadata:
  name: ${safeName}-${id}
  namespace: ${ns}
spec:
  selector:
    app: ${id}
  ports:
    - port: 80
      targetPort: 8080
`;

        if (cfg.hpaMinReplicas) {
          files[`k8s/${id}-hpa.yaml`] = `# hpaTargetCPU: ${cfg.hpaTargetCPU || "70%"}
${buildLldComments(cfg, reasoning, ["hpaMinReplicas", "hpaMaxReplicas"])}
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: ${safeName}-${id}
  namespace: ${ns}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: ${safeName}-${id}
  minReplicas: ${cfg.hpaMinReplicas.match(/\d+/)?.[0] || "2"}
  maxReplicas: ${(cfg.hpaMaxReplicas || "6").match(/\d+/)?.[0] || "6"}
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: ${(cfg.hpaTargetCPU || "70%").replace("%", "")}
`;
        }
      } else if (isWorker && cfg.kedaMinReplicas !== undefined) {
        files[`k8s/${id}-scaledobject.yaml`] = `# KEDA event-driven autoscaling — ${cfg.kedaTriggerType || "queue depth"}
${buildLldComments(cfg, reasoning, ["kedaMinReplicas", "kedaMaxReplicas"])}
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: ${safeName}-${id}
  namespace: ${ns}
spec:
  scaleTargetRef:
    name: ${safeName}-${id}
  minReplicaCount: ${cfg.kedaMinReplicas.match(/\d+/)?.[0] || "0"}
  maxReplicaCount: ${(cfg.kedaMaxReplicas || "5").match(/\d+/)?.[0] || "5"}
  triggers:
    - type: rabbitmq
      metadata:
        queueName: ${safeName}-jobs
        mode: QueueLength
        value: "10"
`;
      } else if (c.type === "auth") {
        files[`k8s/${id}-service.yaml`] = `apiVersion: v1
kind: Service
metadata:
  name: ${safeName}-${id}
  namespace: ${ns}
spec:
  selector:
    app: ${id}
  ports:
    - port: 8080
      targetPort: 8080
`;
        helmComponents.push({ name: id, chart: HELM_CHART_SERVICE_HINTS.auth, namespace: ns, values: { "replicaCount": (cfg.replicas || "2").match(/\d+/)?.[0] || "2" } });
      }
    } else if (c.type === "cdn") {
      files["k8s/ingress.yaml"] = `# ${k8s.serviceName}
${buildLldComments(cfg, reasoning, ["ingressClass", "tlsMode", "replicas"])}
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${safeName}-ingress
  namespace: ${cfg.namespace || "ingress-system"}
  annotations:
    kubernetes.io/ingress.class: "${cfg.ingressClass || "nginx"}"
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
spec:
  tls:
    - hosts:
        - "${safeName}.example.com"
      secretName: ${safeName}-tls
  rules:
    - host: "${safeName}.example.com"
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: ${safeName}-compute
                port:
                  number: 80
`;
    } else if (c.type === "audit-log") {
      files["k8s/audit-log-daemonset.yaml"] = `# ${k8s.serviceName}
${buildLldComments(cfg, reasoning, ["deploymentMode"])}
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: ${safeName}-falco
  namespace: ${ns}
spec:
  selector:
    matchLabels:
      app: falco
  template:
    metadata:
      labels:
        app: falco
    spec:
      hostNetwork: true
      hostPID: true
      containers:
        - name: falco
          image: "falcosecurity/falco:latest"
          securityContext:
            privileged: true
          volumeMounts:
            - name: audit-sink
              mountPath: /var/log/falco
      volumes:
        - name: audit-sink
          emptyDir: {}
---
# Fluentd sidecar ships /var/log/falco to an immutable object store bucket (MinIO or external).
# See helm-values-summary.yaml for the MinIO bucket configuration if self-hosted.
`;
    } else if (c.type === "deidentification") {
      files["k8s/deidentification-cronjob.yaml"] = `# ${k8s.serviceName}
${buildLldComments(cfg, reasoning, ["deploymentMode"])}
apiVersion: batch/v1
kind: CronJob
metadata:
  name: ${safeName}-deidentification
  namespace: ${ns}
spec:
  schedule: "0 2 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: presidio-batch
              image: "mcr.microsoft.com/presidio-analyzer:latest"
              command: ["python", "run_deidentification_batch.py"]
`;
    } else if (STATEFUL_TYPES.includes(c.type)) {
      if (isExternal) {
        files[`k8s/${id}-external-service.yaml`] = `# ${k8s.serviceName}
${buildLldComments(cfg, reasoning, ["deploymentMode"])}
apiVersion: v1
kind: Service
metadata:
  name: ${safeName}-${id}-external
  namespace: ${ns}
spec:
  type: ExternalName
  externalName: "REPLACE-WITH-YOUR-MANAGED-DB-HOSTNAME"
---
apiVersion: v1
kind: Secret
metadata:
  name: ${safeName}-${id}-credentials
  namespace: ${ns}
type: Opaque
stringData:
  # Populate via your secrets manager / sealed-secrets before applying — placeholders only.
  username: "REPLACE_ME"
  password: "REPLACE_ME"
`;
      } else {
        const replicas = (cfg.replicas || "1").match(/\d+/)?.[0] || "1";
        const storageSize = cfg.storageSize || "20Gi";
        const storageClass = (cfg.storageClass || "standard").split(" ")[0];

        files[`k8s/${id}-statefulset.yaml`] = `# ${k8s.serviceName}
${buildLldComments(cfg, reasoning, ["replicas", "storageSize", "storageClass", "networkPolicy"])}
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: ${safeName}-${id}
  namespace: ${ns}
spec:
  serviceName: ${safeName}-${id}
  replicas: ${replicas}
  selector:
    matchLabels:
      app: ${id}
  template:
    metadata:
      labels:
        app: ${id}
    spec:
      containers:
        - name: ${id}
          image: "your-registry/${id}:latest"
          volumeMounts:
            - name: data
              mountPath: /data
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: ${storageClass}
        resources:
          requests:
            storage: ${storageSize}
---
apiVersion: v1
kind: Service
metadata:
  name: ${safeName}-${id}
  namespace: ${ns}
spec:
  clusterIP: None
  selector:
    app: ${id}
  ports:
    - port: 5432
`;

        if (HELM_CHART_SERVICE_HINTS[c.type]) {
          helmComponents.push({
            name: id,
            chart: HELM_CHART_SERVICE_HINTS[c.type],
            namespace: ns,
            values: { replicaCount: replicas, "persistence.size": storageSize },
          });
        }
      }
    }

    // Best-effort NetworkPolicy translation from the LLD's free-text summary.
    if (cfg.networkPolicy) {
      files[`k8s/${id}-networkpolicy.yaml`] = `# Translated from LLD summary: "${cfg.networkPolicy}"
# Review and adjust podSelector/namespaceSelector to match your actual label scheme.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${safeName}-${id}-policy
  namespace: ${ns}
spec:
  podSelector:
    matchLabels:
      app: ${id}
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - namespaceSelector: {}
  egress:
    - to:
        - namespaceSelector: {}
`;
    }
  });

  // ---- Shared app ConfigMap ----
  files["k8s/app-configmap.yaml"] = `apiVersion: v1
kind: ConfigMap
metadata:
  name: ${safeName}-app-config
  namespace: app
data:
  # Populate with real service hostnames once the manifests above are applied —
  # these placeholders mirror the connections in the generated architecture diagram.
${connections.map((conn: any) => `  ${conn.from}_to_${conn.to}: "${safeName}-${conn.to}.${"app"}.svc.cluster.local"`).join("\n")}
`;

  // ---- Helm values summary ----
  if (helmComponents.length > 0) {
    files["helm-values-summary.yaml"] = `# Helm values summary for ${projectName}
#
# This is NOT a replacement for running \`helm install\`/\`helm template\` — it documents the
# key values this architecture's LLD rules computed, so you can pass them via --set or a
# values file when installing each chart below.

${helmComponents
  .map(
    (h) => `# ---- ${h.name} (chart: ${h.chart}) ----
# namespace: ${h.namespace}
${Object.entries(h.values)
  .map(([k, v]) => `# ${k}: ${v}`)
  .join("\n")}
`
  )
  .join("\n")}
`;
  }

  // ---- README ----
  const complianceSection = buildK8sComplianceSection(industryContext, components);
  files["README.md"] = `# Kubernetes Manifests for ${projectName}

This manifest set was automatically synthesized by the **AI Cloud Architecture Generator**,
cloud-agnostic by design — deploy to EKS, GKE, AKS, or a self-hosted cluster (kubeadm, k3s, etc.)
by pointing \`kubectl\`/\`helm\` at whichever cluster you provision separately. Nothing here
provisions the cluster itself.

## File Structure
*   \`k8s/00-namespaces.yaml\`: Namespace layout (see below for why each exists).
*   \`k8s/*-deployment.yaml\` / \`*-statefulset.yaml\`: Workload definitions.
*   \`k8s/*-hpa.yaml\` / \`*-scaledobject.yaml\`: Autoscaling (HPA for request-driven compute, KEDA for queue-driven workers).
*   \`k8s/*-service.yaml\` / \`*-external-service.yaml\`: In-cluster networking, or a placeholder binding to an external managed service.
*   \`k8s/*-networkpolicy.yaml\`: Best-effort translated network segmentation — **review before applying**, label selectors are placeholders.
*   \`k8s/ingress.yaml\`: Cluster ingress + cert-manager TLS.
*   \`k8s/app-configmap.yaml\`: Shared application configuration.
*   \`helm-values-summary.yaml\`: Key values for the Helm charts this architecture calls for (Redis, RabbitMQ, Keycloak, MinIO, Vault) — install those charts yourself, this only documents the sizing.

## Namespace Layout
${[...namespaces].map((ns) => `*   \`${ns}\``).join("\n")}

Namespaces are split so that RBAC and NetworkPolicy can scope access per concern (e.g. a
dedicated \`data-phi\` namespace for PHI keeps that compliance boundary enforceable
independently of the general \`data\` namespace).
${complianceSection}
---

> [!WARNING]
> ## Deployment Disclaimer
> This is a starting point, not a production-ready manifest set. You MUST review resource
> requests/limits, network policies, image references (all are placeholders pointing at
> "your-registry"), and secret management (Secrets here are empty placeholders — use
> Sealed Secrets, External Secrets Operator, or your cluster's secret manager) before
> applying any of this to a real cluster.

## Deployment Steps
1. Provision a cluster (EKS/GKE/AKS/self-hosted) — not automated by this manifest set.
2. Install cluster-level dependencies referenced above: cert-manager, KEDA (if any worker uses it), and any Helm charts listed in \`helm-values-summary.yaml\`.
3. Apply namespaces first:
   \`\`\`bash
   kubectl apply -f k8s/00-namespaces.yaml
   \`\`\`
4. Populate real secrets (replace every \`REPLACE_ME\` / \`REPLACE-WITH-...\` placeholder).
5. Apply the rest:
   \`\`\`bash
   kubectl apply -f k8s/
   \`\`\`
`;

  return files;
}

function buildK8sComplianceSection(industryContext: IndustryContextForExport, components: any[]): string {
  if (!industryContext || industryContext.industry === "none") return "";

  const complianceComponents = components.filter((c) =>
    ["tokenization", "audit-log", "phi-vault", "deidentification"].includes(c.type)
  );
  const lines = complianceComponents
    .map((c) => {
      const k8s = getK8sMapping(c);
      return `*   **${c.name}** → \`${k8s.serviceName}\`: ${c.reasoning || c.description || ""}`;
    })
    .join("\n");

  const standard = industryContext.industry === "fintech" ? "PCI-DSS" : "HIPAA";

  return `
---

> [!IMPORTANT]
> ## Compliance: ${standard} (Kubernetes-native controls)

This project was flagged as **${industryContext.industry}**${industryContext.rationale ? ` (${industryContext.rationale})` : ""}. The compliance components below were mapped to Kubernetes-native equivalents rather than reusing managed-cloud service names, since none of the underlying services exist inside a cluster:

${lines || "*   No dedicated compliance components were added."}

**Still your responsibility, same as any other provider:** a signed BAA (healthtech) or a completed PCI-DSS SAQ/QSA audit (fintech) — this manifest set only addresses infrastructure controls, and self-hosting these components on Kubernetes shifts *more* operational burden onto your team than a managed cloud service would, not less.
`;
}
