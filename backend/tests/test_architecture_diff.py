"""Tests for app/services/architecture_diff.py's compute_architecture_diff and
calculate_total_cost -- pure functions, no DB access."""

from app.services.architecture_diff import calculate_total_cost, compute_architecture_diff


def component(
    comp_id: str,
    name: str,
    comp_type: str = "compute",
    *,
    cost: dict[str, dict] | None = None,
    lld_config: dict[str, dict] | None = None,
    reasoning: str | None = None,
) -> dict:
    """cost: {"aws": {"min": 10, "max": 20}, ...}; lld_config: {"aws": {"key": "val"}, ...}."""
    cloud_mappings = {}
    providers = set((cost or {}).keys()) | set((lld_config or {}).keys())
    for prov in providers:
        mapping: dict = {"serviceName": f"{prov}-service-for-{comp_id}"}
        if cost and prov in cost:
            mapping["costEstimate"] = {"min": cost[prov]["min"], "max": cost[prov]["max"]}
        if lld_config and prov in lld_config:
            mapping["lld"] = {"config": lld_config[prov], "reasoning": {}}
        cloud_mappings[prov] = mapping
    c: dict = {"id": comp_id, "name": name, "type": comp_type, "cloudMappings": cloud_mappings}
    if reasoning is not None:
        c["reasoning"] = reasoning
    return c


class TestCalculateTotalCost:
    def test_sums_min_and_max_across_components_for_a_provider(self):
        components = [
            component("a", "A", cost={"aws": {"min": 10, "max": 30}}),
            component("b", "B", cost={"aws": {"min": 5, "max": 15}}),
        ]
        total = calculate_total_cost(components, "aws")
        assert total == {"min": 15, "max": 45}

    def test_ignores_components_with_no_mapping_for_provider(self):
        components = [component("a", "A", cost={"azure": {"min": 10, "max": 30}})]
        total = calculate_total_cost(components, "aws")
        assert total == {"min": 0, "max": 0}


class TestAddedRemovedModifiedDetection:
    def test_detects_added_component(self):
        prev = [component("a", "A", cost={"aws": {"min": 1, "max": 2}})]
        new = [
            component("a", "A", cost={"aws": {"min": 1, "max": 2}}),
            component("b", "B", cost={"aws": {"min": 3, "max": 4}}, reasoning="Needed for caching."),
        ]
        diff = compute_architecture_diff(new, prev)

        assert len(diff["added"]) == 1
        assert diff["added"][0]["id"] == "b"
        assert diff["added"][0]["reasoning"] == "Needed for caching."

    def test_added_component_gets_default_reasoning_when_missing(self):
        diff = compute_architecture_diff([component("a", "A")], [])
        assert diff["added"][0]["reasoning"] == "Newly added component."

    def test_added_component_uses_custom_default_reasoning_option(self):
        diff = compute_architecture_diff(
            [component("a", "A")], [], {"defaultAddedReasoning": "Custom default."}
        )
        assert diff["added"][0]["reasoning"] == "Custom default."

    def test_detects_removed_component(self):
        prev = [component("a", "A"), component("b", "B")]
        new = [component("a", "A")]
        diff = compute_architecture_diff(new, prev)

        assert len(diff["removed"]) == 1
        assert diff["removed"][0]["id"] == "b"

    def test_detects_renamed_component_as_modified(self):
        prev = [component("a", "Old Name")]
        new = [component("a", "New Name")]
        diff = compute_architecture_diff(new, prev)

        assert len(diff["modified"]) == 1
        change = diff["modified"][0]["changes"][0]
        assert change["parameter"] == "Name"
        assert change["oldVal"] == "Old Name"
        assert change["newVal"] == "New Name"

    def test_detects_service_swap_as_modified(self):
        prev = [component("a", "A", cost={"aws": {"min": 10, "max": 20}})]
        new = [component("a", "A", cost={"aws": {"min": 10, "max": 20}})]
        # Manually swap the service name to simulate a provider service change.
        new[0]["cloudMappings"]["aws"]["serviceName"] = "Different Service"

        diff = compute_architecture_diff(new, prev)
        changes = diff["modified"][0]["changes"]
        service_change = next(c for c in changes if c["parameter"] == "AWS Service")
        assert service_change["oldVal"] == "aws-service-for-a"
        assert service_change["newVal"] == "Different Service"

    def test_unchanged_component_is_not_in_any_diff_bucket(self):
        prev = [component("a", "A", cost={"aws": {"min": 10, "max": 20}})]
        new = [component("a", "A", cost={"aws": {"min": 10, "max": 20}})]
        diff = compute_architecture_diff(new, prev)

        assert diff["added"] == []
        assert diff["removed"] == []
        assert diff["modified"] == []


class TestCostDeltaComputation:
    def test_cost_delta_computed_across_all_three_providers(self):
        prev = [component("a", "A", cost={"aws": {"min": 10, "max": 20}, "azure": {"min": 5, "max": 15}, "gcp": {"min": 8, "max": 18}})]
        new = [component("a", "A", cost={"aws": {"min": 30, "max": 50}, "azure": {"min": 5, "max": 15}, "gcp": {"min": 4, "max": 9}})]

        diff = compute_architecture_diff(new, prev)

        assert diff["costDelta"]["aws"] == {"min": 20, "max": 30}
        assert diff["costDelta"]["azure"] == {"min": 0, "max": 0}
        assert diff["costDelta"]["gcp"] == {"min": -4, "max": -9}

    def test_cost_delta_reflects_added_and_removed_components(self):
        prev = [component("a", "A", cost={"aws": {"min": 10, "max": 20}})]
        new = [
            component("a", "A", cost={"aws": {"min": 10, "max": 20}}),
            component("b", "B", cost={"aws": {"min": 5, "max": 10}}),
        ]
        diff = compute_architecture_diff(new, prev)
        assert diff["costDelta"]["aws"] == {"min": 5, "max": 10}


class TestLldConfigKeyChanges:
    def test_detects_added_lld_config_key(self):
        prev = [component("a", "A", lld_config={"aws": {"memory": "512MB"}})]
        new = [component("a", "A", lld_config={"aws": {"memory": "512MB", "timeout": "30s"}})]
        diff = compute_architecture_diff(new, prev)

        changes = diff["modified"][0]["changes"]
        change = next(c for c in changes if c["parameter"] == "AWS timeout")
        assert change["oldVal"] == "none"
        assert change["newVal"] == "30s"

    def test_detects_removed_lld_config_key(self):
        prev = [component("a", "A", lld_config={"aws": {"memory": "512MB", "timeout": "30s"}})]
        new = [component("a", "A", lld_config={"aws": {"memory": "512MB"}})]
        diff = compute_architecture_diff(new, prev)

        changes = diff["modified"][0]["changes"]
        change = next(c for c in changes if c["parameter"] == "AWS timeout")
        assert change["oldVal"] == "30s"
        assert change["newVal"] == "removed"
        assert change["reasoning"] == "No longer applicable after the service change."

    def test_detects_changed_lld_config_value(self):
        prev = [component("a", "A", lld_config={"aws": {"memory": "512MB"}})]
        new = [component("a", "A", lld_config={"aws": {"memory": "1024MB"}})]
        diff = compute_architecture_diff(new, prev)

        changes = diff["modified"][0]["changes"]
        change = next(c for c in changes if c["parameter"] == "AWS memory")
        assert change["oldVal"] == "512MB"
        assert change["newVal"] == "1024MB"
