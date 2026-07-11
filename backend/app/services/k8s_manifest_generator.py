"""Port of src/lib/k8s-manifest-generator.ts. Generates a map of filename -> YAML/Markdown file
content for a cloud-agnostic Kubernetes manifest set, driven by each component's
cloudMappings.kubernetes field. Components/connections/industryContext are plain dicts (LLD data,
not Pydantic models) -- see llm.py's docstring for why that convention is used throughout the
LLM-adjacent/HLD-adjacent parts of this codebase.

YAML is whitespace-sensitive, so every f-string below intentionally starts its content at column 0
(matching the unindented multi-line template literals in the original TS) rather than following the
surrounding Python indentation -- do not "clean up" the indentation of the string bodies.
"""

import re

STATEFUL_TYPES = ["database", "storage", "queue", "cache", "tokenization", "phi-vault"]

HELM_CHART_SERVICE_HINTS: dict[str, str] = {
    "cache": "bitnami/redis",
    "queue": "bitnami/rabbitmq",
    "auth": "bitnami/keycloak (or the Keycloak Operator)",
    "storage": "bitnami/minio",
    "tokenization": "hashicorp/vault",
}


def _get_k8s_mapping(c: dict) -> dict:
    mapping = (c.get("cloudMappings") or {}).get("kubernetes")
    if mapping:
        return mapping
    return {
        "serviceName": c.get("name"),
        "alternatives": [],
        "costEstimate": {"min": 0, "max": 0, "assumptions": ""},
        "lld": {"config": {}, "reasoning": {}},
    }


def _build_lld_comments(cfg: dict, reasoning: dict, keys: list[str]) -> str:
    lines = []
    for k in keys:
        # Mirrors TS `cfg[k] !== undefined`: a present (even empty-string) key counts.
        if k not in cfg or cfg[k] is None:
            continue
        v = cfg[k]
        r = reasoning.get(k)
        suffix = f" — {r}" if r else ""
        lines.append(f"    # {k}: {v}{suffix}")
    return "\n".join(lines)


def _parse_resource_string(value: str | None, fallback_cpu: str, fallback_mem: str) -> dict:
    if not value:
        return {"cpu": fallback_cpu, "memory": fallback_mem}
    parts = [s.strip().split(" ")[0] for s in value.split("/")]
    cpu = parts[0] if len(parts) > 0 else ""
    memory = parts[1] if len(parts) > 1 else ""
    return {"cpu": cpu or fallback_cpu, "memory": memory or fallback_mem}


def _first_int(value: str, fallback: str) -> str:
    match = re.search(r"\d+", value)
    return match.group(0) if match else fallback


