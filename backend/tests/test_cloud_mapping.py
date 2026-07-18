"""Tests for app/services/cloud_mapping.py's get_cloud_mapping -- pure functions, no DB access.
Spot-checks representative (provider, component_type) pairs across aws/azure/gcp/kubernetes/
private, plus the exact budget-classification regression this whole task exists to fix."""


def make_requirements(
    functional: list[str] | None = None,
    *,
    expectedScale: str = "1,000 users",
    readWritePattern: str = "balanced",
    dataNature: str = "structured business records",
    latencySensitivity: str = "medium",
    budget: str = "$2,000/month",
    teamMaturity: str = "senior engineers",
    compliance: str = "none",
) -> dict:
    return {
        "functional": functional if functional is not None else ["Users can manage their account settings"],
        "nonFunctional": {
            "expectedScale": expectedScale,
            "readWritePattern": readWritePattern,
            "dataNature": dataNature,
            "latencySensitivity": latencySensitivity,
            "budget": budget,
            "teamMaturity": teamMaturity,
            "compliance": compliance,
        },
    }


class TestBudgetRegression:
    def test_large_budget_aws_primary_compute_does_not_pick_lambda(self):
        """The exact bug this task fixes: a $50,000/month budget must never be classified as
        tight, so the AWS primary compute mapping must not pick the Lambda/serverless branch even
        when paired with a small team (which alone would push toward serverless)."""
        from app.services.cloud_mapping import get_cloud_mapping

        req = make_requirements(budget="$50,000/month", teamMaturity="a small team")
        mapping = get_cloud_mapping("aws", "compute", "compute", req)

        assert "Lambda" not in mapping["serviceName"]
        # Phase 2: the LB is no longer bundled into compute's own serviceName -- it's a separate
        # "lb"-type component (see TestLbAndDnsMapping below).
        assert mapping["serviceName"] == "Amazon ECS Fargate"

    def test_large_budget_aws_worker_compute_does_not_pick_lambda(self):
        from app.services.cloud_mapping import get_cloud_mapping

        req = make_requirements(budget="$10,000/month", teamMaturity="a small team")
        mapping = get_cloud_mapping("aws", "compute", "worker", req)

        assert "Lambda" not in mapping["serviceName"]
        assert mapping["serviceName"] == "Amazon ECS Fargate (Worker)"

    def test_small_budget_aws_primary_compute_does_pick_serverless(self):
        from app.services.cloud_mapping import get_cloud_mapping

        req = make_requirements(budget="$50/month", teamMaturity="a small team")
        mapping = get_cloud_mapping("aws", "compute", "compute", req)

        # Phase 2: the API Gateway is no longer bundled into compute's own serviceName -- it's a
        # separate "lb"-type component (see TestLbAndDnsMapping below).
        assert mapping["serviceName"] == "AWS Lambda"

    def test_large_budget_azure_compute_does_not_pick_functions(self):
        from app.services.cloud_mapping import get_cloud_mapping

        req = make_requirements(budget="$50,000/month", teamMaturity="not_specified")
        mapping = get_cloud_mapping("azure", "compute", "compute", req)

        assert "Functions" not in mapping["serviceName"]

    def test_large_budget_gcp_compute_does_not_pick_functions(self):
        from app.services.cloud_mapping import get_cloud_mapping

        req = make_requirements(budget="$10,000/month", teamMaturity="not_specified")
        mapping = get_cloud_mapping("gcp", "compute", "compute", req)

        assert "Functions" not in mapping["serviceName"]


class TestRelationalVsDocumentDatabaseDrivesCloudMapping:
    def test_relational_data_nature_maps_to_aws_relational_service(self):
        from app.services.cloud_mapping import get_cloud_mapping

        req = make_requirements(dataNature="relational transactional records")
        mapping = get_cloud_mapping("aws", "database", "database", req)

        assert "RDS" in mapping["serviceName"] or "Aurora" in mapping["serviceName"]

    def test_unstructured_data_nature_maps_to_aws_document_service(self):
        from app.services.cloud_mapping import get_cloud_mapping

        req = make_requirements(dataNature="flexible schema-less content")
        mapping = get_cloud_mapping("aws", "database", "database", req)

        assert mapping["serviceName"] == "Amazon DynamoDB"

    def test_relational_data_nature_maps_to_gcp_relational_service(self):
        from app.services.cloud_mapping import get_cloud_mapping

        req = make_requirements(dataNature="relational transactional records")
        mapping = get_cloud_mapping("gcp", "database", "database", req)

        assert "Cloud SQL" in mapping["serviceName"]

    def test_unstructured_data_nature_maps_to_gcp_document_service(self):
        from app.services.cloud_mapping import get_cloud_mapping

        req = make_requirements(dataNature="flexible schema-less content")
        mapping = get_cloud_mapping("gcp", "database", "database", req)

        assert mapping["serviceName"] == "Google Cloud Firestore"


