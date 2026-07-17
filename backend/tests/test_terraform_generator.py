"""Tests for app/services/terraform_generator.py -- pure functions, no DB access.

Covers the fixes for three confirmed bugs (see task description this test suite accompanies):
  1. Compute services named "... + ALB"/"... + API Gateway"/"... + App Gateway"/"... + HTTPS Load
     Balancer" now actually emit a real ingress resource wiring to the compute resource, for both
     the container-based and serverless compute variant of every provider.
  2. No hardcoded plaintext database password appears anywhere in generated output -- every
     provider's relational-database branch now generates a `random_password` and stores it in that
     cloud's secret manager, never the raw value in an output.
  3. `database.tf` never references a Terraform resource that isn't actually declared, for any
     combination of components (cache-only, cache+NoSQL, cache+relational) -- regression coverage
     for the AWS `aws_elasticache_cluster` -> `aws_db_subnet_group.db_subnets` dangling reference.

The cross-file "every reference resolves to a declared resource" check is the main regression
guard against reintroducing bug 3's class of error in any provider/branch.
"""

import re

import pytest

from app.services.terraform_generator import generate_terraform_code

HARDCODED_PASSWORD = "ManagedSecretPassword123!"

# ---------------------------------------------------------------------------
# Reference/declaration extraction -- catches "resource references a name that isn't declared
# anywhere in the combined output" for any TYPE.NAME address of the form aws_x.y / azurerm_x.y /
# google_x.y (optionally prefixed with "data." for data sources, tracked separately since data
# sources and managed resources are declared with distinct blocks in Terraform).
# ---------------------------------------------------------------------------
_RESOURCE_DECL_RE = re.compile(r'(?m)^\s*resource\s+"([a-zA-Z0-9_]+)"\s+"([a-zA-Z0-9_]+)"')
_DATA_DECL_RE = re.compile(r'(?m)^\s*data\s+"([a-zA-Z0-9_]+)"\s+"([a-zA-Z0-9_]+)"')
_REF_RE = re.compile(r"\b(data\.)?((?:aws|azurerm|google)_[a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)")


def _unresolved_references(files: dict[str, str]) -> list[str]:
    """Combines every generated file's content and returns a list of TYPE.NAME references that
    have no matching `resource "TYPE" "NAME"` (or `data "TYPE" "NAME"`) declaration anywhere in
    the combined output. An empty list means every reference resolves."""
    combined = "\n".join(files.values())
    declared_resources = set(_RESOURCE_DECL_RE.findall(combined))
    declared_data = set(_DATA_DECL_RE.findall(combined))

    unresolved = []
    for is_data, rtype, rname in _REF_RE.findall(combined):
        if is_data:
            if (rtype, rname) not in declared_data:
                unresolved.append(f"data.{rtype}.{rname}")
        else:
            if (rtype, rname) not in declared_resources:
                unresolved.append(f"{rtype}.{rname}")
    return unresolved


def _component(comp_id: str, comp_type: str, name: str, service_names: dict[str, str], config: dict | None = None) -> dict:
    """Builds a minimal component dict with cloudMappings for whichever providers are passed in
    `service_names` (e.g. {"aws": "Amazon ECS Fargate + ALB"})."""
    return {
        "id": comp_id,
        "type": comp_type,
        "name": name,
        "cloudMappings": {
            provider: {"serviceName": svc, "lld": {"config": config or {}, "reasoning": {}}}
            for provider, svc in service_names.items()
        },
    }


def _full_stack(provider: str, compute_service: str, database_service: str, cache_service: str, storage_service: str) -> list[dict]:
    """compute (non-worker) + relational database + cache + storage -- the "realistic
    architecture" combination called out in the task's own manual-verification step."""
    return [
        _component("compute", "compute", "API", {provider: compute_service}, {"minInstances": "2"}),
        _component("database", "database", "DB", {provider: database_service}),
        _component("cache", "cache", "Cache", {provider: cache_service}),
        _component("storage", "storage", "Storage", {provider: storage_service}),
    ]


AWS_CONTAINER_STACK = _full_stack("aws", "Amazon ECS Fargate + ALB", "Amazon RDS PostgreSQL", "Amazon ElastiCache", "Amazon S3")
AWS_SERVERLESS_STACK = _full_stack("aws", "AWS Lambda + API Gateway", "Amazon RDS PostgreSQL", "Amazon ElastiCache", "Amazon S3")

