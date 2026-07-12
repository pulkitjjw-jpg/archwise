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

export type StepEdgeInfo = { color: string; stepIndex: number };

// Maps each real connection (keyed "from->to", matching how edges are keyed elsewhere in the
// diagram code) to the step that "completes" it. Every component is assigned to the step it FIRST
// appears in; an edge is then owned by whichever of its two endpoints appears LATER in the
// sequence, since that's the step where the edge actually becomes part of the story being walked
// through. This intentionally covers every edge between any two journey-touched components, not
// only edges strictly within one step or between immediately-adjacent steps -- an earlier version
// only colored those narrower cases and left most of a real diagram's edges an undifferentiated
// default blue, which defeats the entire point of a multi-colored flow. A component untouched by
// any step (truly outside the journey) leaves its edges uncolored, which is the one case where
// falling back to the default color is correct.
export function buildStepEdgeColors(
  steps: JourneyStep[],
  connections: VerificationConnection[]
): Record<string, StepEdgeInfo> {
  const firstStepForComponent = new Map<string, number>();
  steps.forEach((step, idx) => {
    for (const cid of step.componentIds || []) {
      if (!firstStepForComponent.has(cid)) firstStepForComponent.set(cid, idx);
    }
  });

  const edgeInfo: Record<string, StepEdgeInfo> = {};
  for (const conn of connections) {
    const fromStep = firstStepForComponent.get(conn.from);
    const toStep = firstStepForComponent.get(conn.to);
    if (fromStep === undefined || toStep === undefined) continue;
    const stepIndex = Math.max(fromStep, toStep);
    edgeInfo[`${conn.from}->${conn.to}`] = { color: getStepColor(stepIndex), stepIndex };
  }
  return edgeInfo;
}
