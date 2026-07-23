"""The core rules-engine + LLM-validation + cloud-mapping pipeline shared by every path that
produces a full architecture: the real auto-generate endpoint (persists the result) and the
What-If preview endpoint (never persists). Extracted from architectures.py's generate_architecture
so both call the exact same pipeline rather than a parallel reimplementation -- per the explicit
requirement that a What-If simulation "reuse the exact same rule-engine + LLM-validation pipeline
used for real architecture generation, just running against the hypothetical field values instead
of the saved ones." Deliberately has NO database access anywhere in this module -- every function
here takes plain dicts/lists and a project name string, never an ORM session or model instance."""

from app.services.architecture_diff import compute_architecture_diff
from app.services.cloud_mapping import get_cloud_mapping
from app.services.industry_rules import run_industry_rules
from app.services.lld_rules import run_lld_rules_engine
from app.services.llm import validate_and_generate_architecture
from app.services.nfr_signals import determine_dr_strategy
from app.services.rules_engine import run_rules_engine
from app.services.security_rules import run_security_rules


def build_cloud_mapping(
    provider: str, component: dict, reqs_context: dict, industry_context: dict, dr_strategy: str = "none"
) -> dict:
    mapping = get_cloud_mapping(provider, component["type"], component["id"], reqs_context, dr_strategy)
    # run_lld_rules_engine recomputes dr_strategy itself from reqs_context/industry_context (both
    # already in scope there) via the same shared nfr_signals.determine_dr_strategy -- no need to
    # thread it through as a second parameter here too.
    lld = run_lld_rules_engine(provider, component["type"], component["id"], reqs_context, None, industry_context)
    return {
        "serviceName": mapping["serviceName"],
        "alternatives": mapping["alternatives"],
        "costEstimate": mapping["costEstimate"],
        "lld": {"config": lld["config"], "reasoning": lld["reasoning"]},
    }


