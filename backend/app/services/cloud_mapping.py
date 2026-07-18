from app.services.nfr_signals import is_budget_tight as _is_budget_tight
from app.services.nfr_signals import is_high_scale as _is_high_scale
from app.services.rules_engine import is_relational_data_nature


def _mapping(service_name: str, alternatives: list[dict], cost_estimate: dict) -> dict:
    return {"serviceName": service_name, "alternatives": alternatives, "costEstimate": cost_estimate}


def _is_high_security(requirements: dict) -> bool:
    """Recomputed locally wherever needed (same precedent as the "lb" branch's own
    is_serverless_rules recompute below) rather than threaded through as a new parameter --
    mirrors lld_rules.py's identical is_high_security derivation so the WAF cost note here always
    agrees with whether lld_rules.py actually turned wafEnabled on."""
    compliance_lower = requirements["nonFunctional"]["compliance"].lower()
    return (
        "gdpr" in compliance_lower
        or "hipaa" in compliance_lower
        or "pci" in compliance_lower
        or "secure" in compliance_lower
        or "audit" in compliance_lower
        or "encrypt" in compliance_lower
    )


def _waf_cost_note(is_high_scale: bool, is_high_security: bool) -> str:
    """Folded into the "lb"/"cdn" cost estimate assumptions strings (aws/azure/gcp only) when a
    WAF would actually be enabled -- see lld_rules.py's wafEnabled trigger (is_high_scale or
    is_high_security or fintech/healthtech industry). Deliberately a small, clearly-labeled
    incremental estimate, not a separate cost line -- this function only sees is_high_scale/
    is_high_security (not industry_context, which isn't threaded into this module at all), so a
    WAF enabled purely by industry_context on an otherwise low-scale/low-security architecture
    won't get this note -- an accepted, documented gap, not a bug."""
    if not (is_high_scale or is_high_security):
        return ""
    return (
        " If a WAF is attached (see LLD wafEnabled), add roughly $5-10/month base + ~$1/month per "
        "managed rule group + a small per-request inspection fee -- a rough incremental estimate, "
        "not a separately tracked line item."
    )


def _apply_dr_cost_increment(mapping: dict, component_type: str, component_id: str, dr_strategy: str) -> dict:
    """Folds the incremental DR cost onto a component's already-computed costEstimate, once any DR
    tier (pilot-light/warm-standby) is active. Applied as a single post-processing step over
    whatever _aws_mapping/_azure_mapping/_gcp_mapping already returned, rather than threading
    dr_strategy through every one of their individual branches -- the exact same "recompute/apply
    locally rather than invasively thread a new parameter everywhere" precedent Phase 3 used for
    is_high_security in the "lb"/"cdn" WAF cost-note branches.

    Storage gets a small bump on both tiers -- cross-region object replication is cheap, and per
    lld_rules.py it's enabled for both tiers once DR is active at all. Database gets a bump on both
    tiers -- a standing cross-region replica costs real money even at the pilot-light tier, just
    less than warm-standby's fully-replicated instance. Compute only gets a bump for warm-standby
    (roughly 30-50% of its own primary cost, per the task's own cost guidance), since pilot-light's
    whole point is no standing secondary compute -- matches the standbyCapacity LLD key lld_rules.py
    only sets for warm-standby."""
    cost = mapping.get("costEstimate") or {}
    if component_type == "storage":
        bump_min, bump_max = (1, 10) if dr_strategy == "pilot-light" else (5, 30)
        note = " Includes a modest incremental cost for cross-region replication once disaster-recovery is active."
    elif component_type == "database":
        if dr_strategy == "pilot-light":
            bump_min, bump_max = 15, 60
            note = " Includes a cross-region read replica for pilot-light disaster recovery."
        else:
            bump_min = round(cost.get("min", 0) * 0.3)
            bump_max = round(cost.get("max", 0) * 0.5)
            note = " Includes a standing secondary-region replica (~30-50% of primary cost) for warm-standby disaster recovery."
    elif component_type == "compute" and dr_strategy == "warm-standby":
        bump_min = round(cost.get("min", 0) * 0.3)
        bump_max = round(cost.get("max", 0) * 0.5)
        note = " Includes a scaled-down standby fleet in the secondary region (~30-50% of primary cost) for warm-standby disaster recovery."
    else:
        return mapping

    mapping["costEstimate"] = {
        "min": cost.get("min", 0) + bump_min,
        "max": cost.get("max", 0) + bump_max,
        "assumptions": (cost.get("assumptions") or "") + note,
    }
    return mapping


def get_cloud_mapping(
    provider: str, component_type: str, component_id: str, requirements: dict, dr_strategy: str = "none"
) -> dict:
    nfr = requirements["nonFunctional"]
    team_lower = nfr["teamMaturity"].lower()

    is_high_scale = _is_high_scale(nfr["expectedScale"])
    is_low_budget = _is_budget_tight(nfr["budget"])

    if provider in ("aws", "azure", "gcp"):
        if provider == "aws":
            mapping = _aws_mapping(component_type, component_id, requirements, is_high_scale, is_low_budget, team_lower)
        elif provider == "azure":
            mapping = _azure_mapping(component_type, component_id, requirements, is_high_scale, is_low_budget, team_lower)
        else:
            mapping = _gcp_mapping(component_type, component_id, requirements, is_high_scale, is_low_budget, team_lower)
        if dr_strategy != "none":
            mapping = _apply_dr_cost_increment(mapping, component_type, component_id, dr_strategy)
        return mapping
    if provider == "kubernetes":
        # Cloud-agnostic -- costs here are infrastructure share (pod resource requests, PVs) on
        # top of cluster capacity you provision separately (EKS/GKE/AKS/self-hosted), not
        # managed service billing. is_low_ops_capacity mirrors rules_engine.py's
        # is_team_junior/is_budget_tight logic to decide when to steer toward an external
        # managed dependency instead of self-hosting stateful workloads on the cluster.
        is_low_ops_capacity = (
            is_low_budget or "junior" in team_lower or "small" in team_lower or team_lower == "not_specified"
        )
        return _kubernetes_mapping(component_type, component_id, is_high_scale, is_low_ops_capacity)
    if provider == "private":
        # On-premises / private cloud (VMware, OpenStack, bare-metal). Conservative by design:
        # no elastic autoscaling, no managed-service fallbacks -- every stateful/managed
        # dependency that a public cloud would absorb becomes an explicit, flagged ops burden
        # here. Cost bands are amortized monthly hardware/licensing estimates, not cloud spend.
        return _private_mapping(component_type, component_id, is_high_scale)

    return _mapping(f"Cloud Service ({component_type})", [], {"min": 0, "max": 0, "assumptions": "Fallback."})


