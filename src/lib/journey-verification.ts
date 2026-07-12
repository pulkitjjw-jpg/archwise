// Client-side mirror of backend/app/services/path_verification.py -- the same check runs twice
// (once server-side for logging, once here so the "Verified" badge on the User Journey view is
// correct even when the steps came from the architecture's already-embedded journeySteps and
// never hit the /journey endpoint this session, e.g. after a page reload). Keep both in sync.

export type JourneyStep = {
  userAction: string;
  systemResponse: string;
  componentIds: string[];
};

type VerificationComponent = { id: string };
type VerificationConnection = { from: string; to: string };

export type JourneyVerification = {
  verified: boolean;
  issues: string[];
};

export function verifyJourneyPath(
  steps: JourneyStep[],
  components: VerificationComponent[],
  connections: VerificationConnection[]
): JourneyVerification {
  const componentIds = new Set(components.map((c) => c.id));
  const adjacentPairs = new Set<string>();
  for (const conn of connections) {
    adjacentPairs.add(`${conn.from}->${conn.to}`);
    adjacentPairs.add(`${conn.to}->${conn.from}`);
  }

  const issues: string[] = [];

  steps.forEach((step, idx) => {
    for (const cid of step.componentIds || []) {
      if (!componentIds.has(cid)) {
        issues.push(`Step ${idx + 1} references component "${cid}", which does not exist in this architecture.`);
      }
    }
  });

  for (let idx = 0; idx < steps.length - 1; idx++) {
    const curIds = (steps[idx].componentIds || []).filter((cid) => componentIds.has(cid));
    const nxtIds = (steps[idx + 1].componentIds || []).filter((cid) => componentIds.has(cid));
    if (curIds.length === 0 || nxtIds.length === 0) continue;

    const sharesComponent = curIds.some((cid) => nxtIds.includes(cid));
    const hasRealEdge = curIds.some((a) => nxtIds.some((b) => adjacentPairs.has(`${a}->${b}`)));
    if (!sharesComponent && !hasRealEdge) {
      issues.push(
        `No connection found between step ${idx + 1} and step ${idx + 2} -- their components aren't linked by any real edge in this architecture.`
      );
    }
  }

  const verified = issues.length === 0;
  if (!verified) {
    console.warn("Journey path verification failed:", issues);
  }
  return { verified, issues };
}

// Fixed palette for multi-colored flow paths -- cycles if there are more steps than colors.
// Deliberately distinct from the app's own accent purple (used for the diagram's default,
// unhighlighted edges) so a colored step never gets mistaken for "no step selected".
const STEP_COLORS = ["#E0507A", "#1F9E6B", "#D98A1F", "#2E9BD6", "#9455D3", "#C2410C", "#0EA5A5"];

export function getStepColor(index: number): string {
  return STEP_COLORS[index % STEP_COLORS.length];
}

// Maps each real connection (keyed "from->to", matching how edges are keyed elsewhere in the
// diagram code) to the color of the step that traverses it -- either an edge wholly WITHIN one
// step's components, or the transition edge bridging step i to step i+1. If two steps would claim
// the same edge, the later step wins (last write), since journey steps are already ordered by the
// sequence a user experiences them.
export function buildStepEdgeColors(
  steps: JourneyStep[],
  connections: VerificationConnection[]
): Record<string, string> {
  const edgeColors: Record<string, string> = {};

  const colorEdgesBetween = (idsA: string[], idsB: string[], color: string) => {
    for (const conn of connections) {
      const key = `${conn.from}->${conn.to}`;
      if (
        (idsA.includes(conn.from) && idsB.includes(conn.to)) ||
        (idsB.includes(conn.from) && idsA.includes(conn.to))
      ) {
        edgeColors[key] = color;
      }
    }
  };

  steps.forEach((step, idx) => {
    const color = getStepColor(idx);
    const ids = step.componentIds || [];
    colorEdgesBetween(ids, ids, color);
    if (idx < steps.length - 1) {
      colorEdgesBetween(ids, steps[idx + 1].componentIds || [], color);
    }
  });

  return edgeColors;
}
