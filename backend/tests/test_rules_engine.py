"""Tests for the deterministic baseline HLD rules engine (app/services/rules_engine.py). Pure
functions -- no DB access needed. Assertions check the actual components/connections/rulesTrace
returned, not just that the call doesn't crash, per the audit's finding that this domain logic has
zero coverage today despite being the thing every downstream feature (cloud mapping, LLD, diff)
builds on."""


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
    """Base requirements deliberately avoid triggering CDN/cache/queue/auth/object-storage so each
    test can turn on exactly the signal it's checking. dataNature has no relational keywords by
    default, so the database branch defaults to Document (see is_relational_data_nature)."""
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


def component_types(result: dict) -> set[str]:
    return {c["type"] for c in result["components"]}


def component_ids(result: dict) -> set[str]:
    return {c["id"] for c in result["components"]}


class TestCdnRule:
    def test_triggered_by_media_keyword_in_functional_requirements(self):
        from app.services.rules_engine import run_rules_engine

        # Default make_requirements() budget/teamMaturity fire the container compute branch, which
        # also adds an "lb" component -- so the CDN sits in front of the lb, not compute directly
        # (see TestLbRule below for the serverless case, where cdn connects straight to compute).
        req = make_requirements(functional=["Users can upload profile pictures and video clips"])
        result = run_rules_engine(req)

        assert "cdn" in component_ids(result)
        assert "Rule-CDN-HighScale-Or-Media" in result["rulesTrace"]
        assert {"from": "cdn", "to": "lb", "protocol": "HTTPS"} in result["connections"]

    def test_triggered_by_high_latency_sensitivity(self):
        from app.services.rules_engine import run_rules_engine

        req = make_requirements(latencySensitivity="high, sub-100ms required")
        result = run_rules_engine(req)

        assert "cdn" in component_ids(result)
        assert "Rule-CDN-HighScale-Or-Media" in result["rulesTrace"]

    def test_not_triggered_without_media_or_high_latency(self):
        from app.services.rules_engine import run_rules_engine

        req = make_requirements()
        result = run_rules_engine(req)

        assert "cdn" not in component_ids(result)
        assert "Rule-CDN-HighScale-Or-Media" not in result["rulesTrace"]


class TestComputeServerlessVsContainer:
    def test_tight_budget_and_junior_team_gets_serverless(self):
        from app.services.rules_engine import run_rules_engine

        req = make_requirements(budget="$50/month", teamMaturity="a junior team, first project")
        result = run_rules_engine(req)

        compute = next(c for c in result["components"] if c["id"] == "compute")
        assert compute["name"] == "Managed Serverless Compute"
        assert "Rule-Compute-Serverless" in result["rulesTrace"]

    def test_large_budget_regression_does_not_get_serverless(self):
        """Regression test for the exact bug being fixed: under the old crude substring check,
        "$50,000/month" contained the digits "50" and was misclassified as a tight budget. A
        well-funded $50k/month budget with a senior/large team must get the container branch."""
        from app.services.rules_engine import run_rules_engine

        req = make_requirements(budget="$50,000/month", teamMaturity="a large, senior engineering team")
        result = run_rules_engine(req)

        compute = next(c for c in result["components"] if c["id"] == "compute")
        assert compute["name"] == "API Container Service"
        assert "Rule-Compute-Container" in result["rulesTrace"]
        assert "Rule-Compute-Serverless" not in result["rulesTrace"]

    def test_large_budget_with_small_team_still_does_not_get_serverless(self):
        """Even paired with a small/junior team (which alone would push toward serverless), a
        genuinely large budget like $10,000/month must not be misread as tight."""
        from app.services.rules_engine import run_rules_engine

        req = make_requirements(budget="$10,000/month", teamMaturity="a small team")
        result = run_rules_engine(req)

        compute = next(c for c in result["components"] if c["id"] == "compute")
        assert compute["name"] == "API Container Service"

    def test_adequate_budget_and_senior_team_gets_container(self):
        from app.services.rules_engine import run_rules_engine

        req = make_requirements(budget="$2,000/month", teamMaturity="senior engineers")
        result = run_rules_engine(req)

        compute = next(c for c in result["components"] if c["id"] == "compute")
        assert compute["name"] == "API Container Service"
        assert "Rule-Compute-Container" in result["rulesTrace"]


