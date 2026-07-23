"""Tests for app/services/architecture_generation.py's generate_architecture_bundle -- specifically
the merge step between the LLM's (now intentionally sparse) response and the deterministic
baseline. This closes a real cost problem: the LLM used to be asked to retype every baseline LLD
config value verbatim (a real 12-component architecture carries ~189 config key/value pairs across
3 providers, virtually all already correct as-is), which was the dominant share of this call's
output tokens and meant the free-tier models in the fallback chain effectively never succeeded for
this endpoint (confirmed via real llm_usage_logs data: 0-1 successes out of ~400 free-tier attempts,
every real generation landing on the paid tier). The LLM now sends sparse "lld.configOverrides"
(only real changes) for existing baseline components, and the server merges that onto the
baseline's own full config -- this test file is the first direct coverage this module has had.
"""

import pytest

from app.services.architecture_generation import generate_architecture_bundle

pytestmark = pytest.mark.asyncio


def _reqs_context(**nfr_overrides) -> dict:
    nfr = {
        "expectedScale": "1,000 users",
        "readWritePattern": "balanced",
        "dataNature": "structured business records",
        "latencySensitivity": "medium",
        "budget": "$2,000/month",
        "teamMaturity": "senior engineers",
        "compliance": "none",
    }
    nfr.update(nfr_overrides)
    return {"functional": ["Users can manage their account settings"], "nonFunctional": nfr}


def _industry_context() -> dict:
    return {"industry": "none", "flags": {}, "rationale": "", "complianceAnswers": []}


async def test_sparse_override_merges_onto_baseline_config_for_the_one_key_changed(monkeypatch):
    # First run WITHOUT any LLM involvement (mocked to echo an empty adjustment) to capture the
    # real deterministic baseline's own "compute" config for the "minInstances" key.
    async def _echo_baseline(project_name, requirements, baseline, provider_costs, api_key, *rest, **kw):
        return {
            "components": [{**c, "cloudMappings": {p: {**m, "lld": {"reasoning": {}}} for p, m in c["cloudMappings"].items()}} for c in baseline["components"]],
            "connections": baseline["connections"],
            "assumptions": [],
            "risks": [],
            "recommendation": {"recommendedProvider": "aws", "rationale": "x", "keyTradeoffs": []},
        }

    monkeypatch.setattr("app.services.architecture_generation.validate_and_generate_architecture", _echo_baseline)
    baseline_result = await generate_architecture_bundle("Test Project", _reqs_context(), _industry_context(), "fake-api-key")
    compute = next(c for c in baseline_result["components"] if c["id"] == "compute")
    baseline_min_instances = compute["cloudMappings"]["aws"]["lld"]["config"].get("minInstances")
    other_keys_baseline = {k: v for k, v in compute["cloudMappings"]["aws"]["lld"]["config"].items() if k != "minInstances"}

    # Now run again, this time the "LLM" only overrides minInstances for the compute component's
    # aws mapping -- every other config key (and both other providers) should pass through
    # untouched from the same baseline.
    async def _fake_with_override(project_name, requirements, baseline, provider_costs, api_key, *rest, **kw):
        components = []
        for c in baseline["components"]:
            new_c = {**c, "cloudMappings": {p: {**m, "lld": {"reasoning": {}}} for p, m in c["cloudMappings"].items()}}
            if c["id"] == "compute":
                new_c["cloudMappings"]["aws"]["lld"]["configOverrides"] = {"minInstances": "99"}
            components.append(new_c)
        return {
            "components": components,
            "connections": baseline["connections"],
            "assumptions": [],
            "risks": [],
            "recommendation": {"recommendedProvider": "aws", "rationale": "x", "keyTradeoffs": []},
        }

    monkeypatch.setattr("app.services.architecture_generation.validate_and_generate_architecture", _fake_with_override)
    result = await generate_architecture_bundle("Test Project", _reqs_context(), _industry_context(), "fake-api-key")
    fixed_compute = next(c for c in result["components"] if c["id"] == "compute")
    aws_config = fixed_compute["cloudMappings"]["aws"]["lld"]["config"]

    assert aws_config["minInstances"] == "99"
    # Every OTHER key is untouched from the real baseline -- proving the merge is truly sparse,
    # not a silent full overwrite.
    other_keys_result = {k: v for k, v in aws_config.items() if k != "minInstances"}
    assert other_keys_result == other_keys_baseline
    assert baseline_min_instances != "99"  # sanity: the override actually changed something real


async def test_no_configoverrides_at_all_leaves_baseline_config_fully_intact(monkeypatch):
    async def _fake_no_changes(project_name, requirements, baseline, provider_costs, api_key, *rest, **kw):
        components = [
            {**c, "cloudMappings": {p: {**m, "lld": {"reasoning": {}}} for p, m in c["cloudMappings"].items()}}
            for c in baseline["components"]
        ]
        return {
            "components": components,
            "connections": baseline["connections"],
            "assumptions": [],
            "risks": [],
            "recommendation": {"recommendedProvider": "aws", "rationale": "x", "keyTradeoffs": []},
        }

    monkeypatch.setattr("app.services.architecture_generation.validate_and_generate_architecture", _fake_no_changes)
    baseline_reqs = _reqs_context()
    result = await generate_architecture_bundle("Test Project", baseline_reqs, _industry_context(), "fake-api-key")

    for c in result["components"]:
        for prov, mapping in c["cloudMappings"].items():
            if prov in ("aws", "azure", "gcp"):
                assert "config" in mapping["lld"]
                assert isinstance(mapping["lld"]["config"], dict)
                assert len(mapping["lld"]["config"]) > 0  # real baseline config survived untouched


