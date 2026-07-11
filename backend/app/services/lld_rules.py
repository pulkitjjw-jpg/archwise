def run_lld_rules_engine(
    provider: str,
    component_type: str,
    component_id: str,
    requirements: dict,
    # When a user manually swaps a component to a specific alternative service (see
    # ArchitectureWorkspace's service-swap editor), the requirements alone no longer determine
    # which LLD shape applies (e.g. serverless vs container config keys) since the requirements
    # haven't changed, only the chosen service has. This lets the caller force the correct
    # branch based on the service name the user actually picked.
    service_name_override: str | None = None,
    # Layers compliance-mandated config on top of the scale/budget-driven baseline below -- see
    # the block right before the return statement. Optional and additive: omitting it (the
    # default for every pre-Phase-4 call site) reproduces the exact prior behavior.
    industry_context: dict | None = None,
) -> dict:
    nfr = requirements["nonFunctional"]
    scale_lower = nfr["expectedScale"].lower()
    budget_lower = nfr["budget"].lower()
    team_lower = nfr["teamMaturity"].lower()
    compliance_lower = nfr["compliance"].lower()

    is_high_scale = (
        "high" in scale_lower
        or "million" in scale_lower
        or "100,000" in scale_lower
        or "10k" in scale_lower
        or "50k" in scale_lower
    )

    is_low_budget = (
        "low" in budget_lower or "50" in budget_lower or "30" in budget_lower or "tight" in budget_lower
    )

    is_high_security = (
        "gdpr" in compliance_lower
        or "hipaa" in compliance_lower
        or "pci" in compliance_lower
        or "secure" in compliance_lower
        or "audit" in compliance_lower
        or "encrypt" in compliance_lower
    )

    # Kubernetes and private cloud have fundamentally different LLD shapes (pod resource
    # requests/HPA/namespaces vs. instance sizes; VM sizing vs. managed-service config) -- they
    # get their own dedicated rule functions below rather than being squeezed into the
    # aws/azure/gcp branch that follows.
    if provider == "kubernetes":
        return _run_kubernetes_lld(
            component_type, component_id, is_high_scale, is_low_budget, team_lower, is_high_security, industry_context
        )
    if provider == "private":
        return _run_private_cloud_lld(component_type, component_id, is_high_scale, is_high_security, industry_context)

    config: dict[str, str] = {}
    reasoning: dict[str, str] = {}

    if component_type == "cdn":
        config["priceClass"] = "PriceClass_All" if is_high_scale else "PriceClass_100"
        config["ipv6Enabled"] = "true"
        config["originShield"] = "Enabled" if is_high_scale else "Disabled"
        config["sslProtocols"] = "TLSv1.2_or_Newer"

        reasoning["priceClass"] = (
            "Enabled edge locations globally to support high volume distribution."
            if is_high_scale
            else "Restricted price class to US/Europe edge locations to minimize cost."
        )
        reasoning["originShield"] = (
            "Enabled Origin Shield to protect backend servers from high-frequency cache misses."
            if is_high_scale
            else "Disabled Origin Shield as scale is moderate, avoiding extra gateway pricing."
        )

    elif component_type == "compute":
        is_worker = component_id == "worker"
        is_serverless = is_low_budget and (
            "junior" in team_lower or "small" in team_lower or team_lower == "not_specified"
        )

        if service_name_override:
            svc_lower = service_name_override.lower()
            if "lambda" in svc_lower or "function" in svc_lower:
                is_serverless = True
            elif (
                "fargate" in svc_lower
                or "container app" in svc_lower
                or "ecs" in svc_lower
                or "cloud run" in svc_lower
                or "kubernetes" in svc_lower
                or "vm" in svc_lower
                or "app service" in svc_lower
                or "compute engine" in svc_lower
            ):
                is_serverless = False

        if is_serverless and not is_worker:
            config["memory"] = "1024MB" if is_high_scale else "512MB"
            config["timeout"] = "30s"
            config["concurrency"] = "100" if is_high_scale else "10"
            config["scalingPolicy"] = "Automatic pay-per-request concurrency scaling."

            reasoning["memory"] = (
                "Allocated 1GB RAM to support swift cold starts under high scale demand."
                if is_high_scale
                else "Allocated 512MB memory to stay within tight free-tier/budget scopes."
            )
            reasoning["timeout"] = "Standard 30s timeout configured for standard API processing."
        else:
            config["instanceSize"] = "0.5 vCPU + 1GB RAM" if is_high_scale else "0.25 vCPU + 0.5 GB RAM"
            config["minInstances"] = "2" if is_high_scale else "1"
            config["maxInstances"] = "10" if is_high_scale else "3"
            config["scalingPolicy"] = (
                "Target tracking scaling policy on CPU utilisation (>70%)."
                if is_high_scale
                else "Simple scaling target on memory utilisation (>80%)."
            )

            reasoning["minInstances"] = (
                "Configured min 2 instances to maintain multi-zone high availability."
                if is_high_scale
                else "Configured min 1 instance to satisfy tight budget goals."
            )
            reasoning["instanceSize"] = (
                "Allocated medium container profile (0.5 vCPU) for stable API concurrency."
                if is_high_scale
                else "Allocated minimum container profile to reduce idle billing."
            )

        # Networking details nested under compute
        config["vpcSubnet"] = "Private App Subnets"
        config["securityGroups"] = "Allows HTTPS ingress from CDN, outbound access to DB/Storage."
        reasoning["vpcSubnet"] = "Isolated compute components from the public internet for security."

    elif component_type == "database":
        is_relational = (
            "relational" in nfr["dataNature"].lower()
            or "sql" in nfr["dataNature"].lower()
            or "invoice" in nfr["dataNature"].lower()
        )

        if service_name_override:
            svc_lower = service_name_override.lower()
            if (
                "dynamo" in svc_lower
                or "cosmos" in svc_lower
                or "firestore" in svc_lower
                or "bigtable" in svc_lower
                or "documentdb" in svc_lower
            ):
                is_relational = False
            elif (
                "sql" in svc_lower
                or "rds" in svc_lower
                or "aurora" in svc_lower
                or "postgres" in svc_lower
                or "spanner" in svc_lower
            ):
                is_relational = True

        if is_relational:
            if is_high_scale:
                config["instanceClass"] = (
                    "db.m6g.xlarge" if provider == "aws" else "Standard_D4ds_v5" if provider == "azure" else "db-custom-4-15360"
                )
            else:
                config["instanceClass"] = (
                    "db.t4g.micro" if provider == "aws" else "Standard_B1ms" if provider == "azure" else "db-f1-micro"
                )
            config["storageSize"] = "100GB GP3" if is_high_scale else "20GB GP3"
            config["multiAZ"] = "true (Primary/Standby)" if (is_high_scale or is_high_security) else "false (Single Node)"
            config["backupRetention"] = "30 Days" if is_high_security else "7 Days"
            config["connectionLimit"] = "500" if is_high_scale else "100"

            reasoning["instanceClass"] = (
                "Provisioned high performance dedicated cores to handle complex transactional scale."
                if is_high_scale
                else "Provisioned burstable cores to keep postgres hosting affordable."
            )
            reasoning["multiAZ"] = (
                "Configured database failover replica across availability zones to prevent data loss."
                if (is_high_scale or is_high_security)
                else "Disabled multi-AZ replication to minimize instance count costs."
            )
        else:
            config["readCapacityUnits"] = "1000 (Auto-Scale)" if is_high_scale else "On-Demand"
            config["writeCapacityUnits"] = "500 (Auto-Scale)" if is_high_scale else "On-Demand"
            config["encryptionType"] = "AWS KMS Managed Encryption"
            config["globalTables"] = "Enabled" if is_high_scale else "Disabled"

            reasoning["readCapacityUnits"] = (
                "Auto-scaled RCU to guarantee low latency database reads under peak traffic."
                if is_high_scale
                else "On-Demand billing is preferred to eliminate idle capacity costs."
            )

        config["vpcSubnet"] = "Private Database Subnets"
        config["securityGroups"] = "Allows port 5432 ingress strictly from App Compute components."
        reasoning["vpcSubnet"] = "Placed database in isolated subnets behind active security group rules."

    elif component_type == "storage":
        config["bucketStructure"] = "Single namespace bucket with folder partition."
        config["encryptionAlgorithm"] = "AES-256 (Server-Side Encryption)"
        config["lifecycleRule"] = "Transition to Glacier Deep Archive after 90 days." if is_high_scale else "none"
        config["versioningEnabled"] = "true" if is_high_security else "false"

        reasoning["lifecycleRule"] = (
            "Enabled auto-archiving policy to offload old file storage costs."
            if is_high_scale
            else "No lifecycle rules configured to keep implementation simple."
        )
        reasoning["versioningEnabled"] = (
            "Enabled bucket versioning to secure audit logs and prevent deletion mistakes."
            if is_high_security
            else "Disabled versioning to save space costs."
        )

    elif component_type == "queue":
        config["queueType"] = "FIFO (Strict Ordering)" if is_high_security else "Standard"
        config["visibilityTimeoutSec"] = "900s (15 Mins)"
        config["retentionDays"] = "4 Days"
        config["maxMessageSizeKB"] = "256KB"

        reasoning["queueType"] = (
            "Chose FIFO queue to ensure transaction logs are processed in exact linear order."
            if is_high_security
            else "Chose Standard queue for high throughput buffer support."
        )
        reasoning["visibilityTimeoutSec"] = "Set visibility timeout to match background worker task limits."

    elif component_type == "cache":
        if is_high_scale:
            config["nodeType"] = (
                "cache.t4g.medium" if provider == "aws" else "Basic C1" if provider == "azure" else "m1-redis-medium"
            )
        else:
            config["nodeType"] = (
                "cache.t4g.micro" if provider == "aws" else "Basic C0" if provider == "azure" else "m1-redis-micro"
            )
        config["clusteringEnabled"] = "true" if is_high_scale else "false"
        config["evictionPolicy"] = "volatile-lru"

        reasoning["nodeType"] = (
            "Provisioned medium cache node to hold high volumes of active user sessions."
            if is_high_scale
            else "Chose smallest burstable memory cache node to fit constraints."
        )

    elif component_type == "auth":
        config["tokenValidityHours"] = "24h"
        config["mfaRequired"] = "true" if is_high_security else "false"
        config["selfSignUpEnabled"] = "true"
        config["passwordStrength"] = "8+ characters, requires symbols/caps."

        reasoning["mfaRequired"] = (
            "Enforced multi-factor authentication (MFA) to satisfy compliance guidelines."
            if is_high_security
            else "Disabled mandatory MFA to ease user onboard friction."
        )

    elif component_type == "tokenization":
        config["encryptionStandard"] = "FIPS 140-2 Level 3 (HSM-backed)"
        config["tokenFormat"] = "Format-Preserving Encryption (FPE)"
        config["pciScope"] = "Isolated CDE — reduces PCI-DSS scope for connected systems"
        config["rawDataLogging"] = "Disabled"

        reasoning["encryptionStandard"] = (
            "HSM-backed key storage is required to keep cryptographic material for cardholder data out of reach of application-layer compromise."
        )
        reasoning["rawDataLogging"] = (
            "PCI-DSS explicitly prohibits logging full PAN (Primary Account Number) data in application or debug logs."
        )

    elif component_type == "audit-log":
        config["retentionPeriod"] = "7 Years (regulatory)" if is_high_security else "3 Years"
        config["immutability"] = "Enabled (WORM / Object Lock)"
        config["accessControl"] = "Write-only for application roles, read-only for auditors"

        reasoning["immutability"] = (
            "Audit trails must be tamper-evident — write-once storage prevents after-the-fact edits to covers unauthorized access."
        )
        reasoning["retentionPeriod"] = (
            "Extended retention aligns with stricter regulatory record-keeping expectations."
            if is_high_security
            else "Standard multi-year retention to support incident investigation and periodic compliance review."
        )

    elif component_type == "phi-vault":
        config["encryptionAtRest"] = "AES-256 (Customer-Managed KMS Key)"
        config["accessLogging"] = "Enabled — every read/write logged with authenticated user identity"
        config["baaRequired"] = "true (Business Associate Agreement with cloud provider required)"
        config["networkIsolation"] = "Private subnet, no direct internet route"

        reasoning["encryptionAtRest"] = (
            "HIPAA's Security Rule requires PHI to be encrypted at rest using keys the covered entity controls, not just provider-managed defaults."
        )
        reasoning["baaRequired"] = (
            "Any cloud provider processing PHI on your behalf must sign a Business Associate Agreement (BAA) before this component can legally hold real patient data."
        )

    elif component_type == "deidentification":
        config["method"] = "Safe Harbor De-identification (18 HIPAA identifiers removed)"
        config["triggerMode"] = "Batch (nightly) — not real-time inline"

        reasoning["method"] = (
            "Safe Harbor is the more auditable of HIPAA's two de-identification standards and doesn't require a statistician's expert determination."
        )

    else:
        config["genericType"] = "Generic Config"
        reasoning["genericType"] = "Standard deployment config."

    # Compliance-mandated config additions, layered on top of whatever the scale/budget-driven
    # rules above already decided. These are ADDED keys, never overrides of the existing scale
    # logic, so a generic (industry_context None/"none") call is byte-for-byte unaffected.
    if industry_context and industry_context["industry"] != "none":
        standard = "PCI-DSS" if industry_context["industry"] == "fintech" else "HIPAA"

        if component_type in ("database", "storage", "cache"):
            config["encryptionInTransit"] = "TLS 1.2+ (Enforced)"
            reasoning["encryptionInTransit"] = (
                f"Mandatory for {standard} compliance — encryption in transit is not optional for regulated data, regardless of scale."
            )

        if component_type == "database" and industry_context["industry"] == "fintech":
            config["multiAZ"] = "true (Primary/Standby)"
            reasoning["multiAZ"] = (
                "Forced to enabled for PCI-DSS compliance — regulated payment workloads require high availability regardless of stated scale."
            )

    return {"config": config, "reasoning": reasoning}


