"use client";

import { useEffect, useRef, useState } from "react";
import dagre from "dagre";
import { Icon } from "@iconify/react";
import { TransformWrapper, TransformComponent } from "react-zoom-pan-pinch";
import { runLldRulesEngine } from "@/lib/lld-rules";
import { validateArchitectureLayout, getProviderMaturityWarning } from "@/lib/validation";
import { resolveServiceIcon } from "@/lib/service-icons";
import { getPlainDescription } from "@/lib/component-descriptions";
import { exportDiagramAsPng, exportDiagramAsSvg, type PngExportEdge, type PngExportNode } from "@/lib/diagram-export";
import InfoTooltip from "./InfoTooltip";

type CloudProviderKey = "aws" | "azure" | "gcp" | "kubernetes" | "private";

const PROVIDER_LABELS: Record<CloudProviderKey, string> = {
  aws: "AWS",
  azure: "Azure",
  gcp: "GCP",
  kubernetes: "K8s",
  private: "Private",
};

// Icon badge background per provider -- provider hues are fills/tints only, never chrome.
const PROVIDER_SOFT_BG: Record<CloudProviderKey, string> = {
  aws: "bg-aws-soft",
  azure: "bg-azure-soft",
  gcp: "bg-gcp-soft",
  kubernetes: "bg-k8s-soft",
  private: "bg-private-soft",
};

// Plain-language labels for the component-type badge in Simple mode -- the raw type slug
// (e.g. "phi-vault", "audit-log") is the Technical-mode value; falls back to the raw type for
// any type not listed here rather than hiding the badge.
const TYPE_LABELS: Record<string, string> = {
  cdn: "Content Delivery",
  compute: "Compute",
  database: "Database",
  storage: "File Storage",
  queue: "Task Queue",
  cache: "Cache",
  auth: "Authentication",
  tokenization: "Tokenization",
  "audit-log": "Audit Log",
  "phi-vault": "Health Data Vault",
  deidentification: "De-identification",
};

const DIAGRAM_NODE_WIDTH = 208;
const DIAGRAM_NODE_HEIGHT = 68;

type DiagramLayout = {
  nodes: Record<string, { x: number; y: number; width: number; height: number }>;
  edgePoints: Record<string, { x: number; y: number }[]>;
  width: number;
  height: number;
};

function computeDiagramLayout(components: ComponentData[], connections: ConnectionData[]): DiagramLayout {
  if (components.length === 0) {
    return { nodes: {}, edgePoints: {}, width: 400, height: 300 };
  }

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 44, ranksep: 110, marginx: 40, marginy: 40 });
  g.setDefaultEdgeLabel(() => ({}));

  const ids = new Set(components.map((c) => c.id));
  components.forEach((c) => {
    g.setNode(c.id, { width: DIAGRAM_NODE_WIDTH, height: DIAGRAM_NODE_HEIGHT });
  });
  connections.forEach((conn) => {
    if (ids.has(conn.from) && ids.has(conn.to)) {
      g.setEdge(conn.from, conn.to);
    }
  });

  dagre.layout(g);

  const nodes: DiagramLayout["nodes"] = {};
  g.nodes().forEach((id) => {
    const n = g.node(id);
    nodes[id] = { x: n.x, y: n.y, width: n.width, height: n.height };
  });

  const edgePoints: DiagramLayout["edgePoints"] = {};
  g.edges().forEach((e) => {
    edgePoints[`${e.v}->${e.w}`] = g.edge(e).points;
  });

  const graph = g.graph();
  return { nodes, edgePoints, width: graph.width || 400, height: graph.height || 300 };
}

// Honest, staged descriptions of what the generation call is actually doing server-side —
// shown progressively (not tied to real server progress events) to make the ~30-45s wait
// legible instead of a single unmoving spinner.
const GENERATION_STAGES = [
  "Analyzing your requirements...",
  "Running architecture rules engine...",
  "Validating decisions with AI...",
  "Mapping to cloud services (AWS/Azure/GCP)...",
  "Computing LLD configurations...",
  "Finalizing cost estimates...",
];
const GENERATION_STAGE_INTERVAL_MS = 8000;

type CloudMapping = {
  serviceName: string;
  alternatives: Array<{
    serviceName: string;
    reason: string;
    costEstimate?: {
      min: number;
      max: number;
      assumptions: string;
    };
  }>;
  costEstimate: {
    min: number;
    max: number;
    assumptions: string;
  };
  lld?: {
    config: Record<string, string>;
    reasoning: Record<string, string>;
  };
  swapReasoning?: string;
};

type ComponentData = {
  id: string;
  name: string;
  type: string;
  description: string;
  reasoning: string;
  rulesFired: string[];
  cloudMapping?: CloudMapping; // legacy support
  cloudMappings?: {
    aws: CloudMapping;
    azure: CloudMapping;
    gcp: CloudMapping;
    // Optional: only present on architectures generated after Phase 4 Step 2.
    kubernetes?: CloudMapping;
    private?: CloudMapping;
  };
  metadata?: {
    isManuallyAdded?: boolean;
    overrideSource?: "user" | "system";
  };
};

type ConnectionData = {
  from: string;
  to: string;
  protocol: string;
};

type ArchitectureData = {
  version: string;
  hld: {
    components: ComponentData[];
    connections: ConnectionData[];
  };
  reasoning: {
    decisions: any[];
    assumptions: string[];
    risks: string[];
    recommendation?: {
      recommendedProvider: "aws" | "azure" | "gcp";
      rationale: string;
      keyTradeoffs: string[];
    };
    diff?: {
      added: Array<{ id: string; name: string; type: string; reasoning: string }>;
      removed: Array<{ id: string; name: string; type: string }>;
      modified: Array<{
        id: string;
        name: string;
        type: string;
        changes: Array<{ parameter: string; oldVal: string; newVal: string; reasoning: string }>;
      }>;
      costDelta: {
        aws: { min: number; max: number };
        azure: { min: number; max: number };
        gcp: { min: number; max: number };
      };
    };
  };
  createdAt: string;
};

interface ArchitectureWorkspaceProps {
  projectId: string;
  requirements: any;
  onRequirementsChange: () => void;
  onSwitchTab: (tab: "requirements" | "hld", fieldToFocus?: string) => void;
  focusMode?: boolean;
  onToggleFocusMode?: () => void;
}

