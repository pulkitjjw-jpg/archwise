"""Deterministic diff/cost computation shared by every architecture-save path (LLM
auto-generate, growth-trigger regenerate, and manual edit). Computing this in Python -- rather
than asking the LLM to compute it -- guarantees costDelta is always present and that
before/after values are always read from the actual stored previous/new component records,
never hallucinated."""

PROVIDERS = ("aws", "azure", "gcp")


def calculate_total_cost(components: list[dict], provider: str) -> dict:
    min_total = 0
    max_total = 0
    for c in components:
        mapping = (c.get("cloudMappings") or {}).get(provider)
        if mapping and mapping.get("costEstimate"):
            min_total += mapping["costEstimate"].get("min") or 0
            max_total += mapping["costEstimate"].get("max") or 0
    return {"min": min_total, "max": max_total}


def compute_architecture_diff(
    new_components: list[dict],
    prev_components: list[dict],
    options: dict | None = None,
) -> dict:
    options = options or {}
    default_added_reasoning = options.get("defaultAddedReasoning") or "Newly added component."
    default_change_reasoning = options.get("defaultChangeReasoning") or "Updated."

    diff: dict = {
        "added": [],
        "removed": [],
        "modified": [],
        "costDelta": {
            "aws": {"min": 0, "max": 0},
            "azure": {"min": 0, "max": 0},
            "gcp": {"min": 0, "max": 0},
        },
    }

    for prov in PROVIDERS:
        new_total = calculate_total_cost(new_components, prov)
        prev_total = calculate_total_cost(prev_components, prov)
        diff["costDelta"][prov] = {
            "min": new_total["min"] - prev_total["min"],
            "max": new_total["max"] - prev_total["max"],
        }

    prev_by_id = {p["id"]: p for p in prev_components}

    for new_c in new_components:
        prev_c = prev_by_id.get(new_c["id"])
        if not prev_c:
            diff["added"].append(
                {
                    "id": new_c["id"],
                    "name": new_c["name"],
                    "type": new_c["type"],
                    "reasoning": new_c.get("reasoning") or default_added_reasoning,
                }
            )
            continue

        changes: list[dict] = []
        if new_c["name"] != prev_c["name"]:
            changes.append(
                {
                    "parameter": "Name",
                    "oldVal": prev_c["name"],
                    "newVal": new_c["name"],
                    "reasoning": "Component renamed.",
                }
            )

        for prov in PROVIDERS:
            prev_mapping = (prev_c.get("cloudMappings") or {}).get(prov)
            new_mapping = (new_c.get("cloudMappings") or {}).get(prov)
            if not prev_mapping or not new_mapping:
                continue

            # Service swap: the bound cloud service itself changed for this provider.
            if prev_mapping["serviceName"] != new_mapping["serviceName"]:
                changes.append(
                    {
                        "parameter": f"{prov.upper()} Service",
                        "oldVal": prev_mapping["serviceName"],
                        "newVal": new_mapping["serviceName"],
                        "reasoning": new_mapping.get("swapReasoning") or default_change_reasoning,
                    }
                )

            prev_cost = prev_mapping.get("costEstimate")
            new_cost = new_mapping.get("costEstimate")
            if prev_cost and new_cost and (prev_cost["min"] != new_cost["min"] or prev_cost["max"] != new_cost["max"]):
                changes.append(
                    {
                        "parameter": f"{prov.upper()} Cost Estimate",
                        "oldVal": f'${prev_cost["min"]} - ${prev_cost["max"]}/mo',
                        "newVal": f'${new_cost["min"]} - ${new_cost["max"]}/mo',
                        "reasoning": "Cost estimate updated based on the revised requirements.",
                    }
                )

            prev_lld = (prev_mapping.get("lld") or {}).get("config") or {}
            new_lld = (new_mapping.get("lld") or {}).get("config") or {}

            for key in new_lld:
                if new_lld[key] != prev_lld.get(key):
                    changes.append(
                        {
                            "parameter": f"{prov.upper()} {key}",
                            "oldVal": prev_lld[key] if key in prev_lld else "none",
                            "newVal": new_lld[key],
                            "reasoning": (new_mapping.get("lld") or {}).get("reasoning", {}).get(key)
                            or default_change_reasoning,
                        }
                    )

            # Config keys that existed under the previous service but no longer apply (e.g.
            # serverless "memory"/"timeout" keys disappearing after swapping to a
            # container-based service, which uses "instanceSize"/"minInstances" instead).
            for key in prev_lld:
                if key not in new_lld:
                    changes.append(
                        {
                            "parameter": f"{prov.upper()} {key}",
                            "oldVal": prev_lld[key],
                            "newVal": "removed",
                            "reasoning": "No longer applicable after the service change.",
                        }
                    )

        if len(changes) > 0:
            diff["modified"].append({"id": new_c["id"], "name": new_c["name"], "type": new_c["type"], "changes": changes})

    new_by_id = {n["id"]: n for n in new_components}
    for prev_c in prev_components:
        if prev_c["id"] not in new_by_id:
            diff["removed"].append({"id": prev_c["id"], "name": prev_c["name"], "type": prev_c["type"]})

    return diff