class TestLbRule:
    def test_container_compute_gets_lb_component_wired_to_compute(self):
        from app.services.rules_engine import run_rules_engine

        req = make_requirements(budget="$2,000/month", teamMaturity="senior engineers")
        result = run_rules_engine(req)

        assert "Rule-Compute-Container" in result["rulesTrace"]
        assert "lb" in component_ids(result)
        assert "Rule-LB-Container" in result["rulesTrace"]
        lb = next(c for c in result["components"] if c["id"] == "lb")
        assert lb["type"] == "lb"
        assert {"from": "lb", "to": "compute", "protocol": "HTTPS"} in result["connections"]

    def test_serverless_compute_gets_no_lb_component(self):
        """Serverless's own gateway (API Gateway/API Management) is resolved per-provider inside
        cloud_mapping.py's "lb" branch when a user manually adds one, but rules_engine.py itself
        never auto-adds an "lb" component for the serverless compute branch."""
        from app.services.rules_engine import run_rules_engine

        req = make_requirements(budget="$50/month", teamMaturity="a junior team, first project")
        result = run_rules_engine(req)

        assert "Rule-Compute-Serverless" in result["rulesTrace"]
        assert "lb" not in component_ids(result)
        assert "Rule-LB-Container" not in result["rulesTrace"]

    def test_cdn_connects_through_lb_not_directly_to_compute_when_lb_present(self):
        from app.services.rules_engine import run_rules_engine

        req = make_requirements(
            functional=["Users can upload profile pictures"], budget="$2,000/month", teamMaturity="senior engineers"
        )
        result = run_rules_engine(req)

        assert {"from": "cdn", "to": "lb", "protocol": "HTTPS"} in result["connections"]
        assert {"from": "cdn", "to": "compute", "protocol": "HTTPS"} not in result["connections"]

    def test_cdn_connects_directly_to_compute_when_no_lb(self):
        from app.services.rules_engine import run_rules_engine

        req = make_requirements(
            functional=["Users can upload profile pictures"], budget="$50/month", teamMaturity="a junior team"
        )
        result = run_rules_engine(req)

        assert "lb" not in component_ids(result)
        assert {"from": "cdn", "to": "compute", "protocol": "HTTPS"} in result["connections"]


class TestDnsRule:
    def test_dns_added_when_lb_present_and_connects_to_lb(self):
        from app.services.rules_engine import run_rules_engine

        req = make_requirements(budget="$2,000/month", teamMaturity="senior engineers")
        result = run_rules_engine(req)

        assert "lb" in component_ids(result)
        assert "dns" in component_ids(result)
        assert "Rule-DNS-PublicEdge" in result["rulesTrace"]
        assert {"from": "dns", "to": "lb", "protocol": "DNS"} in result["connections"]

    def test_dns_added_when_only_cdn_present_no_lb_and_connects_to_cdn(self):
        from app.services.rules_engine import run_rules_engine

        req = make_requirements(
            functional=["Users can upload profile pictures"], budget="$50/month", teamMaturity="a junior team"
        )
        result = run_rules_engine(req)

        assert "lb" not in component_ids(result)
        assert "cdn" in component_ids(result)
        assert "dns" in component_ids(result)
        assert {"from": "dns", "to": "cdn", "protocol": "DNS"} in result["connections"]
        assert {"from": "dns", "to": "lb", "protocol": "DNS"} not in result["connections"]

    def test_dns_not_added_when_neither_lb_nor_cdn_present(self):
        """Serverless compute (no lb) with no CDN-triggering signals -- no public edge at all, so
        no DNS component either."""
        from app.services.rules_engine import run_rules_engine

        req = make_requirements(budget="$50/month", teamMaturity="a junior team, first project")
        result = run_rules_engine(req)

        assert "lb" not in component_ids(result)
        assert "cdn" not in component_ids(result)
        assert "dns" not in component_ids(result)
        assert "Rule-DNS-PublicEdge" not in result["rulesTrace"]


class TestDatabaseRelationalVsDocument:
    def test_relational_data_nature_gets_relational_database(self):
        from app.services.rules_engine import run_rules_engine

        req = make_requirements(dataNature="relational transactional records requiring strict consistency")
        result = run_rules_engine(req)

        database = next(c for c in result["components"] if c["id"] == "database")
        assert database["name"] == "Relational Database"
        assert "Rule-DB-Relational" in result["rulesTrace"]
        assert {"from": "compute", "to": "database", "protocol": "SQL/TCP"} in result["connections"]

    def test_invoice_in_functional_requirements_gets_relational_database(self):
        from app.services.rules_engine import run_rules_engine

        req = make_requirements(functional=["Users can generate and download invoice PDFs"])
        result = run_rules_engine(req)

        database = next(c for c in result["components"] if c["id"] == "database")
        assert database["name"] == "Relational Database"

    def test_unstructured_data_nature_gets_document_database(self):
        from app.services.rules_engine import run_rules_engine

        req = make_requirements(dataNature="flexible, schema-less user-generated content")
        result = run_rules_engine(req)

        database = next(c for c in result["components"] if c["id"] == "database")
        assert database["name"] == "Document Database"
        assert "Rule-DB-Document" in result["rulesTrace"]


