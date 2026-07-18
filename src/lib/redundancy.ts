// Redundancy detection (Phase 4 diagram enhancement) -- a small, pure helper that inspects an
// LLD config object (the exact key/value shapes backend/app/services/lld_rules.py actually
// produces, across aws/azure/gcp/kubernetes/private and every component type) and decides whether
// the component it belongs to is deployed with >=2 redundant replicas/nodes/instances. This is
// purely a DIAGRAM-level visual cue -- it never changes which/how many HLD components exist (see
// ArchitectureWorkspace.tsx's node-rendering loop, which draws a stacked-card effect + a small
// badge when this returns true). Standalone module with no imports from ArchitectureWorkspace.tsx,
// matching health-score.ts/diagram-layout.ts's existing pattern of staying easily testable in
// isolation.
//
// The four keys checked below (multiAZ, clusteringEnabled, minInstances, replicas) are the ONLY
// keys lld_rules.py ever uses to signal a redundant deployment; every other config key (vmCount,
// vmSize, haMode, instanceSize, ...) either doesn't indicate replica count or (as with the
// "private" provider's vmCount/haMode) describes manual/self-managed failover that the rules
// engine itself is careful to *not* dress up as automatic redundancy ("Manual failover", "no
// elastic capacity pool") -- deliberately not treated as a redundancy signal here either.

/** Extracts the first integer found in a string, e.g. "3 (Primary + 2 Replicas)" -> 3,
 * "4 (Distributed Mode)" -> 4, "1 (Standalone)" -> 1. Returns null if no digits are present. */
function firstNumber(value: string): number | null {
  const match = value.match(/\d+/);
  if (!match) return null;
  const n = parseInt(match[0], 10);
  return Number.isNaN(n) ? null : n;
}

/** Pure detection helper: does this LLD config signal the component is deployed with >=2
 * redundant instances/replicas/nodes? Checks, in order: multiAZ (starts with "true", case
 * insensitive -- covers "true (Primary/Standby)" and forced-true PCI-DSS overrides),
 * clusteringEnabled (=== "true"), minInstances (parsed int > 1), replicas (first number in the
 * string > 1 -- covers plain counts like "4" as well as annotated ones like
 * "3 (Primary + 2 Replicas)" / "4 (Distributed Mode)" / "3 (Clustered)" / "3 (Cluster Mode)" /
 * "3 (Vault Raft HA)"). Returns false if none of these keys are present, or none indicate >1. */
export function isRedundantConfig(config: Record<string, string> | undefined | null): boolean {
  if (!config) return false;

  const multiAZ = config.multiAZ;
  if (typeof multiAZ === "string" && multiAZ.trim().toLowerCase().startsWith("true")) {
    return true;
  }

  if (config.clusteringEnabled === "true") {
    return true;
  }

  if (typeof config.minInstances === "string") {
    const min = parseInt(config.minInstances, 10);
    if (!Number.isNaN(min) && min > 1) return true;
  }

  if (typeof config.replicas === "string") {
    const count = firstNumber(config.replicas);
    if (count !== null && count > 1) return true;
  }

  return false;
}

/** Short badge text for a redundant component's diagram card. Prefers an explicit replica count
 * ("×3", "×4") when minInstances/replicas gives a real number > 1; falls back to "Multi-AZ" or
 * "HA" for the boolean-only multiAZ/clusteringEnabled signals, which carry no explicit count.
 * Returns null when isRedundantConfig(config) is false -- callers should gate on that first. */
export function getRedundancyBadge(config: Record<string, string> | undefined | null): string | null {
  if (!config) return null;

  if (typeof config.minInstances === "string") {
    const min = parseInt(config.minInstances, 10);
    if (!Number.isNaN(min) && min > 1) return `×${min}`;
  }

  if (typeof config.replicas === "string") {
    const count = firstNumber(config.replicas);
    if (count !== null && count > 1) return `×${count}`;
  }

  const multiAZ = config.multiAZ;
  if (typeof multiAZ === "string" && multiAZ.trim().toLowerCase().startsWith("true")) {
    return "Multi-AZ";
  }

  if (config.clusteringEnabled === "true") {
    return "HA";
  }

  return null;
}