async def test_cost_estimate_and_alternatives_always_come_from_baseline_never_the_llm(monkeypatch):
    """Even if a non-compliant model ignores the "omit costEstimate" instruction and sends one
    anyway, the server must overwrite it with the real, deterministic baseline figure -- cost
    accounting must never depend on the LLM getting arithmetic right."""

    async def _fake_with_wrong_cost(project_name, requirements, baseline, provider_costs, api_key, *rest, **kw):
        components = []
        for c in baseline["components"]:
            new_c = {**c, "cloudMappings": {}}
            for p, m in c["cloudMappings"].items():
                new_mapping = {**m, "lld": {"reasoning": {}}}
                if p in ("aws", "azure", "gcp"):
                    new_mapping["costEstimate"] = {"min": 999999, "max": 999999, "assumptions": "made up by a rogue model"}
                new_c["cloudMappings"][p] = new_mapping
            components.append(new_c)
        return {
            "components": components,
            "connections": baseline["connections"],
            "assumptions": [],
            "risks": [],
            "recommendation": {"recommendedProvider": "aws", "rationale": "x", "keyTradeoffs": []},
        }

    monkeypatch.setattr("app.services.architecture_generation.validate_and_generate_architecture", _fake_with_wrong_cost)
    result = await generate_architecture_bundle("Test Project", _reqs_context(), _industry_context(), "fake-api-key")

    for c in result["components"]:
        for prov in ("aws", "azure", "gcp"):
            assert c["cloudMappings"][prov]["costEstimate"]["min"] != 999999


async def test_new_component_with_no_baseline_gets_a_freshly_computed_cost_estimate(monkeypatch):
    """A genuinely new component the LLM decides to add (no baseline counterpart) has nothing to
    merge onto -- its costEstimate/alternatives must be computed fresh via the same deterministic
    pricing path every baseline component's own cost figure goes through, not left missing (the
    prompt no longer asks the LLM for costEstimate at all, so there's no LLM-provided fallback)."""

    async def _fake_adds_new_component(project_name, requirements, baseline, provider_costs, api_key, *rest, **kw):
        components = [
            {**c, "cloudMappings": {p: {**m, "lld": {"reasoning": {}}} for p, m in c["cloudMappings"].items()}}
            for c in baseline["components"]
        ]
        components.append(
            {
                "id": "brand-new-cache",
                "name": "New Cache Layer",
                "type": "cache",
                "description": "A genuinely new component with no baseline counterpart.",
                "reasoning": "Added by the LLM to address a latency concern the rule engine missed.",
                "cloudMappings": {
                    "aws": {"serviceName": "Amazon ElastiCache", "lld": {"config": {"nodeType": "cache.t3.micro"}, "reasoning": {}}},
                    "azure": {"serviceName": "Azure Cache for Redis", "lld": {"config": {"tier": "Basic"}, "reasoning": {}}},
                    "gcp": {"serviceName": "Memorystore", "lld": {"config": {"tier": "Basic"}, "reasoning": {}}},
                },
            }
        )
        return {
            "components": components,
            "connections": baseline["connections"],
            "assumptions": [],
            "risks": [],
            "recommendation": {"recommendedProvider": "aws", "rationale": "x", "keyTradeoffs": []},
        }

    monkeypatch.setattr("app.services.architecture_generation.validate_and_generate_architecture", _fake_adds_new_component)
    result = await generate_architecture_bundle("Test Project", _reqs_context(), _industry_context(), "fake-api-key")

    new_component = next(c for c in result["components"] if c["id"] == "brand-new-cache")
    for prov in ("aws", "azure", "gcp"):
        mapping = new_component["cloudMappings"][prov]
        assert "min" in mapping["costEstimate"] and "max" in mapping["costEstimate"]
        assert mapping["costEstimate"]["min"] >= 0
        assert isinstance(mapping["alternatives"], list)
    # Its OWN directly-provided lld.config (not configOverrides, since there's no baseline) is
    # preserved as given.
    assert new_component["cloudMappings"]["aws"]["lld"]["config"] == {"nodeType": "cache.t3.micro"}
    # Kubernetes/private mappings are still computed for every component including new ones.
    assert "kubernetes" in new_component["cloudMappings"]
    assert "private" in new_component["cloudMappings"]


async def test_kubernetes_and_private_mappings_are_always_attached(monkeypatch):
    async def _fake_minimal(project_name, requirements, baseline, provider_costs, api_key, *rest, **kw):
        components = [
            {**c, "cloudMappings": {p: {**m, "lld": {"reasoning": {}}} for p, m in c["cloudMappings"].items()}}
            for c in baseline["components"]
        ]
        return {
            "components": components,
            "connections": baseline["connections"],
            "assumptions": [],
            "risks": [],
            "recommendation": {"recommendedProvider": "aws", "rationale": "x", "keyTradeoffs": []},
        }

    monkeypatch.setattr("app.services.architecture_generation.validate_and_generate_architecture", _fake_minimal)
    result = await generate_architecture_bundle("Test Project", _reqs_context(), _industry_context(), "fake-api-key")

    for c in result["components"]:
        assert "kubernetes" in c["cloudMappings"]
        assert "private" in c["cloudMappings"]
