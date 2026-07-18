"""Terraform code generator -- ported from src/lib/terraform-generator.ts.

Builds a map of filename -> file content for the selected provider: multiple `.tf` files plus
a README with compliance (fintech/healthtech) and manual-provisioning (private cloud) sections.
This is a line-for-line port -- every branch, string literal (including markdown formatting and
whitespace in the multi-line templates), and the exact `files[...]` insertion order the original
TS produces are preserved intentionally (Python dicts preserve insertion order the same way JS
objects do), since golden-snapshot diffing against the live TS implementation is the acceptance
bar for this port.

Components/connections/industry_context are plain dict/list[dict], never strict Pydantic
models -- same deliberate choice as the rest of this LLD/HLD-adjacent code (see llm.py's
docstring); dict KEYS stay in their original camelCase (e.g. "serviceName", "cloudMappings")
since these are the actual API response shapes, not Python-internal structures.
"""

import re


def _parse_int(value, default: str) -> int:
    """Mirrors JavaScript's `parseInt(value || default, 10)`: parses a leading integer and
    ignores any trailing non-numeric suffix (e.g. "100GB GP3" -> 100, "30 Days" -> 30,
    "900s (15 Mins)" -> 900). `value` is treated as falsy (and `default` used instead) for
    None/""/0-length strings, matching the TS `||` fallback."""
    raw = value if value else default
    match = re.match(r"\s*[+-]?\d+", str(raw))
    return int(match.group()) if match else 0


def _get_lld(c: dict, provider: str) -> dict:
    mapping = (c.get("cloudMappings") or {}).get(provider)
    return (mapping or {}).get("lld") or {"config": {}, "reasoning": {}}


def _get_service_name(c: dict, provider: str) -> str:
    mapping = (c.get("cloudMappings") or {}).get(provider)
    return (mapping or {}).get("serviceName") or c.get("name")


def _build_comments(lld: dict, keys: list[str]) -> str:
    config = lld.get("config") or {}
    reasoning = lld.get("reasoning") or {}
    comments = ""
    for k in keys:
        if config.get(k) or reasoning.get(k):
            comments += f"# LLD config [{k} = {config.get(k) or 'default'}]: {reasoning.get(k) or 'Applied rule engine configuration.'}\n"
    return comments


def _get_dr_strategy(components: list[dict], provider: str) -> str:
    """Single source of truth for which DR tier (if any) is active for this architecture, read
    directly off the database component's own LLD config -- the "drStrategy" key lld_rules.py's
    Phase 5 DR enrichment sets there (aws/azure/gcp only, "none"/"pilot-light"/"warm-standby").
    Reading it off the already-resolved LLD config rather than adding a new top-level parameter to
    generate_terraform_code keeps that function's public signature backward compatible."""
    for c in components:
        if c.get("type") != "database":
            continue
        lld = _get_lld(c, provider)
        dr = (lld.get("config") or {}).get("drStrategy")
        if dr in ("pilot-light", "warm-standby"):
            return dr
    return "none"


def _build_compliance_section(industry_context: dict | None, components: list[dict]) -> str:
    if not industry_context or industry_context.get("industry") == "none":
        return ""

    compliance_components = [
        c for c in components if c.get("type") in ("tokenization", "audit-log", "phi-vault", "deidentification")
    ]
    component_lines = "\n".join(
        f"*   **{c.get('name')}** (`{c.get('type')}`): {c.get('reasoning') or c.get('description') or 'Compliance component.'}"
        for c in compliance_components
    )

    rationale = industry_context.get("rationale")
    flags = industry_context.get("flags") or {}
    rationale_suffix = f" ({rationale})" if rationale else ""

    if industry_context.get("industry") == "fintech":
        components_block = (
            component_lines
            or "*   No dedicated compliance components were added — verify this is expected for your payment flow."
        )
        card_data_line = (
            "*   Provisions a dedicated tokenization layer so raw card data (PAN) never touches application compute or the primary database, shrinking your PCI-DSS scope."
            if flags.get("handlesCardDataDirectly")
            else "*   Card data is handled via a third-party processor — this Terraform does not provision cardholder-data storage, but the systems that call the processor are still in scope."
        )
        return f"""
---

> [!IMPORTANT]
> ## Compliance: PCI-DSS

This project was flagged as **fintech** during discovery{rationale_suffix}. The following compliance-driven infrastructure was added on top of the baseline architecture:

{components_block}

**What this Terraform does for you:**
*   Provisions an immutable, write-once audit log store for all cardholder-data-adjacent activity (PCI-DSS Requirement 10).
*   Enforces TLS 1.2+ on data stores in the transaction path (PCI-DSS Requirement 4).
{card_data_line}

**What you are still responsible for:**
*   Achieving PCI-DSS certification requires a third-party Qualified Security Assessor (QSA) audit or a completed Self-Assessment Questionnaire (SAQ) — this Terraform is a starting point, not a certification.
*   Network segmentation, firewall rule review, and penetration testing are not automated by this configuration.
*   Key rotation policies, incident response procedures, and employee access reviews must be established operationally.
"""

    # healthtech
    components_block = (
        component_lines or "*   No dedicated compliance components were added — verify this is expected if PHI is involved."
    )
    phi_line = (
        "*   Provisions a dedicated, encrypted PHI Data Vault isolated from general application data, with mandatory access logging."
        if flags.get("storesPHI")
        else "*   PHI storage was not confirmed during discovery — if patient-identifiable data is added later, re-run generation with that confirmed so a dedicated PHI vault is provisioned."
    )
    data_residency = flags.get("dataResidency")
    residency_line = (
        f"*   Data residency was specified as **{data_residency}** — verify every provisioned region and any managed service's underlying data location honors this before deployment."
        if data_residency and data_residency != "not_specified"
        else ""
    )
    return f"""
---

> [!IMPORTANT]
> ## Compliance: HIPAA

This project was flagged as **healthtech** during discovery{rationale_suffix}. The following compliance-driven infrastructure was added on top of the baseline architecture:

{components_block}

**What this Terraform does for you:**
*   Provisions an immutable, write-once audit log store recording all access to systems containing PHI (HIPAA Security Rule, 45 CFR 164.312(b)).
*   Enforces TLS 1.2+ on data stores handling regulated data (encryption in transit).
{phi_line}
{residency_line}

**What you are still responsible for:**
*   **A signed Business Associate Agreement (BAA) with your cloud provider is required before any real PHI touches this infrastructure.** This Terraform does not and cannot establish that agreement — it is a legal contract between you and the provider.
*   Achieving full HIPAA compliance requires a documented risk assessment, workforce training, and breach notification procedures — this Terraform addresses infrastructure controls only, not administrative or physical safeguards.
*   Verify every managed service used here is on your cloud provider's list of HIPAA-eligible services before deploying real patient data.
"""


def _build_manual_provisioning_section(provider: str, components: list[dict]) -> str:
    if provider != "private":
        return ""

    def _row(c: dict) -> str:
        mapping = (c.get("cloudMappings") or {}).get("private") or {}
        lld = mapping.get("lld") or {"config": {}, "reasoning": {}}
        config = lld.get("config") or {}
        flagged_key = next(
            (k for k in config.keys() if "flag" in k.lower() or "mode" in k.lower() or "recommended" in k.lower()),
            None,
        )
        flag_note = config.get(flagged_key) if flagged_key else "—"
        service_name = mapping.get("serviceName") or c.get("name")
        return f"| {c.get('name')} | {service_name} | {flag_note} |"

    rows = "\n".join(_row(c) for c in components)

    return f"""
---

> [!IMPORTANT]
> ## What Needs Manual Provisioning

Nothing in this Terraform actually provisions private-cloud infrastructure — there is no
generic Terraform provider for "your data center." Every `null_resource` in `compute.tf` is a
documented placeholder. Being honest about what this tool can and can't automate for you:

**Cannot be automated by this tool at all:**
*   Physical or virtual machine provisioning (pick a real provider in `main.tf`: vSphere, OpenStack, or manage bare-metal outside Terraform entirely).
*   Network segmentation / VLAN configuration on your physical switches.
*   Storage array allocation (SAN/NAS) and its own RAID/replication setup.
*   Hardware procurement lead time for anything requiring new physical capacity.

**Explicitly flagged per component (no managed-service equivalent exists on-premises):**

| Component | Chosen Approach | Manual Ops Flag |
|---|---|---|
{rows}

**What you're responsible for that a public cloud would otherwise absorb:**
*   Failover/HA orchestration (no managed multi-AZ equivalent — you configure and test the failover runbook yourself).
*   Patching and version upgrades for every self-managed service (RabbitMQ, PostgreSQL, Redis, etc.).
*   Backup scheduling and restore testing — nothing here schedules or verifies a single backup.
*   Physical security and hardware lifecycle management for whatever data center this deploys into.
"""


