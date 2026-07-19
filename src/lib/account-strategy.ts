// Multi-account environment separation detection (Phase 7 diagram enhancement) -- a small, pure
// helper that inspects the "compute" component's LLD config (the exact key/value shapes
// backend/app/services/lld_rules.py's Phase 7 multi-account enrichment actually produces,
// aws/azure/gcp only -- see that file's "accountSeparation"/"accountStructure" keys inside the
// "compute" branch) and decides whether this architecture is modeled as deployed independently
// into separate per-environment cloud accounts/subscriptions/projects.
//
// "compute" is the single source of truth here -- lld_rules.py only ever sets "accountSeparation"
// to the literal string "true" once nfr_signals.determine_account_strategy resolves to
// "multi-account" for aws/azure/gcp; it's absent entirely (never "false") for the single-account
// default, kubernetes, and private, matching dr-strategy.ts's identical "absent means not active"
// convention for its own "routingPolicy" key.
//
// Unlike getDrStrategy/getDrBadge (dr-strategy.ts) and getRedundancyBadge (redundancy.ts), both
// small PER-NODE badges rendered on one component's diagram card, account separation is a
// WHOLE-DIAGRAM concept: every component in a single architecture diagram represents one
// environment's topology, deployed independently N times (once per environment) into N separate
// accounts -- never N different component subsets rendered together in one diagram. So this module
// exposes a single banner-text helper meant to render once, above/around the whole diagram, not a
// per-node badge -- see ArchitectureWorkspace.tsx's call site for the exact placement and a note on
// why this deliberately isn't a React Flow swimlane/group-node boundary around subsets of
// components.

/** Pure detection helper: does this "compute" component's LLD config, for whichever provider is
 * currently active, signal that multi-account environment separation is active? */
export function isMultiAccountActive(config: Record<string, string> | undefined | null): boolean {
  if (!config) return false;
  return config.accountSeparation === "true";
}

/** Short banner text for the whole-diagram notice, or null when isMultiAccountActive(config) is
 * false -- callers should gate on that (render nothing) rather than show an empty banner, the same
 * pattern getDrBadge/getRedundancyBadge already establish for their own null case. */
export function getAccountStrategyBanner(config: Record<string, string> | undefined | null): string | null {
  if (!isMultiAccountActive(config)) return null;
  return "Deployed independently across separate Dev / Staging / Prod accounts for blast-radius isolation.";
}