def _run_kubernetes_lld(
    component_type: str,
    component_id: str,
    is_high_scale: bool,
    is_low_budget: bool,
    team_lower: str,
    is_high_security: bool,
    industry_context: dict | None = None,
) -> dict:
    is_low_ops_capacity = (
        is_low_budget or "junior" in team_lower or "small" in team_lower or team_lower == "not_specified"
    )

    config: dict[str, str] = {}
    reasoning: dict[str, str] = {}

    if component_type == "cdn":
        config["ingressClass"] = "nginx"
        config["tlsMode"] = "cert-manager (Let's Encrypt)"
        config["replicas"] = "2"
        config["namespace"] = "ingress-system"
        reasoning["replicas"] = "Two Ingress-NGINX replicas avoid a single point of failure for all cluster traffic entry."
        reasoning["tlsMode"] = "cert-manager automates certificate issuance and renewal rather than requiring manual cert rotation."

    elif component_type == "compute":
        is_worker = component_id == "worker"
        if is_worker:
            config["replicas"] = "2"
            config["resourceRequests"] = "250m CPU / 256Mi Memory"
            config["resourceLimits"] = "500m CPU / 512Mi Memory"
            config["kedaMinReplicas"] = "0"
            config["kedaMaxReplicas"] = "15" if is_high_scale else "5"
            config["kedaTriggerType"] = "Queue depth (RabbitMQ/NATS)"
            config["namespace"] = "app"

            reasoning["kedaMinReplicas"] = "Scaling to zero when the queue is empty avoids paying for idle worker capacity."
            reasoning["kedaMaxReplicas"] = (
                "Higher ceiling to absorb large batch/reconciliation spikes at scale."
                if is_high_scale
                else "Modest ceiling appropriate for lower expected background job volume."
            )
        else:
            config["replicas"] = "4" if is_high_scale else "2"
            config["resourceRequests"] = "500m CPU / 512Mi Memory" if is_high_scale else "250m CPU / 256Mi Memory"
            config["resourceLimits"] = "1000m CPU / 1Gi Memory" if is_high_scale else "500m CPU / 512Mi Memory"
            config["hpaMinReplicas"] = "4" if is_high_scale else "2"
            config["hpaMaxReplicas"] = "20" if is_high_scale else "6"
            config["hpaTargetCPU"] = "70%"
            config["namespace"] = "app"
            config["networkPolicy"] = "Allow ingress from ingress-nginx namespace only; allow egress to data namespace only"

            reasoning["hpaMinReplicas"] = (
                "Minimum 4 replicas spread across nodes for multi-zone-equivalent availability under high scale."
                if is_high_scale
                else "Minimum 2 replicas is the smallest count that still tolerates a single pod eviction without downtime."
            )
            reasoning["networkPolicy"] = (
                "Default-deny network policy scoped to only the traffic paths this component actually needs, limiting lateral movement if a pod is compromised."
            )

    elif component_type == "database":
        if is_low_ops_capacity:
            config["deploymentMode"] = "External (ExternalName Service + Secret)"
            config["namespace"] = "data"
            reasoning["deploymentMode"] = (
                "Given the team's low operational maturity/tight budget, the database runs outside the cluster on a managed service — self-managing a stateful database's failover, backups, and patching on Kubernetes is a significant ops burden this avoids."
            )
        else:
            config["replicas"] = "3 (Primary + 2 Replicas)" if is_high_scale else "1 (Single Instance)"
            config["storageSize"] = "100Gi" if is_high_scale else "20Gi"
            config["storageClass"] = "ssd-retain (Retain reclaim policy)"
            config["resourceRequests"] = "1000m CPU / 2Gi Memory" if is_high_scale else "500m CPU / 1Gi Memory"
            config["namespace"] = "data"
            config["networkPolicy"] = "Allow ingress from app namespace only; deny all else"

            reasoning["storageClass"] = (
                "A Retain reclaim policy prevents the underlying volume from being deleted if the StatefulSet or PVC is accidentally removed — data loss protection for a self-managed database."
            )
            reasoning["replicas"] = (
                "Primary plus two read replicas for both read scaling and failover capacity."
                if is_high_scale
                else "Single instance keeps operational surface minimal; acceptable only because ops capacity was assessed as adequate to handle its own failover."
            )

    elif component_type == "storage":
        config["replicas"] = "4 (Distributed Mode)" if is_high_scale else "1 (Standalone)"
        config["storageSize"] = "500Gi" if is_high_scale else "100Gi"
        config["namespace"] = "data"
        reasoning["replicas"] = (
            "MinIO distributed mode (4+ nodes) provides erasure coding for durability at this scale."
            if is_high_scale
            else "Standalone MinIO is sufficient for lower storage volumes, at the cost of no built-in redundancy."
        )

    elif component_type == "queue":
        config["replicas"] = "3 (Clustered)"
        config["storageSize"] = "50Gi" if is_high_scale else "10Gi"
        config["namespace"] = "data"
        reasoning["replicas"] = "A 3-node cluster is the minimum for RabbitMQ quorum queues to survive a single node failure."

    elif component_type == "cache":
        config["replicas"] = "3 (Cluster Mode)" if is_high_scale else "1 (Standalone)"
        config["namespace"] = "data"
        reasoning["replicas"] = (
            "Redis Cluster mode shards data across nodes to handle higher throughput."
            if is_high_scale
            else "Standalone Redis is sufficient for lower cache volumes; a node failure means a cold cache, not data loss, since this is a cache."
        )

    elif component_type == "auth":
        config["replicas"] = "2"
        config["namespace"] = "identity"
        reasoning["replicas"] = "Two replicas avoid identity/login becoming a single point of failure for the whole application."

    elif component_type == "tokenization":
        config["replicas"] = "3 (Vault Raft HA)"
        config["namespace"] = "security"
        config["networkPolicy"] = "Only the app namespace may reach Vault; no direct external ingress permitted"
        reasoning["replicas"] = "Vault's Raft integrated storage needs an odd number of nodes (3 minimum) to maintain quorum during a node failure."
        reasoning["networkPolicy"] = "Narrowing which namespaces can reach the tokenization boundary is itself a PCI-DSS-relevant network segmentation control."

    elif component_type == "audit-log":
        config["deploymentMode"] = "DaemonSet (Falco — one pod per node)"
        config["namespace"] = "monitoring"
        reasoning["deploymentMode"] = "Falco must run on every node as a DaemonSet to observe syscall-level activity across the whole cluster, not just within one namespace."

    elif component_type == "phi-vault":
        config["storageClass"] = "encrypted-retain"
        config["namespace"] = "data-phi"
        config["networkPolicy"] = "Only the app namespace may reach phi-vault; deny all else"
        reasoning["namespace"] = "A dedicated namespace (separate from the general 'data' namespace) keeps the HIPAA compliance boundary enforceable via namespace-scoped RBAC and network policy."
        reasoning["storageClass"] = "An encrypted StorageClass with a Retain policy ensures PHI is encrypted at the volume level and cannot be silently deleted by a PVC/StatefulSet mistake."

    elif component_type == "deidentification":
        config["deploymentMode"] = "CronJob (nightly)"
        config["namespace"] = "data"
        reasoning["deploymentMode"] = "Runs as a scheduled batch job against new PHI records rather than an always-on Deployment, since de-identification doesn't need to be real-time."

    else:
        config["genericType"] = "Generic in-cluster workload"
        config["namespace"] = "app"
        reasoning["genericType"] = "Standard deployment config."

    if industry_context and industry_context["industry"] != "none":
        standard = "PCI-DSS" if industry_context["industry"] == "fintech" else "HIPAA"
        if component_type in ("database", "storage", "cache", "queue"):
            config["mtls"] = "Enabled (service mesh or cert-manager-issued pod certs)"
            reasoning["mtls"] = (
                f"Mandatory for {standard} compliance — encryption in transit between pods is not optional for regulated data, regardless of scale."
            )

    return {"config": config, "reasoning": reasoning}