class TestRepresentativeProviderComponentPairs:
    def test_aws_storage(self):
        from app.services.cloud_mapping import get_cloud_mapping

        req = make_requirements()
        mapping = get_cloud_mapping("aws", "storage", "storage", req)
        assert mapping["serviceName"] == "Amazon S3"
        assert "alternatives" in mapping and len(mapping["alternatives"]) == 1
        assert "costEstimate" in mapping

    def test_azure_cache(self):
        from app.services.cloud_mapping import get_cloud_mapping

        req = make_requirements()
        mapping = get_cloud_mapping("azure", "cache", "cache", req)
        assert "Redis" in mapping["serviceName"]

    def test_gcp_auth(self):
        from app.services.cloud_mapping import get_cloud_mapping

        req = make_requirements()
        mapping = get_cloud_mapping("gcp", "auth", "auth", req)
        assert mapping["serviceName"] == "Firebase Authentication"

    def test_kubernetes_compute_primary(self):
        from app.services.cloud_mapping import get_cloud_mapping

        req = make_requirements()
        mapping = get_cloud_mapping("kubernetes", "compute", "compute", req)
        assert mapping["serviceName"] == "Deployment + HorizontalPodAutoscaler (HPA)"

    def test_kubernetes_database_low_ops_capacity_goes_external(self):
        from app.services.cloud_mapping import get_cloud_mapping

        req = make_requirements(budget="$50/month", teamMaturity="a small team")
        mapping = get_cloud_mapping("kubernetes", "database", "database", req)
        assert "External" in mapping["serviceName"]

    def test_kubernetes_database_adequate_ops_capacity_self_manages(self):
        from app.services.cloud_mapping import get_cloud_mapping

        req = make_requirements(budget="$50,000/month", teamMaturity="a large senior platform team")
        mapping = get_cloud_mapping("kubernetes", "database", "database", req)
        assert "StatefulSet" in mapping["serviceName"]

    def test_private_compute(self):
        from app.services.cloud_mapping import get_cloud_mapping

        req = make_requirements()
        mapping = get_cloud_mapping("private", "compute", "compute", req)
        assert "Virtual Machines" in mapping["serviceName"]

    def test_private_database(self):
        from app.services.cloud_mapping import get_cloud_mapping

        req = make_requirements()
        mapping = get_cloud_mapping("private", "database", "database", req)
        assert "PostgreSQL" in mapping["serviceName"]

    def test_unknown_provider_falls_back_to_generic_mapping(self):
        from app.services.cloud_mapping import get_cloud_mapping

        req = make_requirements()
        mapping = get_cloud_mapping("unknown-provider", "compute", "compute", req)
        assert mapping["alternatives"] == []
        assert mapping["costEstimate"] == {"min": 0, "max": 0, "assumptions": "Fallback."}