def _aws_mapping(
    component_type: str,
    component_id: str,
    requirements: dict,
    is_high_scale: bool,
    is_low_budget: bool,
    team_lower: str,
) -> dict:
    if component_type == "realtime":
        return _mapping(
            "Amazon API Gateway (WebSocket APIs)",
            [
                {
                    "serviceName": "AWS AppSync (GraphQL Subscriptions)",
                    "reason": "Chose API Gateway WebSocket APIs for direct bidirectional connection control at low cost and no GraphQL schema overhead. AppSync is the better fit if the app already speaks GraphQL end-to-end.",
                    "costEstimate": {
                        "min": 15,
                        "max": 120 if is_high_scale else 40,
                        "assumptions": "AppSync real-time subscription pricing (~$2/million messages) plus GraphQL query costs.",
                    },
                }
            ],
            {
                "min": 5,
                "max": 90 if is_high_scale else 20,
                "assumptions": "API Gateway WebSocket APIs billed per connection-minute + per message ($1.00/million messages, $0.25/million connection-minutes).",
            },
        )

    if component_type == "cdn":
        return _mapping(
            "Amazon CloudFront",
            [
                {
                    "serviceName": "AWS Global Accelerator",
                    "reason": "Chose CloudFront because it supports edge caching for static assets, whereas Global Accelerator is better suited for raw TCP/UDP latency optimizations.",
                    "costEstimate": {
                        "min": 30 if is_high_scale else 18,
                        "max": 200 if is_high_scale else 40,
                        "assumptions": "AWS Global Accelerator fixed hourly accelerator fee (~$18/mo) plus per-GB data processing charges.",
                    },
                }
            ],
            {
                "min": 20 if is_high_scale else 0,
                "max": 150 if is_high_scale else 5,
                "assumptions": (
                    "CloudFront data transfer out costs for high volume traffic."
                    if is_high_scale
                    else "CloudFront free tier covers up to 1TB of data transfer out."
                )
                + _waf_cost_note(is_high_scale, _is_high_security(requirements)),
            },
        )

    if component_type == "compute":
        if component_id == "worker":
            if is_low_budget:
                return _mapping(
                    "AWS Lambda (Worker)",
                    [
                        {
                            "serviceName": "Amazon ECS Fargate (Worker Task)",
                            "reason": "Chose Lambda because the team has low operational maturity and the budget is tight. Fargate tasks incur higher baseline costs for idle time.",
                            "costEstimate": {
                                "min": 15,
                                "max": 120 if is_high_scale else 30,
                                "assumptions": "0.25 vCPU + 0.5 GB RAM container task running continuously for background jobs.",
                            },
                        }
                    ],
                    {
                        "min": 0,
                        "max": 30 if is_high_scale else 5,
                        "assumptions": "Lambda execution duration costs based on spiky background processing volume.",
                    },
                )
            return _mapping(
                "Amazon ECS Fargate (Worker)",
                [
                    {
                        "serviceName": "Amazon EC2 Worker Instance",
                        "reason": "Chose Fargate to eliminate instance patching and OS management overhead. EC2 would be cheaper but requires more operations effort.",
                        "costEstimate": {
                            "min": 7,
                            "max": 60 if is_high_scale else 15,
                            "assumptions": "Amazon EC2 t3.micro/small instance running continuously, cheaper than Fargate but requires manual patching and scaling.",
                        },
                    }
                ],
                {
                    "min": 15,
                    "max": 120 if is_high_scale else 30,
                    "assumptions": "0.25 vCPU + 0.5 GB RAM container task running continuously for background jobs.",
                },
            )

        # Primary Compute
        is_serverless_rules = is_low_budget and (
            "junior" in team_lower or "small" in team_lower or team_lower == "not_specified"
        )
        if is_serverless_rules:
            return _mapping(
                "AWS Lambda",
                [
                    {
                        "serviceName": "Amazon ECS Fargate",
                        "reason": "Chose Lambda to leverage pay-per-request pricing and zero management overhead. Fargate containers have a higher fixed monthly cost.",
                        "costEstimate": {
                            "min": 15,
                            "max": 220 if is_high_scale else 42,
                            "assumptions": "1-2 ECS Fargate tasks (0.5 vCPU, 1GB RAM) running 24/7; its fronting Application Load Balancer is costed separately as the architecture's own \"lb\" component.",
                        },
                    }
                ],
                {
                    "min": 0,
                    "max": 80 if is_high_scale else 10,
                    "assumptions": "Lambda execution times (128MB RAM, 100ms duration). Its fronting API Gateway is costed separately as the architecture's own \"lb\" component.",
                },
            )
        return _mapping(
            "Amazon ECS Fargate",
            [
                {
                    "serviceName": "AWS Lambda",
                    "reason": "Chose Fargate because the application has long-running connections or consistent request streams. An ALB in front of Fargate provides better caching and SSL termination than API Gateway's Lambda integration.",
                    "costEstimate": {
                        "min": 0,
                        "max": 80 if is_high_scale else 10,
                        "assumptions": "Lambda execution times (128MB RAM, 100ms duration). Its fronting API Gateway is costed separately as the architecture's own \"lb\" component.",
                    },
                }
            ],
            {
                "min": 15,
                "max": 220 if is_high_scale else 42,
                "assumptions": "1-2 ECS Fargate tasks (0.5 vCPU, 1GB RAM) running 24/7; its fronting Application Load Balancer is costed separately as the architecture's own \"lb\" component.",
            },
        )

    if component_type == "lb":
        # This branch doesn't yet know whether it's fronting serverless or container-style
        # compute, so it recomputes the exact same signal the compute branch above used --
        # deterministic, so it always agrees with whatever compute actually chose, whether the
        # "lb" component was auto-added by rules_engine.py (container-only) or added manually
        # via the editor onto a serverless architecture.
        is_serverless_rules = is_low_budget and (
            "junior" in team_lower or "small" in team_lower or team_lower == "not_specified"
        )
        is_high_sec = _is_high_security(requirements)
        if is_serverless_rules:
            return _mapping(
                "Amazon API Gateway (HTTP API)",
                [
                    {
                        "serviceName": "Application Load Balancer",
                        "reason": "Chose API Gateway's HTTP API for native Lambda proxy integration with no idle-capacity cost. An ALB is the right fit once compute is container-based rather than Lambda.",
                        "costEstimate": {
                            "min": 18,
                            "max": 60 if is_high_scale else 20,
                            "assumptions": "ALB fixed hourly charge (~$18/month) plus Load Balancer Capacity Unit (LCU) charges that scale with traffic.",
                        },
                    }
                ],
                {
                    "min": 0,
                    "max": 80 if is_high_scale else 10,
                    "assumptions": "API Gateway HTTP API requests ($1.00/million) -- no fixed baseline cost, scales to zero with traffic."
                    + _waf_cost_note(is_high_scale, is_high_sec),
                },
            )
        return _mapping(
            "Application Load Balancer",
            [
                {
                    "serviceName": "Amazon API Gateway (HTTP API)",
                    "reason": "Chose an ALB for the health-checked, sticky-session-capable routing that a fleet of long-running container instances needs. API Gateway's HTTP API is the better fit once compute is Lambda-based.",
                    "costEstimate": {
                        "min": 0,
                        "max": 80 if is_high_scale else 10,
                        "assumptions": "API Gateway HTTP API requests ($1.00/million) -- no fixed baseline cost, scales to zero with traffic.",
                    },
                }
            ],
            {
                "min": 18,
                "max": 60 if is_high_scale else 20,
                "assumptions": "ALB fixed hourly charge (~$18/month) plus Load Balancer Capacity Unit (LCU) charges that scale with traffic."
                + _waf_cost_note(is_high_scale, is_high_sec),
            },
        )

    if component_type == "dns":
        return _mapping(
            "Amazon Route 53",
            [
                {
                    "serviceName": "Third-Party DNS (e.g. Cloudflare DNS)",
                    "reason": "Chose Route 53 for native AWS integration -- alias records can point directly at an ALB/CloudFront/API Gateway with no extra CNAME indirection. A third-party DNS provider is a reasonable choice if DNS is already managed there for other domains.",
                    "costEstimate": {
                        "min": 0,
                        "max": 20 if is_high_scale else 5,
                        "assumptions": "Most third-party DNS providers price hosted zones/queries comparably to Route 53 at this volume.",
                    },
                }
            ],
            {
                "min": 0.50,
                "max": 5 if is_high_scale else 1,
                "assumptions": "Route 53 hosted zone ($0.50/month) plus per-million-query pricing; negligible at this traffic volume.",
            },
        )

    if component_type == "database":
        if component_id == "database":
            is_relational = is_relational_data_nature(requirements)
            if is_relational:
                if is_low_budget:
                    return _mapping(
                        "Amazon RDS PostgreSQL (db.t4g.micro)",
                        [
                            {
                                "serviceName": "Amazon Aurora Serverless v2",
                                "reason": "Chose RDS single instance because Aurora Serverless v2 has a minimum 0.5 ACU baseline cost (~$40/month), which exceeds the tight budget limit.",
                                "costEstimate": {
                                    "min": 40,
                                    "max": 300 if is_high_scale else 100,
                                    "assumptions": "Aurora Serverless v2 scaling between 0.5 and 4 ACUs with Multi-AZ replication.",
                                },
                            }
                        ],
                        {
                            "min": 15,
                            "max": 25,
                            "assumptions": "Single db.t4g.micro instance (2 vCPU, 1GB RAM) with 20GB GP3 storage.",
                        },
                    )
                return _mapping(
                    "Amazon Aurora PostgreSQL (Serverless v2)",
                    [
                        {
                            "serviceName": "Amazon RDS PostgreSQL (Multi-AZ)",
                            "reason": "Chose Aurora Serverless v2 to accommodate unpredictable scaling automatically. RDS Multi-AZ would provide HA but is less flexible.",
                            "costEstimate": {
                                "min": 15,
                                "max": 25,
                                "assumptions": "Single db.t4g.micro instance (2 vCPU, 1GB RAM) with 20GB GP3 storage.",
                            },
                        }
                    ],
                    {
                        "min": 40,
                        "max": 300 if is_high_scale else 100,
                        "assumptions": "Aurora Serverless v2 scaling between 0.5 and 4 ACUs with Multi-AZ replication.",
                    },
                )
            return _mapping(
                "Amazon DynamoDB",
                [
                    {
                        "serviceName": "Amazon DocumentDB (MongoDB Compatible)",
                        "reason": "Chose DynamoDB because DocumentDB requires a running cluster instance (~$50/month minimum), whereas DynamoDB is serverless and pay-as-you-go.",
                        "costEstimate": {
                            "min": 50,
                            "max": 250 if is_high_scale else 80,
                            "assumptions": "Amazon DocumentDB db.t3.medium instance cluster (~$50/month minimum) plus storage/IO costs.",
                        },
                    }
                ],
                {
                    "min": 0,
                    "max": 100 if is_high_scale else 15,
                    "assumptions": "DynamoDB On-Demand read/write request units + storage capacity costs.",
                },
            )
        return _mapping(
            "Amazon RDS PostgreSQL",
            [
                {
                    "serviceName": "Amazon DynamoDB",
                    "reason": "Chose RDS for structured schemas.",
                    "costEstimate": {
                        "min": 0,
                        "max": 100 if is_high_scale else 15,
                        "assumptions": "DynamoDB On-Demand read/write request units + storage capacity costs.",
                    },
                }
            ],
            {"min": 15, "max": 50, "assumptions": "RDS DB instance."},
        )

    if component_type == "storage":
        return _mapping(
            "Amazon S3",
            [
                {
                    "serviceName": "Amazon EFS (Elastic File System)",
                    "reason": "Chose S3 because the files are unstructured media/blobs. EFS is better for POSIX-compliant file systems mounted directly onto EC2/Fargate.",
                    "costEstimate": {
                        "min": 5,
                        "max": 150 if is_high_scale else 30,
                        "assumptions": "Amazon EFS Standard storage ($0.30/GB) for POSIX-compliant file access, no request-based fees.",
                    },
                }
            ],
            {
                "min": 1,
                "max": 80 if is_high_scale else 15,
                "assumptions": "S3 Standard storage volume ($0.023/GB) + GET/PUT request API calls.",
            },
        )

    if component_type == "queue":
        return _mapping(
            "Amazon SQS (Simple Queue Service)",
            [
                {
                    "serviceName": "Amazon MSK (Managed Streaming for Apache Kafka)",
                    "reason": "Chose SQS because the workload has simple message buffer requirements. Kafka (MSK) is designed for high-throughput log streams and has a high minimum instance cost (~$200/month).",
                    "costEstimate": {
                        "min": 200,
                        "max": 600 if is_high_scale else 250,
                        "assumptions": "Amazon MSK provisioned broker cluster (minimum 2-3 kafka.t3.small brokers, ~$200/month baseline).",
                    },
                }
            ],
            {
                "min": 0,
                "max": 30 if is_high_scale else 5,
                "assumptions": "SQS request volume (first 1 million requests/month are free).",
            },
        )

    if component_type == "cache":
        return _mapping(
            "Amazon ElastiCache (Redis OSS)",
            [
                {
                    "serviceName": "Amazon DynamoDB Accelerator (DAX)",
                    "reason": "Chose ElastiCache Redis because it supports versatile cache structures (sessions, query caches). DAX is specifically optimized only for DynamoDB key caching.",
                    "costEstimate": {
                        "min": 36,
                        "max": 150 if is_high_scale else 60,
                        "assumptions": "DAX requires a minimum 3-node cluster (dax.t3.small) for the built-in HA quorum.",
                    },
                }
            ],
            {
                "min": 12,
                "max": 90 if is_high_scale else 25,
                "assumptions": "Single cache.t4g.micro node running Redis OSS for session caching.",
            },
        )

    if component_type == "auth":
        return _mapping(
            "Amazon Cognito User Pools",
            [
                {
                    "serviceName": "Auth0 / Clerk (SaaS Provider)",
                    "reason": "Chose Cognito for full AWS native integration and cost savings. Cognito is free for the first 50,000 monthly active users (MAUs), whereas Clerk/Auth0 have lower free limits.",
                    "costEstimate": {
                        "min": 99 if is_high_scale else 0,
                        "max": 250 if is_high_scale else 35,
                        "assumptions": "Auth0/Clerk paid tier pricing kicks in above ~1,000 MAUs on the free plan, then per-MAU billing.",
                    },
                }
            ],
            {
                "min": 0,
                "max": 40 if is_high_scale else 0,
                "assumptions": "Cognito User Pools pricing: 50,000 MAUs free, then $0.0055 per MAU.",
            },
        )

    if component_type == "tokenization":
        return _mapping(
            "AWS KMS + Dedicated Tokenization Microservice (ECS Fargate)",
            [
                {
                    "serviceName": "Third-Party Tokenization Vault (e.g. Basis Theory, VGS)",
                    "reason": "Chose a self-managed KMS-backed microservice to keep full control of the tokenization boundary. A third-party vault offloads PCI-DSS scope entirely but adds a recurring per-transaction vendor fee and an external dependency in the payment path.",
                    "costEstimate": {
                        "min": 200,
                        "max": 1500 if is_high_scale else 500,
                        "assumptions": "Third-party tokenization vault per-transaction/per-token pricing plus a monthly platform fee.",
                    },
                }
            ],
            {
                "min": 40,
                "max": 300 if is_high_scale else 100,
                "assumptions": "KMS key usage fees + a small dedicated Fargate task (0.25 vCPU, 0.5GB RAM) running the tokenization service continuously.",
            },
        )

    if component_type == "audit-log":
        return _mapping(
            "Amazon S3 (Object Lock — Compliance Mode) + CloudTrail",
            [
                {
                    "serviceName": "Amazon QLDB (Quantum Ledger Database)",
                    "reason": "Chose S3 Object Lock for cost-effective, provably immutable storage at scale. QLDB offers cryptographic verification of the full change history but at a materially higher baseline cost for simple append-only audit logging.",
                    "costEstimate": {
                        "min": 60,
                        "max": 400 if is_high_scale else 150,
                        "assumptions": "QLDB ledger with a small number of I/O request units and journal storage.",
                    },
                }
            ],
            {
                "min": 3,
                "max": 60 if is_high_scale else 15,
                "assumptions": "S3 Standard storage with Object Lock (Compliance mode) + CloudTrail management event logging (first trail free).",
            },
        )

    if component_type == "phi-vault":
        return _mapping(
            "AWS HealthLake (FHIR-native PHI Store)",
            [
                {
                    "serviceName": "Amazon RDS PostgreSQL (KMS-Encrypted, Dedicated PHI Instance)",
                    "reason": "Chose HealthLake because it's purpose-built for healthcare data (FHIR R4) with built-in HIPAA-eligible encryption and query tooling. A dedicated encrypted RDS instance is cheaper and simpler if the data isn't already FHIR-structured.",
                    "costEstimate": {
                        "min": 20,
                        "max": 250 if is_high_scale else 80,
                        "assumptions": "Dedicated db.t4g.medium instance (KMS-encrypted) with 50GB storage, isolated from the general application database.",
                    },
                }
            ],
            {
                "min": 90,
                "max": 600 if is_high_scale else 200,
                "assumptions": "HealthLake data store charges based on stored FHIR resources plus API request volume.",
            },
        )

    if component_type == "deidentification":
        return _mapping(
            "Amazon Comprehend Medical (PHI Detection & De-identification)",
            [
                {
                    "serviceName": "AWS Glue DataBrew (Custom Masking Rules)",
                    "reason": "Chose Comprehend Medical because it uses NLP trained specifically to detect the 18 HIPAA identifiers in unstructured clinical text. DataBrew is cheaper for simple structured-field masking but requires hand-authored rules per field.",
                    "costEstimate": {
                        "min": 5,
                        "max": 80 if is_high_scale else 25,
                        "assumptions": "DataBrew job runs on a nightly batch schedule processing the PHI vault export.",
                    },
                }
            ],
            {
                "min": 10,
                "max": 150 if is_high_scale else 40,
                "assumptions": "Comprehend Medical priced per unit of text processed ($0.0010/100 characters), run as a nightly batch job over new PHI records.",
            },
        )

    if component_type == "monitoring":
        return _mapping(
            "Amazon CloudWatch (Logs + Alarms + Dashboards)",
            [
                {
                    "serviceName": "Datadog / New Relic (Third-Party APM)",
                    "reason": "Chose native CloudWatch for zero extra vendor integration and billing that stays inside the existing AWS bill. A third-party APM (Datadog/New Relic) gives richer cross-service tracing and a nicer dashboard UI, at a real per-host/per-GB SaaS cost on top of AWS.",
                    "costEstimate": {
                        "min": 15,
                        "max": 250 if is_high_scale else 70,
                        "assumptions": "Datadog Pro tier per-host pricing (~$15-23/host/month) plus ingested log volume charges.",
                    },
                }
            ],
            {
                "min": 3,
                "max": 90 if is_high_scale else 20,
                "assumptions": "CloudWatch Logs ingestion/storage + custom metrics + dashboard widgets -- scales with log volume and alarm count, cheap at low scale.",
            },
        )

    if component_type == "notification":
        return _mapping(
            "Amazon SNS",
            [
                {
                    "serviceName": "Amazon Pinpoint (Multi-Channel Campaigns)",
                    "reason": "Chose SNS for simple, cheap fan-out delivery to email/SMS/push endpoints. Pinpoint adds campaign templating, audience segmentation, and delivery analytics, at a materially higher cost for capabilities this use case may not need yet.",
                    "costEstimate": {
                        "min": 30,
                        "max": 300 if is_high_scale else 90,
                        "assumptions": "Pinpoint per-message channel pricing (SMS/push/email) plus a monthly active-endpoint charge.",
                    },
                }
            ],
            {
                "min": 0,
                "max": 40 if is_high_scale else 5,
                "assumptions": "SNS pay-per-notification pricing (~$0.50/million for email, ~$0.0075/SMS in the US) -- the first 1,000 email notifications/month are free.",
            },
        )

    return _mapping(f"AWS Mapped Service ({component_type})", [], {"min": 0, "max": 0, "assumptions": "Generic AWS component."})


