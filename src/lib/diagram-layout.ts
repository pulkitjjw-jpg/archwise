// Diagram layout engine (Workstream Q) -- replaces the previous dagre-only layout, which only
// ever produced straight-line polylines through dagre's own waypoints with no collision-aware
// routing against OTHER edges. On dense architectures (15-20+ components, e.g. the enterprise
// healthcare example) that produced badly overlapping, hard-to-follow paths. ELK's layered
// algorithm with ORTHOGONAL edge routing is purpose-built to avoid exactly that: edges route
// around nodes and each other, not just between dagre's virtual dummy nodes.
import ELK, { type ElkNode } from "elkjs/lib/elk.bundled.js";

export const DIAGRAM_NODE_WIDTH = 208;
export const DIAGRAM_NODE_HEIGHT = 68;

export type DiagramLayout = {
  nodes: Record<string, { x: number; y: number; width: number; height: number }>;
  edgePoints: Record<string, { x: number; y: number }[]>;
  width: number;
  height: number;
};

type LayoutComponent = { id: string };
type LayoutConnection = { from: string; to: string };

const elk = new ELK();

// Orthogonal elbow (horizontal-vertical-horizontal) between two node BOUNDARIES, not centers --
// used for edges touching a manually-dragged node, where ELK's own bend points no longer apply
// (see computeDiagramLayoutAsync). Exiting/entering from the boundary rather than cutting through
// the middle of both boxes matches how ELK's own edge sections already behave, so a dragged
// node's edges still read as visually consistent with the rest of the diagram.
function buildElbowPoints(
  from: { x: number; y: number; width: number; height: number },
  to: { x: number; y: number; width: number; height: number }
): { x: number; y: number }[] {
  const goingRight = to.x >= from.x;
  const startX = goingRight ? from.x + from.width / 2 : from.x - from.width / 2;
  const endX = goingRight ? to.x - to.width / 2 : to.x + to.width / 2;
  const startY = from.y;
  const endY = to.y;

  if (Math.abs(startY - endY) < 1) {
    // Already on the same row -- a single straight segment is already clean, no elbow needed.
    return [
      { x: startX, y: startY },
      { x: endX, y: endY },
    ];
  }

  const midX = (startX + endX) / 2;
  return [
    { x: startX, y: startY },
    { x: midX, y: startY },
    { x: midX, y: endY },
    { x: endX, y: endY },
  ];
}

