def _find_cycle(components: list[dict], connections: list[dict]) -> list[str] | None:
    """Detects a directed cycle in the component graph via DFS with a recursion-stack color
    marking. Returns the cycle as an ordered list of component ids (first id repeated at the
    end), or None if the graph is acyclic."""
    adjacency: dict[str, list[str]] = {c["id"]: [] for c in components}
    for conn in connections:
        if conn["from"] in adjacency:
            adjacency[conn["from"]].append(conn["to"])

    UNVISITED, IN_PROGRESS, DONE = 0, 1, 2
    state: dict[str, int] = {c["id"]: UNVISITED for c in components}
    path_stack: list[str] = []

    def dfs(node_id: str) -> list[str] | None:
        state[node_id] = IN_PROGRESS
        path_stack.append(node_id)

        for neighbor_id in adjacency.get(node_id, []):
            if state.get(neighbor_id) == IN_PROGRESS:
                cycle_start = path_stack.index(neighbor_id)
                return path_stack[cycle_start:] + [neighbor_id]
            if state.get(neighbor_id) == UNVISITED:
                found = dfs(neighbor_id)
                if found:
                    return found

        path_stack.pop()
        state[node_id] = DONE
        return None

    for c in components:
        if state[c["id"]] == UNVISITED:
            found = dfs(c["id"])
            if found:
                return found
    return None


def validate_architecture_layout(
    components: list[dict],
    connections: list[dict],
    requirements: dict | None = None,
    active_provider_costs: dict | None = None,
) -> dict:
    errors: list[str] = []
    warnings: list[str] = []

    # 1. Orphaned Components Check (Hard Error)
    if len(components) > 1:
        for c in components:
            is_connected = any(conn["from"] == c["id"] or conn["to"] == c["id"] for conn in connections)
            if not is_connected:
                errors.append(
                    f'"{c["name"]}" is orphaned. Every component must be connected to at least one other component.'
                )

    # 2. Broken DB Dependency Check (Hard Error)
    has_compute = any(c["type"] == "compute" for c in components)
    has_database = any(c["type"] in ("db", "database", "storage") for c in components)
    if has_compute and not has_database:
        errors.append(
            "Broken dependency: Compute components are present, but there is no Database or Object Storage component configured in the layout."
        )

    # 3. Circular Dependency Check (Hard Error)
    cycle_path = _find_cycle(components, connections)
    if cycle_path:
        name_by_id = {c["id"]: c["name"] for c in components}
        path_names = [name_by_id.get(id_, id_) for id_ in cycle_path]
        errors.append(
            f"Structural violation: circular dependency detected ({' → '.join(path_names)}). Connections must form a directed acyclic graph."
        )

    # 4. Bypass Checks (Soft Warnings)
    by_id = {c["id"]: c for c in components}
    for conn in connections:
        from_component = by_id.get(conn["from"])
        to_component = by_id.get(conn["to"])

        if from_component and to_component:
            # CDN directly to Database
            if from_component["type"] == "cdn" and to_component["type"] in ("db", "database"):
                warnings.append(
                    f'Unusual pattern: CDN "{from_component["name"]}" connects directly to Database "{to_component["name"]}" without an intermediate compute or caching layer.'
                )

            # Load Balancer directly to Database
            if from_component["type"] == "lb" and to_component["type"] in ("db", "database"):
                warnings.append(
                    f'Unusual pattern: Load Balancer "{from_component["name"]}" connects directly to Database "{to_component["name"]}" without an intermediate compute or caching layer.'
                )

    # 5. Budget Overrun Check (Soft Warning)
    if requirements and requirements.get("nonFunctional", {}).get("budget") and active_provider_costs:
        budget_str = requirements["nonFunctional"]["budget"].lower()
        is_low_budget = (
            "low" in budget_str
            or "tight" in budget_str
            or "50" in budget_str
            or "30" in budget_str
            or "100" in budget_str
            or "$100" in budget_str
        )

        if is_low_budget and active_provider_costs["min"] > 120:
            warnings.append(
                f'Unusual budget alignment: the updated architecture\'s estimated cost (${active_provider_costs["min"]} - ${active_provider_costs["max"]}/mo) exceeds your stated budget threshold.'
            )

    return {"isValid": len(errors) == 0, "errors": errors, "warnings": warnings}


def get_provider_maturity_warning(active_provider: str, requirements: dict | None = None) -> str | None:
    """Same soft-warning philosophy as validate_architecture_layout above (informational, never
    blocking) but scoped to a single concern -- the currently-selected deployment target versus
    the team's stated operational maturity -- so it can be checked independently of whether the
    user is actively editing the diagram. Kubernetes and private cloud both trade managed-service
    simplicity for self-managed operational surface area; a low-maturity/small team taking that
    on is exactly the kind of judgment call this tool should flag, not silently allow."""
    if active_provider not in ("kubernetes", "private"):
        return None
    if not requirements or not requirements.get("nonFunctional"):
        return None

    nfr = requirements["nonFunctional"]
    team_lower = nfr["teamMaturity"].lower()
    budget_lower = nfr["budget"].lower()

    is_low_maturity = (
        "junior" in team_lower or "small" in team_lower or "new" in team_lower or team_lower == "not_specified"
    )
    is_tight_budget = "tight" in budget_lower or "low" in budget_lower

    if not is_low_maturity and not is_tight_budget:
        return None

    platform = "Kubernetes" if active_provider == "kubernetes" else "a private cloud/on-premises deployment"
    return (
        f"{platform} significantly increases operational complexity — self-managed failover, patching, backups, "
        "and scaling all become your team's responsibility instead of a managed service's. Given your stated team "
        "size/maturity, consider a managed cloud provider (AWS/Azure/GCP) unless there's a specific reason "
        "(compliance, cost at extreme scale, existing infrastructure) that requires this."
    )
