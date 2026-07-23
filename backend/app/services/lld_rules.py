from app.services.nfr_signals import determine_account_strategy as _determine_account_strategy
from app.services.nfr_signals import determine_dr_strategy as _determine_dr_strategy
from app.services.nfr_signals import is_budget_tight as _is_budget_tight
from app.services.nfr_signals import is_high_scale as _is_high_scale

# Secondary-region defaults per provider, keyed to whatever primary region terraform_generator.py
# itself defaults to (aws_region "us-east-1", location "East US", gcp_region "us-central1") -- LLD
# config here is descriptive text, not a Terraform variable, so a fixed sensible pair per provider
# is the right level of detail (a real deployment picks its own regions; this documents the pattern).
_DR_SECONDARY_REGION = {
    "aws": "us-west-2",
    "azure": "West US",
    "gcp": "us-east1",
}

# Provider-specific phrasing for a warm-standby database's cross-region replication mechanism --
# real service names per cloud, not generic filler (see the task's own AWS/Azure/GCP examples).
_DR_WARM_STANDBY_DB_REPLICATION = {
    "aws": "Aurora Global Database (or equivalent) with sub-second cross-region replication, automatic failover capable",
    "azure": "Azure SQL/Cosmos DB geo-replication with automatic failover capable",
    "gcp": "Cloud SQL cross-region replica with automatic failover capable",
}
_DR_PILOT_LIGHT_DB_REPLICATION = "Cross-region read replica, promoted manually on failover"

# AWS/Azure/GCP rule-set label per provider -- shared by the "lb" and "cdn" branches below since a
# WAF is a property of whichever edge component fronts the public internet, not a first-class
# component of its own (see rules_engine.py's comments near the "lb"/"dns" additions for the
# identical reasoning already applied to NAT Gateway/IGW -- a hollow third node here would be
# diagram clutter, not signal).
_WAF_RULE_SET_BY_PROVIDER = {
    "aws": "AWS Managed Rules - Core Rule Set + SQL Injection Rule Set",
    "azure": "Azure-managed Default Rule Set (DRS)",
    "gcp": "Google Cloud Armor - OWASP Top 10 preconfigured rules",
}

# Phase 7 (multi-account environment separation) -- provider-specific phrasing for the actual
# "account"-equivalent concept each cloud uses, and the actual cross-account/cross-subscription/
# cross-project access mechanism a CI/CD pipeline would use to deploy into any one of them. Real
# service names/mechanisms per cloud, not generic filler -- same precedent as
# _DR_WARM_STANDBY_DB_REPLICATION above.
_ACCOUNT_STRUCTURE_BY_PROVIDER = {
    "aws": "Separate AWS accounts per environment (dev/staging/prod)",
    "azure": "Separate Azure subscriptions per environment (dev/staging/prod)",
    "gcp": "Separate GCP projects per environment (dev/staging/prod)",
}
_CROSS_ACCOUNT_ACCESS_PATTERN_BY_PROVIDER = {
    "aws": "Cross-account IAM role assumption (sts:AssumeRole) from a central CI/CD identity into a per-account TerraformDeployRole",
    "azure": "A dedicated service principal per subscription, granted Contributor (or narrower) access, authenticated by the central CI/CD pipeline",
    "gcp": "A project-scoped service account per GCP project, impersonated by the central CI/CD pipeline via short-lived credentials",
}


