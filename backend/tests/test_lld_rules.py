"""Spot-checks for app/services/lld_rules.py's run_lld_rules_engine -- pure function, no DB
access. Focused on compute/database across aws/kubernetes/private, and the compliance-mandated
config additions (encryptionInTransit, mtls, networkSegmentation) that industry_context layers on
top for fintech/healthtech but not for "none"."""

from app.services.lld_rules import run_lld_rules_engine


def make_requirements(
    *,
    expectedScale: str = "1,000 users",
    budget: str = "$2,000/month",
    teamMaturity: str = "senior engineers",
    compliance: str = "none",
    dataNature: str = "structured business records",
) -> dict:
    return {
        "nonFunctional": {
            "expectedScale": expectedScale,
            "readWritePattern": "balanced",
            "dataNature": dataNature,
            "latencySensitivity": "medium",
            "budget": budget,
            "teamMaturity": teamMaturity,
            "compliance": compliance,
        },
    }


FINTECH_CONTEXT = {"industry": "fintech", "flags": {}}
HEALTHTECH_CONTEXT = {"industry": "healthtech", "flags": {}}
NONE_CONTEXT = {"industry": "none", "flags": {}}


class TestComputeAws:
    def test_serverless_config_for_tight_budget_and_junior_team(self):
        req = make_requirements(budget="$50/month", teamMaturity="a small team")
        result = run_lld_rules_engine("aws", "compute", "compute", req)
        assert "memory" in result["config"]
        assert "concurrency" in result["config"]

    def test_container_config_for_large_budget_regression(self):
        """The exact bug this task fixes: $50,000/month must not be read as tight, so a
        senior/large team on that budget gets the container LLD shape, not serverless."""
        req = make_requirements(budget="$50,000/month", teamMaturity="a large senior team")
        result = run_lld_rules_engine("aws", "compute", "compute", req)
        assert "instanceSize" in result["config"]
        assert "minInstances" in result["config"]
        assert "memory" not in result["config"]


class TestDatabaseAws:
    def test_relational_high_scale_uses_dedicated_instance_class(self):
        req = make_requirements(expectedScale="high scale, 1 million users", dataNature="relational transactional records")
        result = run_lld_rules_engine("aws", "database", "database", req)
        assert result["config"]["instanceClass"] == "db.m6g.xlarge"
        assert result["config"]["multiAZ"].startswith("true")

    def test_non_relational_gets_capacity_unit_config(self):
        req = make_requirements(dataNature="flexible schema-less content")
        result = run_lld_rules_engine("aws", "database", "database", req)
        assert "readCapacityUnits" in result["config"]
        assert "encryptionType" in result["config"]


class TestLbAws:
    def test_container_budget_gets_alb_shaped_config(self):
        req = make_requirements(budget="$50,000/month", teamMaturity="a large senior team")
        result = run_lld_rules_engine("aws", "lb", "lb", req)
        assert result["config"]["healthCheckPath"] == "/health"
        assert "listenerProtocol" in result["config"]
        assert "gatewayType" not in result["config"]
        assert result["reasoning"]["unhealthyThresholdCount"]

    def test_serverless_budget_gets_api_gateway_shaped_config(self):
        req = make_requirements(budget="$50/month", teamMaturity="a junior team")
        result = run_lld_rules_engine("aws", "lb", "lb", req)
        assert result["config"]["gatewayType"] == "HTTP API (Regional)"
        assert "healthCheckPath" not in result["config"]
        assert result["reasoning"]["corsPolicy"]

    def test_service_name_override_forces_api_gateway_shape(self):
        """A manually swapped service (e.g. user picks 'Amazon API Gateway (HTTP API)' for an lb
        that would otherwise resolve to container-shaped config) overrides the deterministic
        budget/team signal."""
        req = make_requirements(budget="$50,000/month", teamMaturity="a large senior team")
        result = run_lld_rules_engine("aws", "lb", "lb", req, service_name_override="Amazon API Gateway (HTTP API)")
        assert result["config"]["gatewayType"] == "HTTP API (Regional)"


class TestDnsAws:
    def test_dns_config_has_genuine_multi_region_forward_looking_note(self):
        req = make_requirements()
        result = run_lld_rules_engine("aws", "dns", "dns", req)
        assert result["config"]["routingPolicy"] == "Simple"
        assert "multi-region" in result["reasoning"]["routingPolicy"].lower()


class TestLbAndDnsKubernetesAndPrivate:
    def test_kubernetes_lb_is_ingress_shaped(self):
        req = make_requirements()
        result = run_lld_rules_engine("kubernetes", "lb", "lb", req)
        assert "namespace" in result["config"]
        assert result["config"]["namespace"] == "ingress-system"

    def test_kubernetes_dns_uses_externaldns_operator(self):
        req = make_requirements()
        result = run_lld_rules_engine("kubernetes", "dns", "dns", req)
        assert "ExternalDNS" in result["config"]["deploymentMode"]

    def test_private_lb_flags_manual_failover(self):
        req = make_requirements()
        result = run_lld_rules_engine("private", "lb", "lb", req)
        assert "Manual failover" in result["config"]["haMode"]

    def test_private_dns_flags_manual_record_management(self):
        req = make_requirements()
        result = run_lld_rules_engine("private", "dns", "dns", req)
        assert "Manual" in result["config"]["deploymentMode"]