AZURE_CONTAINER_STACK = _full_stack(
    "azure", "Azure Container Apps + App Gateway", "Azure Database for PostgreSQL (Flexible Server)", "Azure Cache for Redis", "Azure Blob Storage"
)
AZURE_SERVERLESS_STACK = _full_stack(
    "azure", "Azure Functions + API Management", "Azure Database for PostgreSQL (Flexible Server)", "Azure Cache for Redis", "Azure Blob Storage"
)

GCP_CONTAINER_STACK = _full_stack(
    "gcp", "Google Cloud Run + HTTPS Load Balancer", "Google Cloud SQL for PostgreSQL (db-custom-1-3840)", "Google Cloud Memorystore", "Google Cloud Storage"
)
GCP_SERVERLESS_STACK = _full_stack(
    "gcp", "Google Cloud Functions + API Gateway", "Google Cloud SQL for PostgreSQL (db-custom-1-3840)", "Google Cloud Memorystore", "Google Cloud Storage"
)


class TestNoHardcodedPassword:
    def test_no_hardcoded_password_string_any_provider(self):
        for provider, stack in [
            ("aws", AWS_CONTAINER_STACK),
            ("azure", AZURE_CONTAINER_STACK),
            ("gcp", GCP_CONTAINER_STACK),
        ]:
            files = generate_terraform_code(provider, "TestProj", stack, [], None)
            for filename, content in files.items():
                assert HARDCODED_PASSWORD not in content, f"{provider}/{filename} contains the hardcoded password literal"

    def test_random_password_resource_present_for_every_relational_db(self):
        for provider, stack in [
            ("aws", AWS_CONTAINER_STACK),
            ("azure", AZURE_CONTAINER_STACK),
            ("gcp", GCP_CONTAINER_STACK),
        ]:
            files = generate_terraform_code(provider, "TestProj", stack, [], None)
            assert 'resource "random_password" "db_password"' in files["database.tf"]


class TestSecretsAreStoredNotOutputRaw:
    def test_aws_secrets_manager_and_output_is_arn_not_raw_password(self):
        files = generate_terraform_code("aws", "TestProj", AWS_CONTAINER_STACK, [], None)
        assert 'resource "aws_secretsmanager_secret" "db_password"' in files["database.tf"]
        assert 'resource "aws_secretsmanager_secret_version" "db_password"' in files["database.tf"]
        assert "random_password.db_password.result" in files["database.tf"]
        assert "aws_secretsmanager_secret.db_password.arn" in files["outputs.tf"]
        # never output the raw generated password value
        assert "random_password.db_password.result" not in files["outputs.tf"]

    def test_azure_key_vault_and_output_is_reference_not_raw_password(self):
        files = generate_terraform_code("azure", "TestProj", AZURE_CONTAINER_STACK, [], None)
        assert 'resource "azurerm_key_vault_secret" "db_password"' in files["database.tf"]
        assert "random_password.db_password.result" in files["database.tf"]
        assert "azurerm_key_vault_secret.db_password.id" in files["outputs.tf"]
        assert "random_password.db_password.result" not in files["outputs.tf"]

    def test_gcp_secret_manager_and_google_sql_user_present(self):
        files = generate_terraform_code("gcp", "TestProj", GCP_CONTAINER_STACK, [], None)
        # the "related gap" -- google_sql_user was entirely missing before the fix
        assert 'resource "google_sql_user" "db_user"' in files["database.tf"]
        assert 'resource "google_secret_manager_secret" "db_password"' in files["database.tf"]
        assert 'resource "google_secret_manager_secret_version" "db_password"' in files["database.tf"]
        assert "google_secret_manager_secret.db_password.secret_id" in files["outputs.tf"]
        assert "random_password.db_password.result" not in files["outputs.tf"]