def _azure_mapping(
    component_type: str,
    component_id: str,
    requirements: dict,
    is_high_scale: bool,
    is_low_budget: bool,
    team_lower: str,
) -> dict:
    if component_type == "realtime":
        return _mapping(
            "Azure Web PubSub",
            [
                {
                    "serviceName": "Azure SignalR Service",
                    "reason": "Chose Web PubSub for a lighter-weight, protocol-agnostic WebSocket service. SignalR Service is the better fit if the backend already uses the .NET SignalR library and wants its client SDK conveniences.",
                    "costEstimate": {
                        "min": 50,
                        "max": 200 if is_high_scale else 80,
                        "assumptions": "SignalR Service Standard tier (~$50/mo base) plus per-unit connection scaling.",
                    },
                }
            ],
            {
                "min": 40 if is_high_scale else 0,
                "max": 150 if is_high_scale else 50,
                "assumptions": "Azure Web PubSub Standard tier, billed per concurrent connection and per message.",
            },
        )

    if component_type == "cdn":
        return _mapping(
            "Azure Front Door",
            [
                {
                    "serviceName": "Azure Traffic Manager",
                    "reason": "Chose Azure Front Door because it provides Global HTTP/HTTPS load balancing and edge asset caching, whereas Traffic Manager is purely DNS-based routing.",
                    "costEstimate": {
                        "min": 1,
                        "max": 15 if is_high_scale else 5,
                        "assumptions": "Azure Traffic Manager DNS-based routing profile ($0.50/million DNS queries), no data transfer/caching fees since it does not proxy traffic.",
                    },
                }
            ],
            {
                "min": 35 if is_high_scale else 10,
                "max": 160 if is_high_scale else 35,
                "assumptions": "Azure Front Door Standard base fee ($35/mo) + data egress charges."
                + _waf_cost_note(is_high_scale, _is_high_security(requirements)),
            },
        )

    if component_type == "compute":
        if component_id == "worker":
            if is_low_budget:
                return _mapping(
                    "Azure Functions (Consumption Worker)",
                    [
                        {
                            "serviceName": "Azure Container Apps (Worker)",
                            "reason": "Chose Azure Functions because it scales down to zero dynamically for background triggers. Container Apps would require a persistent active container profile.",
                            "costEstimate": {
                                "min": 15,
                                "max": 120 if is_high_scale else 30,
                                "assumptions": "Container profile allocating 0.25 vCPU and 0.5 GB RAM running continuously.",
                            },
                        }
                    ],
                    {
                        "min": 0,
                        "max": 35 if is_high_scale else 5,
                        "assumptions": "Serverless execution duration pricing based on invocation volumes.",
                    },
                )
            return _mapping(
                "Azure Container Apps (Worker)",
                [
                    {
                        "serviceName": "Azure Virtual Machines (Scale Sets)",
                        "reason": "Chose Container Apps to avoid VM management, OS upgrades, and complex scale rules. VMs would be cheaper but require significant administrative overhead.",
                        "costEstimate": {
                            "min": 8,
                            "max": 65 if is_high_scale else 18,
                            "assumptions": "Azure VM Scale Set with a single reserved B-series burstable instance, cheaper than Container Apps but requires manual patching and scaling.",
                        },
                    }
                ],
                {
                    "min": 15,
                    "max": 120 if is_high_scale else 30,
                    "assumptions": "Container profile allocating 0.25 vCPU and 0.5 GB RAM running continuously.",
                },
            )

        # Primary API Compute
        is_serverless_rules = is_low_budget and (
            "junior" in team_lower or "small" in team_lower or team_lower == "not_specified"
        )
        if is_serverless_rules:
            return _mapping(
                "Azure Functions",
                [
                    {
                        "serviceName": "Azure Container Apps",
                        "reason": "Chose Azure Functions to minimize fixed costs, charging strictly per request. Container Apps has a slightly higher base footprint cost.",
                        "costEstimate": {
                            "min": 15,
                            "max": 230 if is_high_scale else 45,
                            "assumptions": "Container App execution (1-2 replicas); its fronting Application Gateway is costed separately as the architecture's own \"lb\" component.",
                        },
                    }
                ],
                {
                    "min": 0,
                    "max": 85 if is_high_scale else 10,
                    "assumptions": "Serverless Functions executions; its fronting API Management gateway is costed separately as the architecture's own \"lb\" component.",
                },
            )
        return _mapping(
            "Azure Container Apps",
            [
                {
                    "serviceName": "Azure App Service (Linux Web App)",
                    "reason": "Chose Container Apps for modern microservices packaging and simpler scale-to-zero settings compared to App Service plans.",
                    "costEstimate": {
                        "min": 0,
                        "max": 85 if is_high_scale else 10,
                        "assumptions": "Serverless Functions executions; its fronting API Management gateway is costed separately as the architecture's own \"lb\" component.",
                    },
                }
            ],
            {
                "min": 15,
                "max": 230 if is_high_scale else 45,
                "assumptions": "Container App execution (1-2 replicas); its fronting Application Gateway is costed separately as the architecture's own \"lb\" component.",
            },
        )

    if component_type == "lb":
        is_serverless_rules = is_low_budget and (
            "junior" in team_lower or "small" in team_lower or team_lower == "not_specified"
        )
        is_high_sec = _is_high_security(requirements)
        if is_serverless_rules:
            return _mapping(
                "Azure API Management",
                [
                    {
                        "serviceName": "Azure Application Gateway",
                        "reason": "Chose API Management's Consumption tier for a gateway that scales to zero with Functions. Application Gateway is the right fit once compute is container-based rather than Functions.",
                        "costEstimate": {
                            "min": 18,
                            "max": 55 if is_high_scale else 20,
                            "assumptions": "Application Gateway Standard_v2 baseline cost (~$18/month) plus capacity unit charges that scale with traffic.",
                        },
                    }
                ],
                {
                    "min": 0,
                    "max": 85 if is_high_scale else 10,
                    "assumptions": "API Management Consumption tier -- billed per API call, no fixed baseline cost."
                    + _waf_cost_note(is_high_scale, is_high_sec),
                },
            )
        return _mapping(
            "Azure Application Gateway",
            [
                {
                    "serviceName": "Azure API Management",
                    "reason": "Chose Application Gateway for health-checked routing and TLS termination in front of a fleet of container instances. API Management's Consumption tier is the better fit once compute is Functions-based.",
                    "costEstimate": {
                        "min": 0,
                        "max": 85 if is_high_scale else 10,
                        "assumptions": "API Management Consumption tier -- billed per API call, no fixed baseline cost.",
                    },
                }
            ],
            {
                "min": 18,
                "max": 55 if is_high_scale else 20,
                "assumptions": "Application Gateway Standard_v2 baseline cost (~$18/month) plus capacity unit charges that scale with traffic."
                + _waf_cost_note(is_high_scale, is_high_sec),
            },
        )

    if component_type == "dns":
        return _mapping(
            "Azure DNS",
            [
                {
                    "serviceName": "Third-Party DNS (e.g. Cloudflare DNS)",
                    "reason": "Chose Azure DNS for native alias-record integration with Application Gateway/Front Door/API Management. A third-party DNS provider is a reasonable choice if DNS is already managed there for other domains.",
                    "costEstimate": {
                        "min": 0,
                        "max": 20 if is_high_scale else 5,
                        "assumptions": "Most third-party DNS providers price hosted zones/queries comparably to Azure DNS at this volume.",
                    },
                }
            ],
            {
                "min": 0.50,
                "max": 5 if is_high_scale else 1,
                "assumptions": "Azure DNS hosted zone (~$0.50/month) plus per-million-query pricing; negligible at this traffic volume.",
            },
        )

    if component_type == "database":
        if component_id == "database":
            is_relational = is_relational_data_nature(requirements)
            if is_relational:
                if is_low_budget:
                    return _mapping(
                        "Azure Database for PostgreSQL (Burstable B1ms)",
                        [
                            {
                                "serviceName": "Azure Cosmos DB (PostgreSQL API)",
                                "reason": "Chose Burstable PostgreSQL single instance because Cosmos DB distributed configurations have a high baseline cost structure (~$90/mo minimum).",
                                "costEstimate": {
                                    "min": 45,
                                    "max": 310 if is_high_scale else 110,
                                    "assumptions": "General Purpose D2ds_v5 instance (2 vCPU, 8GB RAM) with high availability configured.",
                                },
                            }
                        ],
                        {
                            "min": 15,
                            "max": 25,
                            "assumptions": "Single burstable compute instance (B1ms, 1 vCPU, 2GB RAM) with 32GB Premium SSD storage.",
                        },
                    )
                return _mapping(
                    "Azure Database for PostgreSQL (Flexible Server)",
                    [
                        {
                            "serviceName": "Azure Cosmos DB for PostgreSQL",
                            "reason": "Chose PostgreSQL Flexible Server to provide high availability and replication zones without the complexity of a distributed Citus database layout.",
                            "costEstimate": {
                                "min": 15,
                                "max": 25,
                                "assumptions": "Single burstable compute instance (B1ms, 1 vCPU, 2GB RAM) with 32GB Premium SSD storage.",
                            },
                        }
                    ],
                    {
                        "min": 45,
                        "max": 310 if is_high_scale else 110,
                        "assumptions": "General Purpose D2ds_v5 instance (2 vCPU, 8GB RAM) with high availability configured.",
                    },
                )
            return _mapping(
                "Azure Cosmos DB (NoSQL)",
                [
                    {
                        "serviceName": "Azure Cache for Redis (Enterprise)",
                        "reason": "Chose Cosmos DB as the primary document store due to strict document query requirements. Redis is used primarily for fast transit caches.",
                        "costEstimate": {
                            "min": 100,
                            "max": 500 if is_high_scale else 200,
                            "assumptions": "Azure Cache for Redis Enterprise E10 tier minimum footprint for advanced modules and higher throughput.",
                        },
                    }
                ],
                {
                    "min": 0,
                    "max": 110 if is_high_scale else 15,
                    "assumptions": "Cosmos DB Serverless provisioning (billing based on consumed Request Units).",
                },
            )
        return _mapping(
            "Azure Database for PostgreSQL",
            [
                {
                    "serviceName": "Azure Cosmos DB",
                    "reason": "Chose PostgreSQL for relational data model.",
                    "costEstimate": {
                        "min": 0,
                        "max": 110 if is_high_scale else 15,
                        "assumptions": "Cosmos DB Serverless provisioning (billing based on consumed Request Units).",
                    },
                }
            ],
            {"min": 15, "max": 50, "assumptions": "Azure PostgreSQL Server."},
        )

    if component_type == "storage":
        return _mapping(
            "Azure Blob Storage (LRS GPv2)",
            [
                {
                    "serviceName": "Azure Files",
                    "reason": "Chose Blob Storage because the application requires flat block media objects. Azure Files is optimized for SMB/NFS file share mounts.",
                    "costEstimate": {
                        "min": 6,
                        "max": 160 if is_high_scale else 35,
                        "assumptions": "Azure Files Premium tier ($0.16/GB-provisioned) for SMB/NFS mounts, provisioned capacity billed regardless of usage.",
                    },
                }
            ],
            {
                "min": 1,
                "max": 85 if is_high_scale else 15,
                "assumptions": "Hot Tier blob storage capacity costs ($0.018/GB) + transactional operations.",
            },
        )

    if component_type == "queue":
        return _mapping(
            "Azure Service Bus (Standard)",
            [
                {
                    "serviceName": "Azure Queue Storage",
                    "reason": "Chose Service Bus Standard because it supports advanced FIFO, transactions, and pub/sub routing. Queue Storage is cheaper but supports only basic queuing.",
                    "costEstimate": {
                        "min": 0,
                        "max": 10 if is_high_scale else 3,
                        "assumptions": "Azure Queue Storage pay-per-operation pricing ($0.0036/10k operations), no fixed monthly base fee.",
                    },
                }
            ],
            {
                "min": 10,
                "max": 35 if is_high_scale else 15,
                "assumptions": "Service Bus Standard base price ($10/mo) which includes 10 million transactions.",
            },
        )

    if component_type == "cache":
        return _mapping(
            "Azure Cache for Redis (Basic C0)",
            [
                {
                    "serviceName": "Azure Cosmos DB Integrated Cache",
                    "reason": "Chose Redis because it supports multi-service session and schema caches. Cosmos DB integrated cache is restricted purely to Cosmos DB reads.",
                    "costEstimate": {
                        "min": 0,
                        "max": 60 if is_high_scale else 15,
                        "assumptions": "Cosmos DB Integrated Cache billed as additional RU consumption on the existing Cosmos DB account, no standalone node cost.",
                    },
                }
            ],
            {
                "min": 16,
                "max": 95 if is_high_scale else 30,
                "assumptions": "Basic tier C0 instance (250MB RAM) for low latency key caching.",
            },
        )

    if component_type == "auth":
        return _mapping(
            "Microsoft Entra ID B2C",
            [
                {
                    "serviceName": "Auth0 / Clerk SaaS",
                    "reason": "Chose Entra ID B2C due to its generous free tier limit (50,000 monthly active users) and direct Microsoft ecosystem integration.",
                    "costEstimate": {
                        "min": 99 if is_high_scale else 0,
                        "max": 250 if is_high_scale else 35,
                        "assumptions": "Auth0/Clerk paid tier pricing kicks in above ~1,000 MAUs on the free plan, then per-MAU billing.",
                    },
                }
            ],
            {
                "min": 0,
                "max": 40 if is_high_scale else 0,
                "assumptions": "Entra ID B2C pricing: 50,000 MAUs free, then standard verification fees.",
            },
        )

    if component_type == "tokenization":
        return _mapping(
            "Azure Key Vault + Dedicated Tokenization Microservice (Container Apps)",
            [
                {
                    "serviceName": "Third-Party Tokenization Vault (e.g. Basis Theory, VGS)",
                    "reason": "Chose a self-managed Key Vault-backed microservice to keep full control of the tokenization boundary. A third-party vault offloads PCI-DSS scope entirely but adds a recurring per-transaction vendor fee and an external dependency in the payment path.",
                    "costEstimate": {
                        "min": 200,
                        "max": 1500 if is_high_scale else 500,
                        "assumptions": "Third-party tokenization vault per-transaction/per-token pricing plus a monthly platform fee.",
                    },
                }
            ],
            {
                "min": 45,
                "max": 310 if is_high_scale else 110,
                "assumptions": "Key Vault Premium (HSM-backed keys) + a small dedicated Container App (0.25 vCPU, 0.5GB RAM) running the tokenization service continuously.",
            },
        )

    if component_type == "audit-log":
        return _mapping(
            "Azure Blob Storage (Immutable/WORM Policy) + Azure Monitor",
            [
                {
                    "serviceName": "Azure Data Explorer (Audit Log Analytics)",
                    "reason": "Chose Blob Storage with an immutability policy for cost-effective, provably immutable storage at scale. Data Explorer offers rich query analytics over the log history but at a materially higher baseline cost for simple append-only audit logging.",
                    "costEstimate": {
                        "min": 60,
                        "max": 400 if is_high_scale else 150,
                        "assumptions": "Data Explorer cluster with minimum compute SKU running continuously for log ingestion and query.",
                    },
                }
            ],
            {
                "min": 3,
                "max": 60 if is_high_scale else 15,
                "assumptions": "Blob Storage Hot tier with a time-based immutability policy + Azure Monitor log ingestion.",
            },
        )

    if component_type == "phi-vault":
        return _mapping(
            "Azure Health Data Services (FHIR API)",
            [
                {
                    "serviceName": "Azure Database for PostgreSQL (Encrypted, Dedicated PHI Instance)",
                    "reason": "Chose Health Data Services because it's purpose-built for healthcare data (FHIR R4) with built-in HIPAA-eligible encryption and query tooling. A dedicated encrypted PostgreSQL instance is cheaper and simpler if the data isn't already FHIR-structured.",
                    "costEstimate": {
                        "min": 20,
                        "max": 250 if is_high_scale else 80,
                        "assumptions": "Dedicated Burstable B2ms instance (KMS-encrypted) with 50GB storage, isolated from the general application database.",
                    },
                }
            ],
            {
                "min": 90,
                "max": 600 if is_high_scale else 200,
                "assumptions": "Health Data Services FHIR service charges based on stored resources plus API request volume.",
            },
        )

    if component_type == "deidentification":
        return _mapping(
            "Azure Health Data De-identification Service",
            [
                {
                    "serviceName": "Azure Purview (Data Classification + Masking)",
                    "reason": "Chose the purpose-built Health Data De-identification service because it directly implements the HIPAA Safe Harbor and Expert Determination methods. Purview is a more general data-governance/classification tool that needs custom masking rules configured per field.",
                    "costEstimate": {
                        "min": 5,
                        "max": 80 if is_high_scale else 25,
                        "assumptions": "Purview data map + classification scan running on a nightly batch schedule over the PHI vault export.",
                    },
                }
            ],
            {
                "min": 10,
                "max": 150 if is_high_scale else 40,
                "assumptions": "De-identification service priced per document/text unit processed, run as a nightly batch job over new PHI records.",
            },
        )

    if component_type == "monitoring":
        return _mapping(
            "Azure Monitor + Application Insights",
            [
                {
                    "serviceName": "Datadog / New Relic (Third-Party APM)",
                    "reason": "Chose native Azure Monitor + Application Insights for zero extra vendor integration and billing that stays inside the existing Azure bill. A third-party APM (Datadog/New Relic) gives richer cross-cloud tracing and a nicer dashboard UI, at a real per-host/per-GB SaaS cost on top of Azure.",
                    "costEstimate": {
                        "min": 15,
                        "max": 250 if is_high_scale else 70,
                        "assumptions": "Datadog Pro tier per-host pricing (~$15-23/host/month) plus ingested log volume charges.",
                    },
                }
            ],
            {
                "min": 3,
                "max": 90 if is_high_scale else 20,
                "assumptions": "Log Analytics ingestion/retention + Application Insights telemetry volume -- scales with log/trace volume, cheap at low scale.",
            },
        )

    if component_type == "notification":
        return _mapping(
            "Azure Service Bus (Topics)",
            [
                {
                    "serviceName": "Azure Notification Hubs",
                    "reason": "Chose Service Bus Topics to reuse the same messaging platform this design already uses for its queue (see the \"queue\" mapping above), avoiding a second messaging service to operate. Notification Hubs is purpose-built for mobile push fan-out at massive device-registration scale, the better fit if push to a large mobile user base is the primary channel.",
                    "costEstimate": {
                        "min": 0,
                        "max": 50 if is_high_scale else 10,
                        "assumptions": "Notification Hubs Free tier covers up to 1M pushes/month; paid tiers scale with registered device count.",
                    },
                }
            ],
            {
                "min": 10,
                "max": 45 if is_high_scale else 18,
                "assumptions": "Service Bus Standard tier base price (~$10/mo, includes 10M operations), shared across topics and queues in the same namespace.",
            },
        )

    return _mapping(f"Azure Mapped Service ({component_type})", [], {"min": 0, "max": 0, "assumptions": "Generic Azure component."})


