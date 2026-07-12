import logging

logger = logging.getLogger("app.services.path_verification")


def verify_journey_path(steps: list[dict], components: list[dict], connections: list[dict]) -> dict:
    """Confirms a generated User Journey (see generate_user_journey in llm.py) actually matches
    the real architecture graph, rather than trusting the LLM's restructuring at face value.
    journeySteps has no explicit per-step from/to -- each step names the set of real component ids
    it touches -- so "connects to a real edge" is checked as: every id referenced exists, and each
    consecutive pair of steps shares a real connection (or a component) bridging them, so the full
    step sequence forms one connected path with no gaps. Called fresh on every journey fetch (steps
    + connections are both already in hand and this is cheap), never persisted -- a stale cached
    verdict would defeat the point of verification."""
    component_ids = {c["id"] for c in components}
    # Undirected: a journey step's flow doesn't necessarily follow the stored from->to direction
    # (e.g. an audit-log write is often modeled from->audit-log, but the user-journey narrative may
    # cross it either way), and this check cares whether components are ADJACENT at all, not the
    # direction of data flow.
    adjacent_pairs: set[tuple[str, str]] = set()
    for conn in connections:
        adjacent_pairs.add((conn["from"], conn["to"]))
        adjacent_pairs.add((conn["to"], conn["from"]))

    issues: list[str] = []

    for idx, step in enumerate(steps):
        step_ids = step.get("componentIds") or []
        for cid in step_ids:
            if cid not in component_ids:
                issues.append(f"Step {idx + 1} references component \"{cid}\", which does not exist in this architecture.")

    for idx in range(len(steps) - 1):
        cur_ids = [cid for cid in (steps[idx].get("componentIds") or []) if cid in component_ids]
        nxt_ids = [cid for cid in (steps[idx + 1].get("componentIds") or []) if cid in component_ids]
        if not cur_ids or not nxt_ids:
            # Already flagged above (unknown component) or the step is genuinely component-less;
            # either way there's nothing valid left here to check connectivity against.
            continue

        shares_component = bool(set(cur_ids) & set(nxt_ids))
        has_real_edge = any((a, b) in adjacent_pairs for a in cur_ids for b in nxt_ids)
        if not shares_component and not has_real_edge:
            issues.append(
                f"No connection found between step {idx + 1} and step {idx + 2} -- "
                f"their components aren't linked by any real edge in this architecture."
            )

    verified = len(issues) == 0
    if not verified:
        logger.warning("Journey path verification failed: %s", issues)

    return {"verified": verified, "issues": issues}