// Manually-dragged positions (Workstream Q item 3) are applied as a POST-PROCESSING step, not
// fed into ELK itself. Tried ELK's own "interactive" layout mode (feeding the dragged position
// back in as a hint) first -- empirically it only weakly influences crossing-minimization/
// ranking, not a hard position constraint, so a node dragged far from its natural rank gets
// pulled back near where ELK would have placed it anyway, defeating manual repositioning
// entirely. So dragged positions are a real, exact override applied after ELK's own layout, and
// only the EDGES touching an overridden node get special-cased (see buildElbowPoints above) --
// everything else still comes straight from ELK's own orthogonal routing, untouched.
export async function computeDiagramLayoutAsync(
  components: LayoutComponent[],
  connections: LayoutConnection[],
  layoutOverrides: Record<string, { x: number; y: number }> = {}
): Promise<DiagramLayout> {
  if (components.length === 0) {
    return { nodes: {}, edgePoints: {}, width: 400, height: 300 };
  }

  const ids = new Set(components.map((c) => c.id));
  const validConnections = connections.filter((c) => ids.has(c.from) && ids.has(c.to));

  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.spacing.nodeNodeBetweenLayers": "110",
      "elk.spacing.nodeNode": "48",
      "elk.spacing.edgeNode": "28",
      "elk.spacing.edgeEdge": "18",
      "elk.layered.mergeEdges": "false",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
    },
    children: components.map((c) => ({ id: c.id, width: DIAGRAM_NODE_WIDTH, height: DIAGRAM_NODE_HEIGHT })),
    edges: validConnections.map((c, i) => ({ id: `e${i}`, sources: [c.from], targets: [c.to] })),
  };

  const result = await elk.layout(graph);

  const nodes: DiagramLayout["nodes"] = {};
  (result.children || []).forEach((n) => {
    // ELK's (x, y) is the top-left corner; the rest of this app's rendering (dagre's convention)
    // expects center coordinates, so convert once here at the source.
    const width = n.width ?? DIAGRAM_NODE_WIDTH;
    const height = n.height ?? DIAGRAM_NODE_HEIGHT;
    nodes[n.id!] = {
      x: (n.x ?? 0) + width / 2,
      y: (n.y ?? 0) + height / 2,
      width,
      height,
    };
  });

  // Apply manual overrides after ELK's own placement.
  Object.entries(layoutOverrides).forEach(([id, pos]) => {
    if (nodes[id]) {
      nodes[id] = { ...nodes[id], x: pos.x, y: pos.y };
    }
  });

  const edgePoints: DiagramLayout["edgePoints"] = {};
  (result.edges || []).forEach((e, i) => {
    const conn = validConnections[i];
    if (!conn) return;
    const key = `${conn.from}->${conn.to}`;
    const touchesOverride = layoutOverrides[conn.from] || layoutOverrides[conn.to];

    if (touchesOverride) {
      // A dragged node's edges can't reuse ELK's stale bend points (computed for its
      // pre-drag position) -- but a raw straight line between node CENTERS was the actual
      // regression reported live: on a dense graph, that diagonal cuts straight through
      // unrelated nodes and reads as broken. Tried feeding the dragged position back into ELK
      // as an "interactive" layout hint first (org.eclipse.elk.interactive); empirically ELK
      // only treats it as a weak suggestion for crossing-minimization/ranking, not a hard
      // constraint -- a node dragged far from its natural rank got silently pulled back near
      // where ELK would have placed it anyway, which would defeat the entire point of manual
      // repositioning. So instead: an orthogonal elbow (horizontal-vertical-horizontal) between
      // the nodes' actual BOUNDARIES, not centers -- same edge-exits-from-the-box convention
      // ELK's own sections already use, so it reads as consistent with every other edge in the
      // diagram even though this specific one isn't collision-checked against every other node.
      const from = nodes[conn.from];
      const to = nodes[conn.to];
      if (from && to) edgePoints[key] = buildElbowPoints(from, to);
      return;
    }

    const section = e.sections?.[0];
    if (!section) return;
    edgePoints[key] = [section.startPoint, ...(section.bendPoints || []), section.endPoint];
  });

  const margin = 40;

  // The SVG viewBox always starts at (0, 0) -- a node dragged up/left of ELK's own bounds (which
  // are always non-negative) would render partly or entirely outside that viewBox and vanish,
  // since extending width/height alone only grows the bottom-right edge, never shifts the
  // origin. Renormalize every coordinate (nodes AND edge points, so the two stay in the same
  // space) by however far the most negative dragged position pushed past the margin -- a no-op
  // (shift of 0) in the common case where nothing has been dragged out of bounds.
  const allX = Object.values(nodes).flatMap((n) => [n.x - n.width / 2, n.x + n.width / 2]);
  const allY = Object.values(nodes).flatMap((n) => [n.y - n.height / 2, n.y + n.height / 2]);
  const minX = allX.length > 0 ? Math.min(...allX) : 0;
  const minY = allY.length > 0 ? Math.min(...allY) : 0;
  const shiftX = minX < margin ? margin - minX : 0;
  const shiftY = minY < margin ? margin - minY : 0;

  if (shiftX !== 0 || shiftY !== 0) {
    Object.keys(nodes).forEach((id) => {
      nodes[id] = { ...nodes[id], x: nodes[id].x + shiftX, y: nodes[id].y + shiftY };
    });
    Object.keys(edgePoints).forEach((key) => {
      edgePoints[key] = edgePoints[key].map((p) => ({ x: p.x + shiftX, y: p.y + shiftY }));
    });
  }

  const width = allX.length > 0 ? Math.max(...allX) + shiftX + margin : result.width || 400;
  const height = allY.length > 0 ? Math.max(...allY) + shiftY + margin : result.height || 300;

  return { nodes, edgePoints, width, height };
}