def generate_kubernetes_manifests(
    project_name: str,
    components: list[dict],
    connections: list[dict],
    industry_context: dict | None = None,
) -> dict[str, str]:
    files: dict[str, str] = {}
    safe_name = re.sub(r"[^a-z0-9]", "-", project_name.lower())
    helm_components: list[dict] = []

    # ---- Namespaces ----
    # JS uses a Set, which iterates in insertion order -- Python sets do not preserve insertion
    # order, so an explicit ordered list (with a manual membership check) is used instead to match.
    namespaces: list[str] = []
    for c in components:
        lld = _get_k8s_mapping(c).get("lld") or {}
        ns_candidate = (lld.get("config") or {}).get("namespace")
        if ns_candidate and ns_candidate not in namespaces:
            namespaces.append(ns_candidate)
    if not namespaces:
        namespaces.append("app")

    files["k8s/00-namespaces.yaml"] = "---\n".join(
        f"""apiVersion: v1
kind: Namespace
metadata:
  name: {ns}
  labels:
    app.kubernetes.io/part-of: {safe_name}
"""
        for ns in namespaces
    )

    # ---- Per-component manifests ----
    for c in components:
        k8s = _get_k8s_mapping(c)
        lld = k8s.get("lld") or {}
        cfg: dict = lld.get("config") or {}
        reasoning: dict = lld.get("reasoning") or {}
        ns = cfg.get("namespace") or "app"
        cid = c.get("id")
        c_type = c.get("type")
        is_external = (cfg.get("deploymentMode") or "").startswith("External")

        if c_type == "compute" or c_type == "auth":
            is_worker = cid == "worker"
            replicas_raw = cfg.get("replicas") or "2"
            replicas_num = _first_int(replicas_raw, "2")
            resources = _parse_resource_string(cfg.get("resourceRequests"), "250m", "256Mi")
            limits = _parse_resource_string(cfg.get("resourceLimits"), "500m", "512Mi")

            files[f"k8s/{cid}-deployment.yaml"] = f"""# {k8s.get("serviceName")}
{_build_lld_comments(cfg, reasoning, ["replicas", "resourceRequests", "resourceLimits"])}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {safe_name}-{cid}
  namespace: {ns}
  labels:
    app: {cid}
spec:
  replicas: {replicas_num}
  selector:
    matchLabels:
      app: {cid}
  template:
    metadata:
      labels:
        app: {cid}
    spec:
      containers:
        - name: {cid}
          image: "your-registry/{safe_name}-{cid}:latest"
          resources:
            requests:
              cpu: "{resources["cpu"]}"
              memory: "{resources["memory"]}"
            limits:
              cpu: "{limits["cpu"]}"
              memory: "{limits["memory"]}"
          envFrom:
            - configMapRef:
                name: {safe_name}-app-config
"""

            if not is_worker and c_type == "compute":
                files[f"k8s/{cid}-service.yaml"] = f"""apiVersion: v1
kind: Service
metadata:
  name: {safe_name}-{cid}
  namespace: {ns}
spec:
  selector:
    app: {cid}
  ports:
    - port: 80
      targetPort: 8080
"""

                if cfg.get("hpaMinReplicas"):
                    hpa_min = _first_int(cfg["hpaMinReplicas"], "2")
                    hpa_max = _first_int(cfg.get("hpaMaxReplicas") or "6", "6")
                    hpa_target_cpu = cfg.get("hpaTargetCPU") or "70%"
                    files[f"k8s/{cid}-hpa.yaml"] = f"""# hpaTargetCPU: {hpa_target_cpu}
{_build_lld_comments(cfg, reasoning, ["hpaMinReplicas", "hpaMaxReplicas"])}
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: {safe_name}-{cid}
  namespace: {ns}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: {safe_name}-{cid}
  minReplicas: {hpa_min}
  maxReplicas: {hpa_max}
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: {hpa_target_cpu.replace("%", "")}
"""
            elif is_worker and cfg.get("kedaMinReplicas") is not None:
                keda_min = _first_int(cfg["kedaMinReplicas"], "0")
                keda_max = _first_int(cfg.get("kedaMaxReplicas") or "5", "5")
                keda_trigger_type = cfg.get("kedaTriggerType") or "queue depth"
                files[f"k8s/{cid}-scaledobject.yaml"] = f"""# KEDA event-driven autoscaling — {keda_trigger_type}
{_build_lld_comments(cfg, reasoning, ["kedaMinReplicas", "kedaMaxReplicas"])}
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: {safe_name}-{cid}
  namespace: {ns}
spec:
  scaleTargetRef:
    name: {safe_name}-{cid}
  minReplicaCount: {keda_min}
  maxReplicaCount: {keda_max}
  triggers:
    - type: rabbitmq
      metadata:
        queueName: {safe_name}-jobs
        mode: QueueLength
        value: "10"
"""
            elif c_type == "auth":
                files[f"k8s/{cid}-service.yaml"] = f"""apiVersion: v1
kind: Service
metadata:
  name: {safe_name}-{cid}
  namespace: {ns}
spec:
  selector:
    app: {cid}
  ports:
    - port: 8080
      targetPort: 8080
"""
                helm_components.append(
                    {
                        "name": cid,
                        "chart": HELM_CHART_SERVICE_HINTS["auth"],
                        "namespace": ns,
                        "values": {"replicaCount": replicas_num},
                    }
                )
        elif c_type == "cdn":
            ingress_ns = cfg.get("namespace") or "ingress-system"
            ingress_class = cfg.get("ingressClass") or "nginx"
            files["k8s/ingress.yaml"] = f"""# {k8s.get("serviceName")}
{_build_lld_comments(cfg, reasoning, ["ingressClass", "tlsMode", "replicas"])}
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {safe_name}-ingress
  namespace: {ingress_ns}
  annotations:
    kubernetes.io/ingress.class: "{ingress_class}"
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
spec:
  tls:
    - hosts:
        - "{safe_name}.example.com"
      secretName: {safe_name}-tls
  rules:
    - host: "{safe_name}.example.com"
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: {safe_name}-compute
                port:
                  number: 80
"""
        elif c_type == "audit-log":
            files["k8s/audit-log-daemonset.yaml"] = f"""# {k8s.get("serviceName")}
{_build_lld_comments(cfg, reasoning, ["deploymentMode"])}
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: {safe_name}-falco
  namespace: {ns}
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
          emptyDir: {{}}
---
# Fluentd sidecar ships /var/log/falco to an immutable object store bucket (MinIO or external).
# See helm-values-summary.yaml for the MinIO bucket configuration if self-hosted.
"""
        elif c_type == "deidentification":
            files["k8s/deidentification-cronjob.yaml"] = f"""# {k8s.get("serviceName")}
{_build_lld_comments(cfg, reasoning, ["deploymentMode"])}
apiVersion: batch/v1
kind: CronJob
metadata:
  name: {safe_name}-deidentification
  namespace: {ns}
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
"""
        elif c_type in STATEFUL_TYPES:
            if is_external:
                files[f"k8s/{cid}-external-service.yaml"] = f"""# {k8s.get("serviceName")}
{_build_lld_comments(cfg, reasoning, ["deploymentMode"])}
apiVersion: v1
kind: Service
metadata:
  name: {safe_name}-{cid}-external
  namespace: {ns}
spec:
  type: ExternalName
  externalName: "REPLACE-WITH-YOUR-MANAGED-DB-HOSTNAME"
---
apiVersion: v1
kind: Secret
metadata:
  name: {safe_name}-{cid}-credentials
  namespace: {ns}
type: Opaque
stringData:
  # Populate via your secrets manager / sealed-secrets before applying — placeholders only.
  username: "REPLACE_ME"
  password: "REPLACE_ME"
"""
            else:
                replicas = _first_int(cfg.get("replicas") or "1", "1")
                storage_size = cfg.get("storageSize") or "20Gi"
                storage_class = (cfg.get("storageClass") or "standard").split(" ")[0]

                files[f"k8s/{cid}-statefulset.yaml"] = f"""# {k8s.get("serviceName")}
{_build_lld_comments(cfg, reasoning, ["replicas", "storageSize", "storageClass", "networkPolicy"])}
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: {safe_name}-{cid}
  namespace: {ns}
spec:
  serviceName: {safe_name}-{cid}
  replicas: {replicas}
  selector:
    matchLabels:
      app: {cid}
  template:
    metadata:
      labels:
        app: {cid}
    spec:
      containers:
        - name: {cid}
          image: "your-registry/{cid}:latest"
          volumeMounts:
            - name: data
              mountPath: /data
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: {storage_class}
        resources:
          requests:
            storage: {storage_size}
---
apiVersion: v1
kind: Service
metadata:
  name: {safe_name}-{cid}
  namespace: {ns}
spec:
  clusterIP: None
  selector:
    app: {cid}
  ports:
    - port: 5432
"""

                if HELM_CHART_SERVICE_HINTS.get(c_type):
                    helm_components.append(
                        {
                            "name": cid,
                            "chart": HELM_CHART_SERVICE_HINTS[c_type],
                            "namespace": ns,
                            "values": {"replicaCount": replicas, "persistence.size": storage_size},
                        }
                    )

        # Best-effort NetworkPolicy translation from the LLD's free-text summary.
        if cfg.get("networkPolicy"):
            files[f"k8s/{cid}-networkpolicy.yaml"] = f"""# Translated from LLD summary: "{cfg["networkPolicy"]}"
# Review and adjust podSelector/namespaceSelector to match your actual label scheme.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: {safe_name}-{cid}-policy
  namespace: {ns}
spec:
  podSelector:
    matchLabels:
      app: {cid}
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - namespaceSelector: {{}}
  egress:
    - to:
        - namespaceSelector: {{}}
"""

    # ---- Shared app ConfigMap ----
    connections_lines = "\n".join(
        f'  {conn["from"]}_to_{conn["to"]}: "{safe_name}-{conn["to"]}.app.svc.cluster.local"' for conn in connections
    )
    files["k8s/app-configmap.yaml"] = f"""apiVersion: v1
kind: ConfigMap
metadata:
  name: {safe_name}-app-config
  namespace: app
data:
  # Populate with real service hostnames once the manifests above are applied —
  # these placeholders mirror the connections in the generated architecture diagram.
{connections_lines}
"""

    # ---- Helm values summary ----
    if helm_components:

        def _helm_item(h: dict) -> str:
            values_lines = "\n".join(f"# {k}: {v}" for k, v in h["values"].items())
            return f"""# ---- {h["name"]} (chart: {h["chart"]}) ----
# namespace: {h["namespace"]}
{values_lines}
"""

        helm_items_joined = "\n".join(_helm_item(h) for h in helm_components)
        files["helm-values-summary.yaml"] = f"""# Helm values summary for {project_name}
#
# This is NOT a replacement for running `helm install`/`helm template` — it documents the
# key values this architecture's LLD rules computed, so you can pass them via --set or a
# values file when installing each chart below.

{helm_items_joined}
"""

    # ---- README ----
    compliance_section = _build_k8s_compliance_section(industry_context, components)
    namespace_layout = "\n".join(f"*   `{ns}`" for ns in namespaces)
    files["README.md"] = f"""# Kubernetes Manifests for {project_name}

This manifest set was automatically synthesized by the **AI Cloud Architecture Generator**,
cloud-agnostic by design — deploy to EKS, GKE, AKS, or a self-hosted cluster (kubeadm, k3s, etc.)
by pointing `kubectl`/`helm` at whichever cluster you provision separately. Nothing here
provisions the cluster itself.

## File Structure
*   `k8s/00-namespaces.yaml`: Namespace layout (see below for why each exists).
*   `k8s/*-deployment.yaml` / `*-statefulset.yaml`: Workload definitions.
*   `k8s/*-hpa.yaml` / `*-scaledobject.yaml`: Autoscaling (HPA for request-driven compute, KEDA for queue-driven workers).
*   `k8s/*-service.yaml` / `*-external-service.yaml`: In-cluster networking, or a placeholder binding to an external managed service.
*   `k8s/*-networkpolicy.yaml`: Best-effort translated network segmentation — **review before applying**, label selectors are placeholders.
*   `k8s/ingress.yaml`: Cluster ingress + cert-manager TLS.
*   `k8s/app-configmap.yaml`: Shared application configuration.
*   `helm-values-summary.yaml`: Key values for the Helm charts this architecture calls for (Redis, RabbitMQ, Keycloak, MinIO, Vault) — install those charts yourself, this only documents the sizing.

## Namespace Layout
{namespace_layout}

Namespaces are split so that RBAC and NetworkPolicy can scope access per concern (e.g. a
dedicated `data-phi` namespace for PHI keeps that compliance boundary enforceable
independently of the general `data` namespace).
{compliance_section}
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
2. Install cluster-level dependencies referenced above: cert-manager, KEDA (if any worker uses it), and any Helm charts listed in `helm-values-summary.yaml`.
3. Apply namespaces first:
   ```bash
   kubectl apply -f k8s/00-namespaces.yaml
   ```
4. Populate real secrets (replace every `REPLACE_ME` / `REPLACE-WITH-...` placeholder).
5. Apply the rest:
   ```bash
   kubectl apply -f k8s/
   ```
"""

    return files