def _gcp_mapping(
    component_type: str,
    component_id: str,
    requirements: dict,
    is_high_scale: bool,
    is_low_budget: bool,
    team_lower: str,
) -> dict:
    if component_type == "realtime":
        return _mapping(
            "Google Cloud Run (WebSocket Support) + Firestore Realtime Listeners",
            [
                {
                    "serviceName": "Firebase Realtime Database",
                    "reason": "Chose Cloud Run + Firestore listeners to keep real-time state in the same document database already used for the rest of the app. Firebase Realtime Database is a simpler dedicated option if the app doesn't otherwise need Firestore's query model.",
                    "costEstimate": {
                        "min": 5,
                        "max": 100 if is_high_scale else 30,
                        "assumptions": "Firebase Realtime Database billed on GB stored + GB downloaded, no per-connection fee.",
                    },
                }
            ],
            {
                "min": 10,
                "max": 110 if is_high_scale else 25,
                "assumptions": "Cloud Run instance held open for WebSocket connections + Firestore realtime listener reads/writes.",
            },
        )

    if component_type == "cdn":
        return _mapping(
            "Google Cloud CDN",
            [
                {
                    "serviceName": "Google Cloud Load Balancing (Anycast)",
                    "reason": "Chose Cloud CDN because it caches static images and assets at Google edge nodes. Raw Load Balancing only handles request routing without caching.",
                    "costEstimate": {
                        "min": 18 if is_high_scale else 5,
                        "max": 90 if is_high_scale else 20,
                        "assumptions": "Global external HTTPS Load Balancer forwarding rule + data processing fees, without edge cache offload.",
                    },
                }
            ],
            {
                "min": 15 if is_high_scale else 5,
                "max": 130 if is_high_scale else 15,
                "assumptions": "Cache lookup costs + Cloud CDN data egress fees."
                + _waf_cost_note(is_high_scale, _is_high_security(requirements)),
            },
        )

    if component_type == "compute":
        if component_id == "worker":
            if is_low_budget:
                return _mapping(
                    "Google Cloud Functions (Worker)",
                    [
                        {
                            "serviceName": "Google Cloud Run (Worker Task)",
                            "reason": "Chose Cloud Functions because it is optimized for brief, event-driven processes. Cloud Run is better for microservices that handle web traffic.",
                            "costEstimate": {
                                "min": 12,
                                "max": 110 if is_high_scale else 25,
                                "assumptions": "Container instance with 0.25 vCPU and 0.5 GB RAM running continuously.",
                            },
                        }
                    ],
                    {
                        "min": 0,
                        "max": 30 if is_high_scale else 5,
                        "assumptions": "Cloud Functions executions duration billing based on request triggers.",
                    },
                )
            return _mapping(
                "Google Cloud Run (Worker)",
                [
                    {
                        "serviceName": "Google Compute Engine (VM Instances)",
                        "reason": "Chose Cloud Run to enjoy container management abstractions and automatic scaling down to zero. VMs require active operating system patching.",
                        "costEstimate": {
                            "min": 6,
                            "max": 55 if is_high_scale else 15,
                            "assumptions": "Google Compute Engine e2-micro/small instance running continuously, cheaper than Cloud Run but requires manual patching and scaling.",
                        },
                    }
                ],
                {
                    "min": 12,
                    "max": 110 if is_high_scale else 25,
                    "assumptions": "Container instance with 0.25 vCPU and 0.5 GB RAM running continuously.",
                },
            )

        # Primary API Compute
        is_serverless_rules = is_low_budget and (
            "junior" in team_lower or "small" in team_lower or team_lower == "not_specified"
        )
        if is_serverless_rules:
            return _mapping(
                "Google Cloud Functions",
                [
                    {
                        "serviceName": "Google Cloud Run",
                        "reason": "Chose Cloud Functions for minimal serverless orchestration overhead. Cloud Run is serverless but requires containerizing the API.",
                        "costEstimate": {
                            "min": 12,
                            "max": 220 if is_high_scale else 42,
                            "assumptions": "Cloud Run CPU allocation; its fronting HTTPS Load Balancer is costed separately as the architecture's own \"lb\" component.",
                        },
                    }
                ],
                {
                    "min": 0,
                    "max": 80 if is_high_scale else 10,
                    "assumptions": "Cloud Functions execution duration costs; its fronting API Gateway is costed separately as the architecture's own \"lb\" component.",
                },
            )
        return _mapping(
            "Google Cloud Run",
            [
                {
                    "serviceName": "Google Kubernetes Engine (GKE Autopilot)",
                    "reason": "Chose Cloud Run for container deployment simplicity without GKE cluster management. GKE is better for complex multi-container pods.",
                    "costEstimate": {
                        "min": 70,
                        "max": 400 if is_high_scale else 150,
                        "assumptions": "GKE Autopilot cluster management fee ($0.10/hour, ~$73/mo) plus pod resource allocation.",
                    },
                }
            ],
            {
                "min": 12,
                "max": 220 if is_high_scale else 42,
                "assumptions": "Cloud Run CPU allocation; its fronting HTTPS Load Balancer is costed separately as the architecture's own \"lb\" component.",
            },
        )

    if component_type == "lb":
        is_serverless_rules = is_low_budget and (
            "junior" in team_lower or "small" in team_lower or team_lower == "not_specified"
        )
        is_high_sec = _is_high_security(requirements)
        if is_serverless_rules:
            return _mapping(
                "Google Cloud API Gateway",
                [
                    {
                        "serviceName": "Google Cloud Load Balancing (HTTPS)",
                        "reason": "Chose API Gateway for native Cloud Functions request routing at low idle cost. A full HTTPS Load Balancer is the right fit once compute is Cloud Run/GKE-based rather than Cloud Functions.",
                        "costEstimate": {
                            "min": 18,
                            "max": 55 if is_high_scale else 20,
                            "assumptions": "Global external HTTPS Load Balancer forwarding rule baseline (~$18/month) plus data processing fees.",
                        },
                    }
                ],
                {
                    "min": 0,
                    "max": 80 if is_high_scale else 10,
                    "assumptions": "API Gateway request pricing -- billed per call, no fixed baseline cost."
                    + _waf_cost_note(is_high_scale, is_high_sec),
                },
            )
        return _mapping(
            "Google Cloud Load Balancing (HTTPS)",
            [
                {
                    "serviceName": "Google Cloud API Gateway",
                    "reason": "Chose the HTTPS Load Balancer for global anycast routing and health checks in front of a serverless-NEG-backed compute fleet. API Gateway is the better fit once compute is Cloud Functions-based.",
                    "costEstimate": {
                        "min": 0,
                        "max": 80 if is_high_scale else 10,
                        "assumptions": "API Gateway request pricing -- billed per call, no fixed baseline cost.",
                    },
                }
            ],
            {
                "min": 18,
                "max": 55 if is_high_scale else 20,
                "assumptions": "Global external HTTPS Load Balancer forwarding rule baseline (~$18/month) plus data processing fees."
                + _waf_cost_note(is_high_scale, is_high_sec),
            },
        )

    if component_type == "dns":
        return _mapping(
            "Google Cloud DNS",
            [
                {
                    "serviceName": "Third-Party DNS (e.g. Cloudflare DNS)",
                    "reason": "Chose Cloud DNS for native alias-record integration with the HTTPS Load Balancer/API Gateway. A third-party DNS provider is a reasonable choice if DNS is already managed there for other domains.",
                    "costEstimate": {
                        "min": 0,
                        "max": 20 if is_high_scale else 5,
                        "assumptions": "Most third-party DNS providers price hosted zones/queries comparably to Cloud DNS at this volume.",
                    },
                }
            ],
            {
                "min": 0.20,
                "max": 5 if is_high_scale else 1,
                "assumptions": "Cloud DNS managed zone (~$0.20/month) plus per-million-query pricing; negligible at this traffic volume.",
            },
        )

    if component_type == "database":
        if component_id == "database":
            is_relational = is_relational_data_nature(requirements)
            if is_relational:
                if is_low_budget:
                    return _mapping(
                        "Google Cloud SQL for PostgreSQL (db-f1-micro)",
                        [
                            {
                                "serviceName": "Google Cloud Spanner",
                                "reason": "Chose Cloud SQL for small PostgreSQL database needs. Cloud Spanner is a globally distributed SQL DB with high minimum costs (~$60/mo).",
                                "costEstimate": {
                                    "min": 60,
                                    "max": 400 if is_high_scale else 150,
                                    "assumptions": "Cloud Spanner minimum 1 processing unit node (~$60/month), intended for globally distributed multi-region workloads.",
                                },
                            }
                        ],
                        {
                            "min": 10,
                            "max": 20,
                            "assumptions": "Shared-core db-f1-micro instance (1 vCPU, 0.6GB RAM) with 20GB SSD storage.",
                        },
                    )
                return _mapping(
                    "Google Cloud SQL for PostgreSQL (db-custom-1-3840)",
                    [
                        {
                            "serviceName": "Google Cloud Spanner",
                            "reason": "Chose Cloud SQL Flexible PostgreSQL for high-performance relational features. Cloud Spanner is reserved for massive multi-region database replication.",
                            "costEstimate": {
                                "min": 60,
                                "max": 400 if is_high_scale else 150,
                                "assumptions": "Cloud Spanner minimum 1 processing unit node (~$60/month), intended for globally distributed multi-region workloads.",
                            },
                        }
                    ],
                    {
                        "min": 35,
                        "max": 280 if is_high_scale else 90,
                        "assumptions": "Dedicated custom vCPU instance (1 vCPU, 3.75GB RAM) with HA cluster configured.",
                    },
                )
            return _mapping(
                "Google Cloud Firestore",
                [
                    {
                        "serviceName": "Google Cloud Bigtable",
                        "reason": "Chose Firestore as the flexible NoSQL document database. Bigtable is a wide-column store designed for multi-terabyte analytical databases.",
                        "costEstimate": {
                            "min": 450,
                            "max": 1500 if is_high_scale else 600,
                            "assumptions": "Cloud Bigtable requires a minimum 1-node cluster (~$450/month) regardless of traffic, intended for multi-terabyte analytical workloads.",
                        },
                    }
                ],
                {
                    "min": 0,
                    "max": 100 if is_high_scale else 15,
                    "assumptions": "Firestore serverless pricing based on read, write, and delete counts.",
                },
            )
        return _mapping(
            "Google Cloud SQL for PostgreSQL",
            [
                {
                    "serviceName": "Google Cloud Firestore",
                    "reason": "Chose Cloud SQL for relational storage.",
                    "costEstimate": {
                        "min": 0,
                        "max": 100 if is_high_scale else 15,
                        "assumptions": "Firestore serverless pricing based on read, write, and delete counts.",
                    },
                }
            ],
            {"min": 10, "max": 45, "assumptions": "Cloud SQL PostgreSQL instance."},
        )

    if component_type == "storage":
        return _mapping(
            "Google Cloud Storage (Standard)",
            [
                {
                    "serviceName": "Google Cloud Filestore",
                    "reason": "Chose Cloud Storage Standard because the data is flat media/image uploads. Filestore provides POSIX network-attached storage mounts for VMs.",
                    "costEstimate": {
                        "min": 200,
                        "max": 600 if is_high_scale else 250,
                        "assumptions": "Filestore Basic tier requires a minimum 1TB provisioned instance (~$200/month) for POSIX network-attached storage.",
                    },
                }
            ],
            {
                "min": 1,
                "max": 80 if is_high_scale else 15,
                "assumptions": "Standard storage capacity cost ($0.020/GB) + egress network charges.",
            },
        )

    if component_type == "queue":
        return _mapping(
            "Google Cloud Pub/Sub",
            [
                {
                    "serviceName": "Google Cloud Tasks",
                    "reason": "Chose Pub/Sub because it provides high-throughput, fan-out event pub/sub. Cloud Tasks is better for targeted queue HTTP executions (cron tasks).",
                    "costEstimate": {
                        "min": 0,
                        "max": 15 if is_high_scale else 5,
                        "assumptions": "Cloud Tasks per-operation pricing ($0.40/million operations after the free tier), intended for targeted HTTP-triggered queues.",
                    },
                }
            ],
            {
                "min": 0,
                "max": 30 if is_high_scale else 5,
                "assumptions": "Pub/Sub message volume (first 10GB of data transfer is free/month).",
            },
        )

    if component_type == "cache":
        return _mapping(
            "Google Cloud Memorystore (Redis)",
            [
                {
                    "serviceName": "Google Cloud Bigtable",
                    "reason": "Chose Memorystore for fast Redis caching. Bigtable can serve as a key-value store but is far more expensive and heavier than cache instances.",
                    "costEstimate": {
                        "min": 450,
                        "max": 1500 if is_high_scale else 600,
                        "assumptions": "Cloud Bigtable requires a minimum 1-node cluster (~$450/month), far exceeding typical cache-node costs.",
                    },
                }
            ],
            {
                "min": 15,
                "max": 90 if is_high_scale else 25,
                "assumptions": "Basic tier M1 Memorystore instance (1GB RAM capacity) running Redis.",
            },
        )

    if component_type == "auth":
        return _mapping(
            "Firebase Authentication",
            [
                {
                    "serviceName": "Google Cloud Identity Platform",
                    "reason": "Chose Firebase Authentication due to its generous free tier (50,000 MAUs free) and easy setup. Identity Platform provides advanced enterprise features at cost.",
                    "costEstimate": {
                        "min": 99 if is_high_scale else 0,
                        "max": 250 if is_high_scale else 35,
                        "assumptions": "Identity Platform enterprise features (SAML/OIDC federation, MFA) billed per-MAU above the free Firebase Auth tier.",
                    },
                }
            ],
            {
                "min": 0,
                "max": 40 if is_high_scale else 0,
                "assumptions": "Firebase Authentication free for standard phone/email accounts up to 50k MAUs.",
            },
        )

    if component_type == "tokenization":
        return _mapping(
            "Google Cloud KMS + Dedicated Tokenization Microservice (Cloud Run)",
            [
                {
                    "serviceName": "Third-Party Tokenization Vault (e.g. Basis Theory, VGS)",
                    "reason": "Chose a self-managed KMS-backed microservice to keep full control of the tokenization boundary. A third-party vault offloads PCI-DSS scope entirely but adds a recurring per-transaction vendor fee and an external dependency in the payment path.",
                    "costEstimate": {
                        "min": 200,
                        "max": 1500 if is_high_scale else 500,
                        "assumptions": "Third-party tokenization vault per-transaction/per-token pricing plus a monthly platform fee.",
                    },
                }
            ],
            {
                "min": 35,
                "max": 280 if is_high_scale else 90,
                "assumptions": "Cloud KMS key usage fees + a small dedicated Cloud Run service (0.25 vCPU, 0.5GB RAM) running the tokenization service continuously.",
            },
        )

    if component_type == "audit-log":
        return _mapping(
            "Google Cloud Storage (Bucket Lock — Immutable) + Cloud Audit Logs",
            [
                {
                    "serviceName": "Google Cloud Logging (Log Analytics)",
                    "reason": "Chose Cloud Storage with Bucket Lock for cost-effective, provably immutable storage at scale. Log Analytics offers rich SQL-based querying over the log history but at a materially higher baseline cost for simple append-only audit logging.",
                    "costEstimate": {
                        "min": 60,
                        "max": 400 if is_high_scale else 150,
                        "assumptions": "Log Analytics-linked bucket with extended retention and BigQuery-style query volume.",
                    },
                }
            ],
            {
                "min": 3,
                "max": 60 if is_high_scale else 15,
                "assumptions": "Cloud Storage Standard tier with a Bucket Lock retention policy + Cloud Audit Logs (Admin Activity logs are free).",
            },
        )

    if component_type == "phi-vault":
        return _mapping(
            "Google Cloud Healthcare API (FHIR Store)",
            [
                {
                    "serviceName": "Google Cloud SQL for PostgreSQL (Encrypted, Dedicated PHI Instance)",
                    "reason": "Chose the Healthcare API because it's purpose-built for healthcare data (FHIR/HL7v2/DICOM) with built-in HIPAA-eligible encryption and query tooling. A dedicated encrypted Cloud SQL instance is cheaper and simpler if the data isn't already FHIR-structured.",
                    "costEstimate": {
                        "min": 20,
                        "max": 250 if is_high_scale else 80,
                        "assumptions": "Dedicated db-custom-1-3840 instance (KMS-encrypted) with 50GB storage, isolated from the general application database.",
                    },
                }
            ],
            {
                "min": 90,
                "max": 600 if is_high_scale else 200,
                "assumptions": "Healthcare API FHIR store charges based on stored resources plus API request/storage volume.",
            },
        )

    if component_type == "deidentification":
        return _mapping(
            "Google Cloud DLP API (De-identification Templates)",
            [
                {
                    "serviceName": "Cloud Healthcare API De-identify Operation",
                    "reason": "Chose the standalone DLP API for flexible, reusable de-identification templates across any text/structured source. The Healthcare API's built-in de-identify operation is more convenient when the PHI is already stored as FHIR resources in the same service.",
                    "costEstimate": {
                        "min": 8,
                        "max": 120 if is_high_scale else 35,
                        "assumptions": "Healthcare API de-identify operation priced per FHIR resource processed, run as a nightly batch job.",
                    },
                }
            ],
            {
                "min": 10,
                "max": 150 if is_high_scale else 40,
                "assumptions": "Cloud DLP API priced per unit of data inspected/transformed, run as a nightly batch job over new PHI records.",
            },
        )

    if component_type == "monitoring":
        return _mapping(
            "Google Cloud Operations Suite (Monitoring + Logging)",
            [
                {
                    "serviceName": "Datadog / New Relic (Third-Party APM)",
                    "reason": "Chose native Cloud Operations Suite for zero extra vendor integration and billing that stays inside the existing GCP bill. A third-party APM (Datadog/New Relic) gives richer cross-cloud tracing and a nicer dashboard UI, at a real per-host/per-GB SaaS cost on top of GCP.",
                    "costEstimate": {
                        "min": 15,
                        "max": 250 if is_high_scale else 70,
                        "assumptions": "Datadog Pro tier per-host pricing (~$15-23/host/month) plus ingested log volume charges.",
                    },
                }
            ],
            {
                "min": 3,
                "max": 90 if is_high_scale else 20,
                "assumptions": "Cloud Logging ingestion/storage + Cloud Monitoring custom metrics and dashboards -- scales with log volume, cheap at low scale (50GB/month logging is free).",
            },
        )

    if component_type == "notification":
        return _mapping(
            "Google Cloud Pub/Sub",
            [
                {
                    "serviceName": "Third-Party Multi-Channel Provider (e.g. Twilio, SendGrid)",
                    "reason": "Chose Pub/Sub because GCP has no dedicated end-user notification product distinct from its own queue -- Pub/Sub already serves both the queue and fan-out-notification roles here, unlike AWS/Azure's SNS-vs-SQS split. A third-party provider (Twilio/SendGrid) is the right call once actual SMS/email/push delivery to end users (not just internal fan-out) is needed, since Pub/Sub itself has no delivery channel of its own.",
                    "costEstimate": {
                        "min": 20,
                        "max": 300 if is_high_scale else 80,
                        "assumptions": "Twilio/SendGrid per-message channel pricing (SMS/email/push) plus a monthly platform fee.",
                    },
                }
            ],
            {
                "min": 0,
                "max": 30 if is_high_scale else 5,
                "assumptions": "Pub/Sub message volume pricing (first 10GB/month free) -- the same pricing shape as the \"queue\" mapping above, since it's the same underlying service.",
            },
        )

    return _mapping(f"GCP Mapped Service ({component_type})", [], {"min": 0, "max": 0, "assumptions": "Generic GCP component."})