def _waf_lld_config(provider: str, is_high_scale: bool, is_high_security: bool, industry_context: dict | None) -> tuple[dict, dict]:
    """Shared helper for the "lb" and "cdn" branches (aws/azure/gcp only) -- returns the config/
    reasoning key-value pairs to merge in for the wafEnabled decision. Enabled when the workload is
    high-scale (worth the marginal per-request inspection cost), high-security/compliance-flagged,
    or the project is fintech/healthtech, where a WAF in front of the public edge is close to a
    baseline expectation rather than optional hardening. Otherwise disabled, with reasoning framed
    as a reasonable cost-saving choice at this scale/sensitivity, not a security gap."""
    industry = (industry_context or {}).get("industry", "none")
    should_enable = is_high_scale or is_high_security or industry in ("fintech", "healthtech")

    config: dict[str, str] = {"wafEnabled": "true" if should_enable else "false"}
    reasoning: dict[str, str] = {}

    if should_enable:
        config["wafRuleSet"] = _WAF_RULE_SET_BY_PROVIDER.get(provider, "Provider-managed OWASP Top 10 rule set")
        config["rateLimitPerIP"] = "2000 requests / 5 min"

        reasons = []
        if is_high_scale:
            reasons.append(
                "the workload is high-scale, where a WAF's marginal per-request inspection cost is worth it to absorb "
                "a larger volume of malicious/bot traffic"
            )
        if is_high_security:
            reasons.append(
                "the project's compliance/security posture calls for defense-in-depth at the edge, not just "
                "application-layer controls"
            )
        if industry in ("fintech", "healthtech"):
            reasons.append(
                f"the project is flagged as {industry}, where a WAF in front of the public edge is close to a "
                "baseline expectation rather than optional hardening"
            )
        reasoning["wafEnabled"] = "Enabled because " + "; and ".join(reasons) + "."
    else:
        reasoning["wafEnabled"] = (
            "Disabled -- at this scale and sensitivity, the added cost and operational overhead (rule tuning, "
            "false-positive management) of a WAF is a reasonable trade-off to skip for now, not a security gap. "
            "Revisit if scale or compliance requirements change."
        )

    return config, reasoning


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
    team_lower = nfr["teamMaturity"].lower()
    compliance_lower = nfr["compliance"].lower()

    is_high_scale = _is_high_scale(nfr["expectedScale"])
    is_low_budget = _is_budget_tight(nfr["budget"])

    is_high_security = (
        "gdpr" in compliance_lower
        or "hipaa" in compliance_lower
        or "pci" in compliance_lower
        or "secure" in compliance_lower
        or "audit" in compliance_lower
        or "encrypt" in compliance_lower
    )

    # Multi-region DR strategy (Phase 5) -- computed once via the shared nfr_signals signal (never
    # reimplemented locally) and used only in the aws/azure/gcp branch below. Deliberately NOT
    # threaded into _run_kubernetes_lld/_run_private_cloud_lld -- the specific cloud-managed DR
    # mechanisms this phase models (Aurora Global Database, Route 53 failover routing, etc.) don't
    # have a natural Kubernetes/on-prem equivalent worth modeling at this scope, matching the WAF
    # precedent (kubernetes/private get a brief note, not full config, for that same reason).
    dr_strategy = _determine_dr_strategy(nfr, industry_context)

    # Multi-account environment separation (Phase 7) -- computed once via the shared nfr_signals
    # signal, same "recompute locally from nfr/industry_context, don't thread as an extra
    # parameter" pattern dr_strategy above already uses. Unlike dr_strategy, this signal has no
    # cost dimension (deploying the SAME config independently into N accounts doesn't change any
    # single environment's own resource sizing/cost the way standing DR capacity does), so it's
    # deliberately NOT threaded into cloud_mapping.py or architecture_generation.py the way
    # dr_strategy is -- it only ever needs to reach the "compute" branch below and, from there,
    # terraform_generator.py (which reads it back off compute's own LLD config, mirroring
    # _get_dr_strategy's "read off the database component" pattern for the "compute" component
    # instead). Only used in the aws/azure/gcp branch that follows -- kubernetes has no native
    # "cloud account" equivalent (namespaces/clusters are a different concept) and private cloud
    # has no account concept at all, matching the WAF/DR precedent of skipping both there.
    account_strategy = _determine_account_strategy(nfr, industry_context)

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

    if component_type == "realtime":
        config["connectionModel"] = "Persistent bidirectional (WebSocket)"
        config["idleTimeoutSec"] = "600s (10 min)"
        config["maxConcurrentConnections"] = "10000" if is_high_scale else "1000"
        config["messageBroadcastMode"] = "Fan-out via managed pub/sub backplane"

        reasoning["maxConcurrentConnections"] = (
            "Sized for a high-traffic real-time workload with many simultaneous open connections."
            if is_high_scale
            else "Modest connection ceiling appropriate for lower expected concurrent real-time usage."
        )
        reasoning["messageBroadcastMode"] = (
            "A managed pub/sub backplane is required once there's more than one server instance, so a message sent to one connection can still reach clients connected to a different instance."
        )

    elif component_type == "cdn":
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

        waf_config, waf_reasoning = _waf_lld_config(provider, is_high_scale, is_high_security, industry_context)
        config.update(waf_config)
        reasoning.update(waf_reasoning)

    elif component_type == "lb":
        # Same is_serverless recompute as the "compute" branch below -- a service_name_override
        # (manual service-swap) or the deterministic scale/budget/team signal both need to agree
        # on whether this "lb" resolves to an ALB-style load balancer (container compute) or an
        # API-gateway-style managed gateway (serverless compute), since the two have genuinely
        # different config shapes.
        is_serverless = is_low_budget and (
            "junior" in team_lower or "small" in team_lower or team_lower == "not_specified"
        )
        if service_name_override:
            svc_lower = service_name_override.lower()
            if "api gateway" in svc_lower or "api management" in svc_lower:
                is_serverless = True
            elif "load balanc" in svc_lower or "application gateway" in svc_lower or svc_lower == "alb":
                is_serverless = False

        if is_serverless:
            config["gatewayType"] = "HTTP API (Regional)"
            config["throttlingBurstLimit"] = "5000" if is_high_scale else "1000"
            config["throttlingRateLimit"] = "2000" if is_high_scale else "500"
            config["corsPolicy"] = "Restricted to configured origin(s), not wildcard"
            config["tlsPolicy"] = "TLS 1.2+"

            reasoning["throttlingBurstLimit"] = (
                "A higher burst ceiling absorbs legitimate traffic spikes without rejecting real requests at high expected scale."
                if is_high_scale
                else "A modest burst ceiling is appropriate for lower expected traffic, and doubles as a cheap first line of defense against a runaway client retry loop."
            )
            reasoning["corsPolicy"] = (
                "A wildcard CORS policy on a public API gateway is a common source of unintended cross-origin access -- restricting to known origins up front is the safer default."
            )
            reasoning["tlsPolicy"] = "The managed gateway terminates TLS itself, so this is the one place a minimum protocol version needs to be enforced for the whole public API surface."
        else:
            config["healthCheckPath"] = "/health"
            config["healthCheckIntervalSec"] = "15" if is_high_scale else "30"
            config["healthCheckTimeoutSec"] = "5"
            config["healthyThresholdCount"] = "2"
            config["unhealthyThresholdCount"] = "3" if is_high_scale else "5"
            config["idleTimeoutSec"] = "60"
            config["listenerProtocol"] = "HTTPS"
            config["listenerPort"] = "443"
            config["tlsPolicy"] = "TLS 1.2+ (Modern Security Policy)"

            reasoning["healthCheckIntervalSec"] = (
                "More frequent health checks pull a failing instance out of rotation faster at high scale, where a slow instance affects more concurrent users."
                if is_high_scale
                else "A standard interval is sufficient at lower scale, and avoids piling unnecessary health-check traffic onto each instance."
            )
            reasoning["unhealthyThresholdCount"] = (
                "A lower unhealthy threshold removes a failing instance from rotation faster, trading a slightly higher chance of a false-positive removal for reduced blast radius at high scale."
                if is_high_scale
                else "A higher threshold avoids flapping a healthy-but-momentarily-slow instance in and out of rotation on a single transient failure."
            )
            reasoning["listenerProtocol"] = (
                "TLS terminates at the load balancer rather than on individual compute instances, so the certificate is issued, rotated, and audited in exactly one place."
            )

        waf_config, waf_reasoning = _waf_lld_config(provider, is_high_scale, is_high_security, industry_context)
        config.update(waf_config)
        reasoning.update(waf_reasoning)

    elif component_type == "dns":
        config["hostedZoneType"] = "Public"
        config["recordType"] = "Alias record to the load balancer/CDN endpoint (not a raw CNAME/IP)"
        config["routingPolicy"] = "Simple"
        config["ttlSeconds"] = "300"

        reasoning["recordType"] = (
            "An alias-style record points directly at the managed load balancer/CDN endpoint without pinning to an IP address that provider can change at any time."
        )
        reasoning["routingPolicy"] = (
            "Simple routing is correct today because there's only one region/endpoint to route traffic to. This is the exact field a future multi-region failover setup would change (e.g. to failover or latency-based routing) -- the mechanism exists here, but that behavior isn't configured yet."
        )
        reasoning["ttlSeconds"] = "A short TTL keeps DNS propagation fast if the target ever needs to change, at the cost of a modest increase in DNS query volume."

        # Phase 5: this is the exact field the comment above was pointing at -- now actually
        # configured once a DR tier is active.
        if dr_strategy != "none":
            config["routingPolicy"] = (
                "Failover (Active-Passive)"
                if dr_strategy == "pilot-light"
                else "Latency-based routing with health-check failover"
            )
            config["secondaryRegion"] = _DR_SECONDARY_REGION.get(provider, "secondary region")
            config["failoverThreshold"] = "3 consecutive health-check failures (~90s to detect)"

            reasoning["routingPolicy"] = (
                (
                    "Active-passive failover routing: all traffic goes to the primary region until its health check "
                    "fails, then DNS shifts traffic to the pilot-light secondary -- the secondary sits mostly idle "
                    "until failover, matching pilot-light's minimal-standing-cost design."
                )
                if dr_strategy == "pilot-light"
                else (
                    "Latency-based routing with health-check failover: traffic is already routed to whichever region "
                    "answers fastest, and a failed health check removes the primary from rotation automatically -- "
                    "appropriate once the secondary region runs real standing capacity (warm-standby), not just a "
                    "cold failover target."
                )
            )
            reasoning["secondaryRegion"] = (
                f"A different region ({config['secondaryRegion']}) than the primary keeps a regional outage (power, "
                "network, or provider-side failure) from taking down both the primary and its failover target at once."
            )
            reasoning["failoverThreshold"] = (
                "A few consecutive failures (not a single blip) avoids triggering a costly/disruptive regional "
                "failover on a single transient health-check miss, while still failing over fast enough to matter."
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
                else "Configured min 1 instance -- standard-scale traffic doesn't yet justify the redundancy overhead of a second always-on instance."
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

        # Phase 5: warm-standby ONLY -- pilot-light's whole point is minimal/no standing compute in
        # the secondary region, so it deliberately gets nothing here.
        if dr_strategy == "warm-standby":
            config["standbyCapacity"] = "1 instance running in secondary region, scales to match primary on failover"
            reasoning["standbyCapacity"] = (
                "Warm-standby keeps a small but real fleet running in the secondary region so failover is a scale-up, "
                "not a cold start from zero -- the defining difference from pilot-light, which keeps no standing "
                "compute at all."
            )

        # Phase 7 (multi-account environment separation) -- modeled as LLD config on this "compute"
        # component (every real architecture has at least one, same reasoning this file already
        # applies to "monitoring fires whenever compute exists") rather than a new top-level HLD
        # concept. Absent entirely for single-account (the default for every pre-Phase-7 call
        # site), never set to "false" -- matching how dr_strategy's own keys are only added once a
        # tier is active rather than always-present-with-a-negative-value.
        if account_strategy == "multi-account":
            config["accountSeparation"] = "true"
            config["accountStructure"] = _ACCOUNT_STRUCTURE_BY_PROVIDER.get(
                provider, "Separate cloud accounts per environment (dev/staging/prod)"
            )
            config["crossAccountAccessPattern"] = _CROSS_ACCOUNT_ACCESS_PATTERN_BY_PROVIDER.get(
                provider, "Per-environment identity assumed by a central CI/CD pipeline"
            )

            reasoning["accountSeparation"] = (
                "Separate accounts per environment give each environment its own hard blast-radius boundary -- a "
                "misconfigured IAM policy, a runaway resource, or a compromised credential in dev/staging cannot "
                "reach prod at all, not just 'shouldn't.' Billing and IAM are also cleanly separated per "
                "environment. The real cost is operational: N accounts means N sets of credentials, N places a "
                "security patch or quota increase has to be applied, and a genuinely more complex CI/CD identity "
                "story than a single shared account -- worth it once a team is large/mature enough to actually "
                "operate that overhead, not a default for a small team."
            )
            reasoning["accountStructure"] = (
                "The same reusable Terraform configuration is deployed independently into each environment's own "
                "account/subscription/project by swapping variables (see environments/*.tfvars) -- this is "
                "deliberately NOT the same pattern as multi-region DR, which needs two regions live "
                "simultaneously in one apply/state. Dev/staging/prod are never live in the same state at once."
            )
            reasoning["crossAccountAccessPattern"] = (
                "A single central CI/CD identity that can assume a scoped role/identity into whichever "
                "environment's account it's deploying to is the standard way to avoid maintaining N separate "
                "long-lived credential sets, one per environment, in the pipeline itself."
            )

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

        # Phase 5: DR enrichment applies uniformly regardless of relational/non-relational shape --
        # both kinds of managed database have a real cross-region replication story on every
        # provider modeled here.
        if dr_strategy != "none":
            config["drStrategy"] = dr_strategy
            config["secondaryRegion"] = _DR_SECONDARY_REGION.get(provider, "secondary region")
            config["crossRegionReplication"] = (
                _DR_PILOT_LIGHT_DB_REPLICATION
                if dr_strategy == "pilot-light"
                else _DR_WARM_STANDBY_DB_REPLICATION.get(provider, _DR_WARM_STANDBY_DB_REPLICATION["aws"])
            )
            reasoning["drStrategy"] = (
                (
                    "Pilot-light: a cross-region replica exists and stays warm, but is only promoted to primary on an "
                    "actual failover -- minimal standing cost, at the price of a manual promotion step and some "
                    "recovery-time lag."
                )
                if dr_strategy == "pilot-light"
                else (
                    "Warm-standby: the secondary region already runs a real, continuously-replicated database "
                    "instance capable of automatic failover -- higher standing cost than pilot-light, but "
                    "recovery time drops from a manual promotion to near-automatic."
                )
            )
            reasoning["crossRegionReplication"] = (
                "The specific managed cross-region replication mechanism this database's provider offers for the "
                f"chosen DR tier ({dr_strategy})."
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

        # Phase 5: cheap and easy to always include once ANY DR tier is active -- unlike database/
        # compute, cross-region object replication carries no meaningful standing-capacity cost
        # difference between pilot-light and warm-standby, so both tiers get the same config.
        if dr_strategy != "none":
            config["crossRegionReplication"] = "Enabled, versioned bucket replicated to secondary region"
            # Cross-region replication is a real AWS/Azure/GCP requirement that the SOURCE bucket
            # carry versioning -- forced true here (overriding the is_high_security-only default
            # above) rather than silently declaring a replication config the storage provider would
            # reject.
            config["versioningEnabled"] = "true"
            reasoning["crossRegionReplication"] = (
                "Object storage replication is inexpensive relative to database/compute standby capacity, so it's "
                "enabled for both DR tiers once any disaster-recovery posture is active -- requires bucket "
                "versioning (see versioningEnabled above) as a prerequisite."
            )
            reasoning["versioningEnabled"] = (
                "Forced to enabled once cross-region replication is active -- versioning on the source bucket is a "
                "hard prerequisite for bucket replication on every major cloud provider, not just a nice-to-have."
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

    elif component_type == "monitoring":
        config["logRetentionDays"] = "365 (regulatory)" if is_high_security else "30"
        config["alertingPhilosophy"] = (
            "Alert on symptoms (error rate, latency, saturation), not causes -- paging on every CPU blip creates alert fatigue that buries the alert that actually matters."
        )
        config["tracingEnabled"] = "true"
        config["tracingSampleRate"] = "5% (sampled)" if is_high_scale else "100% (full trace)"
        config["metricNamespace"] = "app/production"

        reasoning["logRetentionDays"] = (
            "Extended retention aligns with regulatory record-keeping expectations for compliance-sensitive workloads."
            if is_high_security
            else "30 days is enough to debug most incidents while keeping storage costs down; extend it if a compliance requirement says otherwise."
        )
        reasoning["tracingSampleRate"] = (
            "Tracing every single request at high request volume gets expensive fast, both in storage and in the "
            "tracing backend's own ingestion cost -- a 5% sample still surfaces the same latency/error patterns "
            "statistically, at a fraction of the cost."
            if is_high_scale
            else "Traffic is low enough that tracing every request is still cheap, and full fidelity makes debugging any single request trivial."
        )
        reasoning["alertingPhilosophy"] = "A small number of high-signal alerts that actually get acted on beats a large number that get muted."

    elif component_type == "notification":
        func_str = " ".join(requirements.get("functional", [])).lower()
        channels: list[str] = []
        if "sms" in func_str or "text message" in func_str:
            channels.append("SMS")
        if "push notification" in func_str or "push" in func_str:
            channels.append("Push")
        if "email" in func_str:
            channels.append("Email")
        inferred = bool(channels)
        if not channels:
            channels = ["Email"]

        config["deliveryChannels"] = ", ".join(channels)
        config["retryPolicy"] = "3 attempts, exponential backoff (1m / 5m / 15m)"
        config["deadLetterHandling"] = (
            "Failed deliveries after the final retry route to a dead-letter queue, retained 14 days for manual inspection/replay"
        )

        reasoning["deliveryChannels"] = (
            "Inferred directly from the stated functional requirements' mention of these channels."
            if inferred
            else "Defaulted to email -- the stated functional requirements didn't call out a specific channel (SMS/push); confirm this matches the actual product need."
        )
        reasoning["retryPolicy"] = "A few retries with backoff absorb a transient provider hiccup without hammering the delivery provider over a permanent failure."
        reasoning["deadLetterHandling"] = (
            "A notification that fails every retry needs to land somewhere reviewable -- a silent failure here is exactly the kind of gap a user only discovers when someone complains they never got the email."
        )

    elif component_type == "search":
        config["indexCount"] = "Multiple indices, sharded by entity type (products, orders, etc.)" if is_high_scale else "Single index, default sharding"
        config["shardCount"] = "5 primary shards + 1 replica each" if is_high_scale else "1 primary shard + 1 replica"
        config["instanceSize"] = "3x r6g.large.search (dedicated master + data nodes)" if is_high_scale else "1x t3.small.search (single node)"

        industry = (industry_context or {}).get("industry", "none")
        needs_pii_redaction = is_high_security or industry in ("fintech", "healthtech")
        config["piiRedactionRequired"] = "true" if needs_pii_redaction else "false"

        reasoning["shardCount"] = (
            "More shards spread indexing/query load across nodes at high volume, at the cost of more per-shard overhead."
            if is_high_scale
            else "A single shard is enough at this volume and avoids the per-shard overhead of an over-sharded small index."
        )
        reasoning["instanceSize"] = (
            "A dedicated master node keeps cluster-state management off the data nodes once query/index volume is high enough to matter."
            if is_high_scale
            else "A single node is sufficient at this volume; add dedicated master nodes if the index grows."
        )
        reasoning["piiRedactionRequired"] = (
            "Search results surface indexed field values verbatim, so if any indexed content includes PII/PHI (e.g. "
            "user-generated reviews, support tickets), the ingestion pipeline feeding this index must redact it before "
            "indexing -- a genuinely different compliance boundary than the primary database, which has its own "
            "access controls this index doesn't inherit."
            if needs_pii_redaction
            else "No regulated/sensitive-data signal detected for this project -- revisit if indexed content later includes PII (e.g. user-generated content)."
        )

    elif component_type == "analytics":
        config["scalingMode"] = (
            "On-demand serverless (compute scales to zero between queries)" if is_low_budget else "Provisioned (reserved capacity for sustained, predictable query load)"
        )
        config["partitionStrategy"] = "Partitioned by ingestion date (daily), enabling partition pruning on time-range queries"
        config["retentionPolicy"] = "Indefinite (regulatory/analytical history retained)" if is_high_security else "2 years, then archived to cold storage"
        config["etlSyncFrequency"] = "Near-real-time change data capture (CDC) from the primary database" if is_high_scale else "Nightly batch ETL from the primary database"

        reasoning["scalingMode"] = (
            "On-demand serverless avoids paying for standing compute capacity on a tight budget, at the cost of less predictable per-query latency than a provisioned warehouse."
            if is_low_budget
            else "Provisioned capacity gives predictable query latency for a sustained reporting workload, at the cost of paying for it whether or not queries are actually running."
        )
        reasoning["etlSyncFrequency"] = (
            "At this scale, a nightly batch lag is too stale for the reporting/analytics use case -- CDC keeps the warehouse close to real-time."
            if is_high_scale
            else "A nightly batch sync is simple to operate and matches most reporting use cases' actual freshness requirements at this scale."
        )
        reasoning["retentionPolicy"] = (
            "Extended retention aligns with regulatory record-keeping expectations for compliance-sensitive workloads."
            if is_high_security
            else "A multi-year window balances useful trend analysis against unbounded storage growth."
        )

    elif component_type == "ml":
        config["instanceType"] = "GPU-backed (e.g. ml.g5.xlarge)" if is_high_scale else "CPU-backed (e.g. ml.m5.large)"
        config["autoScaling"] = "Target-tracking on InvocationsPerInstance, 2-10 instances" if is_high_scale else "Fixed 1 instance (no autoscaling)"

        industry = (industry_context or {}).get("industry", "none")
        model_sees_regulated_data = is_high_security or industry in ("fintech", "healthtech")
        config["dataComplianceBoundary"] = (
            "true -- PHI/PII may reach this model, extending the compliance boundary to include the inference endpoint"
            if model_sees_regulated_data
            else "false -- no regulated-data signal detected for this project"
        )

        reasoning["instanceType"] = (
            "GPU inference cuts per-request latency materially for real-time recommendation/classification traffic at this volume, at a real cost premium over CPU."
            if is_high_scale
            else "CPU inference is cheaper and sufficient for lighter models at this request volume; revisit if latency becomes a problem."
        )
        reasoning["autoScaling"] = (
            "Autoscaling absorbs request-volume spikes without over-provisioning for peak load at all times."
            if is_high_scale
            else "A single fixed instance is simplest and cheapest at this request volume; add autoscaling once traffic grows."
        )
        reasoning["dataComplianceBoundary"] = (
            "If the features sent to this model include any PHI/PII (not just an opaque user ID), the inference endpoint "
            "itself falls inside the same compliance boundary as the database it draws from -- encryption in transit, "
            "access logging, and data-residency requirements apply here too, not just at the primary data store."
            if model_sees_regulated_data
            else "No regulated-data signal detected for this project -- revisit this if the model's input features start including PHI/PII rather than anonymized/derived signals."
        )

    elif component_type == "workflow":
        config["executionType"] = (
            "Express (high-volume, short-duration, at-least-once)" if is_high_scale else "Standard (durable, full execution history up to 1 year)"
        )
        config["retryPolicy"] = "3 retries per state with exponential backoff; unhandled errors route to a catch-all error handler"
        config["executionHistoryRetention"] = "90 days" if is_high_security else "30 days"

        reasoning["executionType"] = (
            "Express trades Standard's exactly-once execution history for materially lower per-execution cost, which matters once invocation volume is genuinely high."
            if is_high_scale
            else "Standard's full execution history is worth the extra cost at this volume -- useful for auditing exactly what happened in a given approval/business-process run."
        )
        reasoning["retryPolicy"] = "A few retries with backoff absorb a transient failure in one step without requiring the whole process to restart from the beginning."
        reasoning["executionHistoryRetention"] = (
            "Extended retention aligns with regulatory record-keeping expectations for a compliance-sensitive process."
            if is_high_security
            else "30 days is enough to debug a recent failed execution while keeping storage costs down."
        )

    else:
        config["genericType"] = "Generic Config"
        reasoning["genericType"] = "Standard deployment config."

    # Compliance-mandated config additions, layered on top of whatever the scale/budget-driven
    # rules above already decided. These are ADDED keys, never overrides of the existing scale
    # logic, so a generic (industry_context None/"none") call is byte-for-byte unaffected.
    if industry_context and industry_context["industry"] != "none":
        standard = "PCI-DSS" if industry_context["industry"] == "fintech" else "HIPAA"

        if component_type in ("database", "storage", "cache", "analytics"):
            config["encryptionInTransit"] = "TLS 1.2+ (Enforced)"
            reasoning["encryptionInTransit"] = (
                f"Mandatory for {standard} compliance — encryption in transit is not optional for regulated data, regardless of scale. "
                "This applies to the analytics warehouse too, since it holds a real (if delayed) copy of the same regulated data."
                if component_type == "analytics"
                else f"Mandatory for {standard} compliance — encryption in transit is not optional for regulated data, regardless of scale."
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

    if component_type == "realtime":
        config["replicas"] = "4" if is_high_scale else "2"
        config["namespace"] = "app"
        config["sessionAffinity"] = "ClientIP (sticky sessions required for WebSocket)"
        config["backplane"] = "Redis Pub/Sub (cross-pod message fan-out)"
        reasoning["sessionAffinity"] = "A WebSocket connection is stateful and pinned to one pod — without sticky sessions, the Ingress could route a client's next request to a pod it has no open connection with."
        reasoning["backplane"] = "A shared pub/sub backplane lets a message published from any pod reach clients connected to any other pod."

    elif component_type == "cdn":
        config["ingressClass"] = "nginx"
        config["tlsMode"] = "cert-manager (Let's Encrypt)"
        config["replicas"] = "2"
        config["namespace"] = "ingress-system"
        reasoning["replicas"] = "Two Ingress-NGINX replicas avoid a single point of failure for all cluster traffic entry."
        reasoning["tlsMode"] = "cert-manager automates certificate issuance and renewal rather than requiring manual cert rotation."
        config["wafNote"] = "Not natively available -- consider a self-hosted ModSecurity/ingress-level WAF (e.g. OWASP CRS via ModSecurity-nginx) if this workload's scale/compliance profile warrants it."

    elif component_type == "lb":
        config["replicas"] = "3" if is_high_scale else "2"
        config["namespace"] = "ingress-system"
        config["healthCheckPath"] = "/healthz"
        config["idleTimeoutSec"] = "60"
        config["tlsMode"] = "cert-manager (Let's Encrypt)"
        reasoning["replicas"] = (
            "Three replicas spread across nodes tolerate a node failure without dropping the cluster's single entry point for all traffic."
            if is_high_scale
            else "Two replicas is the minimum that avoids the Ingress controller itself becoming a single point of failure."
        )
        reasoning["healthCheckPath"] = (
            "Ingress-NGINX health-checks each backend Service's endpoints directly via Kubernetes readiness probes, not a separate synthetic external check."
        )
        config["wafNote"] = "Not natively available -- consider a self-hosted ModSecurity/ingress-level WAF (e.g. OWASP CRS via ModSecurity-nginx) if this workload's scale/compliance profile warrants it."

    elif component_type == "dns":
        config["deploymentMode"] = "ExternalDNS Operator (In-Cluster)"
        config["namespace"] = "ingress-system"
        config["syncPolicy"] = "upsert-only (never deletes records it didn't create)"
        reasoning["deploymentMode"] = (
            "ExternalDNS watches Ingress/Service resources and syncs their hostnames to an external DNS provider automatically -- the standard Kubernetes-native way to avoid manually updating DNS records on every deploy."
        )
        reasoning["syncPolicy"] = "upsert-only is the safer default -- it will never delete a DNS record it doesn't already track as its own, even if the matching Ingress is removed."

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

    elif component_type == "monitoring":
        config["namespace"] = "monitoring"
        config["deploymentMode"] = "kube-prometheus-stack (Helm chart: Prometheus + Grafana + Alertmanager)"
        config["retentionDays"] = "90" if is_high_security else "15"
        config["tracingSampleRate"] = "5% (sampled, via OpenTelemetry Collector)" if is_high_scale else "100% (full trace)"
        reasoning["retentionDays"] = (
            "Extended in-cluster retention for compliance-sensitive workloads -- consider remote-writing to a long-term store (e.g. Thanos/Mimir) beyond this window."
            if is_high_security
            else "Short retention keeps Prometheus' local storage footprint small; extend it or add remote-write if longer history is needed."
        )
        reasoning["tracingSampleRate"] = (
            "Sampling keeps the OpenTelemetry Collector's ingestion volume manageable at high request rates."
            if is_high_scale
            else "Full-fidelity tracing is still cheap to store at this request volume."
        )

    elif component_type == "notification":
        config["namespace"] = "app"
        config["deploymentMode"] = "NATS JetStream (Helm chart) + a small notification-dispatch Deployment calling the external delivery provider's API"
        config["retryPolicy"] = "3 attempts, exponential backoff"
        reasoning["deploymentMode"] = "JetStream durably queues the fan-out event; the dispatch Deployment is what actually calls the configured external email/SMS/push provider, since nothing in-cluster can deliver to an end-user inbox or phone directly."

    elif component_type == "search":
        config["replicas"] = "3 (multi-node cluster, quorum-based)" if is_high_scale else "1 (single node)"
        config["storageSize"] = "200Gi" if is_high_scale else "50Gi"
        config["namespace"] = "data"
        reasoning["replicas"] = (
            "A 3-node cluster tolerates a single node failure without losing quorum for index writes."
            if is_high_scale
            else "A single node is sufficient at this volume; a node failure means reindexing from the source of truth, not permanent data loss, since this is a derived index."
        )

    elif component_type == "analytics":
        config["deploymentMode"] = "External (ExternalName Service + Secret) -- no in-cluster analytics/data-warehouse equivalent"
        config["namespace"] = "data"
        reasoning["deploymentMode"] = (
            "A real OLAP data warehouse is a genuinely different, heavier stateful workload than anything else this "
            "cluster self-hosts -- this is modeled as a network destination outside the cluster (a managed warehouse "
            "or an existing enterprise one), reached via a Kubernetes Secret holding its connection credentials."
        )

    elif component_type == "ml":
        config["deploymentMode"] = "KServe InferenceService (or Seldon Core)"
        config["replicas"] = "2" if is_high_scale else "1"
        config["namespace"] = "ml"
        reasoning["deploymentMode"] = "KServe wraps model serving in a Kubernetes-native CRD with built-in autoscaling (including scale-to-zero), so the endpoint doesn't need a hand-rolled Deployment + HPA."
        reasoning["namespace"] = "A dedicated 'ml' namespace keeps GPU-scheduling and model-serving RBAC scoped separately from the general 'app' namespace."

    elif component_type == "workflow":
        config["deploymentMode"] = "Argo Workflows (Helm chart)"
        config["namespace"] = "workflows"
        reasoning["deploymentMode"] = "Argo Workflows defines each step as a Kubernetes-native CRD (a real pod per step), so retries/error-handling/execution history live in cluster-native resources rather than an external managed service."
        reasoning["namespace"] = "A dedicated 'workflows' namespace keeps the orchestrator's own controller/RBAC scoped separately from the workloads it triggers."

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

    if component_type == "realtime":
        config["vmSize"] = "4 vCPU / 8GB RAM"
        config["vmCount"] = "3 (clustered, sticky-session reverse proxy)" if is_high_scale else "2"
        config["scalingMode"] = "Manual (no autoscaler) — capacity must be pre-provisioned for peak concurrent connections"
        reasoning["scalingMode"] = "Private infrastructure has no elastic capacity pool — the number of simultaneously open WebSocket connections is capped by whatever's pre-provisioned."

    elif component_type == "cdn":
        config["vmSize"] = "2 vCPU / 4GB RAM"
        config["scalingMode"] = "Manual (no autoscaler)"
        reasoning["scalingMode"] = "No CDN edge network on-premises — traffic capacity is whatever the reverse-proxy VM(s) can handle, sized ahead of time."
        config["wafNote"] = "Not natively available -- consider a self-hosted ModSecurity/ingress-level WAF (e.g. OWASP CRS via ModSecurity-nginx) if this workload's scale/compliance profile warrants it."

    elif component_type == "lb":
        config["vmSize"] = "4 vCPU / 8GB RAM"
        config["vmCount"] = "2 (active/passive failover pair)"
        config["healthCheckPath"] = "/health"
        config["haMode"] = "Manual failover (keepalived/VRRP, or a documented manual DNS cutover)"
        reasoning["haMode"] = "On-premises load balancer HA requires a manually configured VRRP/keepalived pair or a documented, tested failover runbook — nothing here does this automatically."
        config["wafNote"] = "Not natively available -- consider a self-hosted ModSecurity/ingress-level WAF (e.g. OWASP CRS via ModSecurity-nginx) if this workload's scale/compliance profile warrants it."

    elif component_type == "dns":
        config["deploymentMode"] = "Manual record management against the existing corporate DNS/BIND server"
        config["ttlSeconds"] = "300"
        reasoning["deploymentMode"] = (
            "Flagging explicitly: there is no automation syncing load balancer/VM changes to DNS records here — every change, including any future failover routing, is a manual step against the existing DNS server."
        )

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

    elif component_type == "monitoring":
        config["vmSize"] = "4 vCPU / 8GB RAM"
        config["deploymentMode"] = "Self-hosted Prometheus + Grafana (or ELK), dedicated VM"
        config["retentionDays"] = "90" if is_high_security else "15"
        reasoning["deploymentMode"] = "No managed observability platform on-premises -- log/metric storage capacity must be sized and monitored like any other stateful service here."

    elif component_type == "notification":
        config["vmCount"] = "1-2 (self-managed message bus)"
        config["retryPolicy"] = "3 attempts, exponential backoff"
        config["externalDependencyFlag"] = "An external delivery provider (email/SMS/push gateway) is required -- nothing on-premises can deliver directly to end users"
        reasoning["externalDependencyFlag"] = "Flagging explicitly: the message bus only handles internal fan-out; actual delivery to a real inbox/phone always exits through an external provider."

    elif component_type == "search":
        config["vmSize"] = "8 vCPU / 32GB RAM" if is_high_scale else "4 vCPU / 16GB RAM"
        config["vmCount"] = "3 (clustered)" if is_high_scale else "1"
        reasoning["vmCount"] = "A 3-node cluster tolerates a single node failure; a single node at lower scale means reindexing from the source of truth on failure, not permanent data loss."

    elif component_type == "analytics":
        config["deploymentMode"] = "No managed equivalent on-premises -- typically a network destination reached over the corporate network/VPN (e.g. an existing enterprise data warehouse appliance)"
        reasoning["deploymentMode"] = "Flagging explicitly: this design does not provision analytics/data-warehouse hardware -- it assumes one already exists on the corporate network, or that provisioning it is a separate, larger undertaking outside this architecture's scope."

    elif component_type == "ml":
        config["vmSize"] = "GPU-equipped VM (e.g. NVIDIA T4/A10) recommended" if is_high_scale else "CPU-only VM acceptable at this request volume"
        config["deploymentMode"] = "Self-hosted inference server (e.g. NVIDIA Triton), no managed equivalent"
        reasoning["deploymentMode"] = "On-premises has no managed autoscaling or model-versioning tooling -- capacity must be pre-provisioned for peak inference load, and deployment/rollback is a manual operational process."

    elif component_type == "workflow":
        config["deploymentMode"] = "Self-hosted orchestrator (e.g. Apache Airflow / Temporal) on dedicated VM(s)"
        config["vmCount"] = "2 (HA pair)" if is_high_scale else "1"
        reasoning["vmCount"] = "An HA pair avoids the orchestrator itself becoming a single point of failure for every process it coordinates once scale is high enough to matter."

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