class TestLbAndDnsMapping:
    """The "lb" branch doesn't know whether it's fronting serverless or container-style compute
    ahead of time -- it recomputes the exact same budget/team signal the compute branch uses, so
    it must always agree with whichever compute service the SAME requirements would produce."""

    def test_aws_lb_resolves_to_alb_for_container_budget(self):
        from app.services.cloud_mapping import get_cloud_mapping

        req = make_requirements(budget="$50,000/month", teamMaturity="a large senior team")
        compute = get_cloud_mapping("aws", "compute", "compute", req)
        lb = get_cloud_mapping("aws", "lb", "lb", req)

        assert compute["serviceName"] == "Amazon ECS Fargate"
        assert lb["serviceName"] == "Application Load Balancer"
        assert "costEstimate" in lb and "alternatives" in lb and len(lb["alternatives"]) == 1

    def test_aws_lb_resolves_to_api_gateway_for_serverless_budget(self):
        from app.services.cloud_mapping import get_cloud_mapping

        req = make_requirements(budget="$50/month", teamMaturity="a junior team")
        compute = get_cloud_mapping("aws", "compute", "compute", req)
        lb = get_cloud_mapping("aws", "lb", "lb", req)

        assert compute["serviceName"] == "AWS Lambda"
        assert lb["serviceName"] == "Amazon API Gateway (HTTP API)"

    def test_azure_lb_container_vs_serverless(self):
        from app.services.cloud_mapping import get_cloud_mapping

        container_req = make_requirements(budget="$50,000/month", teamMaturity="a large senior team")
        serverless_req = make_requirements(budget="$50/month", teamMaturity="a junior team")

        assert get_cloud_mapping("azure", "lb", "lb", container_req)["serviceName"] == "Azure Application Gateway"
        assert get_cloud_mapping("azure", "lb", "lb", serverless_req)["serviceName"] == "Azure API Management"

    def test_gcp_lb_container_vs_serverless(self):
        from app.services.cloud_mapping import get_cloud_mapping

        container_req = make_requirements(budget="$50,000/month", teamMaturity="a large senior team")
        serverless_req = make_requirements(budget="$50/month", teamMaturity="a junior team")

        assert get_cloud_mapping("gcp", "lb", "lb", container_req)["serviceName"] == "Google Cloud Load Balancing (HTTPS)"
        assert get_cloud_mapping("gcp", "lb", "lb", serverless_req)["serviceName"] == "Google Cloud API Gateway"

    def test_dns_mapping_every_major_provider(self):
        from app.services.cloud_mapping import get_cloud_mapping

        req = make_requirements()
        assert get_cloud_mapping("aws", "dns", "dns", req)["serviceName"] == "Amazon Route 53"
        assert get_cloud_mapping("azure", "dns", "dns", req)["serviceName"] == "Azure DNS"
        assert get_cloud_mapping("gcp", "dns", "dns", req)["serviceName"] == "Google Cloud DNS"

    def test_kubernetes_lb_and_dns_are_real_incluster_resources(self):
        from app.services.cloud_mapping import get_cloud_mapping

        req = make_requirements()
        lb = get_cloud_mapping("kubernetes", "lb", "lb", req)
        dns = get_cloud_mapping("kubernetes", "dns", "dns", req)

        assert "Ingress" in lb["serviceName"]
        assert "ExternalDNS" in dns["serviceName"]

    def test_private_lb_and_dns_are_self_managed(self):
        from app.services.cloud_mapping import get_cloud_mapping

        req = make_requirements()
        lb = get_cloud_mapping("private", "lb", "lb", req)
        dns = get_cloud_mapping("private", "dns", "dns", req)

        assert "Self-Managed" in lb["serviceName"]
        assert "Manually Managed" in dns["serviceName"]


class TestHighScaleAffectsCostBands:
    def test_high_scale_increases_aws_storage_max_cost(self):
        from app.services.cloud_mapping import get_cloud_mapping

        low_scale_req = make_requirements(expectedScale="500 users")
        high_scale_req = make_requirements(expectedScale="high scale, 1 million users")

        low_mapping = get_cloud_mapping("aws", "storage", "storage", low_scale_req)
        high_mapping = get_cloud_mapping("aws", "storage", "storage", high_scale_req)

        assert high_mapping["costEstimate"]["max"] > low_mapping["costEstimate"]["max"]


class TestMonitoringMapping:
    def test_aws_monitoring_is_cloudwatch(self):
        from app.services.cloud_mapping import get_cloud_mapping

        req = make_requirements()
        mapping = get_cloud_mapping("aws", "monitoring", "monitoring", req)
        assert "CloudWatch" in mapping["serviceName"]
        assert "alternatives" in mapping and len(mapping["alternatives"]) == 1
        assert "costEstimate" in mapping

    def test_azure_monitoring_is_monitor_plus_app_insights(self):
        from app.services.cloud_mapping import get_cloud_mapping

        req = make_requirements()
        mapping = get_cloud_mapping("azure", "monitoring", "monitoring", req)
        assert "Monitor" in mapping["serviceName"]
        assert "Application Insights" in mapping["serviceName"]

    def test_gcp_monitoring_is_operations_suite(self):
        from app.services.cloud_mapping import get_cloud_mapping

        req = make_requirements()
        mapping = get_cloud_mapping("gcp", "monitoring", "monitoring", req)
        assert "Operations Suite" in mapping["serviceName"]

    def test_kubernetes_monitoring_is_self_hosted_prometheus_grafana(self):
        from app.services.cloud_mapping import get_cloud_mapping

        req = make_requirements()
        mapping = get_cloud_mapping("kubernetes", "monitoring", "monitoring", req)
        assert "Prometheus" in mapping["serviceName"] and "Grafana" in mapping["serviceName"]

    def test_private_monitoring_is_self_managed(self):
        from app.services.cloud_mapping import get_cloud_mapping

        req = make_requirements()
        mapping = get_cloud_mapping("private", "monitoring", "monitoring", req)
        assert "Self-Managed" in mapping["serviceName"]


