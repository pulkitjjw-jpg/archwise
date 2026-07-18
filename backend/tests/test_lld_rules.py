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
    functional: list[str] | None = None,
) -> dict:
    reqs: dict = {
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
    if functional is not None:
        reqs["functional"] = functional
    return reqs


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


class TestDrStrategyLldConfig:
    """Phase 5: dns/database/storage/compute LLD enrichment when a DR tier is active, computed
    internally via nfr_signals.determine_dr_strategy from the same requirements/industry_context
    already passed to run_lld_rules_engine -- no dr_strategy parameter of its own."""

    def _pilot_light_req(self):
        # is_high_scale alone -> pilot-light (see TestDetermineDrStrategy in test_nfr_signals.py).
        return make_requirements(expectedScale="high scale, 1 million users", budget="$50,000/month", teamMaturity="a large senior team")

    def _warm_standby_req(self):
        # is_high_scale AND is_high_security -> warm-standby.
        return make_requirements(
            expectedScale="high scale, 1 million users", compliance="HIPAA required", budget="$50,000/month", teamMaturity="a large senior team"
        )

    def test_generic_project_gets_no_dr_keys_on_dns(self):
        req = make_requirements()
        result = run_lld_rules_engine("aws", "dns", "dns", req)
        assert "secondaryRegion" not in result["config"]
        assert "failoverThreshold" not in result["config"]
        assert result["config"]["routingPolicy"] == "Simple"

    def test_pilot_light_dns_gets_active_passive_failover(self):
        req = self._pilot_light_req()
        result = run_lld_rules_engine("aws", "dns", "dns", req)
        assert result["config"]["routingPolicy"] == "Failover (Active-Passive)"
        assert result["config"]["secondaryRegion"] == "us-west-2"
        assert result["config"]["failoverThreshold"]
        assert result["reasoning"]["secondaryRegion"]

    def test_warm_standby_dns_gets_latency_based_routing(self):
        req = self._warm_standby_req()
        result = run_lld_rules_engine("aws", "dns", "dns", req)
        assert "Latency-based routing" in result["config"]["routingPolicy"]
        assert result["config"]["secondaryRegion"] == "us-west-2"

    def test_dns_secondary_region_is_provider_specific(self):
        req = self._pilot_light_req()
        assert run_lld_rules_engine("azure", "dns", "dns", req)["config"]["secondaryRegion"] == "West US"
        assert run_lld_rules_engine("gcp", "dns", "dns", req)["config"]["secondaryRegion"] == "us-east1"

    def test_generic_project_database_gets_no_dr_keys(self):
        req = make_requirements()
        result = run_lld_rules_engine("aws", "database", "database", req)
        assert "drStrategy" not in result["config"]
        assert "crossRegionReplication" not in result["config"]

    def test_pilot_light_database_gets_manual_promotion_replica(self):
        req = self._pilot_light_req()
        result = run_lld_rules_engine("aws", "database", "database", req)
        assert result["config"]["drStrategy"] == "pilot-light"
        assert result["config"]["secondaryRegion"] == "us-west-2"
        assert "promoted manually" in result["config"]["crossRegionReplication"]

    def test_warm_standby_database_gets_automatic_failover_replication(self):
        req = self._warm_standby_req()
        result = run_lld_rules_engine("aws", "database", "database", req)
        assert result["config"]["drStrategy"] == "warm-standby"
        assert "Aurora Global Database" in result["config"]["crossRegionReplication"]
        assert "automatic failover" in result["config"]["crossRegionReplication"]

    def test_warm_standby_database_cross_region_replication_is_provider_specific(self):
        req = self._warm_standby_req()
        azure_result = run_lld_rules_engine("azure", "database", "database", req)
        gcp_result = run_lld_rules_engine("gcp", "database", "database", req)
        assert "Cosmos DB" in azure_result["config"]["crossRegionReplication"] or "SQL" in azure_result["config"]["crossRegionReplication"]
        assert "Cloud SQL" in gcp_result["config"]["crossRegionReplication"]

    def test_generic_project_storage_gets_no_cross_region_replication_key(self):
        req = make_requirements()
        result = run_lld_rules_engine("aws", "storage", "storage", req)
        assert "crossRegionReplication" not in result["config"]

    def test_pilot_light_storage_gets_cross_region_replication_and_forces_versioning(self):
        req = self._pilot_light_req()
        result = run_lld_rules_engine("aws", "storage", "storage", req)
        assert result["config"]["crossRegionReplication"]
        assert result["config"]["versioningEnabled"] == "true"

    def test_warm_standby_storage_also_gets_cross_region_replication(self):
        """Storage enrichment is identical for both tiers -- cheap and always-on once any DR tier
        is active, per lld_rules.py's own design (see the crossRegionReplication comment)."""
        pilot_result = run_lld_rules_engine("aws", "storage", "storage", self._pilot_light_req())
        warm_result = run_lld_rules_engine("aws", "storage", "storage", self._warm_standby_req())
        assert pilot_result["config"]["crossRegionReplication"] == warm_result["config"]["crossRegionReplication"]

    def test_generic_project_compute_gets_no_standby_capacity(self):
        req = make_requirements()
        result = run_lld_rules_engine("aws", "compute", "compute", req)
        assert "standbyCapacity" not in result["config"]

    def test_pilot_light_compute_gets_no_standby_capacity(self):
        """Pilot-light's whole point is minimal/no standing secondary compute."""
        req = self._pilot_light_req()
        result = run_lld_rules_engine("aws", "compute", "compute", req)
        assert "standbyCapacity" not in result["config"]

    def test_warm_standby_compute_gets_standby_capacity(self):
        req = self._warm_standby_req()
        result = run_lld_rules_engine("aws", "compute", "compute", req)
        assert result["config"]["standbyCapacity"]
        assert result["reasoning"]["standbyCapacity"]

    def test_kubernetes_and_private_are_unaffected_by_dr_strategy(self):
        """DR enrichment is scoped to the aws/azure/gcp branch only -- kubernetes/private LLD
        shapes are untouched even when the same NFR would trigger warm-standby on aws/azure/gcp."""
        req = self._warm_standby_req()
        k8s_result = run_lld_rules_engine("kubernetes", "database", "database", req)
        private_result = run_lld_rules_engine("private", "database", "database", req)
        assert "drStrategy" not in k8s_result["config"]
        assert "drStrategy" not in private_result["config"]


class TestWafLldConfig:
    """WAF is LLD-only (no new component type) -- config keys land on the EXISTING "lb"/"cdn"
    branches for aws/azure/gcp, triggered by is_high_scale OR is_high_security OR a
    fintech/healthtech industry_context."""

    def test_high_scale_enables_waf_on_lb(self):
        req = make_requirements(expectedScale="high scale, 1 million users", budget="$50,000/month", teamMaturity="a large senior team")
        result = run_lld_rules_engine("aws", "lb", "lb", req)
        assert result["config"]["wafEnabled"] == "true"
        assert "wafRuleSet" in result["config"]
        assert result["config"]["rateLimitPerIP"]

    def test_high_security_compliance_enables_waf_on_lb(self):
        req = make_requirements(compliance="PCI-DSS required", budget="$50,000/month", teamMaturity="a large senior team")
        result = run_lld_rules_engine("aws", "lb", "lb", req)
        assert result["config"]["wafEnabled"] == "true"

    def test_fintech_industry_context_enables_waf_even_at_low_scale(self):
        req = make_requirements(expectedScale="500 users", budget="$50,000/month", teamMaturity="a large senior team")
        result = run_lld_rules_engine("aws", "lb", "lb", req, industry_context={"industry": "fintech", "flags": {}})
        assert result["config"]["wafEnabled"] == "true"

    def test_healthtech_industry_context_enables_waf_on_cdn(self):
        req = make_requirements(expectedScale="500 users", functional=["Users can upload profile pictures"])
        result = run_lld_rules_engine("aws", "cdn", "cdn", req, industry_context={"industry": "healthtech", "flags": {}})
        assert result["config"]["wafEnabled"] == "true"

    def test_low_scale_low_security_generic_disables_waf(self):
        req = make_requirements(expectedScale="500 users", budget="$50,000/month", teamMaturity="a large senior team")
        result = run_lld_rules_engine("aws", "lb", "lb", req)
        assert result["config"]["wafEnabled"] == "false"
        assert "wafRuleSet" not in result["config"]
        assert "not a security gap" in result["reasoning"]["wafEnabled"]

    def test_provider_specific_rule_set_labels(self):
        req = make_requirements(expectedScale="high scale, 1 million users")
        aws_result = run_lld_rules_engine("aws", "lb", "lb", req)
        azure_result = run_lld_rules_engine("azure", "lb", "lb", req)
        gcp_result = run_lld_rules_engine("gcp", "lb", "lb", req)
        assert "AWS Managed Rules" in aws_result["config"]["wafRuleSet"]
        assert "Azure-managed" in azure_result["config"]["wafRuleSet"]
        assert "Cloud Armor" in gcp_result["config"]["wafRuleSet"]

    def test_kubernetes_lb_gets_brief_waf_note_not_full_config(self):
        req = make_requirements(expectedScale="high scale, 1 million users")
        result = run_lld_rules_engine("kubernetes", "lb", "lb", req)
        assert "wafEnabled" not in result["config"]
        assert "ModSecurity" in result["config"]["wafNote"]

    def test_private_cdn_gets_brief_waf_note_not_full_config(self):
        req = make_requirements(expectedScale="high scale, 1 million users")
        result = run_lld_rules_engine("private", "cdn", "cdn", req)
        assert "wafEnabled" not in result["config"]
        assert "ModSecurity" in result["config"]["wafNote"]


class TestMonitoringLldConfig:
    def test_generic_scale_gets_baseline_retention_and_sampling(self):
        req = make_requirements(expectedScale="1,000 users")
        result = run_lld_rules_engine("aws", "monitoring", "monitoring", req)
        assert result["config"]["logRetentionDays"] == "30"
        assert result["config"]["tracingSampleRate"] == "100% (full trace)"

    def test_high_scale_reduces_tracing_sample_rate(self):
        req = make_requirements(expectedScale="high scale, 1 million users")
        result = run_lld_rules_engine("aws", "monitoring", "monitoring", req)
        assert result["config"]["tracingSampleRate"] == "5% (sampled)"

    def test_high_security_extends_log_retention(self):
        req = make_requirements(compliance="HIPAA required")
        result = run_lld_rules_engine("aws", "monitoring", "monitoring", req)
        assert result["config"]["logRetentionDays"] == "365 (regulatory)"

    def test_kubernetes_monitoring_uses_kube_prometheus_stack(self):
        req = make_requirements()
        result = run_lld_rules_engine("kubernetes", "monitoring", "monitoring", req)
        assert "kube-prometheus-stack" in result["config"]["deploymentMode"]

    def test_private_monitoring_flags_no_managed_platform(self):
        req = make_requirements()
        result = run_lld_rules_engine("private", "monitoring", "monitoring", req)
        assert "Self-hosted" in result["config"]["deploymentMode"]


class TestNotificationLldConfig:
    def test_defaults_to_email_when_no_channel_specified(self):
        req = make_requirements(functional=["Users can view their order history"])
        result = run_lld_rules_engine("aws", "notification", "notification", req)
        assert result["config"]["deliveryChannels"] == "Email"
        assert "Defaulted to email" in result["reasoning"]["deliveryChannels"]

    def test_infers_sms_channel_from_functional_requirements(self):
        req = make_requirements(functional=["System sends SMS reminders before appointments"])
        result = run_lld_rules_engine("aws", "notification", "notification", req)
        assert "SMS" in result["config"]["deliveryChannels"]
        assert "Inferred directly" in result["reasoning"]["deliveryChannels"]

    def test_infers_multiple_channels(self):
        req = make_requirements(functional=["Users get an email and a push notification when their order ships"])
        result = run_lld_rules_engine("aws", "notification", "notification", req)
        assert "Email" in result["config"]["deliveryChannels"]
        assert "Push" in result["config"]["deliveryChannels"]

    def test_retry_and_dead_letter_handling_always_present(self):
        req = make_requirements()
        result = run_lld_rules_engine("aws", "notification", "notification", req)
        assert result["config"]["retryPolicy"]
        assert "dead-letter" in result["config"]["deadLetterHandling"]

    def test_kubernetes_notification_flags_external_delivery_dependency(self):
        req = make_requirements()
        result = run_lld_rules_engine("kubernetes", "notification", "notification", req)
        assert "external" in result["config"]["deploymentMode"].lower()

    def test_private_notification_flags_external_delivery_dependency(self):
        req = make_requirements()
        result = run_lld_rules_engine("private", "notification", "notification", req)
        assert "external delivery provider" in result["config"]["externalDependencyFlag"].lower()