class TestLoadBalancerAndApiGatewayResources:
    def test_aws_container_variant_has_alb_and_ecs_load_balancer_block(self):
        files = generate_terraform_code("aws", "TestProj", AWS_CONTAINER_STACK, [], None)
        compute = files["compute.tf"]
        assert 'resource "aws_lb" "app"' in compute
        assert 'resource "aws_lb_target_group" "app"' in compute
        assert 'resource "aws_lb_listener" "app"' in compute
        assert "load_balancer {" in compute
        assert "target_group_arn = aws_lb_target_group.app.arn" in compute
        # ALB gets its own security group, and app_sg is tightened to only trust it
        assert 'resource "aws_security_group" "alb_sg"' in compute
        assert "security_groups = [aws_security_group.alb_sg.id]" in compute
        assert "aws_lb.app.dns_name" in files["outputs.tf"]

    def test_aws_serverless_variant_has_http_api_gateway(self):
        files = generate_terraform_code("aws", "TestProj", AWS_SERVERLESS_STACK, [], None)
        compute = files["compute.tf"]
        assert 'resource "aws_apigatewayv2_api" "compute_api"' in compute
        assert 'resource "aws_apigatewayv2_integration" "compute_integration"' in compute
        assert 'resource "aws_apigatewayv2_route" "compute_route"' in compute
        assert 'resource "aws_apigatewayv2_stage" "compute_stage"' in compute
        assert 'resource "aws_lambda_permission" "compute_apigw"' in compute
        assert "aws_apigatewayv2_stage.compute_stage.invoke_url" in files["outputs.tf"]

    def test_aws_worker_component_gets_no_public_ingress(self):
        """Background workers (component id "worker") must never get an ALB/API Gateway --
        matches the k8s_manifest_generator.py convention of no Service/ingress for workers."""
        stack = AWS_CONTAINER_STACK + [_component("worker", "compute", "Worker", {"aws": "Amazon ECS Fargate (Worker)"})]
        files = generate_terraform_code("aws", "TestProj", stack, [], None)
        compute = files["compute.tf"]
        assert 'resource "aws_ecs_service" "worker_service"' in compute
        # only one ALB total (the primary compute's), not one per compute component
        assert compute.count('resource "aws_lb" "app"') == 1

    def test_azure_container_variant_has_application_gateway(self):
        files = generate_terraform_code("azure", "TestProj", AZURE_CONTAINER_STACK, [], None)
        compute = files["compute.tf"]
        assert 'resource "azurerm_application_gateway" "appgw"' in compute
        assert "ingress {" in compute  # container app now actually has ingress enabled
        assert "azurerm_container_app.compute.ingress[0].fqdn" in compute
        assert "azurerm_public_ip.appgw_pip.ip_address" in files["outputs.tf"]

    def test_azure_serverless_variant_has_api_management(self):
        files = generate_terraform_code("azure", "TestProj", AZURE_SERVERLESS_STACK, [], None)
        compute = files["compute.tf"]
        assert 'resource "azurerm_api_management" "apim"' in compute
        assert 'resource "azurerm_api_management_backend" "compute_backend"' in compute
        assert 'resource "azurerm_api_management_api" "compute_api"' in compute
        assert "azurerm_api_management.apim.gateway_url" in files["outputs.tf"]

    def test_gcp_container_variant_has_https_load_balancer(self):
        files = generate_terraform_code("gcp", "TestProj", GCP_CONTAINER_STACK, [], None)
        compute = files["compute.tf"]
        assert 'resource "google_compute_backend_service" "compute_backend"' in compute
        assert 'resource "google_compute_url_map" "compute_url_map"' in compute
        assert 'resource "google_compute_target_http_proxy" "compute_http_proxy"' in compute
        assert 'resource "google_compute_global_forwarding_rule" "compute_forwarding_rule"' in compute
        assert "google_compute_global_address.compute_lb_ip.address" in files["outputs.tf"]

    def test_gcp_serverless_variant_has_api_gateway(self):
        files = generate_terraform_code("gcp", "TestProj", GCP_SERVERLESS_STACK, [], None)
        compute = files["compute.tf"]
        assert 'resource "google_api_gateway_api" "compute_api"' in compute
        assert 'resource "google_api_gateway_api_config" "compute_config"' in compute
        assert 'resource "google_api_gateway_gateway" "compute_gateway"' in compute
        assert "google_api_gateway_gateway.compute_gateway.default_hostname" in files["outputs.tf"]