// End-to-end flow bookends (Workstream R) -- the topology diagram previously showed only cloud
// infrastructure, with no visual indication of where the flow actually starts (the end user
// opening the app) or ends (the response coming back to them). Deliberately NOT real
// architecture components: they're never written to hld.components, never sent through
// Terraform/K8s export, never priced, never provider-specific -- purely a rendering-layer
// overlay computed fresh from whatever the current component/connection graph looks like, so
// every existing project gets this immediately with no migration or regeneration.
export const USER_NODE_ID = "__end_user__";
export const CLIENT_NODE_ID = "__client_app__";
export const RESPONSE_NODE_ID = "__response__";

export type FlowBookendNode = {
  id: string;
  name: string;
  kind: "user" | "client" | "response";
};

export type FlowBookendConnection = { from: string; to: string; protocol: string };

export function buildFlowBookends(
  components: { id: string }[],
  connections: { from: string; to: string }[]
): { nodes: FlowBookendNode[]; connections: FlowBookendConnection[] } {
  if (components.length === 0) return { nodes: [], connections: [] };

  const hasIncoming = new Set(connections.map((c) => c.to));
  const hasOutgoing = new Set(connections.map((c) => c.from));
  const entryPoints = components.filter((c) => !hasIncoming.has(c.id)).map((c) => c.id);
  const exitPoints = components.filter((c) => !hasOutgoing.has(c.id)).map((c) => c.id);

  // Defensive fallback: an unusual graph (fully cyclic, or a single node) could have zero
  // natural entry/exit points -- fall back to the first/last component so the bookends still
  // attach to something rather than floating disconnected.
  const entries = entryPoints.length > 0 ? entryPoints : [components[0].id];
  const exits = exitPoints.length > 0 ? exitPoints : [components[components.length - 1].id];

  const nodes: FlowBookendNode[] = [
    { id: USER_NODE_ID, name: "End User", kind: "user" },
    { id: CLIENT_NODE_ID, name: "Client App (Web/Mobile)", kind: "client" },
    { id: RESPONSE_NODE_ID, name: "Response to User", kind: "response" },
  ];

  const bookendConnections: FlowBookendConnection[] = [
    { from: USER_NODE_ID, to: CLIENT_NODE_ID, protocol: "User Action" },
    ...entries.map((id) => ({ from: CLIENT_NODE_ID, to: id, protocol: "HTTPS Request" })),
    ...exits.map((id) => ({ from: id, to: RESPONSE_NODE_ID, protocol: "Response" })),
  ];

  return { nodes, connections: bookendConnections };
}

// Turns a polyline (straight-line-only ELK bend points, or a 2-point override fallback) into a
// smooth SVG path with rounded corners at each interior vertex -- a sharp right-angle turn reads
// as more mechanical/harder to trace at a glance than a gently rounded one, which is why every
// mainstream diagramming tool (Lucidchart, draw.io, AWS's own architecture diagrams) rounds
// orthogonal edge corners rather than rendering raw right angles.
export function buildRoundedPath(points: { x: number; y: number }[], radius = 12): string {
  if (points.length < 2) return "";
  if (points.length === 2) {
    return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  }

  const parts: string[] = [`M ${points[0].x} ${points[0].y}`];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const next = points[i + 1];

    const toPrev = { x: prev.x - curr.x, y: prev.y - curr.y };
    const toNext = { x: next.x - curr.x, y: next.y - curr.y };
    const prevLen = Math.hypot(toPrev.x, toPrev.y) || 1;
    const nextLen = Math.hypot(toNext.x, toNext.y) || 1;
    const r = Math.min(radius, prevLen / 2, nextLen / 2);

    const beforeCorner = { x: curr.x + (toPrev.x / prevLen) * r, y: curr.y + (toPrev.y / prevLen) * r };
    const afterCorner = { x: curr.x + (toNext.x / nextLen) * r, y: curr.y + (toNext.y / nextLen) * r };

    parts.push(`L ${beforeCorner.x} ${beforeCorner.y}`);
    parts.push(`Q ${curr.x} ${curr.y} ${afterCorner.x} ${afterCorner.y}`);
  }
  const last = points[points.length - 1];
  parts.push(`L ${last.x} ${last.y}`);
  return parts.join(" ");
}