def _build_k8s_compliance_section(industry_context: dict | None, components: list[dict]) -> str:
    if not industry_context or industry_context.get("industry") == "none":
        return ""

    compliance_types = ("tokenization", "audit-log", "phi-vault", "deidentification")
    compliance_components = [c for c in components if c.get("type") in compliance_types]
    lines = "\n".join(
        f"*   **{c.get('name')}** → `{_get_k8s_mapping(c).get('serviceName')}`: {c.get('reasoning') or c.get('description') or ''}"
        for c in compliance_components
    )

    standard = "PCI-DSS" if industry_context.get("industry") == "fintech" else "HIPAA"
    rationale = industry_context.get("rationale")
    rationale_suffix = f" ({rationale})" if rationale else ""

    return f"""
---

> [!IMPORTANT]
> ## Compliance: {standard} (Kubernetes-native controls)

This project was flagged as **{industry_context.get("industry")}**{rationale_suffix}. The compliance components below were mapped to Kubernetes-native equivalents rather than reusing managed-cloud service names, since none of the underlying services exist inside a cluster:

{lines or "*   No dedicated compliance components were added."}

**Still your responsibility, same as any other provider:** a signed BAA (healthtech) or a completed PCI-DSS SAQ/QSA audit (fintech) — this manifest set only addresses infrastructure controls, and self-hosting these components on Kubernetes shifts *more* operational burden onto your team than a managed cloud service would, not less.
"""