class TestObjectStorageRule:
    def test_triggered_by_file_upload_functional_requirement(self):
        from app.services.rules_engine import run_rules_engine

        req = make_requirements(functional=["Users can upload PDF documents"])
        result = run_rules_engine(req)

        assert "storage" in component_ids(result)
        assert "Rule-Storage-Object" in result["rulesTrace"]
        assert {"from": "compute", "to": "storage", "protocol": "HTTPS"} in result["connections"]

    def test_not_triggered_without_file_media_signals(self):
        from app.services.rules_engine import run_rules_engine

        req = make_requirements()
        result = run_rules_engine(req)

        assert "storage" not in component_ids(result)


class TestCachingRule:
    def test_triggered_by_read_heavy_pattern(self):
        from app.services.rules_engine import run_rules_engine

        req = make_requirements(readWritePattern="read-heavy, mostly product browsing")
        result = run_rules_engine(req)

        assert "cache" in component_ids(result)
        assert "Rule-Cache-ReadHeavy" in result["rulesTrace"]
        assert {"from": "compute", "to": "cache", "protocol": "Redis/TCP"} in result["connections"]

    def test_triggered_by_high_expected_scale(self):
        from app.services.rules_engine import run_rules_engine

        req = make_requirements(expectedScale="high scale, 1 million users")
        result = run_rules_engine(req)

        assert "cache" in component_ids(result)

    def test_not_triggered_for_balanced_low_scale(self):
        from app.services.rules_engine import run_rules_engine

        req = make_requirements()
        result = run_rules_engine(req)

        assert "cache" not in component_ids(result)


class TestQueueWorkerRule:
    def test_triggered_by_background_job_keyword(self):
        from app.services.rules_engine import run_rules_engine

        req = make_requirements(functional=["System runs background report generation jobs"])
        result = run_rules_engine(req)

        assert "queue" in component_ids(result)
        assert "worker" in component_ids(result)
        assert "Rule-Queue-Worker" in result["rulesTrace"]
        assert {"from": "compute", "to": "queue", "protocol": "AMQP/HTTP"} in result["connections"]
        assert {"from": "queue", "to": "worker", "protocol": "Poll"} in result["connections"]
        assert {"from": "worker", "to": "database", "protocol": "SQL/TCP"} in result["connections"]

    def test_worker_connects_to_storage_when_object_store_also_present(self):
        from app.services.rules_engine import run_rules_engine

        req = make_requirements(functional=["Users can upload files for async background processing"])
        result = run_rules_engine(req)

        assert "storage" in component_ids(result)
        assert "queue" in component_ids(result)
        assert {"from": "worker", "to": "storage", "protocol": "HTTPS"} in result["connections"]

    def test_not_triggered_without_async_signals(self):
        from app.services.rules_engine import run_rules_engine

        req = make_requirements()
        result = run_rules_engine(req)

        assert "queue" not in component_ids(result)
        assert "worker" not in component_ids(result)


class TestAuthRule:
    def test_triggered_by_login_keyword(self):
        from app.services.rules_engine import run_rules_engine

        req = make_requirements(functional=["Users can login with email and password"])
        result = run_rules_engine(req)

        assert "auth" in component_ids(result)
        assert "Rule-Auth-Compliance" in result["rulesTrace"]
        assert {"from": "compute", "to": "auth", "protocol": "OIDC/HTTPS"} in result["connections"]

    def test_triggered_by_gdpr_compliance(self):
        from app.services.rules_engine import run_rules_engine

        req = make_requirements(compliance="GDPR required for EU users")
        result = run_rules_engine(req)

        assert "auth" in component_ids(result)

    def test_not_triggered_without_auth_signals(self):
        from app.services.rules_engine import run_rules_engine

        req = make_requirements()
        result = run_rules_engine(req)

        assert "auth" not in component_ids(result)


class TestEveryComponentHasReasoning:
    def test_every_generated_component_carries_a_reasoning_string(self):
        from app.services.rules_engine import run_rules_engine

        req = make_requirements(
            functional=["Users can login", "Users can upload video files", "Background jobs process uploads"],
            budget="$50,000/month",
            teamMaturity="a small team",
        )
        result = run_rules_engine(req)

        assert len(result["components"]) > 0
        for c in result["components"]:
            assert isinstance(c.get("reasoning"), str) and c["reasoning"].strip() != ""