export default function ArchitectureWorkspace({
  projectId,
  requirements,
  onRequirementsChange,
  onSwitchTab,
  focusMode,
  onToggleFocusMode,
}: ArchitectureWorkspaceProps) {
  const [architecture, setArchitecture] = useState<ArchitectureData | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [generationStageIndex, setGenerationStageIndex] = useState(0);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [activeProvider, setActiveProvider] = useState<CloudProviderKey>("aws");
  const [viewMode, setViewMode] = useState<"diagram" | "comparison">("diagram");
  const [isLldExpanded, setIsLldExpanded] = useState(false);
  // Simple is the default for every new session -- matches the goal of being usable with
  // zero architecture background. Technical is one click away, not buried.
  const [explanationMode, setExplanationMode] = useState<"simple" | "technical">("simple");
  const [error, setError] = useState("");
  const [versionList, setVersionList] = useState<ArchitectureData[]>([]);

  const [isEditing, setIsEditing] = useState(false);
  const [draftHld, setDraftHld] = useState<{ components: ComponentData[]; connections: ConnectionData[] } | null>(null);
  const [validationResults, setValidationResults] = useState<{ isValid: boolean; errors: string[]; warnings: string[] }>({
    isValid: true,
    errors: [],
    warnings: [],
  });

  const [newNodeName, setNewNodeName] = useState("");
  const [newNodeType, setNewNodeType] = useState("compute");
  const [newNodeReasoning, setNewNodeReasoning] = useState("");

  const [newEdgeFrom, setNewEdgeFrom] = useState("");
  const [newEdgeTo, setNewEdgeTo] = useState("");
  const [newEdgeProtocol, setNewEdgeProtocol] = useState("HTTPS");

  const [swapReason, setSwapReason] = useState("");

  const [savingManualChanges, setSavingManualChanges] = useState(false);

  const loadArchitecture = async (selectedVersion?: string) => {
    try {
      setLoading(true);
      // Fetch full version list
      const historyRes = await fetch(`/api/projects/${projectId}/architectures?all=true`);
      let historyData: ArchitectureData[] = [];
      if (historyRes.ok) {
        const data = await historyRes.json();
        historyData = data.architectures || [];
        setVersionList(historyData);
      }

      // If a specific version is requested, load it from the cached historyData
      if (selectedVersion && historyData.length > 0) {
        const matched = historyData.find((a) => a.version === selectedVersion);
        if (matched) {
          setArchitecture(matched);
          setLoading(false);
          return;
        }
      }

      // Default fallback to fetch the latest generated architecture
      const res = await fetch(`/api/projects/${projectId}/architectures`);
      if (res.ok) {
        const data = await res.json();
        setArchitecture(data.architecture || null);
      } else {
        setArchitecture(null);
      }
    } catch (err) {
      console.error("Failed to load architecture:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadArchitecture();
  }, [projectId]);

  // LLD accordion defaults open in Technical mode (deeper detail should be the default there,
  // not an extra click) and closed in Simple mode -- re-applied whenever the selected node
  // changes so switching components doesn't leave a stale expand/collapse state behind.
  useEffect(() => {
    setIsLldExpanded(explanationMode === "technical");
  }, [selectedNodeId, explanationMode]);

  // Advance the staged loading message every few seconds while a generation call is
  // in-flight. These stages are honest labels for what the server is doing during the call,
  // not real progress events — they just make the long single-request wait legible.
  useEffect(() => {
    if (!generating) {
      setGenerationStageIndex(0);
      return;
    }
    const interval = setInterval(() => {
      setGenerationStageIndex((prev) => Math.min(prev + 1, GENERATION_STAGES.length - 1));
    }, GENERATION_STAGE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [generating]);

  // Determine if critical fields are specified
  const isScaleUnspecified =
    !requirements?.nonFunctional?.expectedScale ||
    requirements.nonFunctional.expectedScale.toLowerCase() === "not_specified" ||
    requirements.nonFunctional.expectedScale.toLowerCase() === "not specified";

  const isBudgetUnspecified =
    !requirements?.nonFunctional?.budget ||
    requirements.nonFunctional.budget.toLowerCase() === "not_specified" ||
    requirements.nonFunctional.budget.toLowerCase() === "not specified";

  const isDataUnspecified =
    !requirements?.nonFunctional?.dataNature ||
    requirements.nonFunctional.dataNature.toLowerCase() === "not_specified" ||
    requirements.nonFunctional.dataNature.toLowerCase() === "not specified";

  const isGenerationBlocked = isScaleUnspecified || isBudgetUnspecified || isDataUnspecified;

  const providerMaturityWarning = getProviderMaturityWarning(activeProvider, requirements);

  const handleGenerate = async () => {
    if (isGenerationBlocked) return;

    try {
      setGenerating(true);
      setError("");
      const res = await fetch(`/api/projects/${projectId}/architectures`, {
        method: "POST",
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || "Failed to generate architecture");
      }

      const data = await res.json();
      setArchitecture(data.architecture);
      await loadArchitecture(data.architecture.version);
    } catch (err: any) {
      setError(err.message || "An unexpected error occurred during generation.");
    } finally {
      setGenerating(false);
    }
  };

  const handleExport = () => {
    if (!architecture) return;
    window.location.href = `/api/projects/${projectId}/export?provider=${activeProvider}`;
  };

  // Exports the diagram itself as an image -- a separate concern from handleExport above, which
  // downloads deployable Terraform/K8s config. This just captures the picture.
  const handleExportDiagramImage = async (format: "svg" | "png") => {
    setImageExportOpen(false);
    if (!architecture) return;
    const filenameBase = `architecture-diagram-v${architecture.version}`;
    try {
      setImageExportBusy(true);
      if (format === "svg") {
        const svgEl = diagramSvgRef.current;
        if (!svgEl) return;
        exportDiagramAsSvg(svgEl, filenameBase);
      } else {
        // Pure-SVG twin, not the live foreignObject-based DOM -- canvas.toBlob() throws on any
        // SVG containing foreignObject regardless of content, so PNG export builds its own
        // simplified rect/text representation from the same layout data instead (see
        // diagram-export.ts for why).
        const pngNodes: PngExportNode[] = diagramComponents
          .map((c) => {
            const coord = nodeCoords[c.id];
            if (!coord) return null;
            const mapping = getMappingForProvider(c, activeProvider);
            return {
              id: c.id,
              x: coord.x,
              y: coord.y,
              width: coord.width,
              height: coord.height,
              label: c.name,
              serviceName: mapping?.serviceName || c.name,
              isCompliance: isComplianceNode(c.type),
              isOverride: c.metadata?.overrideSource === "user",
              accentHex: "#5B4FE8",
            };
          })
          .filter((n): n is PngExportNode => n !== null);

        const pngEdges: PngExportEdge[] = diagramConnections
          .map((conn) => {
            const points = diagramLayout.edgePoints[`${conn.from}->${conn.to}`];
            if (!points || points.length < 2) return null;
            return { d: points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ") };
          })
          .filter((e): e is PngExportEdge => e !== null);

        await exportDiagramAsPng(pngNodes, pngEdges, diagramLayout.width, diagramLayout.height, filenameBase);
      }
    } catch (err) {
      console.error("Diagram image export failed:", err);
      setError("Failed to export diagram image. Please try again.");
    } finally {
      setImageExportBusy(false);
    }
  };

  const handleEnterEditMode = () => {
    if (!architecture) return;
    setDraftHld({
      components: JSON.parse(JSON.stringify(architecture.hld.components)),
      connections: JSON.parse(JSON.stringify(architecture.hld.connections)),
    });
    setIsEditing(true);
    setError("");
    const firstNode = architecture.hld.components[0]?.id || "";
    const secondNode = architecture.hld.components[1]?.id || "";
    setNewEdgeFrom(firstNode);
    setNewEdgeTo(secondNode);
  };

  const handleCancelEditMode = () => {
    setIsEditing(false);
    setDraftHld(null);
    setNewNodeName("");
    setNewNodeReasoning("");
    setError("");
  };

  const handleAddComponent = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newNodeName.trim()) return;
    if (!draftHld) return;

    const newId = `node-${Math.random().toString(36).substr(2, 9)}`;
    const newNode: ComponentData = {
      id: newId,
      name: newNodeName.trim(),
      type: newNodeType,
      description: `User-defined ${newNodeType} component.`,
      reasoning: newNodeReasoning.trim() || "Manually added by user.",
      rulesFired: [],
      metadata: {
        isManuallyAdded: true,
        overrideSource: "user" as const,
      },
    };

    setDraftHld({
      components: [...draftHld.components, newNode],
      connections: draftHld.connections,
    });

    setNewNodeName("");
    setNewNodeReasoning("");
    if (!newEdgeFrom) setNewEdgeFrom(newId);
    else if (!newEdgeTo) setNewEdgeTo(newId);
  };

  const handleRemoveNode = (nodeId: string) => {
    if (!draftHld) return;

    const updatedComponents = draftHld.components.filter((c) => c.id !== nodeId);
    const updatedConnections = draftHld.connections.filter(
      (conn) => conn.from !== nodeId && conn.to !== nodeId
    );

    setDraftHld({
      components: updatedComponents,
      connections: updatedConnections,
    });

    if (selectedNodeId === nodeId) {
      setSelectedNodeId(null);
    }
  };

  const handleAddConnection = (e: React.FormEvent) => {
    e.preventDefault();
    if (!draftHld || !newEdgeFrom || !newEdgeTo) return;
    if (newEdgeFrom === newEdgeTo) return;

    const exists = draftHld.connections.some(
      (conn) => conn.from === newEdgeFrom && conn.to === newEdgeTo
    );
    if (exists) return;

    const newConn: ConnectionData = {
      from: newEdgeFrom,
      to: newEdgeTo,
      protocol: newEdgeProtocol || "TCP",
    };

    setDraftHld({
      components: draftHld.components,
      connections: [...draftHld.connections, newConn],
    });
  };

  const handleRemoveConnection = (fromId: string, toId: string) => {
    if (!draftHld) return;

    const updatedConnections = draftHld.connections.filter(
      (conn) => !(conn.from === fromId && conn.to === toId)
    );

    setDraftHld({
      components: draftHld.components,
      connections: updatedConnections,
    });
  };

  const handleUpdateLldConfig = (nodeId: string, provider: CloudProviderKey, paramKey: string, newVal: string) => {
    if (!draftHld) return;
    const updatedComponents = draftHld.components.map((c) => {
      if (c.id !== nodeId) return c;
      const mapping = c.cloudMappings?.[provider];
      if (!mapping) return c;
      const currentLld = mapping.lld || { config: {}, reasoning: {} };
      const updatedConfig = { ...currentLld.config, [paramKey]: newVal };
      return {
        ...c,
        metadata: {
          ...c.metadata,
          overrideSource: "user",
        },
        cloudMappings: {
          ...c.cloudMappings,
          [provider]: {
            ...mapping,
            lld: {
              ...currentLld,
              config: updatedConfig,
            },
          },
        },
      } as ComponentData;
    });
    setDraftHld({
      components: updatedComponents,
      connections: draftHld.connections,
    });
  };

  const handleUpdateLldReasoning = (nodeId: string, provider: CloudProviderKey, paramKey: string, val: string) => {
    if (!draftHld) return;
    const updatedComponents = draftHld.components.map((c) => {
      if (c.id !== nodeId) return c;
      const mapping = c.cloudMappings?.[provider];
      if (!mapping) return c;
      const currentLld = mapping.lld || { config: {}, reasoning: {} };
      const updatedReasoning = { ...currentLld.reasoning, [paramKey]: val };
      return {
        ...c,
        metadata: {
          ...c.metadata,
          overrideSource: "user",
        },
        cloudMappings: {
          ...c.cloudMappings,
          [provider]: {
            ...mapping,
            lld: {
              ...currentLld,
              reasoning: updatedReasoning,
            },
          },
        },
      } as ComponentData;
    });
    setDraftHld({
      components: updatedComponents,
      connections: draftHld.connections,
    });
  };

  const handleUpdateComponentReasoning = (nodeId: string, val: string) => {
    if (!draftHld) return;
    const updatedComponents = draftHld.components.map((c) => {
      if (c.id !== nodeId) return c;
      return {
        ...c,
        reasoning: val,
        metadata: {
          ...c.metadata,
          overrideSource: "user" as const,
        },
      } as ComponentData;
    });
    setDraftHld({
      components: updatedComponents,
      connections: draftHld.connections,
    });
  };

  // Swap a component's bound cloud service to one of its already-computed "alternatives
  // considered" entries. The demoted current service becomes a new alternative in its place
  // (with its own cost band), so the swap is reversible, and the LLD config is recomputed for
  // the newly chosen service rather than left stale from the previous one.
  const handleSwapService = (nodeId: string, provider: CloudProviderKey, altIndex: number) => {
    if (!draftHld) return;
    const reasonText = swapReason.trim() || "Manually changed by user.";

    const updatedComponents = draftHld.components.map((c) => {
      if (c.id !== nodeId) return c;
      const mapping = c.cloudMappings?.[provider];
      const chosen = mapping?.alternatives[altIndex];
      if (!mapping || !chosen || !chosen.costEstimate) return c;

      const demotedAlternative = {
        serviceName: mapping.serviceName,
        reason: "Rule-engine default choice before this manual override.",
        costEstimate: mapping.costEstimate,
      };
      const updatedAlternatives = mapping.alternatives.map((alt, idx) =>
        idx === altIndex ? demotedAlternative : alt
      );

      const recomputedLld = runLldRulesEngine(
        provider,
        c.type,
        c.id,
        {
          functional: requirements?.functional || [],
          nonFunctional: requirements?.nonFunctional || {
            expectedScale: "not_specified",
            readWritePattern: "not_specified",
            dataNature: "not_specified",
            latencySensitivity: "not_specified",
            budget: "not_specified",
            teamMaturity: "not_specified",
            compliance: "not_specified",
          },
        },
        chosen.serviceName
      );

      return {
        ...c,
        metadata: {
          ...c.metadata,
          overrideSource: "user" as const,
        },
        cloudMappings: {
          ...c.cloudMappings,
          [provider]: {
            ...mapping,
            serviceName: chosen.serviceName,
            costEstimate: chosen.costEstimate,
            alternatives: updatedAlternatives,
            lld: recomputedLld,
            swapReasoning: reasonText,
          },
        },
      } as ComponentData;
    });

    setDraftHld({
      components: updatedComponents,
      connections: draftHld.connections,
    });
    setSwapReason("");
  };

  const handleSaveManualChanges = async () => {
    if (!draftHld || !validationResults.isValid) return;

    try {
      setSavingManualChanges(true);
      setError("");
      const res = await fetch(`/api/projects/${projectId}/architectures/manual`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          components: draftHld.components,
          connections: draftHld.connections,
        }),
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || "Failed to save manual changes");
      }

      const data = await res.json();
      setIsEditing(false);
      setDraftHld(null);
      await loadArchitecture(data.architecture.version);
    } catch (err: any) {
      setError(err.message || "An error occurred while saving overrides.");
    } finally {
      setSavingManualChanges(false);
    }
  };

  // Helper to extract mapping based on active provider
  const getMappingForProvider = (node: ComponentData, prov: CloudProviderKey): CloudMapping | undefined => {
    if (node.cloudMappings) {
      return node.cloudMappings[prov];
    }
    if (prov === "aws" && node.cloudMapping) {
      return node.cloudMapping;
    }
    return undefined;
  };

  // Compute Total Cost Estimates dynamically
  const calculateTotalCost = (prov: CloudProviderKey) => {
    if (!architecture) return { min: 0, max: 0 };
    const min = architecture.hld.components.reduce((sum, c) => {
      const mapping = getMappingForProvider(c, prov);
      return sum + (mapping?.costEstimate.min || 0);
    }, 0);
    const max = architecture.hld.components.reduce((sum, c) => {
      const mapping = getMappingForProvider(c, prov);
      return sum + (mapping?.costEstimate.max || 0);
    }, 0);
    return { min, max };
  };

  // Run layout validations reactively when draftHld or activeProvider changes
  useEffect(() => {
    if (draftHld) {
      const activeCosts = calculateTotalCost(activeProvider);
      const res = validateArchitectureLayout(
        draftHld.components,
        draftHld.connections,
        requirements,
        activeCosts
      );
      setValidationResults(res);
    }
  }, [draftHld, activeProvider]);

  // Node Positions Calculation for Premium SVG Rendering
  const diagramComponents = isEditing
    ? draftHld?.components || []
    : architecture?.hld.components || [];
  const diagramConnections = isEditing
    ? draftHld?.connections || []
    : architecture?.hld.connections || [];
  const diagramLayout = computeDiagramLayout(diagramComponents, diagramConnections);
  const nodeCoords = diagramLayout.nodes;
  const selectedNode = isEditing
    ? draftHld?.components.find((c) => c.id === selectedNodeId)
    : architecture?.hld.components.find((c) => c.id === selectedNodeId);

  // Plain-language data-flow context for the drawer -- who this component sends requests to,
  // and who sends requests to it, using the component names a non-architect would recognize
  // rather than raw ids.
  const nodeNameById = (id: string) => diagramComponents.find((c) => c.id === id)?.name || id;
  const outgoingConnections = selectedNode
    ? diagramConnections.filter((c) => c.from === selectedNode.id)
    : [];
  const incomingConnections = selectedNode
    ? diagramConnections.filter((c) => c.to === selectedNode.id)
    : [];

  // Fit the graph to the visible canvas whenever its size changes (provider/version/edit-mode
  // switches can all change the node count) -- a static initialScale can't adapt to that.
  const diagramViewportRef = useRef<HTMLDivElement>(null);
  const diagramTransformRef = useRef<any>(null);
  const diagramSvgRef = useRef<SVGSVGElement>(null);
  const [imageExportOpen, setImageExportOpen] = useState(false);
  const [imageExportBusy, setImageExportBusy] = useState(false);
  const imageExportRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!imageExportOpen) return;
    const onClickOutside = (e: MouseEvent) => {
      if (imageExportRef.current && !imageExportRef.current.contains(e.target as Node)) {
        setImageExportOpen(false);
      }
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [imageExportOpen]);
  useEffect(() => {
    const viewport = diagramViewportRef.current;
    const transform = diagramTransformRef.current;
    if (!viewport || !transform || diagramLayout.width === 0) return;
    const fitScale = Math.min(
      (viewport.clientWidth - 24) / diagramLayout.width,
      (viewport.clientHeight - 24) / diagramLayout.height,
      1
    );
    transform.centerView(Math.max(fitScale, 0.1), 0);
  }, [diagramLayout.width, diagramLayout.height]);

  const awsTotal = calculateTotalCost("aws");
  const azureTotal = calculateTotalCost("azure");
  const gcpTotal = calculateTotalCost("gcp");
  const k8sTotal = calculateTotalCost("kubernetes");
  const privateTotal = calculateTotalCost("private");

  const totalMinCost = calculateTotalCost(activeProvider).min;
  const totalMaxCost = calculateTotalCost(activeProvider).max;

  const getProviderCostDeltaString = (prov: CloudProviderKey) => {
    // costDelta is only ever computed for aws/azure/gcp (see architectures/route.ts) — cloud
    // spend deltas don't map cleanly onto Kubernetes/private cloud's hardware-amortized costs.
    // Cast for lookup safety; the undefined-guard right below handles k8s/private cleanly.
    const costDelta = (architecture?.reasoning?.diff?.costDelta as Record<string, { min: number; max: number }> | undefined)?.[prov];
    if (!costDelta) return "";
    const minDelta = costDelta.min;
    const maxDelta = costDelta.max;

    if (minDelta === 0 && maxDelta === 0) return " (no change)";
    const signMin = minDelta >= 0 ? "+" : "";
    const signMax = maxDelta >= 0 ? "+" : "";
    return ` (${signMin}$${minDelta} - ${signMax}$${maxDelta}/mo)`;
  };

  const COMPLIANCE_TYPES = ["tokenization", "audit-log", "phi-vault", "deidentification"];
  const isComplianceNode = (type: string) => COMPLIANCE_TYPES.includes(type);


  if (loading) {
    return (
      <div className="flex h-96 flex-col items-center justify-center p-8 text-ink-muted">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-accent border-t-transparent" />
        <span className="mt-4 text-sm font-semibold">Loading system architecture...</span>
      </div>
    );
  }

  if (generating) {
    return (
      <div className="flex h-96 flex-col items-center justify-center p-8 text-ink-muted text-center">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-accent border-t-transparent flex items-center justify-center shadow-md">
          🌀
        </div>
        <span className="mt-4 text-base font-semibold text-ink font-bold">
          {GENERATION_STAGES[generationStageIndex]}
        </span>
        <span className="mt-2 text-xs text-ink-muted max-w-sm">
          Generating cost metrics and resolving senior architect cloud recommendations across AWS, Azure, and GCP.
        </span>
      </div>
    );
  }

  const selectedMapping = selectedNode ? getMappingForProvider(selectedNode, activeProvider) : undefined;

  // Client-side fallback compilation for older architecture versions missing lld
  const getLldData = () => {
    if (!selectedNode) return undefined;
    if (selectedMapping?.lld) {
      return selectedMapping.lld;
    }
    return runLldRulesEngine(activeProvider, selectedNode.type, selectedNode.id, {
      functional: requirements?.functional || [],
      nonFunctional: requirements?.nonFunctional || {
        expectedScale: "not_specified",
        readWritePattern: "not_specified",
        dataNature: "not_specified",
        latencySensitivity: "not_specified",
        budget: "not_specified",
        teamMaturity: "not_specified",
        compliance: "not_specified",
      },
    });
  };

  const lldData = getLldData();

  if (!architecture) {
    return (
      <div className="p-6 sm:p-8 flex flex-col h-full justify-between overflow-y-auto">
        <div>
          <h3 className="text-xl font-bold text-ink">Synthesize System Architecture</h3>
          <p className="text-sm text-ink-muted mt-1">
            Generate an architecture diagram complete with cloud service mappings for AWS, Azure, and GCP.
          </p>

          {error && (
            <div className="mt-4 flex items-center justify-between rounded-2xl border border-danger/25 bg-danger-soft p-4 text-sm text-danger shadow-sm animate-fadeIn">
              <div className="flex items-center gap-2">
                <span>⚠️</span>
                <span>{error}</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleGenerate}
                  className="rounded-lg bg-danger-soft hover:bg-danger/15 text-danger px-2 py-1 text-xs font-bold transition"
                >
                  Retry
                </button>
                <button
                  onClick={() => setError("")}
                  className="text-danger transition hover:opacity-70 font-extrabold text-xs px-2 py-1"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}

          {isGenerationBlocked ? (
            <div className="mt-6 rounded-3xl border border-warning/25 bg-warning-soft/50 p-5">
              <h4 className="font-semibold text-warning flex items-center gap-2">
                <span>⚠️</span> Generation Locked
              </h4>
              <p className="mt-2 text-sm text-warning leading-relaxed">
                We are missing critical parameters required to run the architecture rules engine. Click specify on the fields below to edit them:
              </p>
              <ul className="mt-4 space-y-2 text-xs">
                {isScaleUnspecified && (
                  <li className="flex items-center gap-2">
                    <span className="text-warning font-bold">•</span>
                    <span className="text-warning font-medium mr-1">Expected Traffic / Scale</span>
                    <button
                      onClick={() => onSwitchTab("requirements", "expectedScale")}
                      className="text-accent-ink font-bold hover:underline bg-accent-soft/50 px-2 py-0.5 rounded border border-accent/25"
                    >
                      specify ➜
                    </button>
                  </li>
                )}
                {isBudgetUnspecified && (
                  <li className="flex items-center gap-2">
                    <span className="text-warning font-bold">•</span>
                    <span className="text-warning font-medium mr-1">Budget Range</span>
                    <button
                      onClick={() => onSwitchTab("requirements", "budget")}
                      className="text-accent-ink font-bold hover:underline bg-accent-soft/50 px-2 py-0.5 rounded border border-accent/25"
                    >
                      specify ➜
                    </button>
                  </li>
                )}
                {isDataUnspecified && (
                  <li className="flex items-center gap-2">
                    <span className="text-warning font-bold">•</span>
                    <span className="text-warning font-medium mr-1">Data Types / Nature</span>
                    <button
                      onClick={() => onSwitchTab("requirements", "dataNature")}
                      className="text-accent-ink font-bold hover:underline bg-accent-soft/50 px-2 py-0.5 rounded border border-accent/25"
                    >
                      specify ➜
                    </button>
                  </li>
                )}
              </ul>
            </div>
          ) : (
            <div className="mt-6 rounded-3xl border border-accent/25 bg-accent-soft/50 p-5">
              <h4 className="font-semibold text-accent-ink flex items-center gap-2">
                <span>✓</span> Requirements Complete
              </h4>
              <p className="mt-1 text-sm text-accent-ink leading-relaxed">
                All critical parameters have been specified. You are ready to generate your multi-cloud architecture.
              </p>
            </div>
          )}
        </div>

        <div className="mt-8 border-t border-line pt-6">
          <button
            onClick={handleGenerate}
            disabled={isGenerationBlocked}
            className="flex w-full items-center justify-center rounded-2xl bg-accent px-5 py-4 text-sm font-semibold text-white shadow-md transition-all hover:bg-accent-ink active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Generate Architecture Design ➜
          </button>
        </div>
      </div>
    );
  }

  const fallbackRecommendation = {
    recommendedProvider: "aws" as const,
    rationale: "AWS is recommended due to its mature serverless infrastructure and consistent API response patterns, offering excellent reliability for the estimated traffic profile within budget.",
    keyTradeoffs: [
      "AWS provides the lowest initial barrier for small teams.",
      "GCP offers slightly cheaper PostgreSQL hosting options but fewer native security logs.",
      "Azure has comparable burstable tiers but higher base cost models for queues."
    ]
  };

  const recommendation = architecture.reasoning.recommendation || fallbackRecommendation;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Workspace Header */}
      <div className="border-b border-line bg-white px-6 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h3 className="text-base font-extrabold text-ink">Multi-Cloud Design Board</h3>
          <p className="text-xs text-ink-muted mt-0.5">
            Design dynamic architectures and compare alternatives across cloud platforms.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex bg-paper p-1 rounded-xl border border-line shadow-sm">
            <button
              onClick={() => setViewMode("diagram")}
              className={`px-3 py-1.5 text-xs font-bold rounded-lg transition ${
                viewMode === "diagram" ? "bg-white text-ink shadow-sm" : "text-ink-muted hover:text-ink"
              }`}
            >
              Topology View
            </button>
            <button
              onClick={() => setViewMode("comparison")}
              className={`px-3 py-1.5 text-xs font-bold rounded-lg transition ${
                viewMode === "comparison" ? "bg-white text-ink shadow-sm" : "text-ink-muted hover:text-ink"
              }`}
            >
              Compare Clouds
            </button>
          </div>
          {onToggleFocusMode && (
            <span className="inline-flex items-center gap-1">
              <button
                onClick={onToggleFocusMode}
                className={`flex h-9 w-9 items-center justify-center rounded-xl border shadow-sm transition ${
                  focusMode
                    ? "border-accent bg-accent text-white"
                    : "border-line bg-paper text-ink-muted hover:text-ink"
                }`}
                aria-label={focusMode ? "Exit focus mode" : "Enter focus mode"}
              >
                <Icon icon={focusMode ? "mdi:arrow-collapse" : "mdi:arrow-expand"} width={16} height={16} />
              </button>
              <InfoTooltip text="Focus mode hides the discovery chat panel so this workspace can use the full page width — handy for the wide Compare Clouds table. Toggle it off to bring chat back." />
            </span>
          )}
          <div className="flex items-center gap-1 bg-paper px-3 py-1.5 rounded-xl border border-line shadow-sm">
            <span className="text-[10px] font-extrabold text-ink-muted uppercase tracking-wider">Version:</span>
            <select
              value={architecture.version}
              onChange={(e) => loadArchitecture(e.target.value)}
              disabled={isEditing}
              className={`bg-transparent text-xs font-bold text-ink focus:outline-none cursor-pointer ${isEditing ? "opacity-50 cursor-not-allowed" : ""}`}
            >
              {versionList.map((v) => (
                <option key={v.version} value={v.version}>
                  v{v.version} {v.version === versionList[0]?.version ? "(Latest)" : ""}
                </option>
              ))}
            </select>
            <InfoTooltip text="Every regenerate or manual save creates a new version instead of overwriting — older versions stay here, read-only, so you can always see what the design looked like before a change." />
          </div>

          {/* Manual Editing Toggles */}
          {viewMode === "diagram" && architecture && (
            isEditing ? (
              <div className="flex items-center gap-2">
                <button
                  onClick={handleSaveManualChanges}
                  disabled={savingManualChanges || !validationResults.isValid}
                  className={`rounded-xl px-3 py-1.5 text-xs font-bold uppercase transition shadow-sm flex items-center gap-1 ${
                    validationResults.isValid
                      ? "bg-success hover:opacity-90 text-white active:scale-95"
                      : "bg-line-strong text-ink-muted cursor-not-allowed"
                  }`}
                >
                  <span>{savingManualChanges ? "Saving..." : "💾 Save Changes"}</span>
                </button>
                <button
                  onClick={handleCancelEditMode}
                  className="rounded-xl bg-ink-muted hover:bg-ink text-white px-3 py-1.5 text-xs font-bold uppercase transition shadow-sm active:scale-95"
                >
                  Cancel
                </button>
              </div>
            ) : (
              architecture.version === versionList[0]?.version && (
                <span className="inline-flex items-center gap-1.5">
                  <button
                    onClick={handleEnterEditMode}
                    className="rounded-xl bg-ink hover:bg-ink/90 text-white px-3 py-1.5 text-xs font-bold uppercase transition shadow-sm active:scale-95"
                  >
                    🔧 Edit Architecture
                  </button>
                  <InfoTooltip text="Add or remove components, rewire connections, swap a service, or edit config directly — instead of only regenerating from requirements. Saving creates a new version, same as Regenerate does." />
                </span>
              )
            )
          )}
        </div>
      </div>

      {error && (
        <div className="mx-6 mt-4 flex items-center justify-between rounded-2xl border border-danger/25 bg-danger-soft p-4 text-sm text-danger shadow-sm animate-fadeIn shrink-0">
          <div className="flex items-center gap-2">
            <span>⚠️</span>
            <span>{error}</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleGenerate}
              className="rounded-lg bg-danger-soft hover:bg-danger/15 text-danger px-2 py-1 text-xs font-bold transition"
            >
              Retry
            </button>
            <button
              onClick={() => setError("")}
              className="text-danger transition hover:opacity-70 font-extrabold text-xs px-2 py-1"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Main Panel Content */}
      <div className="flex-1 overflow-hidden">
        {viewMode === "diagram" ? (
          <div className="flex h-full flex-col lg:flex-row overflow-hidden">
            {/* Interactive Diagram Canvas (Left) */}
            <div className="min-w-0 flex-1 p-6 flex flex-col justify-between border-b lg:border-b-0 lg:border-r border-line overflow-y-auto">
              <div>
                <div className="flex flex-wrap items-center justify-between gap-y-2 border-b border-line pb-3">
                  <span className="flex items-center gap-1.5 text-xs text-ink-muted font-semibold uppercase tracking-wider">
                    Interactive Topology
                    <InfoTooltip text="Each box is a piece of your infrastructure (a database, a compute service, etc). Click one to see cost, config, and why it was chosen. Lines show what talks to what." />
                  </span>

                  <div className="flex flex-wrap items-center gap-2">
                    {/* Export Button */}
                    <span className="inline-flex items-center gap-1">
                      <button
                        onClick={handleExport}
                        className="rounded-xl bg-accent hover:bg-accent-ink text-white px-3 py-1.5 text-[9.5px] font-extrabold uppercase transition shadow-sm active:scale-95 flex items-center gap-1"
                      >
                        <span>📥</span> {activeProvider === "kubernetes" ? "Export Manifests" : "Export TF"}
                      </button>
                      <InfoTooltip
                        text={
                          activeProvider === "kubernetes"
                            ? "Downloads ready-to-apply Kubernetes YAML manifests (Deployments, Services, etc.) for this design — the actual deployable config, not a picture of it."
                            : "Downloads ready-to-run Terraform (.tf) files for the selected cloud provider — the actual deployable infrastructure code, not a picture of it. Switch providers above to export a different cloud's config."
                        }
                      />
                    </span>

                    {/* Export Diagram Image -- deliberately a separate control from Export TF
                        above: one downloads the picture, the other downloads deployable code. */}
                    <span ref={imageExportRef} className="relative inline-flex items-center gap-1">
                      <button
                        onClick={() => setImageExportOpen((v) => !v)}
                        disabled={imageExportBusy}
                        className="rounded-xl border border-line-strong bg-panel hover:bg-paper text-ink-muted px-3 py-1.5 text-[9.5px] font-extrabold uppercase transition shadow-sm active:scale-95 flex items-center gap-1 disabled:opacity-50"
                      >
                        <span>🖼️</span> {imageExportBusy ? "Exporting..." : "Export Image"} <span className="text-[8px]">▾</span>
                      </button>
                      {imageExportOpen && (
                        <div className="absolute left-0 top-full z-20 mt-1.5 w-36 rounded-xl border border-line bg-white p-1 shadow-lg animate-fadeIn">
                          <button
                            onClick={() => handleExportDiagramImage("png")}
                            className="block w-full rounded-lg px-2.5 py-1.5 text-left text-[10px] font-bold text-ink-muted hover:bg-paper hover:text-ink"
                          >
                            As PNG (image)
                          </button>
                          <button
                            onClick={() => handleExportDiagramImage("svg")}
                            className="block w-full rounded-lg px-2.5 py-1.5 text-left text-[10px] font-bold text-ink-muted hover:bg-paper hover:text-ink"
                          >
                            As SVG (vector)
                          </button>
                        </div>
                      )}
                      <InfoTooltip text="Downloads the diagram as an image (PNG) or scalable vector (SVG) — for docs, slides, or sharing. This is just the picture; use Export TF for the actual deployable infrastructure code." />
                    </span>

                    {/* Deployment Target Toggle */}
                    <span className="inline-flex items-center gap-1">
                      <div className="flex bg-paper/80 p-0.5 rounded-lg border border-line shadow-sm">
                        {(["aws", "azure", "gcp", "kubernetes", "private"] as const).map((p) => (
                          <button
                            key={p}
                            onClick={() => setActiveProvider(p)}
                            className={`px-2 py-1 text-[9px] font-extrabold uppercase rounded transition ${
                              activeProvider === p
                                ? "bg-ink text-white shadow-sm"
                                : "text-ink-muted hover:text-ink"
                            }`}
                          >
                            {PROVIDER_LABELS[p]}
                          </button>
                        ))}
                      </div>
                      <InfoTooltip text="Same architecture, mapped to different deployment targets. Switching re-maps every component to that provider's equivalent services and recalculates cost — nothing about your requirements changes." />
                    </span>
                    <span className="rounded-full bg-success-soft border border-success/25 text-success px-2.5 py-0.5 text-[9px] font-extrabold flex items-center gap-1">
                      <span>Est: ${totalMinCost} - ${totalMaxCost}/mo</span>
                      {getProviderCostDeltaString(activeProvider) && (
                        <span className={`px-1 rounded font-black ${
                          ((architecture.reasoning.diff?.costDelta as Record<string, { min: number; max: number }> | undefined)?.[activeProvider]?.min || 0) < 0
                            ? "text-success bg-success-soft"
                            : "text-warning bg-warning-soft"
                        }`}>
                          {getProviderCostDeltaString(activeProvider)}
                        </span>
                      )}
                    </span>
                  </div>
                </div>

                {/* Team Maturity / Deployment Target Advisory */}
                {providerMaturityWarning && (
                  <div className="mt-4 flex items-start gap-2.5 rounded-2xl border border-warning/25 bg-warning-soft/60 p-3.5 text-xs text-warning shadow-sm animate-fadeIn">
                    <span className="text-sm">⚠️</span>
                    <div className="leading-relaxed">
                      <span className="font-extrabold uppercase text-[9px] tracking-wider text-warning block">
                        Recommendation
                      </span>
                      {providerMaturityWarning}
                    </div>
                  </div>
                )}


                {/* What Changed Diff Panel */}
                {architecture.reasoning.diff && (
                  <div className="mt-6 rounded-3xl border border-accent/25/80 bg-accent-soft/10 p-5 shadow-sm">
                    <h4 className="font-extrabold text-ink flex items-center gap-2 text-xs uppercase tracking-wider">
                      <span>🔄</span> What Changed in Version {architecture.version}
                    </h4>
                    <p className="text-[11px] text-ink-muted mt-1">
                      Delta modifications generated in response to growth triggers or updates:
                    </p>
                    <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-3 border-t border-line pt-4">
                      {/* Added Components */}
                      {architecture.reasoning.diff.added && architecture.reasoning.diff.added.length > 0 && (
                        <div className="space-y-2">
                          <span className="text-[9px] font-black text-success uppercase tracking-widest block bg-success-soft/60 border border-success/25 px-2 py-0.5 rounded w-max">
                            + Added
                          </span>
                          <ul className="text-xs space-y-2 text-ink-muted">
                            {architecture.reasoning.diff.added.map((item: any, idx: number) => (
                              <li key={idx} className="leading-relaxed">
                                <span className="font-bold text-ink block">{item.name}</span>
                                <span className="text-[10px] text-ink-faint font-semibold uppercase">{item.type}</span>
                                <span className="block text-[11px] text-ink-muted italic mt-0.5">{item.reasoning}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* Modified Components */}
                      {architecture.reasoning.diff.modified && architecture.reasoning.diff.modified.length > 0 && (
                        <div className="space-y-2">
                          <span className="text-[9px] font-black text-warning uppercase tracking-widest block bg-warning-soft/60 border border-warning/25 px-2 py-0.5 rounded w-max">
                            ~ Modified
                          </span>
                          <ul className="text-xs space-y-3 text-ink-muted">
                            {architecture.reasoning.diff.modified.map((item: any, idx: number) => (
                              <li key={idx} className="leading-relaxed">
                                <span className="font-bold text-ink block">{item.name}</span>
                                <div className="mt-1 space-y-1.5 pl-2 border-l-2 border-line">
                                  {item.changes.map((ch: any, cIdx: number) => (
                                    <div key={cIdx} className="text-[11px]">
                                      <span className="font-semibold text-ink-muted block uppercase text-[9px]">{ch.parameter}</span>
                                      <span className="text-ink-faint line-through">{ch.oldVal}</span> ➜{" "}
                                      <span className="text-ink font-bold">{ch.newVal}</span>
                                      <span className="block text-[10px] text-ink-muted italic mt-0.5">{ch.reasoning}</span>
                                    </div>
                                  ))}
                                </div>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* Removed Components */}
                      {architecture.reasoning.diff.removed && architecture.reasoning.diff.removed.length > 0 && (
                        <div className="space-y-2">
                          <span className="text-[9px] font-black text-danger uppercase tracking-widest block bg-danger-soft/60 border border-danger/25 px-2 py-0.5 rounded w-max">
                            − Removed
                          </span>
                          <ul className="text-xs space-y-2 text-ink-muted">
                            {architecture.reasoning.diff.removed.map((item: any, idx: number) => (
                              <li key={idx} className="leading-relaxed">
                                <span className="font-bold text-ink line-through block">{item.name}</span>
                                <span className="text-[10px] text-ink-faint font-semibold uppercase">{item.type}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Topology Diagram — dagre-laid-out SVG canvas with pan/zoom for larger graphs */}
                <div ref={diagramViewportRef} className="relative mt-6 rounded-2xl border border-line bg-paper shadow-inner overflow-hidden" style={{ height: "min(780px, calc(100vh - 260px))" }}>
                  <TransformWrapper ref={diagramTransformRef} initialScale={1} minScale={0.15} maxScale={2.5}>
                    {({ zoomIn, zoomOut }) => (
                      <>
                        <div className="absolute right-3 top-3 z-10 flex gap-1.5">
                          <button
                            onClick={() => zoomIn()}
                            className="flex h-8 w-8 items-center justify-center rounded-lg border border-line-strong bg-panel text-ink-muted shadow-sm hover:text-ink"
                            aria-label="Zoom in"
                          >
                            <Icon icon="mdi:plus" width={16} height={16} />
                          </button>
                          <button
                            onClick={() => zoomOut()}
                            className="flex h-8 w-8 items-center justify-center rounded-lg border border-line-strong bg-panel text-ink-muted shadow-sm hover:text-ink"
                            aria-label="Zoom out"
                          >
                            <Icon icon="mdi:minus" width={16} height={16} />
                          </button>
                          <button
                            onClick={() => {
                              const viewport = diagramViewportRef.current;
                              if (!viewport) return;
                              const fitScale = Math.min(
                                (viewport.clientWidth - 24) / diagramLayout.width,
                                (viewport.clientHeight - 24) / diagramLayout.height,
                                1
                              );
                              diagramTransformRef.current?.centerView(Math.max(fitScale, 0.1), 200);
                            }}
                            className="flex h-8 w-8 items-center justify-center rounded-lg border border-line-strong bg-panel text-ink-muted shadow-sm hover:text-ink"
                            aria-label="Fit to view"
                          >
                            <Icon icon="mdi:fit-to-page-outline" width={15} height={15} />
                          </button>
                          <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-line-strong bg-panel shadow-sm">
                            <InfoTooltip text="Zoom in/out with these buttons or your scroll wheel. Drag anywhere on the canvas to pan around. Fit-to-view re-centers and re-scales everything back into frame." />
                          </span>
                        </div>
                        <TransformComponent wrapperStyle={{ width: "100%", height: "100%" }}>
                          <svg
                            ref={diagramSvgRef}
                            viewBox={`0 0 ${diagramLayout.width} ${diagramLayout.height}`}
                            width={diagramLayout.width}
                            height={diagramLayout.height}
                          >
                            <defs>
                              {/* Arrowhead marking request/response direction -- dagre's points
                                  run from conn.from to conn.to, so an end-marker here always
                                  points the right way without needing per-edge math. */}
                              <marker
                                id="flow-arrow"
                                viewBox="0 0 10 10"
                                refX="8.5"
                                refY="5"
                                markerWidth="7"
                                markerHeight="7"
                                orient="auto-start-reverse"
                              >
                                <path d="M 0 0 L 10 5 L 0 10 z" className="fill-accent" />
                              </marker>
                            </defs>
                            {/* Connections — routed through dagre's own computed waypoints, so
                                skip-rank edges (e.g. into the compliance cluster) don't cut through
                                unrelated nodes. */}
                            {diagramConnections.map((conn, idx) => {
                              const points = diagramLayout.edgePoints[`${conn.from}->${conn.to}`];
                              if (!points || points.length < 2) return null;
                              const d = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
                              return (
                                <g key={idx}>
                                  <path d={d} fill="none" className="stroke-accent/25" strokeWidth={2.5} />
                                  <path
                                    d={d}
                                    fill="none"
                                    className="stroke-accent/70"
                                    strokeWidth={1.5}
                                    strokeDasharray="5, 9"
                                    markerEnd="url(#flow-arrow)"
                                  >
                                    <animate attributeName="stroke-dashoffset" values="56;0" dur="3s" repeatCount="indefinite" />
                                  </path>
                                </g>
                              );
                            })}

                            {/* Compliance cluster — a subtle bounding box around HIPAA/PCI-style
                                compliance components so they read as a group at any graph size. */}
                            {(() => {
                              const complianceBoxes = diagramComponents
                                .filter((c) => isComplianceNode(c.type))
                                .map((c) => nodeCoords[c.id])
                                .filter(Boolean) as { x: number; y: number; width: number; height: number }[];
                              if (complianceBoxes.length < 2) return null;
                              const pad = 26;
                              const minX = Math.min(...complianceBoxes.map((b) => b.x - b.width / 2)) - pad;
                              const minY = Math.min(...complianceBoxes.map((b) => b.y - b.height / 2)) - (pad + 14);
                              const maxX = Math.max(...complianceBoxes.map((b) => b.x + b.width / 2)) + pad;
                              const maxY = Math.max(...complianceBoxes.map((b) => b.y + b.height / 2)) + pad;
                              return (
                                <g>
                                  <rect
                                    x={minX}
                                    y={minY}
                                    width={maxX - minX}
                                    height={maxY - minY}
                                    rx={16}
                                    className="fill-warning-soft/50 stroke-warning"
                                    strokeWidth={1.4}
                                    strokeDasharray="6 5"
                                  />
                                  <text x={minX + 16} y={minY + 22} className="fill-warning text-[11px] font-bold uppercase tracking-wide">
                                    Compliance &amp; Security
                                  </text>
                                </g>
                              );
                            })()}

                            {/* Nodes — real per-service icons, rendered as HTML cards inside
                                foreignObject so text truncates naturally and the icon library
                                just works, rather than hand-rolled SVG text/rects. */}
                            {diagramComponents.map((node) => {
                              const coord = nodeCoords[node.id];
                              if (!coord) return null;

                              const isSelected = selectedNodeId === node.id;
                              const mapping = getMappingForProvider(node, activeProvider);
                              const serviceName = mapping?.serviceName || node.name;
                              const isOverride = node.metadata?.overrideSource === "user";

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
                                    className={`group relative flex h-full w-full cursor-pointer items-center gap-2.5 rounded-2xl border bg-panel px-3 py-2 shadow-sm transition-all ${
                                      isSelected
                                        ? "border-accent ring-2 ring-accent-soft"
                                        : isComplianceNode(node.type)
                                          ? "border-warning/50 hover:border-warning"
                                          : "border-line-strong hover:border-ink-faint"
                                    } ${isOverride ? "border-dashed" : ""}`}
                                  >
                                    <div className={`flex h-9 w-9 flex-none items-center justify-center rounded-lg ${PROVIDER_SOFT_BG[activeProvider]}`}>
                                      <Icon icon={resolveServiceIcon(serviceName, node.type)} width={20} height={20} />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                      <div className="truncate text-[9.5px] font-bold uppercase tracking-wide text-ink-faint">
                                        {node.name}
                                      </div>
                                      <div className="truncate text-[12.5px] font-bold text-ink">{serviceName}</div>
                                    </div>

                                    {isComplianceNode(node.type) && (
                                      <Icon icon="mdi:shield-check-outline" width={15} height={15} className="flex-none text-warning" />
                                    )}
                                    {isOverride && (
                                      <span className="absolute -right-1.5 -top-1.5 flex h-4 w-4 flex-none items-center justify-center rounded-full bg-warning text-[8px] font-black text-white ring-2 ring-panel">
                                        U
                                      </span>
                                    )}

                                    {isEditing && (
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleRemoveNode(node.id);
                                        }}
                                        className="absolute -left-1.5 -top-1.5 flex h-5 w-5 flex-none items-center justify-center rounded-full bg-danger text-white ring-2 ring-panel transition hover:scale-110"
                                        aria-label={`Remove ${node.name}`}
                                      >
                                        <Icon icon="mdi:close" width={12} height={12} />
                                      </button>
                                    )}
                                  </div>
                                </foreignObject>
                              );
                            })}
                          </svg>
                        </TransformComponent>
                      </>
                    )}
                  </TransformWrapper>
                </div>

                {/* Manual Editing Controls Toolbar */}
                {isEditing && draftHld && (
                  <div className="mt-4 border border-line bg-paper/50 rounded-[1.5rem] p-4 space-y-4 animate-fadeIn">
                    {/* Panel Title */}
                    <div className="flex items-center justify-between border-b border-line pb-2">
                      <span className="text-[10px] font-black text-ink-muted uppercase tracking-widest">
                        🔧 Manual Editor Controls
                      </span>
                      <span className="text-[9px] font-bold text-ink-faint bg-paper px-1.5 py-0.5 rounded">
                        Draft Mode
                      </span>
                    </div>

                    <div className="grid gap-4 md:grid-cols-2">
                      {/* Form 1: Add Component */}
                      <form onSubmit={handleAddComponent} className="space-y-3">
                        <div className="text-[10px] font-bold text-ink-muted">➕ Add Generic Component</div>
                        <div className="flex flex-col gap-2">
                          <div className="flex gap-2">
                            <select
                              value={newNodeType}
                              onChange={(e) => setNewNodeType(e.target.value)}
                              className="bg-white border border-line rounded-xl px-2.5 py-1.5 text-xs font-semibold focus:outline-none focus:ring-1 focus:ring-accent animate-fadeIn"
                            >
                              <option value="compute">Compute</option>
                              <option value="db">Database</option>
                              <option value="cache">Cache</option>
                              <option value="queue">Queue</option>
                              <option value="cdn">CDN</option>
                              <option value="storage">Object Storage</option>
                              <option value="auth">Auth</option>
                              <option value="lb">Load Balancer</option>
                              <option value="tokenization">Tokenization Layer</option>
                              <option value="audit-log">Audit Log Store</option>
                              <option value="phi-vault">PHI Data Vault</option>
                              <option value="deidentification">De-identification Pipeline</option>
                            </select>
                            <input
                              type="text"
                              value={newNodeName}
                              onChange={(e) => setNewNodeName(e.target.value)}
                              placeholder="Component Name (e.g. MemoryDB)"
                              className="flex-1 bg-white border border-line rounded-xl px-3 py-1.5 text-xs font-semibold focus:outline-none focus:ring-1 focus:ring-accent"
                            />
                          </div>
                          <input
                            type="text"
                            value={newNodeReasoning}
                            onChange={(e) => setNewNodeReasoning(e.target.value)}
                            placeholder="Optional: Rationale / Reason for adding..."
                            className="bg-white border border-line rounded-xl px-3 py-1.5 text-xs font-medium focus:outline-none focus:ring-1 focus:ring-accent"
                          />
                          <button
                            type="submit"
                            className="w-full bg-accent hover:bg-accent-ink text-white rounded-xl py-1.5 text-[10px] font-extrabold uppercase tracking-wide transition shadow-sm"
                          >
                            Add Component Node
                          </button>
                        </div>
                      </form>

                      {/* Form 2: Add Connection */}
                      <form onSubmit={handleAddConnection} className="space-y-3">
                        <div className="text-[10px] font-bold text-ink-muted">🔗 Add Connection Link</div>
                        <div className="flex flex-col gap-2">
                          <div className="flex gap-2">
                            <select
                              value={newEdgeFrom}
                              onChange={(e) => setNewEdgeFrom(e.target.value)}
                              className="flex-1 bg-white border border-line rounded-xl px-2.5 py-1.5 text-xs font-semibold focus:outline-none focus:ring-1 focus:ring-accent"
                            >
                              <option value="">Select From...</option>
                              {draftHld.components.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.name} ({c.type})
                                </option>
                              ))}
                            </select>
                            <select
                              value={newEdgeTo}
                              onChange={(e) => setNewEdgeTo(e.target.value)}
                              className="flex-1 bg-white border border-line rounded-xl px-2.5 py-1.5 text-xs font-semibold focus:outline-none focus:ring-1 focus:ring-accent"
                            >
                              <option value="">Select To...</option>
                              {draftHld.components.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.name} ({c.type})
                                </option>
                              ))}
                            </select>
                          </div>
                          <div className="flex gap-2">
                            <input
                              type="text"
                              value={newEdgeProtocol}
                              onChange={(e) => setNewEdgeProtocol(e.target.value)}
                              placeholder="Protocol (e.g. HTTPS, TCP)"
                              className="flex-1 bg-white border border-line rounded-xl px-3 py-1.5 text-xs font-semibold focus:outline-none focus:ring-1 focus:ring-accent"
                            />
                            <button
                              type="submit"
                              className="bg-ink hover:bg-ink/90 text-white rounded-xl px-4 py-1.5 text-[10px] font-extrabold uppercase tracking-wide transition shadow-sm"
                            >
                              Connect
                            </button>
                          </div>
                        </div>
                      </form>
                    </div>

                    {/* Active Connections List (for simple deletion) */}
                    <div className="border-t border-line pt-3">
                      <span className="text-[9px] font-black text-ink-faint uppercase tracking-widest block mb-2">
                        Active Connection Links
                      </span>
                      <div className="flex flex-wrap gap-2 max-h-[100px] overflow-y-auto pr-1">
                        {draftHld.connections.length === 0 ? (
                          <span className="text-[10px] text-ink-faint italic">No active connections.</span>
                        ) : (
                          draftHld.connections.map((conn, idx) => {
                            const fromNode = draftHld.components.find((c) => c.id === conn.from);
                            const toNode = draftHld.components.find((c) => c.id === conn.to);
                            return (
                              <div
                                key={idx}
                                className="flex items-center gap-1.5 bg-white border border-line rounded-xl px-2.5 py-1 text-[10px] font-bold text-ink-muted shadow-sm"
                              >
                                <span>{fromNode?.name || conn.from}</span>
                                <span className="text-ink-faint font-normal">➜</span>
                                <span>{toNode?.name || conn.to}</span>
                                <span className="text-ink-faint">({conn.protocol})</span>
                                <button
                                  type="button"
                                  onClick={() => handleRemoveConnection(conn.from, conn.to)}
                                  className="text-danger transition hover:opacity-70 font-black ml-1 scale-110"
                                >
                                  ×
                                </button>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {/* Validation Results Alerts Panel */}
                {isEditing && draftHld && (
                  <div className="mt-4 space-y-2">
                    {/* Hard Errors list (Blocking Save) */}
                    {validationResults.errors.map((err, idx) => (
                      <div
                        key={idx}
                        className="flex items-start gap-2.5 rounded-2xl border border-danger/25 bg-danger-soft p-3 text-xs text-danger shadow-sm animate-fadeIn"
                      >
                        <span className="text-sm">❌</span>
                        <div className="leading-relaxed">
                          <span className="font-extrabold uppercase text-[9px] tracking-wider text-danger block">
                            Blocker
                          </span>
                          {err}
                        </div>
                      </div>
                    ))}

                    {/* Soft Warnings list */}
                    {validationResults.warnings.map((warn, idx) => (
                      <div
                        key={idx}
                        className="flex items-start gap-2.5 rounded-2xl border border-warning/25 bg-warning-soft/50 p-3 text-xs text-warning shadow-sm animate-fadeIn"
                      >
                        <span className="text-sm">⚠️</span>
                        <div className="leading-relaxed">
                          <span className="font-extrabold uppercase text-[9px] tracking-wider text-warning block">
                            Warning
                          </span>
                          {warn}
                        </div>
                      </div>
                    ))}

                    {validationResults.isValid &&
                      validationResults.errors.length === 0 &&
                      validationResults.warnings.length === 0 && (
                        <div className="flex items-center gap-2 rounded-2xl border border-success/25 bg-success-soft/50 px-3 py-2.5 text-xs text-success shadow-sm">
                          <span className="text-sm">✅</span>
                          <span className="font-semibold">All structural validation checks passed. Ready to save!</span>
                        </div>
                      )}
                  </div>
                )}
              </div>

              <div className="mt-6 border-t border-line pt-4 flex items-center justify-between">
                <span className="text-xs text-ink-muted font-medium">
                  Active Provider view: <strong className="uppercase">{activeProvider}</strong>
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <InfoTooltip text="Creates a new version (e.g. v0.1.0 → v0.1.1) from your current requirements — it does not overwrite this one. Past versions stay browsable from the Version dropdown above, with a full What-Changed diff." />
                  <button
                    onClick={handleGenerate}
                    disabled={isGenerationBlocked}
                    className="rounded-xl bg-ink hover:bg-ink/90 text-white px-4 py-2 text-xs font-bold transition shadow-sm active:scale-95 disabled:opacity-50"
                  >
                    Regenerate Design
                  </button>
                </span>
              </div>
            </div>

            {/* Topology Drawer (Right) */}
            <div className="w-full lg:w-[360px] bg-paper/50 p-6 overflow-y-auto flex flex-col justify-between border-t lg:border-t-0 border-line">
              {selectedNode ? (
                <div className="space-y-6">
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="rounded-full bg-accent-soft border border-accent/30 px-2 py-0.5 text-[9px] font-bold text-accent-ink uppercase tracking-wider">
                          {explanationMode === "simple" ? TYPE_LABELS[selectedNode.type] || selectedNode.type : selectedNode.type}
                        </span>
                        <span className="rounded-full bg-line border border-line-strong px-2 py-0.5 text-[9px] font-bold text-ink-muted uppercase tracking-wider">
                          {activeProvider} Mapped
                        </span>
                      </div>
                      <div className="flex flex-none rounded-lg border border-line-strong bg-panel p-0.5 text-[9px] font-bold uppercase tracking-wide">
                        <button
                          onClick={() => setExplanationMode("simple")}
                          className={`rounded-md px-2 py-1 transition ${explanationMode === "simple" ? "bg-accent text-white" : "text-ink-muted hover:text-ink"}`}
                        >
                          Simple
                        </button>
                        <button
                          onClick={() => setExplanationMode("technical")}
                          className={`rounded-md px-2 py-1 transition ${explanationMode === "technical" ? "bg-accent text-white" : "text-ink-muted hover:text-ink"}`}
                        >
                          Technical
                        </button>
                      </div>
                    </div>
                    <h4 className="text-base font-bold text-ink mt-2">
                      {selectedMapping?.serviceName || selectedNode.name}
                    </h4>
                    <p className="text-[10px] text-ink-faint font-semibold uppercase mt-0.5 tracking-wider">
                      Generic Component: {selectedNode.name}
                    </p>

                    <div className="mt-3 rounded-2xl border border-accent/25 bg-accent-soft p-3.5 text-xs text-ink leading-relaxed">
                      {getPlainDescription(selectedNode.type, selectedNode.id)}
                    </div>

                    {explanationMode === "technical" && (
                      <p className="text-xs text-ink-muted mt-2 leading-relaxed">{selectedNode.description}</p>
                    )}

                    {/* Plain-language data flow -- lets you trace a request without reading the
                        diagram's arrows directly. Shown in both modes since "what talks to what"
                        is useful regardless of technical depth. */}
                    {(incomingConnections.length > 0 || outgoingConnections.length > 0) && (
                      <div className="mt-3 space-y-2 text-xs">
                        {incomingConnections.length > 0 && (
                          <div className="flex items-start gap-1.5">
                            <span className="mt-0.5 flex-none text-ink-faint">⬅</span>
                            <span className="text-ink-muted">
                              <span className="font-semibold text-ink">Receives from:</span>{" "}
                              {incomingConnections.map((c, i) => (
                                <span key={i}>
                                  {i > 0 && ", "}
                                  {nodeNameById(c.from)}
                                  {c.protocol ? ` (${c.protocol})` : ""}
                                </span>
                              ))}
                            </span>
                          </div>
                        )}
                        {outgoingConnections.length > 0 && (
                          <div className="flex items-start gap-1.5">
                            <span className="mt-0.5 flex-none text-ink-faint">➡</span>
                            <span className="text-ink-muted">
                              <span className="font-semibold text-ink">Sends to:</span>{" "}
                              {outgoingConnections.map((c, i) => (
                                <span key={i}>
                                  {i > 0 && ", "}
                                  {nodeNameById(c.to)}
                                  {c.protocol ? ` (${c.protocol})` : ""}
                                </span>
                              ))}
                            </span>
                          </div>
                        )}
                      </div>
                    )}

                    {isEditing && (
                      <div className="space-y-1.5 bg-white border border-line rounded-2xl p-3 mt-3 shadow-sm">
                        <label className="text-[9px] font-black text-ink-muted uppercase tracking-widest block">
                          Component Override Rationale
                        </label>
                        <textarea
                          value={selectedNode.reasoning || ""}
                          placeholder="Why are manual overrides or adjustments needed?"
                          rows={3}
                          onChange={(e) => handleUpdateComponentReasoning(selectedNode.id, e.target.value)}
                          className="w-full text-xs text-ink bg-paper border border-line rounded-xl p-2 focus:outline-none focus:ring-1 focus:ring-accent leading-relaxed shadow-inner"
                        />
                      </div>
                    )}
                  </div>

                  {selectedMapping?.costEstimate && (
                    <div>
                      <h5 className="flex items-center gap-1.5 text-xs font-bold text-ink-muted uppercase tracking-wider">
                        Estimated Cost
                        <InfoTooltip text="Monthly range for just this one component, on the currently-selected provider. It's a band, not a quote — actual billing depends on real usage; see the assumptions line for what the estimate is based on." />
                      </h5>
                      <div className="mt-2 rounded-2xl border border-success/25 bg-success-soft/40 p-3.5">
                        <div className="text-sm font-extrabold text-success">
                          ${selectedMapping.costEstimate.min} - ${selectedMapping.costEstimate.max}/mo
                        </div>
                        <div className="text-[11px] text-success font-medium leading-normal mt-1 italic">
                          Assumptions: {selectedMapping.costEstimate.assumptions}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Expandable LLD Configs section -- stays available while editing regardless
                      of explanation mode, since swapping/tuning config is an editing action. */}
                  {lldData && (explanationMode === "technical" || isEditing) && (
                    <div className="border-t border-line/80 pt-4">
                      <div className="flex w-full items-center justify-between py-2">
                        <button
                          onClick={() => setIsLldExpanded(!isLldExpanded)}
                          className="flex flex-1 items-center gap-1.5 text-xs font-bold text-ink-muted uppercase tracking-wider hover:text-ink transition"
                        >
                          <span>⚙️ Technical Details (LLD)</span>
                          <span>{isLldExpanded ? "▲" : "▼"}</span>
                        </button>
                        <InfoTooltip text="Low-Level Design: the actual config values (instance size, replica count, retention, etc.) behind this component's cloud service — the level of detail an engineer would need to actually provision it, with a reason for each value." />
                      </div>

                      {isLldExpanded && (
                        <div className="mt-3 space-y-4 max-h-[300px] overflow-y-auto pr-1">
                          {Object.keys(lldData.config).map((key) => {
                            const val = lldData.config[key];
                            const note = lldData.reasoning?.[key];
                            return (
                              <div
                                key={key}
                                className="rounded-2xl border border-line bg-white p-3 space-y-2.5 shadow-sm"
                              >
                                <div className="flex justify-between items-center gap-2">
                                  <span className="font-mono text-[10px] font-bold text-ink-muted bg-paper px-1.5 py-0.5 rounded">
                                    {key}
                                  </span>
                                  {isEditing ? (
                                    <input
                                      type="text"
                                      value={val}
                                      onChange={(e) =>
                                        handleUpdateLldConfig(selectedNode.id, activeProvider, key, e.target.value)
                                      }
                                      className="font-mono text-[10px] font-bold text-ink bg-paper border border-line px-1.5 py-0.5 rounded text-right focus:outline-none focus:ring-1 focus:ring-accent w-32"
                                    />
                                  ) : (
                                    <span className="font-mono text-[10px] font-bold text-ink bg-paper px-1.5 py-0.5 rounded text-right">
                                      {val}
                                    </span>
                                  )}
                                </div>
                                {isEditing ? (
                                  <textarea
                                    value={note || ""}
                                    placeholder="Enter explanation for this config override..."
                                    rows={2}
                                    onChange={(e) =>
                                      handleUpdateLldReasoning(selectedNode.id, activeProvider, key, e.target.value)
                                    }
                                    className="w-full text-[10px] text-ink-muted bg-paper border border-line rounded-lg p-1.5 focus:outline-none focus:ring-1 focus:ring-accent leading-normal"
                                  />
                                ) : (
                                  note && (
                                    <p className="text-[10px] text-ink-muted font-medium leading-relaxed italic">
                                      {note}
                                    </p>
                                  )
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}

                  {selectedMapping?.alternatives && selectedMapping.alternatives.length > 0 && (explanationMode === "technical" || isEditing) && (
                    <div>
                      <h5 className="flex items-center gap-1.5 text-xs font-bold text-ink-muted uppercase tracking-wider">
                        Alternatives Considered
                        <InfoTooltip text="Other real services that could fill this same role, and why the rule engine picked the current one over them. While editing, you can switch to one of these instead." />
                      </h5>

                      {isEditing && (
                        <input
                          type="text"
                          value={swapReason}
                          onChange={(e) => setSwapReason(e.target.value)}
                          placeholder="Optional: reason for switching service..."
                          className="mt-2 w-full bg-white border border-line rounded-xl px-3 py-1.5 text-xs font-medium focus:outline-none focus:ring-1 focus:ring-accent"
                        />
                      )}

                      <div className="mt-2 space-y-2">
                        {selectedMapping.alternatives.map((alt, idx) => (
                          <div
                            key={idx}
                            className="rounded-2xl border border-line bg-white p-3.5 text-xs text-ink leading-normal"
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="font-bold text-ink">Alternative: {alt.serviceName}</div>
                              {isEditing && (
                                <button
                                  type="button"
                                  disabled={!alt.costEstimate}
                                  onClick={() => handleSwapService(selectedNode.id, activeProvider, idx)}
                                  title={!alt.costEstimate ? "Cost data unavailable for this alternative on this architecture version." : undefined}
                                  className="shrink-0 rounded-lg bg-accent hover:bg-accent-ink text-white px-2 py-1 text-[9px] font-extrabold uppercase tracking-wide transition shadow-sm disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                  Switch to this
                                </button>
                              )}
                            </div>
                            <div className="text-ink-muted mt-1 font-medium leading-relaxed">{alt.reason}</div>
                            {alt.costEstimate && (
                              <div className="text-[11px] text-success font-bold mt-1.5">
                                ${alt.costEstimate.min} - ${alt.costEstimate.max}/mo
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {explanationMode === "technical" && (
                    <div>
                      <h5 className="text-xs font-bold text-ink-muted uppercase tracking-wider">Architect Rationale</h5>
                      <div className="mt-2 rounded-2xl border border-accent/25 bg-accent-soft/30 p-3.5 text-xs text-accent-ink font-medium leading-relaxed">
                        {selectedNode.reasoning}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex-1 overflow-y-auto">
                  <div className="text-center text-ink-faint">
                    <span className="text-3xl">👈</span>
                    <h4 className="font-semibold text-sm mt-3 text-ink-muted">Select a Component</h4>
                    <p className="text-xs text-ink-muted max-w-[260px] mx-auto mt-1">
                      Click any box in the diagram to see its cost, config, and reasoning. Meanwhile, here&apos;s
                      what each piece in this design actually does:
                    </p>
                  </div>

                  {/* Glossary of the types actually present in this diagram -- a legend instead
                      of a bare empty box, and scoped to this design rather than every possible
                      component type in the system. */}
                  <div className="mt-5 space-y-2">
                    {Array.from(new Set(diagramComponents.map((c) => c.type))).map((type) => (
                      <div
                        key={type}
                        className="flex items-start gap-2.5 rounded-xl border border-line bg-white p-2.5 text-left"
                      >
                        <div className="flex h-7 w-7 flex-none items-center justify-center rounded-lg bg-paper">
                          <Icon icon={resolveServiceIcon(undefined, type)} width={15} height={15} />
                        </div>
                        <div className="min-w-0">
                          <div className="text-[10px] font-bold uppercase tracking-wide text-ink">
                            {TYPE_LABELS[type] || type}
                          </div>
                          <p className="text-[10.5px] text-ink-muted leading-snug mt-0.5">
                            {getPlainDescription(type, "")}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : (
          /* Compare Clouds View Mode (Table/Grid) */
          <div className="h-full overflow-y-auto p-6 space-y-6">
            {/* Recommended Cloud Choice Banner */}
            <div className="rounded-3xl border border-accent/25 bg-gradient-to-r from-accent-soft/60 to-success-soft/40 p-6 shadow-sm">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="rounded-full bg-accent px-3 py-1 text-xs font-extrabold text-white uppercase tracking-wider">
                      ★ Recommended Provider
                    </span>
                    <span className="rounded-full bg-ink px-3 py-1 text-xs font-extrabold text-white uppercase tracking-wider">
                      {recommendation.recommendedProvider}
                    </span>
                    <InfoTooltip text="Not just 'cheapest' — the architect weighs cost, your team's experience level, compliance needs, and long-term flexibility together. Read the rationale below for the specific reasons for this project." />
                  </div>
                  <h4 className="text-lg font-black text-ink mt-3">Architect&apos;s Overall Selection Rationale</h4>
                  <p className="text-sm text-ink-muted leading-relaxed mt-2 max-w-4xl">
                    {recommendation.rationale}
                  </p>
                </div>
              </div>

              {recommendation.keyTradeoffs && recommendation.keyTradeoffs.length > 0 && (
                <div className="mt-5 border-t border-line/60 pt-4">
                  <h5 className="text-xs font-bold text-ink-muted uppercase tracking-wider">Key Trade-offs Considered</h5>
                  <ul className="mt-2.5 space-y-2 text-xs text-ink-muted font-medium">
                    {recommendation.keyTradeoffs.map((t, idx) => (
                      <li key={idx} className="flex gap-2.5">
                        <span className="text-accent font-extrabold">▪</span>
                        <span>{t}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {/* Side-by-Side Comparison Table -- first column stays pinned while the provider
                columns scroll horizontally, so K8s/Private never silently disappear off-screen. */}
            <div className="rounded-[2rem] border border-line bg-white shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse table-fixed min-w-[1300px]">
                  <thead>
                    <tr className="bg-paper border-b border-line">
                      <th className="sticky left-0 z-10 bg-paper p-4 text-xs font-bold text-ink-muted uppercase tracking-wider w-[180px] border-r border-line">
                        Generic Component
                      </th>
                      <th className={`p-4 text-xs font-bold text-ink-muted uppercase tracking-wider ${recommendation.recommendedProvider === "aws" ? "bg-accent-soft/50" : ""}`}>
                        <span className="flex items-center gap-1.5">
                          <Icon icon="logos:aws" width={16} height={16} /> Amazon Web Services
                          {recommendation.recommendedProvider === "aws" && <span title="Recommended">★</span>}
                        </span>
                      </th>
                      <th className={`p-4 text-xs font-bold text-ink-muted uppercase tracking-wider ${recommendation.recommendedProvider === "azure" ? "bg-accent-soft/50" : ""}`}>
                        <span className="flex items-center gap-1.5">
                          <Icon icon="logos:microsoft-azure" width={16} height={16} /> Microsoft Azure
                          {recommendation.recommendedProvider === "azure" && <span title="Recommended">★</span>}
                        </span>
                      </th>
                      <th className={`p-4 text-xs font-bold text-ink-muted uppercase tracking-wider ${recommendation.recommendedProvider === "gcp" ? "bg-accent-soft/50" : ""}`}>
                        <span className="flex items-center gap-1.5">
                          <Icon icon="logos:google-cloud" width={16} height={16} /> Google Cloud
                          {recommendation.recommendedProvider === "gcp" && <span title="Recommended">★</span>}
                        </span>
                      </th>
                      <th className="p-4 text-xs font-bold text-ink-muted uppercase tracking-wider">
                        <span className="flex items-center gap-1.5"><Icon icon="mdi:kubernetes" width={16} height={16} className="text-k8s" /> Kubernetes</span>
                      </th>
                      <th className="p-4 text-xs font-bold text-ink-muted uppercase tracking-wider">
                        <span className="flex items-center gap-1.5"><Icon icon="mdi:server" width={16} height={16} className="text-private" /> Private Cloud</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line text-xs font-medium text-ink-muted">
                    {architecture.hld.components.map((c) => {
                      const awsM = getMappingForProvider(c, "aws");
                      const azureM = getMappingForProvider(c, "azure");
                      const gcpM = getMappingForProvider(c, "gcp");
                      const k8sM = getMappingForProvider(c, "kubernetes");
                      const privateM = getMappingForProvider(c, "private");

                      return (
                        <tr key={c.id} className="hover:bg-paper/40">
                          {/* Component name */}
                          <td className="sticky left-0 z-10 bg-white p-4 align-top border-r border-line">
                            <span className="flex items-center gap-1.5 font-extrabold text-ink">
                              {c.name}
                              {c.reasoning && <InfoTooltip text={c.reasoning} />}
                            </span>
                            <span className="text-[10px] text-ink-faint font-semibold block mt-0.5 uppercase tracking-wide">
                              {c.type}
                            </span>
                          </td>

                          {/* AWS Column */}
                          <td className={`p-4 align-top space-y-1 ${recommendation.recommendedProvider === "aws" ? "bg-accent-soft/20" : ""}`}>
                            <div className="font-extrabold text-ink">{awsM?.serviceName || "—"}</div>
                            {awsM?.costEstimate && (
                              <div className="text-[11px] text-success font-bold">
                                ${awsM.costEstimate.min} - ${awsM.costEstimate.max}/mo
                              </div>
                            )}
                            {awsM?.costEstimate?.assumptions && (
                              <div className="text-[10px] text-ink-faint leading-normal font-medium">
                                {awsM.costEstimate.assumptions}
                              </div>
                            )}
                          </td>

                          {/* Azure Column */}
                          <td className={`p-4 align-top space-y-1 ${recommendation.recommendedProvider === "azure" ? "bg-accent-soft/20" : ""}`}>
                            <div className="font-extrabold text-ink">{azureM?.serviceName || "—"}</div>
                            {azureM?.costEstimate && (
                              <div className="text-[11px] text-success font-bold">
                                ${azureM.costEstimate.min} - ${azureM.costEstimate.max}/mo
                              </div>
                            )}
                            {azureM?.costEstimate?.assumptions && (
                              <div className="text-[10px] text-ink-faint leading-normal font-medium">
                                {azureM.costEstimate.assumptions}
                              </div>
                            )}
                          </td>

                          {/* GCP Column */}
                          <td className={`p-4 align-top space-y-1 ${recommendation.recommendedProvider === "gcp" ? "bg-accent-soft/20" : ""}`}>
                            <div className="font-extrabold text-ink">{gcpM?.serviceName || "—"}</div>
                            {gcpM?.costEstimate && (
                              <div className="text-[11px] text-success font-bold">
                                ${gcpM.costEstimate.min} - ${gcpM.costEstimate.max}/mo
                              </div>
                            )}
                            {gcpM?.costEstimate?.assumptions && (
                              <div className="text-[10px] text-ink-faint leading-normal font-medium">
                                {gcpM.costEstimate.assumptions}
                              </div>
                            )}
                          </td>

                          {/* Kubernetes Column */}
                          <td className="p-4 align-top space-y-1">
                            <div className="font-extrabold text-ink">{k8sM?.serviceName || "—"}</div>
                            {k8sM?.costEstimate && (
                              <div className="text-[11px] text-success font-bold">
                                ${k8sM.costEstimate.min} - ${k8sM.costEstimate.max}/mo
                              </div>
                            )}
                            {k8sM?.costEstimate?.assumptions && (
                              <div className="text-[10px] text-ink-faint leading-normal font-medium">
                                {k8sM.costEstimate.assumptions}
                              </div>
                            )}
                          </td>

                          {/* Private Cloud Column */}
                          <td className="p-4 align-top space-y-1">
                            <div className="font-extrabold text-ink">{privateM?.serviceName || "—"}</div>
                            {privateM?.costEstimate && (
                              <div className="text-[11px] text-success font-bold">
                                ${privateM.costEstimate.min} - ${privateM.costEstimate.max}/mo
                              </div>
                            )}
                            {privateM?.costEstimate?.assumptions && (
                              <div className="text-[10px] text-ink-faint leading-normal font-medium">
                                {privateM.costEstimate.assumptions}
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}

                    {/* Totals Row */}
                    <tr className="bg-paper/80 font-black border-t-2 border-line">
                      <td className="sticky left-0 z-10 bg-paper p-4 text-xs text-ink border-r border-line">Total Estimated Cost</td>
                      <td className={`p-4 text-xs text-success font-extrabold ${recommendation.recommendedProvider === "aws" ? "bg-accent-soft/20" : ""}`}>
                        <div>${awsTotal.min} - ${awsTotal.max}/mo</div>
                        {getProviderCostDeltaString("aws") && (
                          <div className={`text-[10px] font-bold ${(architecture.reasoning.diff?.costDelta?.aws?.min || 0) < 0 ? "text-success" : "text-warning"}`}>
                            {getProviderCostDeltaString("aws")}
                          </div>
                        )}
                      </td>
                      <td className={`p-4 text-xs text-success font-extrabold ${recommendation.recommendedProvider === "azure" ? "bg-accent-soft/20" : ""}`}>
                        <div>${azureTotal.min} - ${azureTotal.max}/mo</div>
                        {getProviderCostDeltaString("azure") && (
                          <div className={`text-[10px] font-bold ${(architecture.reasoning.diff?.costDelta?.azure?.min || 0) < 0 ? "text-success" : "text-warning"}`}>
                            {getProviderCostDeltaString("azure")}
                          </div>
                        )}
                      </td>
                      <td className={`p-4 text-xs text-success font-extrabold ${recommendation.recommendedProvider === "gcp" ? "bg-accent-soft/20" : ""}`}>
                        <div>${gcpTotal.min} - ${gcpTotal.max}/mo</div>
                        {getProviderCostDeltaString("gcp") && (
                          <div className={`text-[10px] font-bold ${(architecture.reasoning.diff?.costDelta?.gcp?.min || 0) < 0 ? "text-success" : "text-warning"}`}>
                            {getProviderCostDeltaString("gcp")}
                          </div>
                        )}
                      </td>
                      <td className="p-4 text-xs text-success font-extrabold">
                        <div>${k8sTotal.min} - ${k8sTotal.max}/mo</div>
                      </td>
                      <td className="p-4 text-xs text-success font-extrabold">
                        <div>${privateTotal.min} - ${privateTotal.max}/mo</div>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div className="flex items-center gap-1.5 border-t border-line bg-paper px-4 py-2 text-[10px] font-semibold text-ink-faint">
                <Icon icon="mdi:gesture-swipe-horizontal" width={13} height={13} />
                Scroll horizontally to compare all 5 providers, including Kubernetes and Private Cloud
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