def _kubernetes_mapping(component_type: str, component_id: str, is_high_scale: bool, is_low_ops_capacity: bool) -> dict:
    if component_type == "realtime":
        return _mapping(
            "Deployment + Service (WebSocket-Capable Ingress, Sticky Sessions)",
            [
                {
                    "serviceName": "External Managed WebSocket Service (e.g. Ably/Pusher)",
                    "reason": "Chose an in-cluster WebSocket-capable Deployment for full control and no per-message vendor billing. A managed service (Ably/Pusher) removes the need to handle sticky-session load balancing and horizontal fan-out yourself, at the cost of a recurring per-connection fee.",
                    "costEstimate": {
                        "min": 49,
                        "max": 300 if is_high_scale else 100,
                        "assumptions": "Managed WebSocket-as-a-service pricing tier, billed per concurrent connection.",
                    },
                }
            ],
            {
                "min": 5,
                "max": 40 if is_high_scale else 15,
                "assumptions": "In-cluster Deployment + Service with sticky-session Ingress annotations; incremental cost only, no external per-connection billing.",
            },
        )

    if component_type == "cdn":
        return _mapping(
            "Ingress-NGINX + cert-manager (Cluster-Level TLS)",
            [
                {
                    "serviceName": "External CDN (Cloudflare/Fastly) in Front of Ingress",
                    "reason": "Chose in-cluster Ingress-NGINX for a fully self-contained setup. An external CDN adds real edge caching/offload for static assets but introduces a dependency outside the cluster and its own billing.",
                    "costEstimate": {
                        "min": 20 if is_high_scale else 0,
                        "max": 150 if is_high_scale else 20,
                        "assumptions": "Third-party CDN usage-based pricing layered in front of the cluster Ingress for static asset offload.",
                    },
                }
            ],
            {
                "min": 5,
                "max": 40 if is_high_scale else 15,
                "assumptions": "Ingress-NGINX controller (2 replicas) + cert-manager pods running within existing cluster capacity — incremental infra cost only, no edge network.",
            },
        )

    if component_type == "lb":
        # Conceptually the same role the AWS/Azure/GCP "lb" mapping plays -- the cluster's own
        # Ingress controller is the L7 routing/health-check/TLS-termination layer in front of
        # compute. Named distinctly from the "cdn" branch above (which also happens to return an
        # Ingress-NGINX + cert-manager pairing, since Kubernetes has no provider-specific CDN
        # edge network of its own) to keep the routing role and the TLS/edge-caching role legible
        # as separate concerns even when both resolve to the same underlying controller.
        return _mapping(
            "Ingress-NGINX Controller (LoadBalancer Service, L7 Routing + Health Checks)",
            [
                {
                    "serviceName": "Cloud Load Balancer (Provisioned Directly, Bypassing Ingress)",
                    "reason": "Chose Ingress-NGINX for a portable, provider-agnostic routing layer defined declaratively as cluster config. Provisioning the cloud host's native load balancer directly is possible but ties the manifests to one specific cloud, defeating the point of a Kubernetes-first deployment target.",
                    "costEstimate": {
                        "min": 18 if is_high_scale else 0,
                        "max": 60 if is_high_scale else 20,
                        "assumptions": "Native cloud load balancer (ALB/App Gateway/Cloud LB) billed directly by whichever cloud host the cluster runs on, outside Kubernetes' own cost accounting.",
                    },
                }
            ],
            {
                "min": 5,
                "max": 40 if is_high_scale else 15,
                "assumptions": "Ingress-NGINX controller (2 replicas) running within existing cluster capacity, plus the cloud host's underlying LoadBalancer Service billing for the external IP itself.",
            },
        )

    if component_type == "dns":
        return _mapping(
            "ExternalDNS Operator (Syncs Ingress Hostnames to an External DNS Provider)",
            [
                {
                    "serviceName": "Manually Managed DNS Records (No In-Cluster Automation)",
                    "reason": "Chose the ExternalDNS operator so DNS records stay in sync automatically whenever an Ingress hostname changes. Manually managing records avoids running an extra in-cluster controller, at the cost of a manual step on every hostname change.",
                    "costEstimate": {
                        "min": 0,
                        "max": 5 if is_high_scale else 1,
                        "assumptions": "DNS record changes made by hand against whichever DNS provider hosts the zone; no automation cost, but no automation either.",
                    },
                }
            ],
            {
                "min": 0,
                "max": 5 if is_high_scale else 1,
                "assumptions": "ExternalDNS runs as a small in-cluster Deployment; the actual DNS hosting/query cost is billed by whichever external provider (Route 53/Cloud DNS/etc.) holds the zone, not by the cluster itself.",
            },
        )

    if component_type == "compute":
        if component_id == "worker":
            return _mapping(
                "Deployment (Worker Pool) + KEDA (Event-Driven Autoscaling)",
                [
                    {
                        "serviceName": "CronJob (Scheduled/Batch-Only Workers)",
                        "reason": "Chose KEDA to scale worker pods in direct response to queue depth. A CronJob is simpler and cheaper but only suits fixed-schedule batch work, not reactive queue processing.",
                        "costEstimate": {
                            "min": 5,
                            "max": 60 if is_high_scale else 20,
                            "assumptions": "CronJob pods only run on their configured schedule, so cost is proportional to job duration rather than continuous replica count.",
                        },
                    }
                ],
                {
                    "min": 10,
                    "max": 150 if is_high_scale else 40,
                    "assumptions": "Worker pod resource requests scaled by KEDA based on queue depth, plus the KEDA operator's own small footprint.",
                },
            )

        return _mapping(
            "Deployment + HorizontalPodAutoscaler (HPA)",
            [
                {
                    "serviceName": "Knative Serving (Scale-to-Zero)",
                    "reason": "Chose standard Deployment+HPA for predictable steady-state load. Knative Serving scales pods to zero when idle, which suits spiky/intermittent traffic better, but adds cold-start latency and an extra control-plane component to operate.",
                    "costEstimate": {
                        "min": 0,
                        "max": 300 if is_high_scale else 80,
                        "assumptions": "Knative Serving scales to zero replicas when idle, so cost tracks actual request volume rather than a constant baseline.",
                    },
                }
            ],
            {
                "min": 60 if is_high_scale else 15,
                "max": 400 if is_high_scale else 100,
                "assumptions": "Pod resource requests (CPU/memory) as a share of overall cluster node cost; assumes cluster capacity is provisioned/billed separately.",
            },
        )

    if component_type == "database":
        if is_low_ops_capacity:
            return _mapping(
                "External Managed Database (e.g. RDS/Cloud SQL) + K8s Secret Binding",
                [
                    {
                        "serviceName": "StatefulSet (Self-Managed PostgreSQL, e.g. CloudNativePG)",
                        "reason": "Strongly recommended external managed database given the team's low operational maturity/tight budget — self-managing a stateful database on Kubernetes (failover, backups, patching, upgrades) is a significant ops burden that a managed service absorbs for you.",
                        "costEstimate": {
                            "min": 20,
                            "max": 200 if is_high_scale else 60,
                            "assumptions": "Persistent volume storage + pod resource requests for a self-managed PostgreSQL StatefulSet (e.g. via the CloudNativePG operator); excludes managed-service reliability guarantees.",
                        },
                    }
                ],
                {
                    "min": 15,
                    "max": 300 if is_high_scale else 100,
                    "assumptions": "External managed database service billed by whichever cloud host the cluster runs on, connected in via an ExternalName Service + Kubernetes Secret.",
                },
            )
        return _mapping(
            "StatefulSet (Self-Managed PostgreSQL, e.g. CloudNativePG)",
            [
                {
                    "serviceName": "External Managed Database (e.g. RDS/Cloud SQL) + K8s Secret Binding",
                    "reason": "Chose self-managed for full control and to avoid a dependency outside the cluster, given adequate operational maturity to run it. A managed database removes failover/backup/patching burden entirely at the cost of that control.",
                    "costEstimate": {
                        "min": 15,
                        "max": 300 if is_high_scale else 100,
                        "assumptions": "External managed database service billed by whichever cloud host the cluster runs on, connected in via an ExternalName Service + Kubernetes Secret.",
                    },
                }
            ],
            {
                "min": 20,
                "max": 200 if is_high_scale else 60,
                "assumptions": "Persistent volume storage + pod resource requests for a self-managed PostgreSQL StatefulSet (e.g. via the CloudNativePG operator); excludes managed-service reliability guarantees.",
            },
        )

    if component_type == "storage":
        return _mapping(
            "MinIO (Self-Hosted S3-Compatible, Helm Chart)",
            [
                {
                    "serviceName": "External Object Storage (e.g. S3/GCS) via K8s Secret",
                    "reason": "Chose MinIO to keep object storage inside the cluster's own infrastructure footprint. An external provider removes disk capacity planning and backup responsibility for the object store entirely.",
                    "costEstimate": {
                        "min": 1,
                        "max": 80 if is_high_scale else 15,
                        "assumptions": "External object storage billed by the cloud host, connected in via a Kubernetes Secret holding provider credentials.",
                    },
                }
            ],
            {
                "min": 10,
                "max": 120 if is_high_scale else 40,
                "assumptions": "MinIO StatefulSet with persistent volumes for object storage; requires its own disk capacity provisioning and backup strategy.",
            },
        )

    if component_type == "queue":
        return _mapping(
            "RabbitMQ (Helm Chart, Bitnami)",
            [
                {
                    "serviceName": "NATS JetStream (Helm Chart)",
                    "reason": "Chose RabbitMQ for its mature tooling and broad client library support. NATS JetStream is lighter-weight and higher-throughput but has a smaller operational ecosystem and less mature management tooling.",
                    "costEstimate": {
                        "min": 8,
                        "max": 100 if is_high_scale else 30,
                        "assumptions": "NATS JetStream StatefulSet (3-node cluster) with persistent volumes — generally lighter resource footprint than RabbitMQ.",
                    },
                }
            ],
            {
                "min": 15,
                "max": 150 if is_high_scale else 40,
                "assumptions": "RabbitMQ StatefulSet (3-node cluster for HA) via the Bitnami Helm chart, with persistent volumes.",
            },
        )

    if component_type == "cache":
        return _mapping(
            "Redis (Helm Chart, Bitnami)",
            [
                {
                    "serviceName": "External Managed Cache (e.g. ElastiCache/Memorystore)",
                    "reason": "Chose self-managed Redis to avoid a dependency outside the cluster. A managed cache removes node failover and version-upgrade responsibility at the cost of that independence.",
                    "costEstimate": {
                        "min": 12,
                        "max": 90 if is_high_scale else 25,
                        "assumptions": "Managed cache service billed by the cloud host, reached from in-cluster pods over a private network path.",
                    },
                }
            ],
            {
                "min": 10,
                "max": 100 if is_high_scale else 30,
                "assumptions": "Redis StatefulSet (Bitnami Helm chart) with a persistent volume for optional AOF persistence.",
            },
        )

    if component_type == "auth":
        return _mapping(
            "Keycloak (Helm Chart)",
            [
                {
                    "serviceName": "External OIDC Provider (e.g. Auth0/Cognito)",
                    "reason": "Chose self-hosted Keycloak to keep identity fully inside the cluster's own infrastructure. An external OIDC provider removes the operational burden of running and patching an identity server at the cost of a per-MAU vendor fee.",
                    "costEstimate": {
                        "min": 0,
                        "max": 250 if is_high_scale else 35,
                        "assumptions": "External OIDC provider (e.g. Auth0/Cognito) paid-tier pricing above its free-tier MAU threshold.",
                    },
                }
            ],
            {
                "min": 15,
                "max": 100 if is_high_scale else 35,
                "assumptions": "Keycloak Deployment (2+ replicas for HA) backed by its own small PostgreSQL StatefulSet, via the Keycloak Operator or Bitnami Helm chart.",
            },
        )

    if component_type == "tokenization":
        return _mapping(
            "HashiCorp Vault (Helm Chart) + Dedicated Tokenization Deployment",
            [
                {
                    "serviceName": "External Tokenization Vault (e.g. Basis Theory, VGS)",
                    "reason": "Chose self-hosted Vault to keep the tokenization boundary and key material entirely inside cluster-managed infrastructure. A third-party vault offloads PCI-DSS scope entirely but adds a recurring per-transaction vendor fee and an external dependency in the payment path.",
                    "costEstimate": {
                        "min": 200,
                        "max": 1500 if is_high_scale else 500,
                        "assumptions": "Third-party tokenization vault per-transaction/per-token pricing plus a monthly platform fee.",
                    },
                }
            ],
            {
                "min": 40,
                "max": 350 if is_high_scale else 120,
                "assumptions": "Vault StatefulSet in HA mode (3 replicas, Raft storage backend) + a small dedicated tokenization Deployment.",
            },
        )

    if component_type == "audit-log":
        return _mapping(
            "Falco + Audit Sink (Fluentd → Immutable Object Store)",
            [
                {
                    "serviceName": "Self-Hosted SIEM (e.g. Wazuh)",
                    "reason": "Chose Falco for its purpose-built Kubernetes runtime security/audit event detection. A full SIEM like Wazuh offers broader correlation and alerting but is materially heavier to operate for audit-log-only needs.",
                    "costEstimate": {
                        "min": 30,
                        "max": 250 if is_high_scale else 90,
                        "assumptions": "Wazuh manager + indexer StatefulSets with persistent volumes for the full SIEM stack.",
                    },
                }
            ],
            {
                "min": 15,
                "max": 150 if is_high_scale else 50,
                "assumptions": "Falco DaemonSet (one pod per node, runtime audit events) + a Fluentd sidecar shipping logs to an immutable MinIO bucket or external object store.",
            },
        )

    if component_type == "phi-vault":
        return _mapping(
            "Encrypted PVC (StorageClass: Encrypted) + Sealed Secrets",
            [
                {
                    "serviceName": "External HIPAA-Eligible Managed Database",
                    "reason": "Chose an in-cluster encrypted PersistentVolumeClaim with Sealed Secrets for credential management to keep PHI inside cluster-managed infrastructure. An external managed database shifts encryption/backup/patching responsibility to the provider at the cost of a dependency outside the cluster.",
                    "costEstimate": {
                        "min": 20,
                        "max": 250 if is_high_scale else 80,
                        "assumptions": "External HIPAA-eligible managed database service billed by the cloud host, isolated in its own private subnet.",
                    },
                }
            ],
            {
                "min": 25,
                "max": 250 if is_high_scale else 80,
                "assumptions": "Dedicated StatefulSet backed by an encrypted-at-rest StorageClass (e.g. cloud-provider EBS/PD with KMS, or LUKS-encrypted local storage) + Sealed Secrets for credential management.",
            },
        )

    if component_type == "deidentification":
        return _mapping(
            "Microsoft Presidio (Self-Hosted, Helm/Deployment)",
            [
                {
                    "serviceName": "Batch CronJob with Custom NLP Masking Rules",
                    "reason": "Chose Presidio because it's a purpose-built open-source PHI/PII detection and anonymization toolkit. A hand-rolled CronJob with custom masking rules is cheaper to run but requires maintaining detection logic yourselves.",
                    "costEstimate": {
                        "min": 5,
                        "max": 80 if is_high_scale else 25,
                        "assumptions": "Lightweight CronJob pod running custom masking rules on a nightly schedule, no dedicated NLP model serving.",
                    },
                }
            ],
            {
                "min": 10,
                "max": 120 if is_high_scale else 35,
                "assumptions": "Presidio Analyzer + Anonymizer Deployments, invoked by a nightly CronJob-triggered batch process over new PHI records.",
            },
        )

    if component_type == "monitoring":
        return _mapping(
            "Prometheus + Grafana (kube-prometheus-stack, Helm Chart)",
            [
                {
                    "serviceName": "Managed Observability (e.g. Datadog/Grafana Cloud)",
                    "reason": "Chose the self-hosted kube-prometheus-stack to keep metrics/logs/dashboards inside the cluster's own infrastructure with no per-host SaaS billing. A managed observability platform removes the operational burden of running and scaling Prometheus' own storage, at a real per-host/per-GB vendor cost.",
                    "costEstimate": {
                        "min": 15,
                        "max": 250 if is_high_scale else 70,
                        "assumptions": "Managed observability SaaS per-host/per-GB-ingested pricing.",
                    },
                }
            ],
            {
                "min": 10,
                "max": 120 if is_high_scale else 35,
                "assumptions": "Prometheus + Grafana + Alertmanager pods with persistent volumes for metrics storage; scales with retention window and cluster size.",
            },
        )

    if component_type == "notification":
        return _mapping(
            "NATS JetStream (Pub/Sub Fan-Out, Helm Chart)",
            [
                {
                    "serviceName": "External Managed Notification Service (e.g. SNS/Pub/Sub) via K8s Secret",
                    "reason": "Chose self-hosted NATS JetStream pub/sub for fan-out delivery inside the cluster's own infrastructure footprint. An external managed service (SNS/Pub/Sub) offloads actual email/SMS/push delivery to real end-user channels, which nothing self-hosted in-cluster can do on its own anyway.",
                    "costEstimate": {
                        "min": 0,
                        "max": 40 if is_high_scale else 5,
                        "assumptions": "External managed notification service billed by the cloud host, reached from in-cluster pods via a Kubernetes Secret holding credentials.",
                    },
                }
            ],
            {
                "min": 8,
                "max": 100 if is_high_scale else 30,
                "assumptions": "NATS JetStream StatefulSet (3-node cluster) with persistent volumes; a real delivery channel (email/SMS/push provider) still needs to be wired in as an external dependency, since nothing in-cluster can deliver to end users directly.",
            },
        )

    return _mapping(
        f"Kubernetes Mapped Workload ({component_type})", [], {"min": 0, "max": 0, "assumptions": "Generic in-cluster workload."}
    )