class TestEveryReferenceResolves:
    """The main regression guard for bug 3's class of error: every TYPE.NAME reference in the
    combined generated output must resolve to an actual declaration, for every provider and every
    compute variant."""

    def test_all_full_stacks_have_no_dangling_references(self):
        stacks = {
            "aws-container": ("aws", AWS_CONTAINER_STACK),
            "aws-serverless": ("aws", AWS_SERVERLESS_STACK),
            "azure-container": ("azure", AZURE_CONTAINER_STACK),
            "azure-serverless": ("azure", AZURE_SERVERLESS_STACK),
            "gcp-container": ("gcp", GCP_CONTAINER_STACK),
            "gcp-serverless": ("gcp", GCP_SERVERLESS_STACK),
        }
        for label, (provider, stack) in stacks.items():
            files = generate_terraform_code(provider, "TestProj", stack, [], None)
            unresolved = _unresolved_references(files)
            assert unresolved == [], f"{label}: dangling references found: {unresolved}"

    def test_aws_cache_only_no_dangling_subnet_group_reference(self):
        """Bug 3 regression: cache with no database component at all."""
        stack = [_component("cache", "cache", "Cache", {"aws": "Amazon ElastiCache"})]
        files = generate_terraform_code("aws", "TestProj", stack, [], None)
        assert _unresolved_references(files) == []
        assert "aws_db_subnet_group.db_subnets" in files["database.tf"]
        assert 'resource "aws_db_subnet_group" "db_subnets"' in files["networking.tf"]

    def test_aws_cache_plus_nosql_no_dangling_subnet_group_reference(self):
        """Bug 3's exact previously-broken combination: cache + NoSQL database, no relational DB."""
        stack = [
            _component("database", "database", "DB", {"aws": "Amazon DynamoDB"}),
            _component("cache", "cache", "Cache", {"aws": "Amazon ElastiCache"}),
        ]
        files = generate_terraform_code("aws", "TestProj", stack, [], None)
        unresolved = _unresolved_references(files)
        assert unresolved == [], f"dangling references found: {unresolved}"
        assert 'resource "aws_dynamodb_table" "nosql"' in files["database.tf"]
        assert "aws_db_subnet_group.db_subnets" in files["database.tf"]

    def test_aws_cache_plus_relational_db_no_dangling_subnet_group_reference(self):
        """Third combination: cache + relational DB (the one that happened to work before)."""
        stack = [
            _component("database", "database", "DB", {"aws": "Amazon RDS PostgreSQL"}),
            _component("cache", "cache", "Cache", {"aws": "Amazon ElastiCache"}),
        ]
        files = generate_terraform_code("aws", "TestProj", stack, [], None)
        assert _unresolved_references(files) == []
        # both branches reference the *same* single subnet group declaration
        assert files["database.tf"].count('resource "aws_db_subnet_group" "db_subnets"') == 0
        assert files["networking.tf"].count('resource "aws_db_subnet_group" "db_subnets"') == 1


class TestPrivateAndKubernetesUntouched:
    """Sanity check that the private-cloud null_resource branch (explicitly out of scope) still
    behaves as before -- no LB/secrets logic should leak into it."""

    def test_private_provider_still_generates_null_resource_placeholders(self):
        components = [_component("compute", "compute", "API", {"private": "Bare Metal Server"})]
        files = generate_terraform_code("private", "TestProj", components, [], None)
        assert 'resource "null_resource" "compute_manual_provisioning"' in files["compute.tf"]
        assert "aws_lb" not in files["compute.tf"]


# ---------------------------------------------------------------------------
# Duplicate-declaration checker -- catches "the same resource TYPE+NAME is declared twice"
# (e.g. two compute-type components -- a main "compute" plus a "worker" -- both mapped to Azure
# Functions/Container Apps, each independently emitting the same shared/singleton resource like
# azurerm_service_plan.func_plan). This class of bug is invisible to _unresolved_references above,
# since that check uses a set() for declared resources -- a duplicate declaration doesn't create an
# unresolved reference, it silently collapses in the set. Terraform itself rejects it at
# `terraform validate` time with "Duplicate resource configuration", so this is a real bug class,
# just a different one than a dangling reference.
# ---------------------------------------------------------------------------
def _duplicate_declarations(files: dict[str, str]) -> list[str]:
    combined = "\n".join(files.values())
    seen: dict[tuple[str, str], int] = {}
    for rtype, rname in _RESOURCE_DECL_RE.findall(combined):
        seen[(rtype, rname)] = seen.get((rtype, rname), 0) + 1
    return [f"{rtype}.{rname} ({count}x)" for (rtype, rname), count in seen.items() if count > 1]


def _kitchen_sink(provider: str, compute_svc: str, worker_svc: str, db_svc: str, cache_svc: str, storage_svc: str, cdn_svc: str, auth_svc: str, queue_svc: str) -> list[dict]:
    """compute + worker (both type=="compute", the combination that exposed the Azure shared-
    resource duplicate-declaration bug) + every other component type -- the broadest realistic
    architecture this generator has to handle in one pass."""
    return [
        _component("compute", "compute", "API", {provider: compute_svc}, {"minInstances": "2"}),
        _component("worker", "compute", "Worker", {provider: worker_svc}),
        _component("database", "database", "DB", {provider: db_svc}),
        _component("cache", "cache", "Cache", {provider: cache_svc}),
        _component("storage", "storage", "Storage", {provider: storage_svc}),
        _component("cdn", "cdn", "CDN", {provider: cdn_svc}),
        _component("auth", "auth", "Auth", {provider: auth_svc}),
        _component("queue", "queue", "Queue", {provider: queue_svc}),
    ]