class TestComputeKubernetes:
    def test_kubernetes_compute_replica_scaling_for_high_scale(self):
        req = make_requirements(expectedScale="high scale, 1 million users")
        result = run_lld_rules_engine("kubernetes", "compute", "compute", req)
        assert result["config"]["replicas"] == "4"
        assert result["config"]["hpaMinReplicas"] == "4"

    def test_kubernetes_compute_replica_scaling_for_low_scale(self):
        req = make_requirements(expectedScale="500 users")
        result = run_lld_rules_engine("kubernetes", "compute", "compute", req)
        assert result["config"]["replicas"] == "2"


class TestDatabaseKubernetes:
    def test_low_ops_capacity_goes_external(self):
        req = make_requirements(budget="$50/month", teamMaturity="a small team")
        result = run_lld_rules_engine("kubernetes", "database", "database", req)
        assert result["config"]["deploymentMode"] == "External (ExternalName Service + Secret)"

    def test_adequate_ops_capacity_self_manages(self):
        req = make_requirements(budget="$50,000/month", teamMaturity="a large senior platform team")
        result = run_lld_rules_engine("kubernetes", "database", "database", req)
        assert "replicas" in result["config"]
        assert "deploymentMode" not in result["config"]


class TestComputePrivate:
    def test_high_scale_gets_larger_vm_size(self):
        req = make_requirements(expectedScale="high scale, 1 million users")
        result = run_lld_rules_engine("private", "compute", "compute", req)
        assert result["config"]["vmSize"] == "8 vCPU / 16GB RAM"

    def test_low_scale_gets_smaller_vm_size(self):
        req = make_requirements(expectedScale="500 users")
        result = run_lld_rules_engine("private", "compute", "compute", req)
        assert result["config"]["vmSize"] == "4 vCPU / 8GB RAM"


class TestDatabasePrivate:
    def test_manual_failover_flagged(self):
        req = make_requirements()
        result = run_lld_rules_engine("private", "database", "database", req)
        assert result["config"]["haMode"] == "Manual failover (no managed failover available)"


class TestComplianceMandatedConfigAdditions:
    def test_aws_database_gets_encryption_in_transit_for_fintech(self):
        req = make_requirements()
        result = run_lld_rules_engine("aws", "database", "database", req, industry_context=FINTECH_CONTEXT)
        assert result["config"]["encryptionInTransit"] == "TLS 1.2+ (Enforced)"

    def test_aws_database_gets_forced_multi_az_for_fintech(self):
        req = make_requirements(expectedScale="500 users")  # low scale would normally disable multiAZ
        result = run_lld_rules_engine("aws", "database", "database", req, industry_context=FINTECH_CONTEXT)
        assert result["config"]["multiAZ"] == "true (Primary/Standby)"

    def test_aws_database_gets_encryption_in_transit_for_healthtech(self):
        req = make_requirements()
        result = run_lld_rules_engine("aws", "database", "database", req, industry_context=HEALTHTECH_CONTEXT)
        assert result["config"]["encryptionInTransit"] == "TLS 1.2+ (Enforced)"

    def test_aws_compute_does_not_get_encryption_in_transit_key(self):
        """encryptionInTransit is only added for database/storage/cache component types."""
        req = make_requirements()
        result = run_lld_rules_engine("aws", "compute", "compute", req, industry_context=FINTECH_CONTEXT)
        assert "encryptionInTransit" not in result["config"]

    def test_aws_database_no_compliance_additions_for_none_industry(self):
        req = make_requirements()
        result = run_lld_rules_engine("aws", "database", "database", req, industry_context=NONE_CONTEXT)
        assert "encryptionInTransit" not in result["config"]

    def test_aws_database_byte_for_byte_unaffected_when_industry_context_omitted(self):
        req = make_requirements()
        with_none = run_lld_rules_engine("aws", "database", "database", req, industry_context=NONE_CONTEXT)
        without_arg = run_lld_rules_engine("aws", "database", "database", req)
        assert with_none == without_arg

    def test_kubernetes_database_gets_mtls_for_fintech(self):
        req = make_requirements(budget="$50,000/month", teamMaturity="a large senior platform team")
        result = run_lld_rules_engine("kubernetes", "database", "database", req, industry_context=FINTECH_CONTEXT)
        assert result["config"]["mtls"] == "Enabled (service mesh or cert-manager-issued pod certs)"

    def test_kubernetes_database_no_mtls_for_none_industry(self):
        req = make_requirements(budget="$50,000/month", teamMaturity="a large senior platform team")
        result = run_lld_rules_engine("kubernetes", "database", "database", req, industry_context=NONE_CONTEXT)
        assert "mtls" not in result["config"]

    def test_private_database_gets_network_segmentation_for_healthtech(self):
        req = make_requirements()
        result = run_lld_rules_engine("private", "database", "database", req, industry_context=HEALTHTECH_CONTEXT)
        assert result["config"]["networkSegmentation"] == "Dedicated VLAN, firewalled from general corporate network"

    def test_private_database_no_network_segmentation_for_none_industry(self):
        req = make_requirements()
        result = run_lld_rules_engine("private", "database", "database", req, industry_context=NONE_CONTEXT)
        assert "networkSegmentation" not in result["config"]