def _private_mapping(component_type: str, component_id: str, is_high_scale: bool) -> dict:
    if component_type == "realtime":
        return _mapping(
            "Self-Managed WebSocket Server (Socket.IO/Node.js Cluster) Behind Reverse Proxy",
            [
                {
                    "serviceName": "Hosted Managed WebSocket Service (Ably/Pusher) Over the Internet",
                    "reason": "Chose a self-managed WebSocket cluster to keep real-time traffic entirely on-premises. A hosted managed service is simpler to operate but means real-time traffic leaves the private network, which may not be acceptable for this deployment's data-residency posture.",
                    "costEstimate": {
                        "min": 49,
                        "max": 300 if is_high_scale else 100,
                        "assumptions": "Managed WebSocket-as-a-service pricing tier, billed per concurrent connection, plus egress from the private network to reach it.",
                    },
                }
            ],
            {
                "min": 10,
                "max": 60 if is_high_scale else 25,
                "assumptions": "Amortized VM cost for a small Socket.IO/Node.js cluster with sticky-session reverse-proxy config; no elastic capacity, sized ahead of time.",
            },
        )

    if component_type == "cdn":
        return _mapping(
            "Reverse Proxy (NGINX/HAProxy) — No CDN Edge Network On-Premises",
            [
                {
                    "serviceName": "Hybrid: External CDN in Front of On-Prem Origin",
                    "reason": "Chose a plain reverse proxy since private infrastructure has no edge network of its own. Layering a commercial CDN (e.g. Cloudflare) in front of your on-prem origin restores edge caching at the cost of routing public traffic through a third party.",
                    "costEstimate": {
                        "min": 20 if is_high_scale else 0,
                        "max": 150 if is_high_scale else 20,
                        "assumptions": "Third-party CDN usage-based pricing layered in front of the on-prem origin.",
                    },
                }
            ],
            {
                "min": 5,
                "max": 20,
                "assumptions": "NGINX/HAProxy reverse-proxy VM(s). No edge caching network — static assets are served from origin unless a hybrid CDN is added in front.",
            },
        )

    if component_type == "lb":
        return _mapping(
            "Self-Managed Load Balancer (HAProxy/NGINX on Dedicated VM)",
            [
                {
                    "serviceName": "Hardware Load Balancer Appliance (e.g. F5 BIG-IP)",
                    "reason": "Chose software HAProxy/NGINX for lower cost and full configuration control. A dedicated hardware appliance offers higher raw throughput and vendor support at a significant capital expense.",
                    "costEstimate": {
                        "min": 5000,
                        "max": 20000,
                        "assumptions": "Dedicated hardware load balancer appliance purchase/lease, amortized monthly — a significant capital expense.",
                    },
                }
            ],
            {
                "min": 60 if is_high_scale else 25,
                "max": 250 if is_high_scale else 90,
                "assumptions": "Dedicated VM(s) running HAProxy/NGINX in an active/passive or active/active pair. Flag: no managed failover — health checks, TLS certificate renewal, and failover are fully manual operational responsibilities.",
            },
        )

    if component_type == "dns":
        return _mapping(
            "Manually Managed DNS Records (Existing Corporate DNS / BIND Server)",
            [
                {
                    "serviceName": "Managed DNS Provider (Hybrid — Public Records Only)",
                    "reason": "Chose the existing corporate DNS infrastructure to keep internal/private records under the same authority private infrastructure already uses. A managed public DNS provider is a reasonable hybrid for just the public-facing record if one is needed.",
                    "costEstimate": {
                        "min": 0,
                        "max": 5 if is_high_scale else 1,
                        "assumptions": "Managed public DNS provider pricing for the subset of records that need to be internet-resolvable.",
                    },
                }
            ],
            {
                "min": 0,
                "max": 0,
                "assumptions": "Flag: no managed DNS automation on-premises — record changes (including any future failover routing) are a manual change against the existing DNS server, with no API-driven update path.",
            },
        )

    if component_type == "compute":
        if component_id == "worker":
            return _mapping(
                "Dedicated Worker VM Pool (Manual Scaling)",
                [
                    {
                        "serviceName": "Shared Compute Pool (Time-Sliced with API Workload)",
                        "reason": "Chose a dedicated worker VM pool for predictable background-job capacity. Sharing the compute pool with the API workload is cheaper but risks background jobs starving user-facing request latency during load spikes.",
                        "costEstimate": {
                            "min": 100 if is_high_scale else 40,
                            "max": 400 if is_high_scale else 150,
                            "assumptions": "No dedicated worker hardware — background jobs compete with API workload on the same VM pool.",
                        },
                    }
                ],
                {
                    "min": 150 if is_high_scale else 60,
                    "max": 600 if is_high_scale else 200,
                    "assumptions": "Amortized monthly hardware + hypervisor licensing for dedicated worker VM capacity, manually sized for expected background job volume.",
                },
            )
        return _mapping(
            "Virtual Machines (VMware vSphere / OpenStack Nova) — Manual Scaling",
            [
                {
                    "serviceName": "Bare-Metal Servers",
                    "reason": "Chose virtualized compute for easier capacity re-allocation between workloads. Bare-metal offers maximum performance with no hypervisor overhead, but has the longest procurement lead time and zero flexibility to reallocate capacity later.",
                    "costEstimate": {
                        "min": 500 if is_high_scale else 200,
                        "max": 2500 if is_high_scale else 700,
                        "assumptions": "Amortized monthly hardware cost for dedicated bare-metal servers, sized for peak load with no ability to burst.",
                    },
                }
            ],
            {
                "min": 400 if is_high_scale else 150,
                "max": 2000 if is_high_scale else 500,
                "assumptions": "Amortized monthly hardware + hypervisor licensing (e.g. VMware vSphere/vCenter) for dedicated VM capacity. No elastic autoscaling — capacity must be pre-provisioned for peak load.",
            },
        )

    if component_type == "database":
        return _mapping(
            "Self-Managed PostgreSQL on Dedicated VM (Manual HA/Failover)",
            [
                {
                    "serviceName": "Licensed Enterprise Database Appliance (e.g. Oracle On-Prem)",
                    "reason": "Chose open-source PostgreSQL to avoid per-core licensing costs. An enterprise database appliance offers vendor support and turnkey HA tooling at a significant licensing premium.",
                    "costEstimate": {
                        "min": 800 if is_high_scale else 300,
                        "max": 3000 if is_high_scale else 1200,
                        "assumptions": "Per-core enterprise database licensing plus dedicated hardware — HA/failover tooling included but at a substantial premium.",
                    },
                }
            ],
            {
                "min": 300 if is_high_scale else 100,
                "max": 1200 if is_high_scale else 400,
                "assumptions": "Dedicated VM(s) plus storage array allocation. Flag: no managed failover — HA, backups, and patching are fully manual operational responsibilities.",
            },
        )

    if component_type == "storage":
        return _mapping(
            "MinIO on Dedicated Storage Array",
            [
                {
                    "serviceName": "SAN/NAS Object Storage Gateway",
                    "reason": "Chose MinIO for an S3-compatible API without a proprietary storage vendor lock-in. A SAN/NAS gateway may already exist in your data center and can be repurposed, but usually speaks a narrower protocol set.",
                    "costEstimate": {
                        "min": 300 if is_high_scale else 100,
                        "max": 1000 if is_high_scale else 350,
                        "assumptions": "Allocated capacity on existing SAN/NAS infrastructure, amortized monthly.",
                    },
                }
            ],
            {
                "min": 200 if is_high_scale else 80,
                "max": 800 if is_high_scale else 300,
                "assumptions": "Dedicated storage array capacity + server(s) running MinIO. Backup/replication strategy is a manual operational responsibility.",
            },
        )

    if component_type == "queue":
        return _mapping(
            "RabbitMQ Self-Managed on Dedicated VM",
            [
                {
                    "serviceName": "NATS Self-Managed on Dedicated VM",
                    "reason": "Chose RabbitMQ for mature tooling. NATS has a lighter footprint but the same fundamental caveat applies either way.",
                    "costEstimate": {
                        "min": 80 if is_high_scale else 30,
                        "max": 300 if is_high_scale else 100,
                        "assumptions": "Dedicated VM(s) running a self-managed NATS cluster.",
                    },
                }
            ],
            {
                "min": 100 if is_high_scale else 40,
                "max": 350 if is_high_scale else 120,
                "assumptions": "Flag: no managed queue available on-premises — RabbitMQ self-managed requires dedicated ops capacity for clustering, HA, and upgrades.",
            },
        )

    if component_type == "cache":
        return _mapping(
            "Redis Self-Managed on Dedicated VM",
            [
                {
                    "serviceName": "Shared Cache Instance (Multi-Tenant)",
                    "reason": "Chose a dedicated Redis VM for predictable latency and no noisy-neighbor risk. A shared instance is cheaper but risks contention with other workloads.",
                    "costEstimate": {
                        "min": 40 if is_high_scale else 15,
                        "max": 150 if is_high_scale else 50,
                        "assumptions": "Shared allocation on a multi-tenant cache VM.",
                    },
                }
            ],
            {
                "min": 80 if is_high_scale else 30,
                "max": 250 if is_high_scale else 90,
                "assumptions": "Dedicated VM running self-managed Redis. Failover and version upgrades are manual operational responsibilities.",
            },
        )

    if component_type == "auth":
        return _mapping(
            "Keycloak Self-Managed on Dedicated VM",
            [
                {
                    "serviceName": "Integrate with Existing On-Prem Active Directory / LDAP",
                    "reason": "Chose Keycloak for a modern OIDC-compliant identity layer. If your organization already runs Active Directory/LDAP, federating through it avoids standing up a new identity system entirely.",
                    "costEstimate": {
                        "min": 0,
                        "max": 60 if is_high_scale else 20,
                        "assumptions": "Incremental integration effort against existing AD/LDAP infrastructure — no new dedicated hardware.",
                    },
                }
            ],
            {
                "min": 60 if is_high_scale else 25,
                "max": 200 if is_high_scale else 70,
                "assumptions": "Dedicated VM(s) running Keycloak backed by its own PostgreSQL instance.",
            },
        )

    if component_type == "tokenization":
        return _mapping(
            "HashiCorp Vault Self-Managed (HA Cluster on Dedicated VMs)",
            [
                {
                    "serviceName": "Hardware Security Module (HSM) Appliance",
                    "reason": "Chose a software Vault HA cluster for lower cost and faster deployment. A dedicated HSM appliance offers stronger, certified key protection guarantees but at a much higher hardware cost and longer procurement time.",
                    "costEstimate": {
                        "min": 2000,
                        "max": 8000,
                        "assumptions": "Dedicated HSM appliance purchase/lease, amortized monthly — a significant capital expense.",
                    },
                }
            ],
            {
                "min": 250 if is_high_scale else 100,
                "max": 900 if is_high_scale else 350,
                "assumptions": "3-node Vault HA cluster on dedicated VMs (Raft storage backend) + a small dedicated tokenization service VM.",
            },
        )

    if component_type == "audit-log":
        return _mapping(
            "Self-Managed SIEM (e.g. Wazuh/ELK Stack) on Dedicated VMs",
            [
                {
                    "serviceName": "Log Files with Manual Archival to WORM Storage",
                    "reason": "Chose a full SIEM stack for searchable, correlated audit events. Plain log files with manual archival to WORM-capable storage is cheaper but requires building your own retrieval/correlation tooling.",
                    "costEstimate": {
                        "min": 60 if is_high_scale else 20,
                        "max": 250 if is_high_scale else 80,
                        "assumptions": "WORM-capable storage array allocation for archived log files, no query/correlation tooling included.",
                    },
                }
            ],
            {
                "min": 150 if is_high_scale else 60,
                "max": 600 if is_high_scale else 200,
                "assumptions": "Flag: no managed immutable storage on-premises — requires a WORM-capable storage array or write-once tape/archive tier for true audit immutability.",
            },
        )

    if component_type == "phi-vault":
        return _mapping(
            "Encrypted Volume on SAN/NAS with Manual Key Management",
            [
                {
                    "serviceName": "Dedicated HSM Appliance for Key Management",
                    "reason": "Chose manual key management (encrypted volume + a documented key custody process) to avoid additional hardware spend. A dedicated HSM appliance offers certified, tamper-resistant key storage at a much higher hardware cost.",
                    "costEstimate": {
                        "min": 2000,
                        "max": 8000,
                        "assumptions": "Dedicated HSM appliance purchase/lease, amortized monthly — a significant capital expense, recommended for real PHI at scale.",
                    },
                }
            ],
            {
                "min": 300 if is_high_scale else 120,
                "max": 1000 if is_high_scale else 400,
                "assumptions": "Encrypted SAN/NAS volume allocation for PHI, with a documented manual key-rotation and access-review process — a Business Associate Agreement is still required from any third party involved in hosting or maintaining this hardware.",
            },
        )

    if component_type == "deidentification":
        return _mapping(
            "Microsoft Presidio Self-Hosted on Dedicated VM",
            [
                {
                    "serviceName": "Manual De-identification Review Process",
                    "reason": "Chose Presidio to automate detection of the 18 HIPAA identifiers. A fully manual review process avoids any new infrastructure but does not scale past small record volumes and is far more error-prone.",
                    "costEstimate": {
                        "min": 0,
                        "max": 0,
                        "assumptions": "No infrastructure cost — cost shows up as staff time instead, and does not scale.",
                    },
                }
            ],
            {
                "min": 100 if is_high_scale else 40,
                "max": 350 if is_high_scale else 120,
                "assumptions": "Dedicated VM running Presidio Analyzer + Anonymizer, invoked by a scheduled batch job.",
            },
        )

    if component_type == "monitoring":
        return _mapping(
            "Self-Managed Monitoring Stack (Prometheus/Grafana or ELK) on Dedicated VM",
            [
                {
                    "serviceName": "Hosted SaaS Observability (Off-Premises)",
                    "reason": "Chose a self-hosted stack to keep telemetry data on-premises, matching this deployment's general data-residency posture. A hosted SaaS observability platform removes all storage/scaling operational burden but means logs and metrics leave the private network.",
                    "costEstimate": {
                        "min": 15,
                        "max": 250 if is_high_scale else 70,
                        "assumptions": "Hosted SaaS observability per-host/per-GB-ingested pricing, plus egress from the private network to reach it.",
                    },
                }
            ],
            {
                "min": 60 if is_high_scale else 25,
                "max": 200 if is_high_scale else 70,
                "assumptions": "Dedicated VM(s) running Prometheus/Grafana or an ELK stack. Storage capacity for metrics/log retention must be sized and monitored like any other stateful service here.",
            },
        )

    if component_type == "notification":
        return _mapping(
            "Self-Managed Message Bus (RabbitMQ/NATS Pub/Sub) + External Delivery Provider",
            [
                {
                    "serviceName": "Direct Integration with a Third-Party Delivery API (No Internal Bus)",
                    "reason": "Chose a self-managed pub/sub bus to decouple triggering a notification from actually sending it, matching how other messaging is handled on this infrastructure. Calling a delivery provider's API directly is simpler if fan-out volume is low enough that decoupling isn't worth the extra moving part.",
                    "costEstimate": {
                        "min": 0,
                        "max": 0,
                        "assumptions": "No internal bus cost -- cost shows up entirely as the delivery provider's per-message billing instead.",
                    },
                }
            ],
            {
                "min": 60 if is_high_scale else 25,
                "max": 200 if is_high_scale else 70,
                "assumptions": "Dedicated VM running a self-managed message bus. An external delivery provider (email/SMS/push gateway) is still required and billed separately -- nothing on-premises can deliver directly to end-user inboxes/devices.",
            },
        )

    return _mapping(
        f"Private Cloud Mapped Component ({component_type})",
        [],
        {"min": 0, "max": 0, "assumptions": "Generic on-premises component — no managed-service equivalent assumed."},
    )