KITCHEN_SINK_STACKS = {
    "aws_container": ("aws", _kitchen_sink("aws", "Amazon ECS Fargate + ALB", "AWS Lambda (Worker)", "Amazon RDS PostgreSQL", "Amazon ElastiCache", "Amazon S3", "Amazon CloudFront", "Amazon Cognito", "Amazon SQS")),
    "aws_serverless": ("aws", _kitchen_sink("aws", "AWS Lambda + API Gateway", "AWS Lambda (Worker)", "Amazon DynamoDB", "Amazon ElastiCache", "Amazon S3", "Amazon CloudFront", "Amazon Cognito", "Amazon SQS")),
    "azure_container": ("azure", _kitchen_sink("azure", "Azure Container Apps", "Azure Container Apps (Worker)", "Azure Database for PostgreSQL", "Azure Cache for Redis", "Azure Blob Storage", "Azure Front Door", "Azure AD B2C", "Azure Service Bus")),
    "azure_serverless": ("azure", _kitchen_sink("azure", "Azure Functions", "Azure Functions (Worker)", "Azure Database for PostgreSQL", "Azure Cache for Redis", "Azure Blob Storage", "Azure Front Door", "Azure AD B2C", "Azure Service Bus")),
    "gcp_container": ("gcp", _kitchen_sink("gcp", "Google Cloud Run", "Google Cloud Run (Worker)", "Cloud SQL for PostgreSQL", "Memorystore for Redis", "Cloud Storage", "Cloud CDN", "Firebase Authentication", "Cloud Pub/Sub")),
    "gcp_serverless": ("gcp", _kitchen_sink("gcp", "Google Cloud Functions", "Google Cloud Functions (Worker)", "Cloud SQL for PostgreSQL", "Memorystore for Redis", "Cloud Storage", "Cloud CDN", "Firebase Authentication", "Cloud Pub/Sub")),
}


class TestNoDuplicateResourceDeclarations:
    """Regression coverage for the Azure duplicate-declaration bug: an architecture with BOTH a
    main "compute" component and a "worker" component (both type=="compute", a common combination
    -- see rules_engine.py's queue/worker rule) must not emit the same shared/singleton resource
    (azurerm_service_plan.func_plan, azurerm_storage_account.functions_storage,
    azurerm_container_app_environment.env) twice."""

    def test_no_duplicate_declarations_any_provider_compute_plus_worker(self):
        for name, (provider, stack) in KITCHEN_SINK_STACKS.items():
            files = generate_terraform_code(provider, "KitchenSink", stack, [], None)
            dupes = _duplicate_declarations(files)
            assert dupes == [], f"{name}: duplicate resource declarations found: {dupes}"


class TestTerraformValidate:
    """Authoritative check: actually runs `terraform init && terraform validate` against the
    generated output using the real provider schemas (aws/azurerm/google/random), for every
    provider x compute-variant combination. This is the only check in this file that can catch a
    resource TYPE that simply doesn't exist in the real provider (e.g. the "azurerm_frontdoor_profile"
    bug -- the real resource is "azurerm_cdn_frontdoor_profile" -- or the GCP API Gateway resources,
    which exist only under the google-beta provider, not google) or a required-attribute mismatch --
    none of which a regex-based reference/declaration checker can ever catch, since the resource
    block itself is internally self-consistent, just wrong against the real schema.

    Skipped entirely if the `terraform` CLI isn't available in this environment (e.g. CI without
    it installed) -- this is a valuable extra check when available, not a hard requirement to run
    the rest of this test file."""

    @staticmethod
    @pytest.fixture(scope="class")
    def terraform_available():
        import shutil

        if shutil.which("terraform") is None:
            pytest.skip("terraform CLI not installed in this environment")

    @pytest.mark.parametrize("name", list(KITCHEN_SINK_STACKS.keys()))
    def test_generated_terraform_validates(self, terraform_available, name, tmp_path):
        import subprocess

        provider, stack = KITCHEN_SINK_STACKS[name]
        files = generate_terraform_code(provider, "ValidateTest", stack, [], None)
        for filename, content in files.items():
            if not filename.endswith(".tf"):
                continue
            (tmp_path / filename).write_text(content)

        init = subprocess.run(
            ["terraform", "init", "-backend=false", "-input=false"],
            cwd=tmp_path, capture_output=True, text=True, timeout=120,
        )
        assert init.returncode == 0, f"{name}: terraform init failed:\n{init.stdout}\n{init.stderr}"

        validate = subprocess.run(
            ["terraform", "validate"], cwd=tmp_path, capture_output=True, text=True, timeout=60,
        )
        assert validate.returncode == 0, f"{name}: terraform validate failed:\n{validate.stdout}\n{validate.stderr}"
