// UI-gating mirror of backend/app/services/security_rules.py's FIX_HANDLERS registry -- decides
// whether a "Fix this" button should even be shown for a given finding, so the user never clicks
// a button that would just 400. The backend registry (keyed by the exact same (component type,
// finding title) pairs) remains the sole source of truth for the ACTUAL fix value -- this module
// never computes or sends one, only decides visibility.
//
// Deliberately excludes findings that would require adding a whole new component or rewiring
// connections (no auth component, no audit-log component, public-to-datastore direct wiring) --
// those aren't a one-field toggle with an unambiguous correct value, see FIX_HANDLERS' own
// docstring for why they're out of scope for this first pass.
const FIXABLE_TITLES_BY_TYPE: Record<string, string[]> = {
  database: [
    "Database has no explicit encryption configuration recorded",
    "Database has no automatic failover configured",
    "Database backup retention is effectively disabled",
    "No disaster-recovery strategy for a system that can't afford extended downtime",
  ],
  cache: ["Cache layer has no encryption configuration recorded"],
  auth: ["Multi-factor authentication is not required", "Unrestricted self-service sign-up on a sensitive-data system"],
  lb: ["Public-facing edge has no WAF despite handling sensitive data"],
  cdn: ["Public-facing edge has no WAF despite handling sensitive data"],
  dns: ["No disaster-recovery strategy for a system that can't afford extended downtime"],
};

// The DR fix specifically only has a real target value on aws/azure/gcp -- kubernetes/private
// never got DR support built in at all (Phase 5 scope decision), so there's no correct config to
// set. Every other fixable finding type applies on any provider it can actually appear on.
const DR_FIX_TITLE = "No disaster-recovery strategy for a system that can't afford extended downtime";
const DR_FIX_PROVIDERS = new Set(["aws", "azure", "gcp"]);

export function isSecurityFindingFixable(componentType: string, findingTitle: string, provider: string): boolean {
  const titles = FIXABLE_TITLES_BY_TYPE[componentType];
  if (!titles || !titles.includes(findingTitle)) return false;
  if (findingTitle === DR_FIX_TITLE) return DR_FIX_PROVIDERS.has(provider);
  return true;
}