class TestNotificationMapping:
    def test_aws_notification_is_sns(self):
        from app.services.cloud_mapping import get_cloud_mapping

        req = make_requirements()
        mapping = get_cloud_mapping("aws", "notification", "notification", req)
        assert mapping["serviceName"] == "Amazon SNS"

    def test_azure_notification_reuses_service_bus_for_consistency_with_queue(self):
        """Azure's queue mapping already uses Service Bus -- notification should reuse the same
        platform (Topics) rather than introducing an unrelated messaging product."""
        from app.services.cloud_mapping import get_cloud_mapping

        req = make_requirements()
        queue_mapping = get_cloud_mapping("azure", "queue", "queue", req)
        notification_mapping = get_cloud_mapping("azure", "notification", "notification", req)
        assert "Service Bus" in queue_mapping["serviceName"]
        assert "Service Bus" in notification_mapping["serviceName"]

    def test_gcp_notification_is_pubsub_same_as_queue(self):
        """GCP has no dedicated notification product distinct from its own queue -- both resolve
        to Pub/Sub, and the mapping is honest about that in its reasoning."""
        from app.services.cloud_mapping import get_cloud_mapping

        req = make_requirements()
        queue_mapping = get_cloud_mapping("gcp", "queue", "queue", req)
        notification_mapping = get_cloud_mapping("gcp", "notification", "notification", req)
        assert queue_mapping["serviceName"] == "Google Cloud Pub/Sub"
        assert notification_mapping["serviceName"] == "Google Cloud Pub/Sub"

    def test_kubernetes_notification_is_self_hosted(self):
        from app.services.cloud_mapping import get_cloud_mapping

        req = make_requirements()
        mapping = get_cloud_mapping("kubernetes", "notification", "notification", req)
        assert "NATS" in mapping["serviceName"]

    def test_private_notification_flags_external_delivery_dependency(self):
        from app.services.cloud_mapping import get_cloud_mapping

        req = make_requirements()
        mapping = get_cloud_mapping("private", "notification", "notification", req)
        assert "Self-Managed" in mapping["serviceName"]


class TestWafCostNoteOnLbAndCdn:
    """The WAF cost note is folded into the existing lb/cdn cost estimate assumptions text
    (never a separate line) whenever is_high_scale or is_high_security would trigger
    lld_rules.py's wafEnabled -- see _waf_cost_note in cloud_mapping.py."""

    def test_high_scale_aws_lb_assumptions_mention_waf(self):
        from app.services.cloud_mapping import get_cloud_mapping

        req = make_requirements(expectedScale="high scale, 1 million users", budget="$50,000/month", teamMaturity="a large senior team")
        mapping = get_cloud_mapping("aws", "lb", "lb", req)
        assert "WAF" in mapping["costEstimate"]["assumptions"]

    def test_high_security_aws_cdn_assumptions_mention_waf(self):
        from app.services.cloud_mapping import get_cloud_mapping

        req = make_requirements(compliance="PCI-DSS required", functional=["Users can upload profile pictures"])
        mapping = get_cloud_mapping("aws", "cdn", "cdn", req)
        assert "WAF" in mapping["costEstimate"]["assumptions"]

    def test_low_scale_low_security_aws_lb_assumptions_do_not_mention_waf(self):
        from app.services.cloud_mapping import get_cloud_mapping

        req = make_requirements(expectedScale="500 users", budget="$2,000/month", teamMaturity="senior engineers")
        mapping = get_cloud_mapping("aws", "lb", "lb", req)
        assert "WAF" not in mapping["costEstimate"]["assumptions"]

    def test_high_scale_azure_lb_assumptions_mention_waf(self):
        from app.services.cloud_mapping import get_cloud_mapping

        req = make_requirements(expectedScale="high scale, 1 million users", budget="$50,000/month", teamMaturity="a large senior team")
        mapping = get_cloud_mapping("azure", "lb", "lb", req)
        assert "WAF" in mapping["costEstimate"]["assumptions"]

    def test_high_scale_gcp_lb_assumptions_mention_waf(self):
        from app.services.cloud_mapping import get_cloud_mapping

        req = make_requirements(expectedScale="high scale, 1 million users", budget="$50,000/month", teamMaturity="a large senior team")
        mapping = get_cloud_mapping("gcp", "lb", "lb", req)
        assert "WAF" in mapping["costEstimate"]["assumptions"]