def _run_private_cloud_lld(
    component_type: str,
    component_id: str,
    is_high_scale: bool,
    is_high_security: bool,
    industry_context: dict | None = None,
) -> dict:
    config: dict[str, str] = {}
    reasoning: dict[str, str] = {}

    if component_type == "cdn":
        config["vmSize"] = "2 vCPU / 4GB RAM"
        config["scalingMode"] = "Manual (no autoscaler)"
        reasoning["scalingMode"] = "No CDN edge network on-premises — traffic capacity is whatever the reverse-proxy VM(s) can handle, sized ahead of time."

    elif component_type == "compute":
        is_worker = component_id == "worker"
        config["vmSize"] = "8 vCPU / 16GB RAM" if is_high_scale else "4 vCPU / 8GB RAM"
        if is_worker:
            config["vmCount"] = "3" if is_high_scale else "2"
        else:
            config["vmCount"] = "4" if is_high_scale else "2"
        config["scalingMode"] = "Manual (no autoscaler) — capacity must be pre-provisioned for peak load"
        reasoning["scalingMode"] = "Private infrastructure has no elastic capacity pool — under-provisioning means dropped requests at peak, not an autoscale event."

    elif component_type == "database":
        config["vmSize"] = "16 vCPU / 64GB RAM" if is_high_scale else "8 vCPU / 32GB RAM"
        config["storageSize"] = "1TB (SAN-backed)" if is_high_scale else "200GB (SAN-backed)"
        config["haMode"] = "Manual failover (no managed failover available)"
        reasoning["haMode"] = "On-premises database HA requires manually configured streaming replication and a documented, tested failover runbook — nothing here does this automatically."

    elif component_type == "storage":
        config["storageAllocation"] = "5TB" if is_high_scale else "1TB"
        config["replicationMode"] = "Manual (backup job to secondary array or off-site)"

    elif component_type == "queue":
        config["vmCount"] = "1 (no managed HA)"
        config["opsFlag"] = "No managed queue on-premises — requires dedicated ops capacity for clustering, HA, and upgrades"
        reasoning["opsFlag"] = "Flagging explicitly: a managed cloud queue absorbs clustering/HA/patching automatically, this does not."

    elif component_type == "cache":
        config["vmSize"] = "4 vCPU / 8GB RAM"
        config["haMode"] = "Manual failover"

    elif component_type == "auth":
        config["vmCount"] = "1-2 (manual load balancing)"

    elif component_type == "tokenization":
        config["vmCount"] = "3 (manual HA cluster)"
        config["hsmRecommended"] = (
            "true — dedicated HSM appliance recommended at this compliance level"
            if is_high_security
            else "false — software-based key storage acceptable"
        )

    elif component_type == "audit-log":
        config["storageMode"] = "WORM-capable storage array required for true immutability"
        reasoning["storageMode"] = "Standard on-prem storage can be overwritten by anyone with array access — immutability requires a storage array or archive tier that explicitly supports write-once semantics."

    elif component_type == "phi-vault":
        config["encryptionMode"] = "Manual key management (HSM appliance recommended)"
        config["baaFlag"] = "A Business Associate Agreement is still required from any third party hosting/maintaining this hardware"

    elif component_type == "deidentification":
        config["vmSize"] = "4 vCPU / 8GB RAM"
        config["schedulingMode"] = "Scheduled batch job (cron)"

    else:
        config["genericType"] = "Generic on-premises component"

    if industry_context and industry_context["industry"] != "none":
        standard = "PCI-DSS" if industry_context["industry"] == "fintech" else "HIPAA"
        if component_type in ("database", "storage", "cache", "queue"):
            config["networkSegmentation"] = "Dedicated VLAN, firewalled from general corporate network"
            reasoning["networkSegmentation"] = (
                f"Mandatory for {standard} compliance — regulated data stores must be network-isolated from the general corporate network, not just access-controlled."
            )

    return {"config": config, "reasoning": reasoning}
