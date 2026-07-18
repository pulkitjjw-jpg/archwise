// Disaster-recovery badge detection (Phase 5 diagram enhancement) -- a small, pure helper that
// inspects the "dns" component's LLD config (the exact key/value shapes backend/app/services/
// lld_rules.py's Phase 5 DR enrichment actually produces, aws/azure/gcp only -- see that file's
// "routingPolicy" block inside the "dns" branch) and decides whether multi-region disaster-
// recovery is active, and if so which tier. Purely a DIAGRAM-level visual cue -- it never changes
// which/how many HLD components exist, matching redundancy.ts's exact precedent (see that file's
// own docstring). Kept as its own tiny module rather than folded into redundancy.ts, since "this
// component is deployed with >=2 redundant replicas" and "this component is part of a multi-region
// DR strategy" are different signals about different things, even though both render as a small
// badge on the same diagram node.
//
// dns's "routingPolicy" key is the single source of truth here: lld_rules.py sets it to "Simple"
// for every non-DR architecture (the default, unconditionally set before any DR enrichment runs),
// "Failover (Active-Passive)" for pilot-light, and "Latency-based routing with health-check
// failover" for warm-standby -- kubernetes/private never touch this key's DR-enrichment branch at
// all (Phase 5 scope is aws/azure/gcp only), so a "Simple" or missing value there correctly reads
// as "no DR" too.

/** Pure detection helper: does this "dns" component's LLD config, for whichever provider is
 * currently active, signal that a DR tier is configured? Returns "pilot-light", "warm-standby", or
 * null (no DR active, or config/routingPolicy absent entirely). */
export function getDrStrategy(config: Record<string, string> | undefined | null): "pilot-light" | "warm-standby" | null {
  if (!config) return null;

  const routingPolicy = config.routingPolicy;
  if (typeof routingPolicy !== "string") return null;

  if (routingPolicy === "Failover (Active-Passive)") return "pilot-light";
  if (routingPolicy.startsWith("Latency-based routing")) return "warm-standby";

  return null;
}

/** Short badge text for the "dns" component's diagram card, e.g. "DR: Pilot Light" / "DR: Warm
 * Standby". Returns null when getDrStrategy(config) is null -- callers should gate on that, the
 * same pattern redundancy.ts's getRedundancyBadge already establishes. */
export function getDrBadge(config: Record<string, string> | undefined | null): string | null {
  const strategy = getDrStrategy(config);
  if (strategy === "pilot-light") return "DR: Pilot Light";
  if (strategy === "warm-standby") return "DR: Warm Standby";
  return null;
}