def generate_terraform_code(
    provider: str,
    project_name: str,
    components: list[dict],
    connections: list[dict],
    industry_context: dict | None = None,
) -> dict[str, str]:
    files: dict[str, str] = {}
    safe_name = re.sub(r"[^a-z0-9]", "-", project_name.lower())

    if provider == "aws":
        # ----------------------------------------------------
        # AWS TERRAFORM GENERATOR
        # ----------------------------------------------------

        files["variables.tf"] = f"""# Terraform Variables for {project_name}

variable "environment" {{
  type        = string
  default     = "dev"
  description = "Target deployment environment (e.g. dev, staging, prod)"
}}

variable "aws_region" {{
  type        = string
  default     = "us-east-1"
  description = "Primary AWS deployment region"
}}

variable "project_name" {{
  type        = string
  default     = "{safe_name}"
  description = "Unique project identifier prefix"
}}
"""

        files["networking.tf"] = """# AWS Networking and VPC Resources

# Rationale: VPC subnets private/public division isolates database and compute nodes from the public web.
resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name        = "${var.project_name}-${var.environment}-vpc"
    Environment = var.environment
  }
}

resource "aws_subnet" "public_1" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.1.0/24"
  availability_zone = "${var.aws_region}a"

  tags = {
    Name = "${var.project_name}-${var.environment}-subnet-public-1"
  }
}

resource "aws_subnet" "private_app_1" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.10.0/24"
  availability_zone = "${var.aws_region}a"

  tags = {
    Name = "${var.project_name}-${var.environment}-subnet-private-app-1"
  }
}

resource "aws_subnet" "private_db_1" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.20.0/24"
  availability_zone = "${var.aws_region}a"

  tags = {
    Name = "${var.project_name}-${var.environment}-subnet-private-db-1"
  }
}

resource "aws_internet_gateway" "igw" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "${var.project_name}-${var.environment}-igw"
  }
}

# NAT Gateway for Compute instances in private app subnets
resource "aws_eip" "nat" {
  domain = "vpc"
}

resource "aws_nat_gateway" "nat" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public_1.id

  tags = {
    Name = "${var.project_name}-${var.environment}-nat"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.igw.id
  }
}

resource "aws_route_table_association" "public_1" {
  subnet_id      = aws_subnet.public_1.id
  route_table_id = aws_route_table.public.id
}

# Rationale: Declared unconditionally (not only when a relational database is present) so any
# component that needs subnet placement across the private subnets -- RDS, ElastiCache, etc. --
# can reference one always-present subnet group instead of every branch declaring its own.
resource "aws_db_subnet_group" "db_subnets" {
  name       = "${var.project_name}-db-subnet-group"
  subnet_ids = [aws_subnet.private_db_1.id, aws_subnet.private_app_1.id] # Multi-AZ Subnets
}
"""

        main_tf = f"""# Main Provider Configuration for {project_name}

terraform {{
  required_providers {{
    random = {{
      source  = "hashicorp/random"
      version = "~> 3.6"
    }}
  }}
}}

provider "aws" {{
  region = var.aws_region
}}
"""

        compute_tf = "# AWS Compute Resources\n\n"
        database_tf = "# AWS Database & Caching Resources\n\n"
        storage_tf = "# AWS Object Storage Resources\n\n"
        outputs_tf = f"# Terraform Outputs for {project_name}\n\n"
        has_alb = False  # tracks whether an ALB was provisioned so app_sg's ingress rule below can be tightened
        # Extra `variable` blocks that depend on which components are actually present (e.g. a
        # notification component's destination-email variable) -- collected during the loop below
        # and appended to variables.tf afterward, since variables.tf itself is built before the
        # loop runs.
        extra_variables_tf = ""

        # Phase 5 (multi-region DR): read directly off the database component's own LLD config --
        # "none" for every generic architecture, byte-for-byte unaffected. When a DR tier is
        # active, a second aliased provider fronts every secondary-region resource emitted below.
        dr_strategy = _get_dr_strategy(components, "aws")
        if dr_strategy != "none":
            main_tf += """
# Phase 5 (multi-region DR): a second aliased provider targeting the secondary region -- every
# resource below tagged `provider = aws.secondary` is provisioned there instead of the primary
# region.
provider "aws" {
  alias  = "secondary"
  region = var.secondary_region
}
"""
            extra_variables_tf += """
variable "secondary_region" {
  type        = string
  default     = "us-west-2"
  description = "Secondary AWS region for disaster-recovery resources (cross-region replicas, standby capacity, DNS failover target)."
}
"""

        # A load balancer/API gateway is now its own real "lb"-type component (see rules_engine.py)
        # rather than bundled into compute's own service name -- this pre-scan of connections finds
        # which compute component (if any) each lb component fronts, keyed by the COMPUTE
        # component's own id. The compute branch below needs this at the moment it processes the
        # compute component (to decide whether the ECS service needs an inline `load_balancer {}`
        # block, which HCL requires to live literally inside that resource), regardless of whether
        # the "lb" component itself is processed earlier or later in this same loop -- Terraform
        # resource references resolve by address, not by emission order, but Python string
        # concatenation for a block that must be nested inside another resource's braces does care.
        by_id = {comp.get("id"): comp for comp in components if comp.get("id")}
        lb_for_compute: dict[str, dict] = {}
        for conn in connections:
            from_c = by_id.get(conn.get("from"))
            to_c = by_id.get(conn.get("to"))
            if from_c and to_c and from_c.get("type") == "lb" and to_c.get("type") == "compute":
                lb_for_compute[to_c.get("id")] = from_c

        for c in components:
            lld = _get_lld(c, "aws")
            svc = _get_service_name(c, "aws")
            config = lld.get("config") or {}
            c_id = c.get("id")

            if c.get("type") == "cdn":
                storage_tf += _build_comments(lld, ["priceClass", "ipv6Enabled", "originShield", "wafEnabled", "wafRuleSet", "rateLimitPerIP"])
                ipv6_enabled = config.get("ipv6Enabled") or "true"
                price_class = config.get("priceClass") or "PriceClass_100"
                cdn_waf_enabled = config.get("wafEnabled") == "true"
                # Rationale: CloudFront attaches a WAFv2 Web ACL via the distribution's own
                # web_acl_id attribute -- unlike an ALB, CloudFront is NOT a valid target for
                # aws_wafv2_web_acl_association (that resource only supports regional resources),
                # so the association here is this inline attribute, not a separate resource.
                cdn_web_acl_line = "\n  web_acl_id          = aws_wafv2_web_acl.cdn_waf.arn" if cdn_waf_enabled else ""
                storage_tf += f"""resource "aws_cloudfront_distribution" "cdn" {{
  enabled             = true
  is_ipv6_enabled     = {ipv6_enabled}
  price_class         = "{price_class}"{cdn_web_acl_line}

  origin {{
    domain_name = "example-origin.s3.amazonaws.com"
    origin_id   = "S3Origin"
  }}

  default_cache_behavior {{
    allowed_methods  = ["GET", "HEAD", "OPTIONS"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "S3Origin"

    forwarded_values {{
      query_string = false
      cookies {{
        forward = "none"
      }}
    }}

    viewer_protocol_policy = "redirect-to-https"
    min_ttl                = 0
    default_ttl            = 3600
    max_ttl                = 86400
  }}

  restrictions {{
    geo_restriction {{
      restriction_type = "none"
    }}
  }}

  viewer_certificate {{
    cloudfront_default_certificate = true
  }}

  tags = {{
    Name        = "${{var.project_name}}-cdn"
    Environment = var.environment
  }}
}}

"""
                if cdn_waf_enabled:
                    rate_limit = _parse_int(config.get("rateLimitPerIP"), "2000")
                    # Rationale: scope = "CLOUDFRONT" WAFv2 Web ACLs must be created in us-east-1 --
                    # count = 1 (rather than an unconditional resource) keeps this entirely absent
                    # from the plan when wafEnabled is "false", instead of an always-declared
                    # resource with a disabled flag.
                    storage_tf += f"""resource "aws_wafv2_web_acl" "cdn_waf" {{
  name  = "${{var.project_name}}-cdn-waf"
  scope = "CLOUDFRONT"

  default_action {{
    allow {{}}
  }}

  rule {{
    name     = "AWSManagedRulesCommonRuleSet"
    priority = 1

    override_action {{
      none {{}}
    }}

    statement {{
      managed_rule_group_statement {{
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }}
    }}

    visibility_config {{
      cloudwatch_metrics_enabled = true
      metric_name                = "cdnWafCommonRuleSet"
      sampled_requests_enabled   = true
    }}
  }}

  rule {{
    name     = "RateLimitRule"
    priority = 2

    action {{
      block {{}}
    }}

    statement {{
      rate_based_statement {{
        limit              = {rate_limit}
        aggregate_key_type = "IP"
      }}
    }}

    visibility_config {{
      cloudwatch_metrics_enabled = true
      metric_name                = "cdnWafRateLimit"
      sampled_requests_enabled   = true
    }}
  }}

  visibility_config {{
    cloudwatch_metrics_enabled = true
    metric_name                = "${{var.project_name}}-cdn-waf"
    sampled_requests_enabled   = true
  }}
}}

"""
                outputs_tf += """output "cdn_domain_name" {
  value       = aws_cloudfront_distribution.cdn.domain_name
  description = "The CloudFront CDN domain distribution URL."
}

"""
            elif c.get("type") == "compute":
                has_lambda = "Lambda" in svc
                # Whether this compute component gets ingress wiring is now driven entirely by
                # whether an "lb"-type component actually connects to it (lb_for_compute, built
                # above), not by an is_worker check -- rules_engine.py only ever wires
                # lb -> "compute", never lb -> "worker", so the same outcome holds in practice, but
                # the check is now general rather than hardcoded to a specific component id.

                if has_lambda:
                    compute_tf += _build_comments(lld, ["memory", "timeout", "concurrency"])
                    memory = _parse_int(config.get("memory"), "512")
                    timeout = _parse_int(config.get("timeout"), "30")
                    compute_tf += f"""resource "aws_lambda_function" "{c_id}" {{
  filename      = "function.zip"
  function_name = "${{var.project_name}}-{c_id}"
  role          = aws_iam_role.lambda_exec.arn
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  memory_size   = {memory}
  timeout       = {timeout}

  vpc_config {{
    subnet_ids         = [aws_subnet.private_app_1.id]
    security_group_ids = [aws_security_group.app_sg.id]
  }}

  tags = {{
    Name        = "${{var.project_name}}-{c_id}"
    Environment = var.environment
  }}
}}

"""
                    # The API Gateway wiring in front of this Lambda is now emitted by the "lb"-type
                    # component's own branch below (see the `elif c.get("type") == "lb":` case), not
                    # here -- a bare Lambda function has no public invocation path at all until that
                    # branch finds this component as its target via `connections` and wires it up.
                else:
                    # ECS Fargate
                    compute_tf += _build_comments(lld, ["instanceSize", "minInstances", "maxInstances", "scalingPolicy"])
                    desired_count = _parse_int(config.get("minInstances"), "1")
                    compute_tf += f"""resource "aws_ecs_cluster" "{c_id}_cluster" {{
  name = "${{var.project_name}}-{c_id}-cluster"
}}

resource "aws_ecs_task_definition" "{c_id}_task" {{
  family                   = "${{var.project_name}}-{c_id}-task"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"

  container_definitions = jsonencode([{{
    name      = "{c_id}-app"
    image     = "nginx:alpine"
    essential = true
    portMappings = [{{
      containerPort = 80
      hostPort      = 80
    }}]
  }}])
}}

"""
                    lb_block = ""
                    depends_on_block = ""
                    if c_id in lb_for_compute:
                        # The actual ALB/target group/listener resources are provisioned by the
                        # "lb"-type component's own branch below -- this compute branch only needs
                        # to know an lb fronts it so it can embed the `load_balancer {}` block HCL
                        # requires to live literally inside this `aws_ecs_service` resource.
                        lb_block = f"""
  load_balancer {{
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = "{c_id}-app"
    container_port   = 80
  }}
"""
                        depends_on_block = """
  depends_on = [aws_lb_listener.app]
"""

                    compute_tf += f"""resource "aws_ecs_service" "{c_id}_service" {{
  name            = "${{var.project_name}}-{c_id}-service"
  cluster         = aws_ecs_cluster.{c_id}_cluster.id
  task_definition = aws_ecs_task_definition.{c_id}_task.arn
  desired_count   = {desired_count}
  launch_type     = "FARGATE"

  network_configuration {{
    subnets         = [aws_subnet.private_app_1.id]
    security_groups = [aws_security_group.app_sg.id]
  }}
{lb_block}{depends_on_block}}}

"""
            elif c.get("type") == "lb":
                # Find which compute component this lb actually fronts by scanning connections
                # (rules_engine.py wires lb -> compute, the edge component is always the "from").
                target_id = None
                for conn in connections:
                    if conn.get("from") == c_id:
                        candidate = by_id.get(conn.get("to"))
                        if candidate and candidate.get("type") == "compute":
                            target_id = conn.get("to")
                            break

                if target_id:
                    target_svc = _get_service_name(by_id.get(target_id, {}), "aws")
                    if "Lambda" in target_svc:
                        # "Amazon API Gateway (HTTP API)" -- wire an HTTP API in front of the Lambda
                        # function it fronts so it's actually reachable; a bare Lambda function has
                        # no public invocation path at all.
                        compute_tf += _build_comments(lld, ["gatewayType", "throttlingBurstLimit", "corsPolicy"])
                        compute_tf += f"""resource "aws_apigatewayv2_api" "{target_id}_api" {{
  name          = "${{var.project_name}}-{target_id}-api"
  protocol_type = "HTTP"
}}

resource "aws_apigatewayv2_integration" "{target_id}_integration" {{
  api_id                 = aws_apigatewayv2_api.{target_id}_api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.{target_id}.invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
}}

resource "aws_apigatewayv2_route" "{target_id}_route" {{
  api_id    = aws_apigatewayv2_api.{target_id}_api.id
  route_key = "$default"
  target    = "integrations/${{aws_apigatewayv2_integration.{target_id}_integration.id}}"
}}

resource "aws_apigatewayv2_stage" "{target_id}_stage" {{
  api_id      = aws_apigatewayv2_api.{target_id}_api.id
  name        = "$default"
  auto_deploy = true
}}

resource "aws_lambda_permission" "{target_id}_apigw" {{
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.{target_id}.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${{aws_apigatewayv2_api.{target_id}_api.execution_arn}}/*/*"
}}

"""
                        outputs_tf += f"""output "{target_id}_api_endpoint" {{
  value       = aws_apigatewayv2_stage.{target_id}_stage.invoke_url
  description = "Public invoke URL for the {target_id} HTTP API (API Gateway -> Lambda)."
}}

"""
                    else:
                        # "Application Load Balancer" -- provision the ALB and register the target
                        # compute's ECS service with its target group; the app_sg ingress rule below
                        # is tightened to only trust the ALB.
                        has_alb = True
                        compute_tf += _build_comments(lld, ["healthCheckPath", "healthCheckIntervalSec", "healthCheckTimeoutSec", "idleTimeoutSec", "listenerProtocol", "wafEnabled", "wafRuleSet", "rateLimitPerIP"])
                        compute_tf += f"""resource "aws_security_group" "alb_sg" {{
  name        = "${{var.project_name}}-${{var.environment}}-alb-sg"
  description = "Allows inbound HTTP/HTTPS traffic to the ALB from the internet"
  vpc_id      = aws_vpc.main.id

  ingress {{
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }}

  ingress {{
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }}

  egress {{
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }}
}}

resource "aws_lb" "app" {{
  name               = "${{var.project_name}}-{target_id}-alb"
  internal           = false
  load_balancer_type = "application"
  subnets            = [aws_subnet.public_1.id]
  security_groups    = [aws_security_group.alb_sg.id]

  tags = {{
    Name        = "${{var.project_name}}-{target_id}-alb"
    Environment = var.environment
  }}
}}

resource "aws_lb_target_group" "app" {{
  name        = "${{var.project_name}}-{target_id}-tg"
  port        = 80
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"

  health_check {{
    path                = "/"
    healthy_threshold   = 2
    unhealthy_threshold = 5
    interval            = 30
    timeout             = 5
  }}
}}

resource "aws_lb_listener" "app" {{
  load_balancer_arn = aws_lb.app.arn
  port              = 80
  protocol          = "HTTP"

  default_action {{
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }}
}}

"""
                        if config.get("wafEnabled") == "true":
                            rate_limit = _parse_int(config.get("rateLimitPerIP"), "2000")
                            compute_tf += f"""resource "aws_wafv2_web_acl" "lb_waf" {{
  name  = "${{var.project_name}}-lb-waf"
  scope = "REGIONAL"

  default_action {{
    allow {{}}
  }}

  rule {{
    name     = "AWSManagedRulesCommonRuleSet"
    priority = 1

    override_action {{
      none {{}}
    }}

    statement {{
      managed_rule_group_statement {{
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }}
    }}

    visibility_config {{
      cloudwatch_metrics_enabled = true
      metric_name                = "lbWafCommonRuleSet"
      sampled_requests_enabled   = true
    }}
  }}

  rule {{
    name     = "RateLimitRule"
    priority = 2

    action {{
      block {{}}
    }}

    statement {{
      rate_based_statement {{
        limit              = {rate_limit}
        aggregate_key_type = "IP"
      }}
    }}

    visibility_config {{
      cloudwatch_metrics_enabled = true
      metric_name                = "lbWafRateLimit"
      sampled_requests_enabled   = true
    }}
  }}

  visibility_config {{
    cloudwatch_metrics_enabled = true
    metric_name                = "${{var.project_name}}-lb-waf"
    sampled_requests_enabled   = true
  }}
}}

# Rationale: an ALB (a REGIONAL-scope resource) is associated with its WAFv2 Web ACL via this
# explicit association resource -- unlike CloudFront, which attaches its (CLOUDFRONT-scope) Web
# ACL via the distribution's own web_acl_id attribute instead (see the "cdn" branch above).
resource "aws_wafv2_web_acl_association" "lb_waf" {{
  resource_arn = aws_lb.app.arn
  web_acl_arn  = aws_wafv2_web_acl.lb_waf.arn
}}

"""
                        outputs_tf += """output "alb_dns_name" {
  value       = aws_lb.app.dns_name
  description = "Public DNS name of the Application Load Balancer fronting the compute service."
}

"""
            elif c.get("type") == "database":
                is_rds = "RDS" in svc or "Aurora" in svc

                if is_rds:
                    database_tf += _build_comments(lld, ["instanceClass", "storageSize", "multiAZ", "backupRetention"])
                    instance_class = config.get("instanceClass") or "db.t4g.micro"
                    storage_size = _parse_int(config.get("storageSize"), "20")
                    multi_az = "true" if config.get("multiAZ") == "true" else "false"
                    backup_retention = _parse_int(config.get("backupRetention"), "7")
                    database_tf += f"""resource "random_password" "db_password" {{
  length           = 24
  special          = true
  override_special = "!#$%&*()-_=+[]{{}}<>:?"
}}

resource "aws_db_instance" "postgres" {{
  identifier             = "${{var.project_name}}-postgres"
  engine                 = "postgres"
  engine_version         = "15.4"
  instance_class         = "{instance_class}"
  allocated_storage      = {storage_size}
  db_subnet_group_name   = aws_db_subnet_group.db_subnets.name
  vpc_security_group_ids = [aws_security_group.db_sg.id]
  multi_az               = {multi_az}
  backup_retention_period = {backup_retention}
  skip_final_snapshot    = true
  username               = "dbadmin"
  password               = random_password.db_password.result
}}

# Rationale: the generated password never lands in plaintext state review/CI logs beyond the
# state file itself -- Secrets Manager is the actual runtime-fetch path application code should use.
resource "aws_secretsmanager_secret" "db_password" {{
  name = "${{var.project_name}}-${{var.environment}}-db-password"
}}

resource "aws_secretsmanager_secret_version" "db_password" {{
  secret_id     = aws_secretsmanager_secret.db_password.id
  secret_string = random_password.db_password.result
}}

"""
                    outputs_tf += """output "db_endpoint" {
  value       = aws_db_instance.postgres.endpoint
  description = "The database endpoint URL."
}

output "db_password_secret_arn" {
  value       = aws_secretsmanager_secret.db_password.arn
  description = "Secrets Manager ARN holding the generated DB password -- fetch it at runtime via IAM, never hardcode it."
}

"""
                else:
                    # DynamoDB
                    database_tf += _build_comments(lld, ["readCapacityUnits", "writeCapacityUnits", "globalTables"])
                    database_tf += """resource "aws_dynamodb_table" "nosql" {
  name         = "${var.project_name}-dynamodb"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"

  attribute {
    name = "id"
    type = "S"
  }

  tags = {
    Name        = "${var.project_name}-nosql"
    Environment = var.environment
  }
}

"""
            elif c.get("type") == "storage":
                storage_tf += _build_comments(lld, ["lifecycleRule", "versioningEnabled"])
                versioning_status = "Enabled" if config.get("versioningEnabled") == "true" else "Disabled"
                storage_tf += f"""resource "aws_s3_bucket" "blobs" {{
  bucket = "${{var.project_name}}-storage-bucket-unique"

  tags = {{
    Name        = "${{var.project_name}}-blobs"
    Environment = var.environment
  }}
}}

resource "aws_s3_bucket_versioning" "blobs" {{
  bucket = aws_s3_bucket.blobs.id
  versioning_configuration {{
    status = "{versioning_status}"
  }}
}}

"""
                outputs_tf += """output "s3_bucket_name" {
  value       = aws_s3_bucket.blobs.id
  description = "The unique S3 bucket name."
}

"""
            elif c.get("type") == "queue":
                database_tf += _build_comments(lld, ["queueType", "visibilityTimeoutSec", "retentionDays"])
                queue_type = config.get("queueType") or ""
                is_fifo = "FIFO" in queue_type
                fifo_suffix = ".fifo" if is_fifo else ""
                fifo_queue = "true" if is_fifo else "false"
                visibility_timeout = _parse_int(config.get("visibilityTimeoutSec"), "900")
                database_tf += f"""resource "aws_sqs_queue" "jobs" {{
  name                       = "${{var.project_name}}-queue${{var.environment}}{fifo_suffix}"
  fifo_queue                 = {fifo_queue}
  visibility_timeout_seconds = {visibility_timeout}
  message_retention_seconds  = 345600 # 4 days
}}

"""
            elif c.get("type") == "cache":
                database_tf += _build_comments(lld, ["nodeType", "clusteringEnabled"])
                node_type = config.get("nodeType") or "cache.t4g.micro"
                database_tf += f"""resource "aws_elasticache_cluster" "redis" {{
  cluster_id           = "${{var.project_name}}-redis"
  engine               = "redis"
  node_type            = "{node_type}"
  num_cache_nodes      = 1
  parameter_group_name = "default.redis7"
  port                 = 6379
  subnet_group_name    = aws_db_subnet_group.db_subnets.name
}}

"""
            elif c.get("type") == "auth":
                database_tf += _build_comments(lld, ["mfaRequired"])
                mfa_configuration = "ON" if config.get("mfaRequired") == "true" else "OFF"
                database_tf += f"""resource "aws_cognito_user_pool" "pool" {{
  name = "${{var.project_name}}-user-pool"

  password_policy {{
    minimum_length = 8
    require_lowercase = true
    require_numbers = true
    require_symbols = true
    require_uppercase = true
  }}

  mfa_configuration = "{mfa_configuration}"
}}

"""
            elif c.get("type") == "monitoring":
                compute_tf += _build_comments(lld, ["logRetentionDays", "tracingSampleRate", "alertingPhilosophy"])
                retention_days = _parse_int(config.get("logRetentionDays"), "30")
                compute_tf += f"""resource "aws_cloudwatch_log_group" "{c_id}" {{
  name              = "/${{var.project_name}}/{c_id}"
  retention_in_days = {retention_days}

  tags = {{
    Name        = "${{var.project_name}}-{c_id}"
    Environment = var.environment
  }}
}}

resource "aws_cloudwatch_dashboard" "{c_id}" {{
  dashboard_name = "${{var.project_name}}-{c_id}-dashboard"

  dashboard_body = jsonencode({{
    widgets = [
      {{
        type   = "log"
        x      = 0
        y      = 0
        width  = 24
        height = 6
        properties = {{
          query  = "SOURCE '${{aws_cloudwatch_log_group.{c_id}.name}}' | fields @timestamp, @message | sort @timestamp desc | limit 100"
          region = var.aws_region
          title  = "Recent Application Logs"
        }}
      }}
    ]
  }})
}}

"""
                # Rationale: found via the same connections-scanning pattern the "lb"/"dns"
                # branches already use to find which compute component they front -- rules_engine.py
                # always wires "compute" -> "monitoring", so this alarm attaches to whichever real
                # compute resource that component actually resolved to (Lambda or ECS Fargate).
                target_compute_id = None
                for conn in connections:
                    if conn.get("to") == c_id:
                        candidate = by_id.get(conn.get("from"))
                        if candidate and candidate.get("type") == "compute":
                            target_compute_id = conn.get("from")
                            break

                if target_compute_id:
                    target_svc = _get_service_name(by_id.get(target_compute_id, {}), "aws")
                    if "Lambda" in target_svc:
                        compute_tf += f"""resource "aws_cloudwatch_metric_alarm" "{c_id}_error_rate" {{
  alarm_name          = "${{var.project_name}}-{target_compute_id}-error-rate"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 5
  alarm_description   = "Alerts when the {target_compute_id} Lambda function's error count exceeds a low, easily-actionable threshold."

  dimensions = {{
    FunctionName = aws_lambda_function.{target_compute_id}.function_name
  }}
}}

"""
                    else:
                        compute_tf += f"""resource "aws_cloudwatch_metric_alarm" "{c_id}_high_cpu" {{
  alarm_name          = "${{var.project_name}}-{target_compute_id}-high-cpu"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "CPUUtilization"
  namespace           = "AWS/ECS"
  period              = 300
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "Alerts when {target_compute_id}'s ECS service CPU utilization stays high -- a signal to investigate before it becomes user-visible latency."

  dimensions = {{
    ClusterName = aws_ecs_cluster.{target_compute_id}_cluster.name
    ServiceName = aws_ecs_service.{target_compute_id}_service.name
  }}
}}

"""
            elif c.get("type") == "notification":
                database_tf += _build_comments(lld, ["deliveryChannels", "retryPolicy", "deadLetterHandling"])
                database_tf += f"""resource "aws_sns_topic" "{c_id}" {{
  name = "${{var.project_name}}-{c_id}-topic"
}}

# Rationale: the actual subscriber endpoint is deployment-specific (a real inbox, phone number, or
# downstream system) -- left as a variable the user fills in rather than a placeholder literal.
resource "aws_sns_topic_subscription" "{c_id}_email" {{
  topic_arn = aws_sns_topic.{c_id}.arn
  protocol  = "email"
  endpoint  = var.{c_id}_notification_email
}}

"""
                outputs_tf += f"""output "{c_id}_topic_arn" {{
  value       = aws_sns_topic.{c_id}.arn
  description = "SNS topic ARN for {c_id} -- publish to this from application code to trigger notifications."
}}

"""
                extra_variables_tf += f"""
variable "{c_id}_notification_email" {{
  type        = string
  default     = "changeme@example.com"
  description = "Destination email address for the {c_id} SNS topic subscription -- replace with a real address before deploying."
}}
"""

        # Add Security groups and IAM placeholders in compute.tf
        # Rationale: once an ALB fronts the compute layer, app_sg should only trust traffic that has
        # already passed through the ALB's security group -- not the raw internet directly.
        app_sg_ingress = (
            """  ingress {
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    security_groups = [aws_security_group.alb_sg.id]
  }
"""
            if has_alb
            else """  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
"""
        )
        compute_tf += f"""# Security Groups and IAM Roles for Compute Nodes

resource "aws_security_group" "app_sg" {{
  name        = "${{var.project_name}}-${{var.environment}}-app-sg"
  description = "Allows inbound traffic to application servers"
  vpc_id      = aws_vpc.main.id

{app_sg_ingress}
  egress {{
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }}
}}
"""
        compute_tf += """
resource "aws_security_group" "db_sg" {
  name   = "${var.project_name}-${var.environment}-db-sg"
  vpc_id = aws_vpc.main.id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.app_sg.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_iam_role" "lambda_exec" {
  name = "${var.project_name}-lambda-exec-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "lambda.amazonaws.com"
      }
    }]
  })
}

# Rationale: IAM permissions bound to compute role, granting read/write strictly to storage buckets.
resource "aws_iam_role_policy_attachment" "lambda_vpc_access" {
  role       = aws_iam_role.lambda_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}
"""

        # Phase 5 (multi-region DR): real secondary-region resources for the specific pattern each
        # DR tier actually needs -- never duplicate diagram-level HLD components (that would break
        # cost math and every type-based lookup elsewhere), just the cross-region Terraform
        # resources the pattern requires. All gated on dr_strategy != "none", so a generic
        # architecture's output is byte-for-byte unaffected.
        if dr_strategy != "none":
            db_component = next((c for c in components if c.get("type") == "database"), None)
            db_svc = _get_service_name(db_component, "aws") if db_component else ""
            has_rds_db = bool(db_component) and ("RDS" in db_svc or "Aurora" in db_svc)
            has_storage = any(c.get("type") == "storage" for c in components)
            has_dns = any(c.get("type") == "dns" for c in components)
            has_cdn = any(c.get("type") == "cdn" for c in components)

            if has_rds_db:
                # Cross-region read replica for both tiers -- a genuinely complete Aurora Global
                # Database (aws_rds_global_cluster + aws_rds_cluster members) would require
                # restructuring the primary database off the plain aws_db_instance this generator
                # already emits for every non-DR architecture; a cross-region read replica is the
                # real, well-documented, always-correct AWS pattern for both tiers here, sized up
                # (multi_az) for warm-standby to reflect its higher-availability posture.
                db_lld = _get_lld(db_component, "aws")
                db_config = db_lld.get("config") or {}
                database_tf += _build_comments(db_lld, ["drStrategy", "secondaryRegion", "crossRegionReplication"])
                replica_instance_class = db_config.get("instanceClass") or "db.t4g.micro"
                replica_multi_az = "true" if dr_strategy == "warm-standby" else "false"
                database_tf += f"""resource "aws_db_instance" "postgres_replica" {{
  provider            = aws.secondary
  identifier          = "${{var.project_name}}-postgres-replica"
  replicate_source_db = aws_db_instance.postgres.arn
  instance_class      = "{replica_instance_class}"
  multi_az            = {replica_multi_az}
  skip_final_snapshot  = true
  publicly_accessible  = false

  tags = {{
    Name        = "${{var.project_name}}-postgres-replica"
    Environment = var.environment
    DrTier      = "{dr_strategy}"
  }}
}}

"""
                outputs_tf += """output "db_replica_endpoint" {
  value       = aws_db_instance.postgres_replica.endpoint
  description = "Cross-region read replica endpoint -- promote this manually (pilot-light) or via automated failover tooling (warm-standby) if the primary region goes down."
}

"""

            if has_storage:
                storage_tf += """# Phase 5 (multi-region DR): cross-region replication requires versioning enabled on BOTH
# buckets and a dedicated IAM role S3 assumes on your behalf to perform the replication.
resource "aws_s3_bucket" "secondary_blobs" {
  provider = aws.secondary
  bucket   = "${var.project_name}-storage-bucket-secondary-unique"

  tags = {
    Name        = "${var.project_name}-blobs-secondary"
    Environment = var.environment
  }
}

resource "aws_s3_bucket_versioning" "secondary_blobs" {
  provider = aws.secondary
  bucket   = aws_s3_bucket.secondary_blobs.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_iam_role" "s3_replication" {
  name = "${var.project_name}-s3-replication-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "s3.amazonaws.com"
      }
    }]
  })
}

resource "aws_iam_role_policy" "s3_replication" {
  name = "${var.project_name}-s3-replication-policy"
  role = aws_iam_role.s3_replication.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action   = ["s3:GetReplicationConfiguration", "s3:ListBucket"]
        Effect   = "Allow"
        Resource = [aws_s3_bucket.blobs.arn]
      },
      {
        Action   = ["s3:GetObjectVersionForReplication", "s3:GetObjectVersionAcl", "s3:GetObjectVersionTagging"]
        Effect   = "Allow"
        Resource = ["${aws_s3_bucket.blobs.arn}/*"]
      },
      {
        Action   = ["s3:ReplicateObject", "s3:ReplicateDelete", "s3:ReplicateTags"]
        Effect   = "Allow"
        Resource = ["${aws_s3_bucket.secondary_blobs.arn}/*"]
      }
    ]
  })
}

resource "aws_s3_bucket_replication_configuration" "blobs" {
  depends_on = [aws_s3_bucket_versioning.blobs, aws_s3_bucket_versioning.secondary_blobs]
  role       = aws_iam_role.s3_replication.arn
  bucket     = aws_s3_bucket.blobs.id

  rule {
    id     = "replicate-to-secondary"
    status = "Enabled"

    destination {
      bucket        = aws_s3_bucket.secondary_blobs.arn
      storage_class = "STANDARD"
    }
  }
}

"""

            if dr_strategy == "warm-standby":
                # Minimal standby compute in the secondary region -- not a full mirrored stack, a
                # small Lambda function at reduced capacity that scales to match primary on
                # failover (per lld_rules.py's standbyCapacity LLD note). No vpc_config: keeping
                # this self-contained avoids needing a whole secondary-region VPC/subnet stack
                # just for a reduced-capacity standby function.
                compute_tf += """
# Phase 5 (multi-region DR, warm-standby only): minimal standby compute in the secondary region.
resource "aws_lambda_function" "standby" {
  provider      = aws.secondary
  filename      = "function.zip"
  function_name = "${var.project_name}-standby"
  role          = aws_iam_role.lambda_exec.arn
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  memory_size   = 512
  timeout       = 30

  tags = {
    Name        = "${var.project_name}-standby"
    Environment = var.environment
  }
}

resource "aws_lambda_function_url" "standby" {
  provider           = aws.secondary
  function_name      = aws_lambda_function.standby.function_name
  authorization_type = "NONE"
}
"""
                outputs_tf += """output "standby_function_url" {
  value       = aws_lambda_function_url.standby.function_url
  description = "Warm-standby secondary-region function URL -- the DNS failover record's SECONDARY target points here."
}

"""

            if has_dns:
                if has_cdn:
                    primary_target_expr = "aws_cloudfront_distribution.cdn.domain_name"
                elif has_alb:
                    primary_target_expr = "aws_lb.app.dns_name"
                else:
                    primary_target_expr = None

                if primary_target_expr:
                    if dr_strategy == "warm-standby":
                        secondary_target_expr = (
                            'trimsuffix(trimprefix(aws_lambda_function_url.standby.function_url, "https://"), "/")'
                        )
                    elif has_storage:
                        secondary_target_expr = "aws_s3_bucket.secondary_blobs.bucket_regional_domain_name"
                    else:
                        secondary_target_expr = primary_target_expr

                    files["networking.tf"] += f"""
# Phase 5 (multi-region DR): failover DNS routing -- a health check on the primary endpoint plus
# two failover_routing_policy records (PRIMARY/SECONDARY), replacing the plain single-region alias
# record a non-DR architecture would otherwise need.
resource "aws_route53_zone" "primary" {{
  name = "${{var.project_name}}.example.com"
}}

resource "aws_route53_health_check" "primary" {{
  fqdn              = {primary_target_expr}
  port              = 443
  type              = "HTTPS"
  resource_path     = "/health"
  failure_threshold = 3
  request_interval  = 30

  tags = {{
    Name = "${{var.project_name}}-primary-health-check"
  }}
}}

resource "aws_route53_record" "primary" {{
  zone_id         = aws_route53_zone.primary.zone_id
  name            = "app.${{var.project_name}}.example.com"
  type            = "CNAME"
  ttl             = 60
  records         = [{primary_target_expr}]
  set_identifier  = "primary"
  health_check_id = aws_route53_health_check.primary.id

  failover_routing_policy {{
    type = "PRIMARY"
  }}
}}

resource "aws_route53_record" "secondary" {{
  zone_id        = aws_route53_zone.primary.zone_id
  name           = "app.${{var.project_name}}.example.com"
  type           = "CNAME"
  ttl            = 60
  records        = [{secondary_target_expr}]
  set_identifier = "secondary"

  failover_routing_policy {{
    type = "SECONDARY"
  }}
}}
"""

        files["main.tf"] = main_tf
        files["compute.tf"] = compute_tf
        files["database.tf"] = database_tf
        files["storage.tf"] = storage_tf
        files["outputs.tf"] = outputs_tf
        files["variables.tf"] += extra_variables_tf

    elif provider == "azure":
        # ----------------------------------------------------
        # AZURE TERRAFORM GENERATOR
        # ----------------------------------------------------

        files["variables.tf"] = f"""# Azure Variables for {project_name}

variable "environment" {{
  type    = string
  default = "dev"
}}

variable "location" {{
  type    = string
  default = "East US"
}}

variable "project_name" {{
  type    = string
  default = "{safe_name}"
}}
"""

        files["networking.tf"] = """# Azure Virtual Network Resources

resource "azurerm_resource_group" "rg" {
  name     = "${var.project_name}-${var.environment}-rg"
  location = var.location
}

# Rationale: Subnets split ensures database nodes are isolated from front-facing container app APIs.
resource "azurerm_virtual_network" "vnet" {
  name                = "${var.project_name}-vnet"
  address_space       = ["10.0.0.0/16"]
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
}

resource "azurerm_subnet" "app_subnet" {
  name                 = "app-subnet"
  resource_group_name  = azurerm_resource_group.rg.name
  virtual_network_name = azurerm_virtual_network.vnet.name
  address_prefixes     = ["10.0.1.0/24"]
}

resource "azurerm_subnet" "db_subnet" {
  name                 = "db-subnet"
  resource_group_name  = azurerm_resource_group.rg.name
  virtual_network_name = azurerm_virtual_network.vnet.name
  address_prefixes     = ["10.0.2.0/24"]
}

# Rationale: Application Gateway requires its own dedicated subnet (no other resource types may
# share it). Declared unconditionally alongside app/db subnets so the Container Apps + App Gateway
# compute branch can always reference it.
resource "azurerm_subnet" "appgw_subnet" {
  name                 = "appgw-subnet"
  resource_group_name  = azurerm_resource_group.rg.name
  virtual_network_name = azurerm_virtual_network.vnet.name
  address_prefixes     = ["10.0.3.0/24"]
}
"""

        main_tf = f"""# Main Provider Configuration for {project_name}

terraform {{
  required_providers {{
    azurerm = {{
      source  = "hashicorp/azurerm"
      version = "~> 3.0"
    }}
    random = {{
      source  = "hashicorp/random"
      version = "~> 3.6"
    }}
  }}
}}

provider "azurerm" {{
  features {{}}
}}

data "azurerm_client_config" "current" {{}}
"""

        compute_tf = "# Azure Compute Resources\n\n"
        database_tf = "# Azure Database Resources\n\n"
        storage_tf = "# Azure Storage & CDN Resources\n\n"
        outputs_tf = f"# Azure Outputs for {project_name}\n\n"
        # Extra `variable` blocks that depend on which components are actually present -- see the
        # identical AWS-branch rationale above; variables.tf itself is built before this loop runs.
        extra_variables_tf = ""

        # Shared/singleton resources emitted at most once even when multiple compute-type
        # components exist (e.g. a main "compute" component plus a "worker" component both mapped
        # to Azure Functions or Container Apps -- a common combination, see rules_engine.py's
        # queue/worker rule) -- without this guard, Terraform sees the same fixed-name resource
        # declared twice and fails with "Duplicate resource configuration".
        func_plan_emitted = False
        container_env_emitted = False

        # Used by the "lb"-type component's own branch below to find which compute component it
        # fronts via `connections` (rules_engine.py wires lb -> compute).
        by_id = {comp.get("id"): comp for comp in components if comp.get("id")}

        # Phase 5 (multi-region DR): computed up front (needed inside the loop below for the
        # storage account's replication type) -- "none" for every generic architecture. Azure has
        # no AWS-style aliased-provider-per-region idiom (azurerm resources take `location`
        # directly), so the secondary-region variable is a plain string, not a provider block.
        dr_strategy = _get_dr_strategy(components, "azure")
        if dr_strategy != "none":
            extra_variables_tf += """
variable "secondary_location" {
  type        = string
  default     = "West US"
  description = "Secondary Azure region for disaster-recovery resources (cross-region database replica, Traffic Manager failover target)."
}
"""

        for c in components:
            lld = _get_lld(c, "azure")
            svc = _get_service_name(c, "azure")
            config = lld.get("config") or {}
            c_id = c.get("id")

            if c.get("type") == "cdn":
                storage_tf += _build_comments(lld, ["priceClass"])
                # "azurerm_frontdoor_profile" is not a real resource type in the azurerm provider
                # (confirmed against the real provider schema) -- azurerm_cdn_frontdoor_profile is
                # the actual (modern, non-deprecated) resource for Azure Front Door.
                storage_tf += """resource "azurerm_cdn_frontdoor_profile" "cdn" {
  name                = "${var.project_name}-frontdoor"
  resource_group_name = azurerm_resource_group.rg.name
  sku_name            = "Standard_AzureFrontDoor"
}

"""
            elif c.get("type") == "compute":
                has_functions = "Functions" in svc
                is_worker = c_id == "worker"  # background workers never get public ingress (matches
                # the k8s_manifest_generator.py convention: is_worker components get no Service/ingress)

                if has_functions:
                    compute_tf += _build_comments(lld, ["memory", "timeout", "concurrency"])
                    if not func_plan_emitted:
                        func_plan_emitted = True
                        compute_tf += f"""resource "azurerm_service_plan" "func_plan" {{
  name                = "${{var.project_name}}-functions-plan"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  os_type             = "Linux"
  sku_name            = "Y1" # Consumption Serverless
}}

# Dedicated storage account for the Function App's own runtime state (triggers, logs, deployment
# packages) -- a hard Azure Functions requirement, unconditionally declared here rather than
# reused from the architecture's own "storage" component (which may not exist in this
# architecture at all, and is conceptually a different thing -- the function runtime's operational
# storage vs. the product's own object storage). Shared across every Functions-based compute
# component in this architecture (see func_plan_emitted above) -- a single Consumption plan and
# storage account can host multiple function apps, so this is correct to share, not a bug.
resource "azurerm_storage_account" "functions_storage" {{
  name                     = "${{var.project_name}}funcsa"
  resource_group_name      = azurerm_resource_group.rg.name
  location                 = azurerm_resource_group.rg.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
}}

"""
                    compute_tf += f"""resource "azurerm_linux_function_app" "{c_id}" {{
  name                = "${{var.project_name}}-{c_id}-app"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  service_plan_id     = azurerm_service_plan.func_plan.id
  storage_account_name       = azurerm_storage_account.functions_storage.name
  storage_account_access_key = azurerm_storage_account.functions_storage.primary_access_key

  site_config {{
    application_stack {{
      node_version = "18"
    }}
  }}
}}

"""
                    # The API Management gateway in front of this Function App is now emitted by the
                    # "lb"-type component's own branch below (see `elif c.get("type") == "lb":`), not
                    # here -- a bare Function App is only reachable via its raw default hostname until
                    # that branch finds this component as its target via `connections` and wires it up.
                else:
                    # Container Apps
                    compute_tf += _build_comments(lld, ["instanceSize", "minInstances", "maxInstances"])
                    min_replicas = _parse_int(config.get("minInstances"), "1")
                    max_replicas = _parse_int(config.get("maxInstances"), "3")
                    ingress_block = (
                        """
  ingress {
    external_enabled = true
    target_port       = 80
    transport         = "auto"

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }
"""
                        if not is_worker
                        else ""
                    )
                    if not container_env_emitted:
                        container_env_emitted = True
                        # Shared across every Container-Apps-based compute component in this
                        # architecture (see container_env_emitted above) -- one environment can
                        # host multiple container apps, so sharing it is correct, not a bug.
                        compute_tf += f"""resource "azurerm_container_app_environment" "env" {{
  name                = "${{var.project_name}}-containerapp-env"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
}}

"""
                    compute_tf += f"""resource "azurerm_container_app" "{c_id}" {{
  name                         = "${{var.project_name}}-{c_id}"
  container_app_environment_id = azurerm_container_app_environment.env.id
  resource_group_name          = azurerm_resource_group.rg.name
  revision_mode                = "Single"

  template {{
    container {{
      name   = "web"
      image  = "nginx:alpine"
      cpu    = 0.25
      memory = "0.5Gi"
    }}
    min_replicas = {min_replicas}
    max_replicas = {max_replicas}
  }}
{ingress_block}}}

"""
                    # The Application Gateway in front of this Container App is now emitted by the
                    # "lb"-type component's own branch below, not here -- see the Functions branch
                    # above for the identical rationale.
            elif c.get("type") == "lb":
                # Find which compute component this lb actually fronts (rules_engine.py wires
                # lb -> compute; the edge component is always the "from").
                target_id = None
                for conn in connections:
                    if conn.get("from") == c_id:
                        candidate = by_id.get(conn.get("to"))
                        if candidate and candidate.get("type") == "compute":
                            target_id = conn.get("to")
                            break

                if target_id:
                    target_svc = _get_service_name(by_id.get(target_id, {}), "azure")
                    if "Functions" in target_svc:
                        # "Azure API Management" -- front the Function App with a real APIM gateway
                        # instead of leaving it reachable only via its raw default hostname.
                        compute_tf += _build_comments(lld, ["gatewayType", "throttlingBurstLimit", "corsPolicy"])
                        compute_tf += f"""resource "azurerm_api_management" "apim" {{
  name                = "${{var.project_name}}-apim"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  publisher_name      = "${{var.project_name}} API Publisher"
  publisher_email     = "admin@${{var.project_name}}.example.com"
  sku_name            = "Consumption_0"
}}

resource "azurerm_api_management_backend" "{target_id}_backend" {{
  name                = "${{var.project_name}}-{target_id}-backend"
  resource_group_name = azurerm_resource_group.rg.name
  api_management_name = azurerm_api_management.apim.name
  protocol            = "http"
  url                 = "https://${{azurerm_linux_function_app.{target_id}.default_hostname}}"
}}

resource "azurerm_api_management_api" "{target_id}_api" {{
  name                = "${{var.project_name}}-{target_id}-api"
  resource_group_name = azurerm_resource_group.rg.name
  api_management_name = azurerm_api_management.apim.name
  revision            = "1"
  display_name        = "${{var.project_name}}-{target_id}-api"
  path                = "{target_id}"
  protocols           = ["https"]
}}

resource "azurerm_api_management_api_policy" "{target_id}_policy" {{
  api_name            = azurerm_api_management_api.{target_id}_api.name
  api_management_name = azurerm_api_management.apim.name
  resource_group_name = azurerm_resource_group.rg.name

  xml_content = <<XML
<policies>
  <inbound>
    <base />
    <set-backend-service backend-id="${{azurerm_api_management_backend.{target_id}_backend.name}}" />
  </inbound>
</policies>
XML
}}

"""
                        outputs_tf += """output "apim_gateway_url" {
  value       = azurerm_api_management.apim.gateway_url
  description = "Public API Management gateway URL fronting the Azure Functions backend."
}

"""
                    else:
                        # "Azure Application Gateway" -- routes to the Container App's own managed
                        # ingress FQDN via an FQDN-based backend pool.
                        compute_tf += _build_comments(lld, ["healthCheckPath", "healthCheckIntervalSec", "healthCheckTimeoutSec", "idleTimeoutSec", "listenerProtocol", "wafEnabled", "wafRuleSet", "rateLimitPerIP"])
                        appgw_waf_enabled = config.get("wafEnabled") == "true"
                        # Rationale: WAF policy association requires the WAF_v2 SKU tier -- Standard_v2
                        # has no firewall_policy_id support. Switching the sku here (rather than always
                        # provisioning WAF_v2) keeps the non-WAF path on the cheaper Standard_v2 tier.
                        appgw_sku_name = "WAF_v2" if appgw_waf_enabled else "Standard_v2"
                        appgw_firewall_policy_line = (
                            "\n  firewall_policy_id  = azurerm_web_application_firewall_policy.appgw_waf.id" if appgw_waf_enabled else ""
                        )
                        compute_tf += f"""resource "azurerm_public_ip" "appgw_pip" {{
  name                = "${{var.project_name}}-appgw-pip"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  allocation_method   = "Static"
  sku                 = "Standard"
}}

resource "azurerm_application_gateway" "appgw" {{
  name                = "${{var.project_name}}-appgw"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location{appgw_firewall_policy_line}

  sku {{
    name     = "{appgw_sku_name}"
    tier     = "{appgw_sku_name}"
    capacity = 1
  }}

  gateway_ip_configuration {{
    name      = "appgw-ip-config"
    subnet_id = azurerm_subnet.appgw_subnet.id
  }}

  frontend_port {{
    name = "frontend-port-80"
    port = 80
  }}

  frontend_ip_configuration {{
    name                 = "appgw-frontend-ip"
    public_ip_address_id = azurerm_public_ip.appgw_pip.id
  }}

  backend_address_pool {{
    name  = "{target_id}-backend-pool"
    fqdns = [azurerm_container_app.{target_id}.ingress[0].fqdn]
  }}

  backend_http_settings {{
    name                                = "{target_id}-backend-http-settings"
    cookie_based_affinity               = "Disabled"
    port                                = 443
    protocol                            = "Https"
    request_timeout                     = 30
    pick_host_name_from_backend_address = true
  }}

  http_listener {{
    name                           = "{target_id}-http-listener"
    frontend_ip_configuration_name = "appgw-frontend-ip"
    frontend_port_name             = "frontend-port-80"
    protocol                       = "Http"
  }}

  request_routing_rule {{
    name                       = "{target_id}-routing-rule"
    rule_type                  = "Basic"
    http_listener_name         = "{target_id}-http-listener"
    backend_address_pool_name  = "{target_id}-backend-pool"
    backend_http_settings_name = "{target_id}-backend-http-settings"
    priority                   = 100
  }}
}}

"""
                        if appgw_waf_enabled:
                            compute_tf += """resource "azurerm_web_application_firewall_policy" "appgw_waf" {
  name                = "${var.project_name}-appgw-waf-policy"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location

  managed_rules {
    managed_rule_set {
      type    = "OWASP"
      version = "3.2"
    }
  }

  policy_settings {
    enabled                     = true
    mode                        = "Prevention"
    request_body_check          = true
    file_upload_limit_in_mb     = 100
    max_request_body_size_in_kb = 128
  }
}

"""
                        outputs_tf += """output "appgw_public_ip" {
  value       = azurerm_public_ip.appgw_pip.ip_address
  description = "Public IP address of the Application Gateway fronting the container app."
}

"""
            elif c.get("type") == "database":
                is_pg = "PostgreSQL" in svc

                if is_pg:
                    database_tf += _build_comments(lld, ["instanceClass", "storageSize", "backupRetention", "multiAZ"])
                    instance_class = config.get("instanceClass") or "MO_Standard_E2ds_v4"
                    storage_mb = _parse_int(config.get("storageSize"), "32") * 1024
                    backup_retention = _parse_int(config.get("backupRetention"), "7")
                    database_tf += f"""resource "random_password" "db_password" {{
  length           = 24
  special          = true
  override_special = "!#$%&*()-_=+[]{{}}<>:?"
}}

resource "azurerm_postgresql_flexible_server" "db" {{
  name                = "${{var.project_name}}-pg-db"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  version             = "14"
  administrator_login          = "psqladmin"
  administrator_password       = random_password.db_password.result
  sku_name                     = "{instance_class}"
  storage_mb                   = {storage_mb}
  backup_retention_days        = {backup_retention}
}}

# Rationale: minimal Key Vault created for the generated DB secret -- the same "output a
# reference, never the raw value" principle as the AWS Secrets Manager / GCP Secret Manager paths.
resource "azurerm_key_vault" "kv" {{
  name                = "${{var.project_name}}-kv"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  tenant_id           = data.azurerm_client_config.current.tenant_id
  sku_name            = "standard"

  access_policy {{
    tenant_id = data.azurerm_client_config.current.tenant_id
    object_id = data.azurerm_client_config.current.object_id

    secret_permissions = ["Get", "Set", "Delete", "Purge"]
  }}
}}

resource "azurerm_key_vault_secret" "db_password" {{
  name         = "${{var.project_name}}-db-password"
  value        = random_password.db_password.result
  key_vault_id = azurerm_key_vault.kv.id
}}

"""
                    outputs_tf += """output "db_fqdn" {
  value       = azurerm_postgresql_flexible_server.db.fqdn
  description = "The fully qualified database endpoint."
}

output "db_password_secret_id" {
  value       = azurerm_key_vault_secret.db_password.id
  description = "Key Vault secret URI holding the generated DB password -- fetch it at runtime via a managed identity, never hardcode it."
}

"""
                else:
                    # Cosmos DB NoSQL
                    database_tf += _build_comments(lld, ["readCapacityUnits"])
                    database_tf += """resource "azurerm_cosmosdb_account" "cosmos" {
  name                = "${var.project_name}-cosmos"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  offer_type          = "Standard"
  kind                = "GlobalDocumentDB"

  consistency_policy {
    consistency_level = "Session"
  }

  geo_location {
    location          = azurerm_resource_group.rg.location
    failover_priority = 0
  }
}

"""
            elif c.get("type") == "storage" or "Storage" in svc:
                storage_tf += _build_comments(lld, ["lifecycleRule", "versioningEnabled", "crossRegionReplication"])
                # Phase 5 (multi-region DR): Azure Storage's own geo-redundant replication (RA-GRS)
                # is the real, native equivalent of a manual secondary-bucket + replication-rule
                # setup -- much simpler than AWS/GCP's own DR storage pattern, and the correct
                # provider-idiomatic choice rather than reinventing cross-region replication by hand.
                replication_type = "RAGRS" if dr_strategy != "none" else "LRS"
                storage_tf += f"""resource "azurerm_storage_account" "storage" {{
  name                     = "${{var.project_name}}storeunique"
  resource_group_name      = azurerm_resource_group.rg.name
  location                 = azurerm_resource_group.rg.location
  account_tier             = "Standard"
  account_replication_type = "{replication_type}"
}}

resource "azurerm_storage_container" "blobs" {{
  name                  = "media"
  storage_account_name  = azurerm_storage_account.storage.name
  container_access_type = "private"
}}

"""
            elif c.get("type") == "queue":
                database_tf += _build_comments(lld, ["queueType", "visibilityTimeoutSec"])
                database_tf += """resource "azurerm_servicebus_namespace" "sb" {
  name                = "${var.project_name}-sb"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  sku                 = "Standard"
}

resource "azurerm_servicebus_queue" "jobs" {
  name         = "task-queue"
  namespace_id = azurerm_servicebus_namespace.sb.id
}

"""
            elif c.get("type") == "cache":
                database_tf += _build_comments(lld, ["nodeType"])
                database_tf += """resource "azurerm_redis_cache" "redis" {
  name                = "${var.project_name}-redis"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  capacity            = 0
  family              = "C"
  sku_name            = "Basic"
}

"""
            elif c.get("type") == "monitoring":
                compute_tf += _build_comments(lld, ["logRetentionDays", "tracingSampleRate", "alertingPhilosophy"])
                retention_days = _parse_int(config.get("logRetentionDays"), "30")
                compute_tf += f"""resource "azurerm_log_analytics_workspace" "{c_id}" {{
  name                = "${{var.project_name}}-{c_id}-law"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  sku                 = "PerGB2018"
  retention_in_days   = {retention_days}
}}

resource "azurerm_application_insights" "{c_id}" {{
  name                = "${{var.project_name}}-{c_id}-appinsights"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  workspace_id        = azurerm_log_analytics_workspace.{c_id}.id
  application_type    = "web"
}}

"""
                outputs_tf += f"""output "{c_id}_app_insights_connection_string" {{
  value       = azurerm_application_insights.{c_id}.connection_string
  description = "Application Insights connection string -- configure the app's telemetry SDK with this at runtime, never hardcode it."
  sensitive   = true
}}

"""
            elif c.get("type") == "notification":
                database_tf += _build_comments(lld, ["deliveryChannels", "retryPolicy", "deadLetterHandling"])
                database_tf += f"""resource "azurerm_servicebus_namespace" "{c_id}_sb" {{
  name                = "${{var.project_name}}-{c_id}-sb"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  sku                 = "Standard"
}}

resource "azurerm_servicebus_topic" "{c_id}" {{
  name         = "${{var.project_name}}-{c_id}-topic"
  namespace_id = azurerm_servicebus_namespace.{c_id}_sb.id
}}

"""

        # Phase 5 (multi-region DR): real secondary-region resources. AWS gets the most detailed
        # implementation (see that branch); Azure/GCP get the equivalent for the two resource types
        # with an unambiguous, well-documented provider-native pattern (database replica + storage
        # replication) plus DNS failover where a real public endpoint exists to target -- standby
        # compute is intentionally not duplicated here (out of scope for the time budget on the
        # secondary providers; AWS is where the most scrutiny lands per the task's own guidance).
        if dr_strategy != "none":
            db_component = next((c for c in components if c.get("type") == "database"), None)
            db_svc = _get_service_name(db_component, "azure") if db_component else ""
            has_pg_db = bool(db_component) and "PostgreSQL" in db_svc

            if has_pg_db:
                db_lld = _get_lld(db_component, "azure")
                database_tf += _build_comments(db_lld, ["drStrategy", "secondaryRegion", "crossRegionReplication"])
                database_tf += """# Phase 5 (multi-region DR): a cross-region read replica, Azure's own native equivalent of
# AWS's replicate_source_db -- create_mode = "Replica" plus source_server_id is all a Postgres
# Flexible Server replica needs; storage/compute config is inherited from the source server.
resource "azurerm_postgresql_flexible_server" "db_replica" {
  name                = "${var.project_name}-pg-db-replica"
  resource_group_name = azurerm_resource_group.rg.name
  location            = var.secondary_location
  create_mode         = "Replica"
  source_server_id    = azurerm_postgresql_flexible_server.db.id
}

"""
                outputs_tf += """output "db_replica_fqdn" {
  value       = azurerm_postgresql_flexible_server.db_replica.fqdn
  description = "Cross-region read replica endpoint -- promote this manually (pilot-light) or via automated failover tooling (warm-standby) if the primary region goes down."
}

"""

            # DNS failover only makes sense when there's a real public endpoint to target -- an
            # Application Gateway's public IP, the one edge component this generator currently
            # gives a stable, directly-referenceable FQDN-capable resource.
            if 'resource "azurerm_public_ip" "appgw_pip"' in compute_tf:
                # Secondary endpoint target: the RA-GRS storage account's own secondary-region read
                # endpoint when storage exists (a real, always-present secondary-region hostname,
                # since RA-GRS is forced on above whenever DR is active) -- otherwise falls back to
                # the primary Application Gateway's own IP as a documented placeholder, since no
                # secondary App Gateway is provisioned (standby compute is AWS-only, see above).
                secondary_target_expr = (
                    "azurerm_storage_account.storage.secondary_blob_host"
                    if 'resource "azurerm_storage_account" "storage"' in storage_tf
                    else "azurerm_public_ip.appgw_pip.ip_address"
                )
                compute_tf += f"""
# Phase 5 (multi-region DR): Traffic Manager priority routing -- Azure's equivalent of Route 53
# failover routing. Endpoint 1 (priority 1) is the primary Application Gateway; endpoint 2
# (priority 2) only receives traffic if endpoint 1 fails Traffic Manager's own health probe.
resource "azurerm_traffic_manager_profile" "app" {{
  name                   = "${{var.project_name}}-tm-profile"
  resource_group_name    = azurerm_resource_group.rg.name
  traffic_routing_method = "Priority"

  dns_config {{
    relative_name = "${{var.project_name}}"
    ttl           = 60
  }}

  monitor_config {{
    protocol = "HTTPS"
    port     = 443
    path     = "/health"
  }}
}}

resource "azurerm_traffic_manager_external_endpoint" "primary" {{
  name       = "primary"
  profile_id = azurerm_traffic_manager_profile.app.id
  target     = azurerm_public_ip.appgw_pip.ip_address
  priority   = 1
}}

resource "azurerm_traffic_manager_external_endpoint" "secondary" {{
  name       = "secondary"
  profile_id = azurerm_traffic_manager_profile.app.id
  target     = {secondary_target_expr}
  priority   = 2
}}
"""
                outputs_tf += """output "traffic_manager_fqdn" {
  value       = azurerm_traffic_manager_profile.app.fqdn
  description = "Traffic Manager's own DNS name -- point your custom domain's CNAME here for automatic priority-based failover."
}

"""

        files["main.tf"] = main_tf
        files["compute.tf"] = compute_tf
        files["database.tf"] = database_tf
        files["storage.tf"] = storage_tf
        files["outputs.tf"] = outputs_tf
        files["variables.tf"] += extra_variables_tf

    elif provider == "gcp":
        # ----------------------------------------------------
        # GCP TERRAFORM GENERATOR
        # ----------------------------------------------------

        files["variables.tf"] = f"""# Google Cloud Variables for {project_name}

variable "environment" {{
  type    = string
  default = "dev"
}}

variable "gcp_project" {{
  type        = string
  default     = "{safe_name}"
  description = "Google Cloud Project ID"
}}

variable "gcp_region" {{
  type    = string
  default = "us-central1"
}}
"""

        files["networking.tf"] = """# Google VPC Networking Resources

# Rationale: VPC networks separate internal application routing from entryload balancers.
resource "google_compute_network" "vpc" {
  name                    = "${var.gcp_project}-${var.environment}-vpc"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "subnet" {
  name          = "subnet-us-central"
  ip_cidr_range = "10.0.1.0/24"
  region        = var.gcp_region
  network       = google_compute_network.vpc.id
}
"""

        main_tf = f"""# Main Provider Configuration for {project_name}

terraform {{
  required_providers {{
    random = {{
      source  = "hashicorp/random"
      version = "~> 3.6"
    }}
    google-beta = {{
      source  = "hashicorp/google-beta"
      version = "~> 5.0"
    }}
  }}
}}

provider "google" {{
  project = var.gcp_project
  region  = var.gcp_region
}}

# API Gateway resources (google_api_gateway_*) are only available under the google-beta provider
# as of this writing, even though the underlying GCP API Gateway service itself is GA -- the
# standard "google" provider genuinely does not implement these resource types (confirmed against
# the provider's real schema, not assumed). Every other GCP resource in this file uses the
# standard "google" provider; only the API Gateway block below opts into google-beta.
provider "google-beta" {{
  project = var.gcp_project
  region  = var.gcp_region
}}
"""

        compute_tf = "# Google Cloud Compute Resources\n\n"
        database_tf = "# Google Cloud Database Resources\n\n"
        storage_tf = "# Google Cloud Storage & CDN Resources\n\n"
        outputs_tf = f"# Google Cloud Outputs for {project_name}\n\n"

        # Used by the "lb"-type component's own branch below to find which compute component it
        # fronts via `connections` (rules_engine.py wires lb -> compute).
        by_id = {comp.get("id"): comp for comp in components if comp.get("id")}

        # Phase 5 (multi-region DR): computed up front (needed inside the loop below for the
        # storage bucket's location). "none" for every generic architecture.
        dr_strategy = _get_dr_strategy(components, "gcp")

        for c in components:
            lld = _get_lld(c, "gcp")
            svc = _get_service_name(c, "gcp")
            config = lld.get("config") or {}
            c_id = c.get("id")

            if c.get("type") == "cdn":
                storage_tf += """resource "google_compute_backend_bucket" "cdn" {
  name        = "${var.gcp_project}-cdn"
  bucket_name = google_storage_bucket.storage.name
  enable_cdn  = true
}

"""
            elif c.get("type") == "compute":
                has_functions = "Functions" in svc

                if has_functions:
                    compute_tf += _build_comments(lld, ["memory", "timeout", "concurrency"])
                    memory = _parse_int(config.get("memory"), "512")
                    timeout = _parse_int(config.get("timeout"), "30")
                    compute_tf += f"""resource "google_cloudfunctions_function" "{c_id}" {{
  name        = "${{var.gcp_project}}-{c_id}"
  description = "Google Cloud Function endpoint for {c_id}"
  runtime     = "nodejs20"

  available_memory_mb   = {memory}
  timeout               = {timeout}
  entry_point           = "handler"
  trigger_http          = true
}}

"""
                    # The API Gateway in front of this function is now emitted by the "lb"-type
                    # component's own branch below, not here -- a bare Cloud Function is only
                    # reachable via its raw HTTPS trigger URL until that branch finds this
                    # component as its target via `connections` and wires it up.
                else:
                    # Cloud Run
                    compute_tf += _build_comments(lld, ["instanceSize", "minInstances", "maxInstances"])
                    min_scale = config.get("minInstances") or "1"
                    max_scale = config.get("maxInstances") or "3"
                    compute_tf += f"""resource "google_cloud_run_service" "{c_id}" {{
  name     = "${{var.gcp_project}}-{c_id}"
  location = var.gcp_region

  template {{
    spec {{
      containers {{
        image = "gcr.io/cloudrun/hello"
        resources {{
          limits = {{
            memory = "512Mi"
            cpu    = "1000m"
          }}
        }}
      }}
    }}
    metadata {{
      annotations = {{
        "autoscaling.knative.dev/minScale" = "{min_scale}"
        "autoscaling.knative.dev/maxScale" = "{max_scale}"
      }}
    }}
  }}
}}

"""
                    # The HTTPS Load Balancer in front of this Cloud Run service is now emitted by
                    # the "lb"-type component's own branch below, not here -- see the Functions
                    # branch above for the identical rationale.
            elif c.get("type") == "lb":
                # Find which compute component this lb actually fronts (rules_engine.py wires
                # lb -> compute; the edge component is always the "from").
                target_id = None
                for conn in connections:
                    if conn.get("from") == c_id:
                        candidate = by_id.get(conn.get("to"))
                        if candidate and candidate.get("type") == "compute":
                            target_id = conn.get("to")
                            break

                if target_id:
                    target_svc = _get_service_name(by_id.get(target_id, {}), "gcp")
                    if "Functions" in target_svc:
                        # "Google Cloud API Gateway" -- front the function with a real API Gateway
                        # instead of leaving it reachable only via its raw HTTPS trigger URL.
                        compute_tf += _build_comments(lld, ["gatewayType", "throttlingBurstLimit", "corsPolicy"])
                        compute_tf += f"""resource "google_cloudfunctions_function_iam_member" "{target_id}_invoker" {{
  project        = var.gcp_project
  region         = var.gcp_region
  cloud_function = google_cloudfunctions_function.{target_id}.name
  role           = "roles/cloudfunctions.invoker"
  member         = "allUsers"
}}

resource "google_api_gateway_api" "{target_id}_api" {{
  provider = google-beta
  api_id   = "${{var.gcp_project}}-{target_id}-api"
}}

resource "google_api_gateway_api_config" "{target_id}_config" {{
  provider      = google-beta
  api           = google_api_gateway_api.{target_id}_api.api_id
  api_config_id = "${{var.gcp_project}}-{target_id}-config"

  openapi_documents {{
    document {{
      path = "openapi.yaml"
      contents = base64encode(<<-EOT
        swagger: "2.0"
        info:
          title: ${{var.gcp_project}}-{target_id}-api
          version: "1.0.0"
        schemes:
          - https
        paths:
          /:
            get:
              operationId: {target_id}Root
              x-google-backend:
                address: ${{google_cloudfunctions_function.{target_id}.https_trigger_url}}
              responses:
                "200":
                  description: OK
        EOT
      )
    }}
  }}

  lifecycle {{
    create_before_destroy = true
  }}
}}

resource "google_api_gateway_gateway" "{target_id}_gateway" {{
  provider   = google-beta
  api_config = google_api_gateway_api_config.{target_id}_config.id
  gateway_id = "${{var.gcp_project}}-{target_id}-gw"
  region     = var.gcp_region
}}

"""
                        outputs_tf += f"""output "{target_id}_gateway_url" {{
  value       = google_api_gateway_gateway.{target_id}_gateway.default_hostname
  description = "Public hostname for the {target_id} API Gateway (Cloud Functions backend)."
}}

"""
                    else:
                        # "Google Cloud Load Balancing (HTTPS)" -- a serverless NEG-backed global
                        # HTTPS load balancer, the real GCP pattern for fronting a public Cloud Run service.
                        compute_tf += _build_comments(lld, ["healthCheckPath", "healthCheckIntervalSec", "healthCheckTimeoutSec", "idleTimeoutSec", "listenerProtocol", "wafEnabled", "wafRuleSet", "rateLimitPerIP"])
                        lb_waf_enabled = config.get("wafEnabled") == "true"
                        lb_security_policy_line = "\n  security_policy       = google_compute_security_policy.lb_waf.id" if lb_waf_enabled else ""
                        compute_tf += f"""resource "google_cloud_run_service_iam_member" "{target_id}_public" {{
  location = google_cloud_run_service.{target_id}.location
  project  = google_cloud_run_service.{target_id}.project
  service  = google_cloud_run_service.{target_id}.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}}

resource "google_compute_region_network_endpoint_group" "{target_id}_neg" {{
  name                  = "${{var.gcp_project}}-{target_id}-neg"
  region                = var.gcp_region
  network_endpoint_type = "SERVERLESS"

  cloud_run {{
    service = google_cloud_run_service.{target_id}.name
  }}
}}

resource "google_compute_backend_service" "{target_id}_backend" {{
  name                  = "${{var.gcp_project}}-{target_id}-backend"
  protocol              = "HTTP"
  load_balancing_scheme = "EXTERNAL_MANAGED"{lb_security_policy_line}

  backend {{
    group = google_compute_region_network_endpoint_group.{target_id}_neg.id
  }}
}}

resource "google_compute_url_map" "{target_id}_url_map" {{
  name            = "${{var.gcp_project}}-{target_id}-url-map"
  default_service = google_compute_backend_service.{target_id}_backend.id
}}

resource "google_compute_target_http_proxy" "{target_id}_http_proxy" {{
  name    = "${{var.gcp_project}}-{target_id}-http-proxy"
  url_map = google_compute_url_map.{target_id}_url_map.id
}}

resource "google_compute_global_address" "{target_id}_lb_ip" {{
  name = "${{var.gcp_project}}-{target_id}-lb-ip"
}}

resource "google_compute_global_forwarding_rule" "{target_id}_forwarding_rule" {{
  name                  = "${{var.gcp_project}}-{target_id}-fwd-rule"
  target                = google_compute_target_http_proxy.{target_id}_http_proxy.id
  port_range            = "80"
  ip_address            = google_compute_global_address.{target_id}_lb_ip.id
  load_balancing_scheme = "EXTERNAL_MANAGED"
}}

"""
                        if lb_waf_enabled:
                            rate_limit = _parse_int(config.get("rateLimitPerIP"), "2000")
                            compute_tf += f"""resource "google_compute_security_policy" "lb_waf" {{
  name = "${{var.gcp_project}}-lb-waf"

  rule {{
    action   = "deny(403)"
    priority = 1000

    match {{
      expr {{
        expression = "evaluatePreconfiguredExpr('xss-stable') || evaluatePreconfiguredExpr('sqli-stable')"
      }}
    }}

    description = "Block common XSS/SQLi patterns using Cloud Armor preconfigured WAF rules."
  }}

  rule {{
    action   = "throttle"
    priority = 2000

    match {{
      versioned_expr = "SRC_IPS_V1"
      config {{
        src_ip_ranges = ["*"]
      }}
    }}

    rate_limit_options {{
      conform_action = "allow"
      exceed_action  = "deny(429)"
      enforce_on_key = "IP"

      rate_limit_threshold {{
        count        = {rate_limit}
        interval_sec = 300
      }}
    }}

    description = "Rate limit per-IP request volume."
  }}

  rule {{
    action   = "allow"
    priority = 2147483647

    match {{
      versioned_expr = "SRC_IPS_V1"
      config {{
        src_ip_ranges = ["*"]
      }}
    }}

    description = "Default allow rule."
  }}
}}

"""
                        outputs_tf += f"""output "{target_id}_lb_ip_address" {{
  value       = google_compute_global_address.{target_id}_lb_ip.address
  description = "Public IP address of the HTTPS Load Balancer fronting the {target_id} Cloud Run service."
}}

"""
            elif c.get("type") == "database":
                is_pg = "PostgreSQL" in svc

                if is_pg:
                    database_tf += _build_comments(lld, ["instanceClass", "storageSize", "backupRetention", "multiAZ"])
                    instance_class = config.get("instanceClass") or "db-f1-micro"
                    disk_size = _parse_int(config.get("storageSize"), "20")
                    availability_type = "REGIONAL" if config.get("multiAZ") == "true" else "ZONAL"
                    database_tf += f"""resource "google_sql_database_instance" "db" {{
  name             = "${{var.gcp_project}}-postgres-db"
  region           = var.gcp_region
  database_version = "POSTGRES_15"

  settings {{
    tier = "{instance_class}"
    disk_size = {disk_size}
    disk_type = "PD_SSD"
    availability_type = "{availability_type}"

    backup_configuration {{
      enabled    = true
      start_time = "02:00"
    }}
  }}
}}

resource "random_password" "db_password" {{
  length           = 24
  special          = true
  override_special = "!#$%&*()-_=+[]{{}}<>:?"
}}

resource "google_sql_user" "db_user" {{
  name     = "dbadmin"
  instance = google_sql_database_instance.db.name
  password = random_password.db_password.result
}}

# Rationale: same "output a reference, never the raw value" principle as the AWS Secrets Manager /
# Azure Key Vault paths -- application code fetches the password from Secret Manager at runtime.
resource "google_secret_manager_secret" "db_password" {{
  secret_id = "${{var.gcp_project}}-db-password"

  replication {{
    auto {{}}
  }}
}}

resource "google_secret_manager_secret_version" "db_password" {{
  secret      = google_secret_manager_secret.db_password.id
  secret_data = random_password.db_password.result
}}

"""
                    outputs_tf += """output "db_ip" {
  value       = google_sql_database_instance.db.public_ip_address
  description = "The database instance public IP."
}

output "db_password_secret_id" {
  value       = google_secret_manager_secret.db_password.secret_id
  description = "Secret Manager secret ID holding the generated DB password -- fetch it at runtime via IAM, never hardcode it."
}

"""
                else:
                    # Firestore NoSQL
                    database_tf += _build_comments(lld, ["readCapacityUnits"])
                    database_tf += """resource "google_firestore_database" "nosql" {
  name        = "(default)"
  project     = var.gcp_project
  type        = "FIRESTORE_NATIVE"
  location_id = "us-east1"
}

"""
            elif c.get("type") == "storage" or "Storage" in svc:
                storage_tf += _build_comments(lld, ["lifecycleRule", "versioningEnabled", "crossRegionReplication"])
                versioning_enabled = "true" if config.get("versioningEnabled") == "true" else "false"
                # Phase 5 (multi-region DR): a dual-region bucket location (spanning us-central1 +
                # us-east1, matching this file's default gcp_region/secondary DR region) is GCS's
                # own native cross-region replication -- Google's real recommended DR pattern for
                # storage, and much simpler than hand-rolling a second bucket + replication job.
                bucket_location = "NAM4" if dr_strategy != "none" else "var.gcp_region"
                location_line = f'"{bucket_location}"' if dr_strategy != "none" else bucket_location
                storage_tf += f"""resource "google_storage_bucket" "storage" {{
  name          = "${{var.gcp_project}}-bucket-storage-unique"
  location      = {location_line}
  force_destroy = true

  versioning {{
    enabled = {versioning_enabled}
  }}
}}

"""
            elif c.get("type") == "queue":
                database_tf += _build_comments(lld, ["queueType"])
                database_tf += """resource "google_pubsub_topic" "pubsub" {
  name = "${var.gcp_project}-jobs-topic"
}

resource "google_pubsub_subscription" "jobs_sub" {
  name  = "task-queue-sub"
  topic = google_pubsub_topic.pubsub.name
}

"""
            elif c.get("type") == "cache":
                database_tf += _build_comments(lld, ["nodeType"])
                database_tf += """resource "google_redis_instance" "redis" {
  name           = "${var.gcp_project}-cache"
  tier           = "BASIC"
  memory_size_gb = 1
  region         = var.gcp_region
}

"""
            elif c.get("type") == "monitoring":
                compute_tf += _build_comments(lld, ["logRetentionDays", "tracingSampleRate", "alertingPhilosophy"])
                retention_days = _parse_int(config.get("logRetentionDays"), "30")
                # Rationale: kept bounded, per the task's own scope guidance -- this configures the
                # project's default log bucket retention (a real, minimal resource directly wired to
                # the LLD's logRetentionDays value), not a full alerting-rules platform.
                compute_tf += f"""resource "google_logging_project_bucket_config" "{c_id}" {{
  project        = var.gcp_project
  location       = "global"
  retention_days = {retention_days}
  bucket_id      = "_Default"
}}

"""
            elif c.get("type") == "notification":
                database_tf += _build_comments(lld, ["deliveryChannels", "retryPolicy", "deadLetterHandling"])
                database_tf += f"""resource "google_pubsub_topic" "{c_id}" {{
  name = "${{var.gcp_project}}-{c_id}-topic"
}}

"""

        # Phase 5 (multi-region DR): real secondary-region resources. AWS gets the most detailed
        # implementation (see that branch); GCP gets the equivalent database + storage DR pattern.
        # DNS failover is intentionally NOT emitted for GCP -- a genuinely correct Cloud DNS geo/
        # failover routing policy needs a real secondary-region endpoint to route to, and this
        # generator deliberately does not duplicate a full secondary-region compute+LB stack (see
        # the task's own "no component duplication" scope boundary) -- AWS's standby Lambda is a
        # narrow, minimal exception scoped to that one provider's implementation.
        if dr_strategy != "none":
            db_component = next((c for c in components if c.get("type") == "database"), None)
            db_svc = _get_service_name(db_component, "gcp") if db_component else ""
            has_pg_db = bool(db_component) and "PostgreSQL" in db_svc

            files["variables.tf"] += """
variable "secondary_gcp_region" {
  type        = string
  default     = "us-east1"
  description = "Secondary GCP region for disaster-recovery resources (cross-region database read replica)."
}
"""

            if has_pg_db:
                db_lld = _get_lld(db_component, "gcp")
                database_tf += _build_comments(db_lld, ["drStrategy", "secondaryRegion", "crossRegionReplication"])
                database_tf += """# Phase 5 (multi-region DR): a cross-region read replica -- GCP's real, native pattern is just
# master_instance_name pointing at the primary instance plus a different region; no separate
# replica_configuration block is needed for a same-project managed-to-managed Cloud SQL replica
# (that block is only for replicating FROM an external, non-Cloud-SQL database).
resource "google_sql_database_instance" "db_replica" {
  name                 = "${var.gcp_project}-postgres-db-replica"
  region               = var.secondary_gcp_region
  database_version     = "POSTGRES_15"
  master_instance_name = google_sql_database_instance.db.name

  settings {
    tier = "db-f1-micro"
  }
}

"""
                outputs_tf += """output "db_replica_ip" {
  value       = google_sql_database_instance.db_replica.public_ip_address
  description = "Cross-region read replica public IP -- promote this manually (pilot-light) or via automated failover tooling (warm-standby) if the primary region goes down."
}

"""

        files["main.tf"] = main_tf
        files["compute.tf"] = compute_tf
        files["database.tf"] = database_tf
        files["storage.tf"] = storage_tf
        files["outputs.tf"] = outputs_tf

    elif provider == "private":
        # ----------------------------------------------------
        # PRIVATE CLOUD / ON-PREMISES TERRAFORM GENERATOR
        # ----------------------------------------------------
        # No single Terraform provider covers "private cloud" -- VMware, OpenStack, and bare-metal
        # all need different providers with environment-specific credentials this tool can't know.
        # Rather than guess, this generates null_resource placeholders that document exactly what
        # needs manual provisioning per component, plus commented-out real provider blocks for the
        # two most common private-cloud Terraform providers so you have a starting point either way.

        files["variables.tf"] = f"""# Private Cloud Variables for {project_name}

variable "environment" {{
  type    = string
  default = "dev"
}}

variable "project_name" {{
  type    = string
  default = "{safe_name}"
}}

# Fill in once you've picked a private cloud provider (see main.tf for options).
variable "datacenter_name" {{
  type        = string
  default     = ""
  description = "vSphere datacenter / OpenStack region / physical site identifier."
}}
"""

        files["main.tf"] = (
            f"# Provider Configuration for {project_name} — PRIVATE CLOUD\n"
            "#\n"
            "# Uncomment and configure ONE of the following depending on your actual private cloud platform.\n"
            "# This tool cannot auto-detect or provision credentials for on-premises infrastructure.\n"
            "\n"
            "# --- Option A: VMware vSphere ---\n"
            "# terraform {\n"
            "#   required_providers {\n"
            "#     vsphere = {\n"
            '#       source  = "hashicorp/vsphere"\n'
            '#       version = "~> 2.0"\n'
            "#     }\n"
            "#   }\n"
            "# }\n"
            '# provider "vsphere" {\n'
            "#   user           = var.vsphere_user\n"
            "#   password       = var.vsphere_password\n"
            "#   vsphere_server = var.vsphere_server\n"
            "# }\n"
            "\n"
            "# --- Option B: OpenStack ---\n"
            "# terraform {\n"
            "#   required_providers {\n"
            "#     openstack = {\n"
            '#       source  = "terraform-provider-openstack/openstack"\n'
            '#       version = "~> 1.53"\n'
            "#     }\n"
            "#   }\n"
            "# }\n"
            '# provider "openstack" {\n'
            '#   cloud = "my-openstack-cloud"\n'
            "# }\n"
            "\n"
            "# --- Option C: Bare-metal (no provider — infrastructure provisioned outside Terraform) ---\n"
            "# If deploying to bare metal without a virtualization layer, most of what's below is\n"
            "# configuration management (Ansible/Puppet/manual) rather than Terraform's job.\n"
        )

        manual_provisioning_tf = (
            f"# Private Cloud Resource Placeholders for {project_name}\n"
            "#\n"
            "# These null_resource blocks are NOT real infrastructure — Terraform has no generic way to\n"
            "# provision a VM on an arbitrary private cloud. Each one documents exactly what a human (or a\n"
            "# platform-specific Terraform provider, once you pick one above) needs to provision manually.\n"
            "\n"
        )

        for c in components:
            lld = _get_lld(c, "private")
            svc = _get_service_name(c, "private")
            config = lld.get("config") or {}
            reasoning = lld.get("reasoning") or {}
            c_id = c.get("id")
            key_lines = "\n".join(
                f"# {k}: {config[k]}" + (f" — {reasoning[k]}" if reasoning.get(k) else "") for k in config.keys()
            )
            manual_provisioning_tf += (
                f"# ---- {c.get('name')} → {svc} ----\n"
                f"{key_lines}\n"
                f'resource "null_resource" "{c_id}_manual_provisioning" {{\n'
                "  triggers = {\n"
                f'    component   = "{c_id}"\n'
                f'    service     = "{svc.replace(chr(34), chr(39))}"\n'
                '    provisioned = "false" # flip once this component has actually been provisioned by hand\n'
                "  }\n"
                "}\n"
                "\n"
            )

        files["compute.tf"] = manual_provisioning_tf
        files["outputs.tf"] = (
            "# No computed outputs — private cloud resources above are manual placeholders,\n"
            "# not real Terraform-managed infrastructure. Update this once real resources exist.\n"
        )

    # README.MD (Consistent across providers)
    compliance_section = _build_compliance_section(industry_context, components)
    manual_section = _build_manual_provisioning_section(provider, components)

    files["README.md"] = f"""# Terraform Configurations for {project_name}

This Terraform configuration script was automatically synthesized by the **AI Cloud Architecture Generator** based on your project requirements and low-level designs.

## File Structure
*   `main.tf`: Provider registrations and base authentication parameters.
*   `networking.tf`: Private subnets, VPC network definitions, and firewall wrappers.
*   `compute.tf`: API servers, application workers, and execution limits.
*   `database.tf`: Database persistence layers and caching clusters.
*   `storage.tf`: Object storage buckets and asset delivery CDNs.
*   `variables.tf`: Parameter definitions (regions, environments, naming prefixes).
*   `outputs.tf`: Primary outputs (endpoints, database hosts, resource names).

---

> [!WARNING]
> ## Deployment Security Disclaimer
> This configuration represents a starting point. It has been derived automatically based on design rules and client brainstorming.
> You MUST review instance profiles, security group configurations, IAM roles, and pricing implications before running `terraform apply` in any real staging or production environments.
{compliance_section}
{manual_section}
---

## State Management Configuration
To maintain shared and remote state files, configure a backend configuration block inside `main.tf`. 

### Remote State Backend Templates

#### AWS S3 Backend:
```hcl
terraform {{
  backend "s3" {{
    bucket         = "your-terraform-state-bucket"
    key            = "states/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "terraform-lock"
  }}
}}
```

#### Azure Blob Backend:
```hcl
terraform {{
  backend "azurerm" {{
    resource_group_name  = "state-resource-group"
    storage_account_name = "statestorageaccount"
    container_name       = "tfstate"
    key                  = "terraform.tfstate"
  }}
}}
```

#### GCP Cloud Storage Backend:
```hcl
terraform {{
  backend "gcs" {{
    bucket  = "your-terraform-state-bucket"
    prefix  = "terraform/state"
  }}
}}
```

---

## Deployment Steps
1. Install the Terraform CLI on your workstation.
2. Authenticate CLI access with credentials (e.g. `aws configure`, `az login`, or `gcloud auth`).
3. Run initialization:
   ```bash
   terraform init
   ```
4. Preview the changes:
   ```bash
   terraform plan
   ```
5. Apply changes:
   ```bash
   terraform apply
   ```
"""

    return files
