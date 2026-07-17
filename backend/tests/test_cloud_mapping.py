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
        assert mapping["serviceName"] == "Amazon ECS Fargate + ALB"

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

        assert mapping["serviceName"] == "AWS Lambda + API Gateway"

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


class TestHighScaleAffectsCostBands:
    def test_high_scale_increases_aws_storage_max_cost(self):
        from app.services.cloud_mapping import get_cloud_mapping

        low_scale_req = make_requirements(expectedScale="500 users")
        high_scale_req = make_requirements(expectedScale="high scale, 1 million users")

        low_mapping = get_cloud_mapping("aws", "storage", "storage", low_scale_req)
        high_mapping = get_cloud_mapping("aws", "storage", "storage", high_scale_req)

        assert high_mapping["costEstimate"]["max"] > low_mapping["costEstimate"]["max"]
