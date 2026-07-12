"use client";

import { useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import { TransformWrapper, TransformComponent } from "react-zoom-pan-pinch";
import { resolveServiceIcon } from "@/lib/service-icons";
import {
  computeDiagramLayoutAsync,
  buildRoundedPath,
  buildFlowBookends,
  type DiagramLayout,
} from "@/lib/diagram-layout";

// Shareable Read-Only Review Link (Workstream T7) -- deliberately a NEW, small, purpose-built
// component rather than ArchitectureWorkspace.tsx with a "readOnly" flag bolted on. That
// component is ~4,700 lines with 40+ pieces of edit/draft/proposal/what-if state and a dozen
// inline POST/PATCH calls; retrofitting a read-only mode there would mean auditing every one of
// them to prove none can fire. Here, no edit/save/export/generate code is ever imported into this
// component's tree at all -- a structural guarantee, not a runtime flag, that a public viewer can
// never mutate anything. This only ever makes ONE network call (the public GET below); it never
// calls flow-story/journey/migration-roadmap generation endpoints, since those cache a fresh LLM
// result on the architecture row and an unauthenticated link must never be able to trigger that.

type CloudProviderKey = "aws" | "azure" | "gcp" | "kubernetes" | "private";

const PROVIDER_LABELS: Record<CloudProviderKey, string> = {
  aws: "AWS",
  azure: "Azure",
  gcp: "Google Cloud",
  kubernetes: "Kubernetes",
  private: "Private Cloud",
};

type ComponentData = {
  id: string;
  name: string;
  type: string;
  reasoning: string;
  cloudMappings?: Record<string, { serviceName: string; costEstimate: { min: number; max: number; assumptions: string } } | undefined>;
};

type ConnectionData = { from: string; to: string; protocol: string };

type SharedArchitecture = {
  version: string;
  hld: { components: ComponentData[]; connections: ConnectionData[] };
  reasoning: { assumptions: string[]; risks: string[] };
  flowStory?: Record<string, string>;
  layoutOverrides?: Record<string, { x: number; y: number }>;
  securityFindings?: Record<string, { severity: string; title: string }[]>;
  createdAt: string;
};

export default function ShareView({ token }: { token: string }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [projectName, setProjectName] = useState("");
  const [architecture, setArchitecture] = useState<SharedArchitecture | null>(null);
  const [activeProvider, setActiveProvider] = useState<CloudProviderKey>("aws");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [diagramLayout, setDiagramLayout] = useState<DiagramLayout | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/share/${token}`)
      .then((res) => (res.ok ? res.json() : res.json().then((d) => Promise.reject(new Error(d.error || "This link is no longer available.")))))
      .then((data) => {
        if (cancelled) return;
        setProjectName(data.projectName);
        setArchitecture(data.architecture);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || "This link is no longer available.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (!architecture) return;
    const { nodes: bookendNodes, connections: bookendConnections } = buildFlowBookends(
      architecture.hld.components,
      architecture.hld.connections
    );
    const layoutComponents = [...architecture.hld.components, ...bookendNodes];
    const layoutConnections = [...architecture.hld.connections, ...bookendConnections];
    let cancelled = false;
    computeDiagramLayoutAsync(layoutComponents, layoutConnections, architecture.layoutOverrides || {}).then((layout) => {
      if (!cancelled) setDiagramLayout(layout);
    });
    return () => {
      cancelled = true;
    };
  }, [architecture]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      </div>
    );
  }

  if (error || !architecture) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-2 bg-paper px-6 text-center">
        <Icon icon="mdi:link-off" width={32} height={32} className="text-ink-faint" />
        <p className="text-sm font-bold text-ink">{error || "This link is no longer available."}</p>
        <p className="text-xs text-ink-muted">The person who shared this may have revoked it, or it never existed.</p>
      </div>
    );
  }

  const getMapping = (c: ComponentData) => c.cloudMappings?.[activeProvider];
  const totalCost = architecture.hld.components.reduce(
    (acc, c) => {
      const m = getMapping(c);
      return { min: acc.min + (m?.costEstimate.min || 0), max: acc.max + (m?.costEstimate.max || 0) };
    },
    { min: 0, max: 0 }
  );
  const selectedNode = architecture.hld.components.find((c) => c.id === selectedNodeId) || null;
  const flowStory = architecture.flowStory?.[activeProvider];
  const findings = architecture.securityFindings?.[activeProvider] || [];

  return (
    <div className="min-h-screen bg-paper">
      <div className="border-b border-line bg-white px-6 py-4">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-3">
          <div>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/25 bg-accent-soft px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-accent-ink">
              <Icon icon="mdi:eye-outline" width={11} height={11} />
              Read-only shared view
            </span>
            <h1 className="mt-1.5 text-xl font-black text-ink">{projectName}</h1>
            <p className="text-xs text-ink-muted">Design v{architecture.version}</p>
          </div>
          <div className="flex bg-paper/80 p-0.5 rounded-lg border border-line shadow-sm">
            {(Object.keys(PROVIDER_LABELS) as CloudProviderKey[]).map((p) => (
              <button
                key={p}
                onClick={() => setActiveProvider(p)}
                className={`px-2.5 py-1.5 text-[10px] font-extrabold uppercase rounded transition ${
                  activeProvider === p ? "bg-ink text-white shadow-sm" : "text-ink-muted hover:text-ink"
                }`}
              >
                {PROVIDER_LABELS[p]}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-[1400px] px-6 py-6">
        <div className="mb-4 flex items-center gap-3">
          <span className="rounded-full border border-success/25 bg-success-soft px-3 py-1 text-xs font-extrabold text-success">
            Est: ${totalCost.min} - ${totalCost.max}/mo for {PROVIDER_LABELS[activeProvider]}
          </span>
          {findings.length > 0 && (
            <span className="rounded-full border border-warning/25 bg-warning-soft px-3 py-1 text-xs font-bold text-warning">
              {findings.length} security finding{findings.length === 1 ? "" : "s"}
            </span>
          )}
        </div>

        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          <div className="rounded-2xl border border-line bg-white shadow-sm" style={{ height: "min(700px, 70vh)" }}>
            {diagramLayout ? (
              <TransformWrapper initialScale={1} minScale={0.15} maxScale={2.5}>
                <TransformComponent wrapperStyle={{ width: "100%", height: "100%" }}>
                  <svg viewBox={`0 0 ${diagramLayout.width} ${diagramLayout.height}`} width={diagramLayout.width} height={diagramLayout.height}>
                    <defs>
                      <marker id="share-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                        <path d="M 0 0 L 10 5 L 0 10 z" fill="#5B4FE8" />
                      </marker>
                    </defs>
                    {[...architecture.hld.connections, ...buildFlowBookends(architecture.hld.components, architecture.hld.connections).connections].map((conn, idx) => {
                      const points = diagramLayout.edgePoints[`${conn.from}->${conn.to}`];
                      if (!points || points.length < 2) return null;
                      return (
                        <path
                          key={idx}
                          d={buildRoundedPath(points)}
                          fill="none"
                          stroke="#5B4FE8"
                          strokeOpacity={0.55}
                          strokeWidth={1.5}
                          strokeDasharray="5,9"
                          markerEnd="url(#share-arrow)"
                        />
                      );
                    })}
                    {architecture.hld.components.map((node) => {
                      const coord = diagramLayout.nodes[node.id];
                      if (!coord) return null;
                      const mapping = getMapping(node);
                      const isSelected = selectedNodeId === node.id;
                      return (
                        <foreignObject
                          key={node.id}
                          x={coord.x - coord.width / 2}
                          y={coord.y - coord.height / 2}
                          width={coord.width}
                          height={coord.height}
                        >
                          <div
                            onClick={() => setSelectedNodeId(node.id)}
                            className={`flex h-full w-full cursor-pointer items-center gap-2.5 rounded-2xl border bg-panel px-3 py-2 shadow-sm transition ${
                              isSelected ? "border-accent ring-2 ring-accent-soft" : "border-line-strong hover:border-ink-faint"
                            }`}
                          >
                            <div className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-accent-soft">
                              <Icon icon={resolveServiceIcon(mapping?.serviceName, node.type)} width={20} height={20} />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-[9.5px] font-bold uppercase tracking-wide text-ink-faint">{node.type}</div>
                              <div className="truncate text-[12.5px] font-bold text-ink">{mapping?.serviceName || node.name}</div>
                            </div>
                          </div>
                        </foreignObject>
                      );
                    })}
                    {(() => {
                      const { nodes: bookendNodes } = buildFlowBookends(architecture.hld.components, architecture.hld.connections);
                      return bookendNodes.map((node) => {
                        const coord = diagramLayout.nodes[node.id];
                        if (!coord) return null;
                        return (
                          <foreignObject key={node.id} x={coord.x - coord.width / 2} y={coord.y - coord.height / 2} width={coord.width} height={coord.height}>
                            <div className="flex h-full w-full items-center gap-2.5 rounded-2xl border-2 border-dashed border-white/30 bg-ink px-3 py-2 shadow-sm">
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-[12.5px] font-bold text-white">{node.name}</div>
                              </div>
                            </div>
                          </foreignObject>
                        );
                      });
                    })()}
                  </svg>
                </TransformComponent>
              </TransformWrapper>
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-ink-muted">Loading diagram...</div>
            )}
          </div>

          <div className="space-y-4">
            <div className="rounded-2xl border border-line bg-white p-4 shadow-sm">
              <span className="text-[10px] font-bold uppercase tracking-wide text-ink-faint">
                {selectedNode ? "Selected component" : "Select a component"}
              </span>
              {selectedNode ? (
                <div className="mt-2">
                  <p className="text-sm font-bold text-ink">{getMapping(selectedNode)?.serviceName || selectedNode.name}</p>
                  <p className="mt-1 text-xs text-ink-muted leading-relaxed">{selectedNode.reasoning}</p>
                  {getMapping(selectedNode) && (
                    <p className="mt-2 text-xs font-bold text-success">
                      ${getMapping(selectedNode)!.costEstimate.min} - ${getMapping(selectedNode)!.costEstimate.max}/mo
                    </p>
                  )}
                </div>
              ) : (
                <p className="mt-2 text-xs text-ink-muted">Click any box in the diagram to see its cost and reasoning.</p>
              )}
            </div>

            {flowStory && (
              <div className="rounded-2xl border border-line bg-white p-4 shadow-sm">
                <span className="text-[10px] font-bold uppercase tracking-wide text-ink-faint">Architecture Flow Story</span>
                <p className="mt-2 text-xs leading-relaxed text-ink-muted">{flowStory}</p>
              </div>
            )}

            {architecture.reasoning.risks?.length > 0 && (
              <div className="rounded-2xl border border-line bg-white p-4 shadow-sm">
                <span className="text-[10px] font-bold uppercase tracking-wide text-ink-faint">Key Risks</span>
                <ul className="mt-2 space-y-1.5 text-xs text-ink-muted">
                  {architecture.reasoning.risks.map((r, i) => (
                    <li key={i}>- {r}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