async def generate_architecture_bundle(
    project_name: str,
    reqs_context: dict,
    industry_context: dict,
    api_key: str,
    prev_components: list[dict] | None = None,
    knowledge_context: list[dict] | None = None,
    product_domain: dict | None = None,
) -> dict:
    """Runs the full pipeline: deterministic rules -> industry compliance layer -> cloud mapping
    for all 5 providers -> LLM validation/enrichment -> diff against prev_components (if given) ->
    security audit. Returns everything a caller needs to either persist a new Architecture row or
    show an unsaved preview -- the caller decides which, this function never touches a database.

    knowledge_context (Workstream: knowledge-base RAG) -- pre-retrieved chunks from the
    architecture/software-engineering book corpus, each {bookTitle, author, chapterTitle,
    pageStart, pageEnd, text, similarity}, or None/empty if nothing cleared the relevance
    threshold. Retrieval itself happens in the ROUTER (which has the DB session), not here -- this
    module's "no database access" invariant stays intact; it only ever receives already-resolved
    plain data, same as reqs_context/industry_context/prev_components.

    product_domain (domain-awareness feature) -- {category, rationale, referenceSystem} from the
    project's Requirement row, or None. Passed straight through to the LLM layer so it can weigh
    genuinely well-known domain-typical patterns (e.g. cart-session caching for e-commerce)
    alongside this project's own stated requirements, visibly labeled via each component's
    "domainPattern" field rather than blended invisibly into "reasoning"."""
    # 1. Deterministic rules baseline, then industry-specific compliance components layered on top
    # (audit log, tokenization, PHI vault, de-identification -- see industry_rules.py). A generic
    # project (industry: "none") gets nothing extra here.
    baseline = run_rules_engine(reqs_context)
    industry_result = run_industry_rules(industry_context, reqs_context["functional"])

    all_components = baseline["components"] + industry_result["components"]
    all_connections = baseline["connections"] + industry_result["connections"]
    all_rules_trace = baseline["rulesTrace"] + industry_result["rulesTrace"]

    # 1b. Multi-region DR strategy (Phase 5) -- computed exactly once, here, since this is the one
    # place NFR + industry_context are both already available without threading either through
    # rules_engine.py (which only ever produces the baseline component list and never touches cloud
    # mapping directly). Passed alongside industry_context into build_cloud_mapping below so
    # cloud_mapping.py's cost folding and lld_rules.py's dns/database/storage/compute enrichment
    # (recomputed there from the same reqs_context/industry_context) always agree on which tier is
    # active. "none" for every generic project -- byte-for-byte unaffected, matching every prior
    # phase's additive-only precedent.
    dr_strategy = determine_dr_strategy(reqs_context["nonFunctional"], industry_context)

    # 2. Resolve mappings, costs, and LLD baselines for AWS, Azure, and GCP for each component --
    # these three go to the LLM for validation/enrichment.
    mapped_baseline_components = [
        {
            **c,
            "cloudMappings": {
                "aws": build_cloud_mapping("aws", c, reqs_context, industry_context, dr_strategy),
                "azure": build_cloud_mapping("azure", c, reqs_context, industry_context, dr_strategy),
                "gcp": build_cloud_mapping("gcp", c, reqs_context, industry_context, dr_strategy),
            },
        }
        for c in all_components
    ]

    # 2b. Kubernetes + private-cloud mappings, computed but kept OUT of the LLM payload (fully
    # deterministic, no managed-service pricing nuance to "validate" -- see generate_architecture's
    # original comment on why this stays out of the LLM's prompt/output size). DR strategy isn't
    # modeled for these two providers (see lld_rules.py's identical scope decision) -- passed
    # through harmlessly, get_cloud_mapping's kubernetes/private branches simply don't use it.
    extra_provider_mappings_by_id = {
        c["id"]: {
            "kubernetes": build_cloud_mapping("kubernetes", c, reqs_context, industry_context, dr_strategy),
            "private": build_cloud_mapping("private", c, reqs_context, industry_context, dr_strategy),
        }
        for c in all_components
    }

    # 3. Baseline total costs (aws/azure/gcp only -- matches provider_costs shape validate_and_
    # generate_architecture expects).
    provider_costs = {"aws": {"min": 0, "max": 0}, "azure": {"min": 0, "max": 0}, "gcp": {"min": 0, "max": 0}}
    for c in mapped_baseline_components:
        for prov in ("aws", "azure", "gcp"):
            provider_costs[prov]["min"] += c["cloudMappings"][prov]["costEstimate"]["min"]
            provider_costs[prov]["max"] += c["cloudMappings"][prov]["costEstimate"]["max"]

    # 4. Validate, enrich, and recommend a provider via LLM, passing the HLD + LLD baselines and
    # (optionally) the previous real architecture's components for continuity awareness.
    enriched = await validate_and_generate_architecture(
        project_name,
        {**reqs_context, "industryContext": industry_context},
        {"components": mapped_baseline_components, "connections": all_connections},
        provider_costs,
        api_key,
        prev_components,
        knowledge_context,
        product_domain,
    )

    # Merge deterministic industry-rule risks in alongside whatever the LLM itself surfaced.
    enriched["risks"] = (enriched.get("risks") or []) + industry_result["risks"]

    # 4b. Re-attach the deterministic rule-engine's "alternatives" and "costEstimate" (both
    # unconditionally re-attached now -- see validate_and_generate_architecture's prompt, which no
    # longer asks the LLM to repeat cost figures at all, only real pricing-table data) onto the
    # LLM's output, plus the Kubernetes/private mappings computed in step 2b.
    #
    # Merge sparse "lld.configOverrides" back onto the baseline's own full "lld.config" -- the
    # prompt no longer asks the LLM to retype every baseline config value verbatim (previously the
    # dominant share of this call's output tokens: a real 12-component architecture carries ~189
    # config key/value pairs across 3 providers, virtually all of them already correct as-is from
    # lld_rules.py). A component with NO baseline counterpart (a genuinely new one the LLM decided
    # to add) has nothing to merge onto, so its own full "lld.config" (if given) is used as-is.
    baseline_by_id = {c["id"]: c for c in mapped_baseline_components}
    for c in enriched["components"]:
        baseline_component = baseline_by_id.get(c["id"])
        if not c.get("cloudMappings"):
            continue
        for prov in ("aws", "azure", "gcp"):
            provider_mapping = c["cloudMappings"].get(prov)
            if not provider_mapping:
                continue
            baseline_provider_mapping = (baseline_component or {}).get("cloudMappings", {}).get(prov)
            if baseline_provider_mapping:
                provider_mapping["alternatives"] = baseline_provider_mapping["alternatives"]
                provider_mapping["costEstimate"] = baseline_provider_mapping["costEstimate"]
            else:
                # A genuinely new component the LLM added has no baseline mapping to re-attach --
                # the prompt no longer asks the LLM for costEstimate at all (see its own docstring),
                # so compute it the same deterministic way every baseline component's own cost
                # figure was computed, rather than leaving it missing.
                fresh_mapping = get_cloud_mapping(prov, c["type"], c["id"], reqs_context, dr_strategy)
                provider_mapping["alternatives"] = fresh_mapping["alternatives"]
                provider_mapping["costEstimate"] = fresh_mapping["costEstimate"]

            lld = provider_mapping.get("lld") or {}
            overrides = lld.pop("configOverrides", None)
            if baseline_provider_mapping:
                baseline_config = baseline_provider_mapping.get("lld", {}).get("config", {})
                lld["config"] = {**baseline_config, **(overrides or {})}
            elif overrides and not lld.get("config"):
                # A genuinely new component that mistakenly used configOverrides anyway (no
                # baseline to overlay onto) -- fall back to treating the overrides as the full
                # config rather than silently dropping the LLM's only config data for this one.
                lld["config"] = overrides
            provider_mapping["lld"] = lld

        extra = extra_provider_mappings_by_id.get(c["id"])
        if extra:
            c["cloudMappings"]["kubernetes"] = extra["kubernetes"]
            c["cloudMappings"]["private"] = extra["private"]
        elif not baseline_component:
            # Pre-existing gap, surfaced (not introduced) by this same change's new test coverage:
            # extra_provider_mappings_by_id is only ever built from the baseline components (step
            # 2b, above), so a genuinely new component the LLM adds never had kubernetes/private
            # mappings computed for it at all -- it would go missing from those two provider tabs
            # entirely. Compute them the same way step 2b does for every baseline component.
            c["cloudMappings"]["kubernetes"] = build_cloud_mapping("kubernetes", c, reqs_context, industry_context, dr_strategy)
            c["cloudMappings"]["private"] = build_cloud_mapping("private", c, reqs_context, industry_context, dr_strategy)

    # 5. Diff against the previous components deterministically in Python (never from the LLM),
    # so costDelta is always present and before/after values always come from real component data.
    diff = None
    if prev_components:
        diff = compute_architecture_diff(
            enriched["components"],
            prev_components,
            {
                "defaultAddedReasoning": "Added in response to updated requirements.",
                "defaultChangeReasoning": "Updated in response to requirement changes.",
            },
        )

    # 6. Deterministic security-posture audit (Workstream T4) for all 5 providers. dr_strategy is
    # passed through so run_security_rules can flag a database/dns component missing its DR config
    # despite the architecture's own NFR/industry profile calling for one (see security_rules.py).
    security_findings = {
        prov: run_security_rules(enriched["components"], enriched["connections"], industry_context, prov, dr_strategy)
        for prov in ("aws", "azure", "gcp", "kubernetes", "private")
    }

    return {
        "components": enriched["components"],
        "connections": enriched["connections"],
        "rulesTrace": all_rules_trace,
        "assumptions": enriched["assumptions"],
        "risks": enriched["risks"],
        "recommendation": enriched["recommendation"],
        "diff": diff,
        "securityFindings": security_findings,
    }
