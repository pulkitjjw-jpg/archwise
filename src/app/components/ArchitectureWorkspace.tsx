"use client";

import { useEffect, useState } from "react";
import { runLldRulesEngine } from "@/lib/lld-rules";
import { validateArchitectureLayout, getProviderMaturityWarning } from "@/lib/validation";

type CloudProviderKey = "aws" | "azure" | "gcp" | "kubernetes" | "private";

const PROVIDER_LABELS: Record<CloudProviderKey, string> = {
  aws: "AWS",
  azure: "Azure",
  gcp: "GCP",
  kubernetes: "K8s",
  private: "Private",
};

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
}

export default function ArchitectureWorkspace({
  projectId,
  requirements,
  onRequirementsChange,
  onSwitchTab,
}: ArchitectureWorkspaceProps) {
  const [architecture, setArchitecture] = useState<ArchitectureData | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [generationStageIndex, setGenerationStageIndex] = useState(0);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [activeProvider, setActiveProvider] = useState<CloudProviderKey>("aws");
  const [viewMode, setViewMode] = useState<"diagram" | "comparison">("diagram");
  const [isLldExpanded, setIsLldExpanded] = useState(false);
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

  // Reset LLD accordion state when selected node changes
  useEffect(() => {
    setIsLldExpanded(false);
  }, [selectedNodeId]);

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
  const getLayout = (components: ComponentData[]) => {
    const columns: Record<string, string[]> = {
      entry: [], // CDN, Auth
      api: [], // Compute
      buffers: [], // Cache, Queue
      backend: [], // Database, Storage, Worker
    };

    components.forEach((c) => {
      if (c.type === "cdn" || c.type === "auth") {
        columns.entry.push(c.id);
      } else if (c.type === "compute" && c.id !== "worker") {
        columns.api.push(c.id);
      } else if (c.type === "queue" || c.type === "cache") {
        columns.buffers.push(c.id);
      } else {
        columns.backend.push(c.id);
      }
    });

    const xCoords: Record<string, number> = {
      entry: 85,
      api: 250,
      buffers: 415,
      backend: 580,
    };

    const nodeCoords: Record<string, { x: number; y: number }> = {};
    const height = 400;

    Object.keys(columns).forEach((col) => {
      const ids = columns[col];
      const colX = xCoords[col];
      const count = ids.length;

      ids.forEach((id, index) => {
        const colY = count === 1 ? height / 2 : (height / (count + 1)) * (index + 1);
        nodeCoords[id] = { x: colX, y: colY };
      });
    });

    return nodeCoords;
  };

  const nodeCoords = isEditing
    ? (draftHld ? getLayout(draftHld.components) : {})
    : (architecture ? getLayout(architecture.hld.components) : {});
  const selectedNode = isEditing
    ? draftHld?.components.find((c) => c.id === selectedNodeId)
    : architecture?.hld.components.find((c) => c.id === selectedNodeId);

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

  const getNodeColor = (type: string, isSelected: boolean) => {
    const base = isSelected ? "stroke-cyan-500 stroke-[3px]" : "stroke-slate-200";
    let bg = "fill-slate-50";

    if (type === "cdn") bg = "fill-amber-50";
    else if (type === "compute") bg = "fill-sky-50";
    else if (type === "database") bg = "fill-purple-50";
    else if (type === "storage") bg = "fill-emerald-50";
    else if (type === "queue") bg = "fill-pink-50";
    else if (type === "cache") bg = "fill-rose-50";
    else if (type === "auth") bg = "fill-indigo-50";
    // Compliance nodes get their own warm, visually distinct palette so they stand out from
    // regular infra at a glance, on top of the shield badge drawn separately on each node.
    else if (type === "tokenization") bg = "fill-orange-50";
    else if (type === "audit-log") bg = "fill-stone-100";
    else if (type === "phi-vault") bg = "fill-red-50";
    else if (type === "deidentification") bg = "fill-teal-50";

    const border = isComplianceNode(type) && !isSelected ? "stroke-amber-400/70" : base;

    return { border, bg };
  };

  const getNodeEmoji = (type: string) => {
    if (type === "cdn") return "🌐";
    if (type === "compute") return "⚙️";
    if (type === "database") return "💾";
    if (type === "storage") return "📦";
    if (type === "queue") return "📥";
    if (type === "cache") return "⚡";
    if (type === "auth") return "🔑";
    if (type === "tokenization") return "🔐";
    if (type === "audit-log") return "🧾";
    if (type === "phi-vault") return "🏥";
    if (type === "deidentification") return "🕶️";
    return "🧩";
  };

  if (loading) {
    return (
      <div className="flex h-96 flex-col items-center justify-center p-8 text-slate-500">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-cyan-500 border-t-transparent" />
        <span className="mt-4 text-sm font-semibold">Loading system architecture...</span>
      </div>
    );
  }

  if (generating) {
    return (
      <div className="flex h-96 flex-col items-center justify-center p-8 text-slate-500 text-center">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-cyan-600 border-t-transparent flex items-center justify-center shadow-md">
          🌀
        </div>
        <span className="mt-4 text-base font-semibold text-slate-900 font-bold">
          {GENERATION_STAGES[generationStageIndex]}
        </span>
        <span className="mt-2 text-xs text-slate-500 max-w-sm">
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
          <h3 className="text-xl font-bold text-slate-950">Synthesize System Architecture</h3>
          <p className="text-sm text-slate-600 mt-1">
            Generate an architecture diagram complete with cloud service mappings for AWS, Azure, and GCP.
          </p>

          {error && (
            <div className="mt-4 flex items-center justify-between rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-950 shadow-sm animate-fadeIn">
              <div className="flex items-center gap-2">
                <span>⚠️</span>
                <span>{error}</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleGenerate}
                  className="rounded-lg bg-red-100 hover:bg-red-200 text-red-900 px-2 py-1 text-xs font-bold transition"
                >
                  Retry
                </button>
                <button
                  onClick={() => setError("")}
                  className="text-red-500 hover:text-red-700 font-extrabold text-xs px-2 py-1"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}

          {isGenerationBlocked ? (
            <div className="mt-6 rounded-3xl border border-amber-200 bg-amber-50/50 p-5">
              <h4 className="font-semibold text-amber-950 flex items-center gap-2">
                <span>⚠️</span> Generation Locked
              </h4>
              <p className="mt-2 text-sm text-amber-900 leading-relaxed">
                We are missing critical parameters required to run the architecture rules engine. Click specify on the fields below to edit them:
              </p>
              <ul className="mt-4 space-y-2 text-xs">
                {isScaleUnspecified && (
                  <li className="flex items-center gap-2">
                    <span className="text-amber-600 font-bold">•</span>
                    <span className="text-amber-950 font-medium mr-1">Expected Traffic / Scale</span>
                    <button
                      onClick={() => onSwitchTab("requirements", "expectedScale")}
                      className="text-cyan-700 font-bold hover:underline bg-cyan-100/50 px-2 py-0.5 rounded border border-cyan-200"
                    >
                      specify ➜
                    </button>
                  </li>
                )}
                {isBudgetUnspecified && (
                  <li className="flex items-center gap-2">
                    <span className="text-amber-600 font-bold">•</span>
                    <span className="text-amber-950 font-medium mr-1">Budget Range</span>
                    <button
                      onClick={() => onSwitchTab("requirements", "budget")}
                      className="text-cyan-700 font-bold hover:underline bg-cyan-100/50 px-2 py-0.5 rounded border border-cyan-200"
                    >
                      specify ➜
                    </button>
                  </li>
                )}
                {isDataUnspecified && (
                  <li className="flex items-center gap-2">
                    <span className="text-amber-600 font-bold">•</span>
                    <span className="text-amber-950 font-medium mr-1">Data Types / Nature</span>
                    <button
                      onClick={() => onSwitchTab("requirements", "dataNature")}
                      className="text-cyan-700 font-bold hover:underline bg-cyan-100/50 px-2 py-0.5 rounded border border-cyan-200"
                    >
                      specify ➜
                    </button>
                  </li>
                )}
              </ul>
            </div>
          ) : (
            <div className="mt-6 rounded-3xl border border-cyan-200 bg-cyan-50/50 p-5">
              <h4 className="font-semibold text-cyan-950 flex items-center gap-2">
                <span>✓</span> Requirements Complete
              </h4>
              <p className="mt-1 text-sm text-cyan-900 leading-relaxed">
                All critical parameters have been specified. You are ready to generate your multi-cloud architecture.
              </p>
            </div>
          )}
        </div>

        <div className="mt-8 border-t border-slate-100 pt-6">
          <button
            onClick={handleGenerate}
            disabled={isGenerationBlocked}
            className="flex w-full items-center justify-center rounded-2xl bg-cyan-600 px-5 py-4 text-sm font-semibold text-white shadow-md transition-all hover:bg-cyan-700 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
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
      <div className="border-b border-slate-200 bg-white px-6 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h3 className="text-base font-extrabold text-slate-950">Multi-Cloud Design Board</h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Design dynamic architectures and compare alternatives across cloud platforms.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex bg-slate-100 p-1 rounded-xl border border-slate-200 shadow-sm">
            <button
              onClick={() => setViewMode("diagram")}
              className={`px-3 py-1.5 text-xs font-bold rounded-lg transition ${
                viewMode === "diagram" ? "bg-white text-slate-950 shadow-sm" : "text-slate-500 hover:text-slate-800"
              }`}
            >
              Topology View
            </button>
            <button
              onClick={() => setViewMode("comparison")}
              className={`px-3 py-1.5 text-xs font-bold rounded-lg transition ${
                viewMode === "comparison" ? "bg-white text-slate-950 shadow-sm" : "text-slate-500 hover:text-slate-800"
              }`}
            >
              Compare Clouds
            </button>
          </div>
          <div className="flex items-center gap-1 bg-slate-100 px-3 py-1.5 rounded-xl border border-slate-200 shadow-sm">
            <span className="text-[10px] font-extrabold text-slate-500 uppercase tracking-wider">Version:</span>
            <select
              value={architecture.version}
              onChange={(e) => loadArchitecture(e.target.value)}
              disabled={isEditing}
              className={`bg-transparent text-xs font-bold text-slate-950 focus:outline-none cursor-pointer ${isEditing ? "opacity-50 cursor-not-allowed" : ""}`}
            >
              {versionList.map((v) => (
                <option key={v.version} value={v.version}>
                  v{v.version} {v.version === versionList[0]?.version ? "(Latest)" : ""}
                </option>
              ))}
            </select>
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
                      ? "bg-emerald-600 hover:bg-emerald-700 text-white active:scale-95"
                      : "bg-slate-300 text-slate-500 cursor-not-allowed"
                  }`}
                >
                  <span>{savingManualChanges ? "Saving..." : "💾 Save Changes"}</span>
                </button>
                <button
                  onClick={handleCancelEditMode}
                  className="rounded-xl bg-slate-500 hover:bg-slate-600 text-white px-3 py-1.5 text-xs font-bold uppercase transition shadow-sm active:scale-95"
                >
                  Cancel
                </button>
              </div>
            ) : (
              architecture.version === versionList[0]?.version && (
                <button
                  onClick={handleEnterEditMode}
                  className="rounded-xl bg-slate-900 hover:bg-slate-800 text-white px-3 py-1.5 text-xs font-bold uppercase transition shadow-sm active:scale-95"
                >
                  🔧 Edit Architecture
                </button>
              )
            )
          )}
        </div>
      </div>

      {error && (
        <div className="mx-6 mt-4 flex items-center justify-between rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-950 shadow-sm animate-fadeIn shrink-0">
          <div className="flex items-center gap-2">
            <span>⚠️</span>
            <span>{error}</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleGenerate}
              className="rounded-lg bg-red-100 hover:bg-red-200 text-red-900 px-2 py-1 text-xs font-bold transition"
            >
              Retry
            </button>
            <button
              onClick={() => setError("")}
              className="text-red-500 hover:text-red-700 font-extrabold text-xs px-2 py-1"
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
            <div className="flex-1 p-6 flex flex-col justify-between border-b lg:border-b-0 lg:border-r border-slate-100 overflow-y-auto">
              <div>
                <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                  <span className="text-xs text-slate-500 font-semibold uppercase tracking-wider">
                    Interactive Topology
                  </span>
                  
                  <div className="flex items-center gap-3">
                    {/* Export Button */}
                    <button
                      onClick={handleExport}
                      className="rounded-xl bg-cyan-600 hover:bg-cyan-700 text-white px-3 py-1.5 text-[9.5px] font-extrabold uppercase transition shadow-sm active:scale-95 flex items-center gap-1"
                    >
                      <span>📥</span> {activeProvider === "kubernetes" ? "Export Manifests" : "Export TF"}
                    </button>

                    {/* Deployment Target Toggle */}
                    <div className="flex bg-slate-100/80 p-0.5 rounded-lg border border-slate-200 shadow-sm">
                      {(["aws", "azure", "gcp", "kubernetes", "private"] as const).map((p) => (
                        <button
                          key={p}
                          onClick={() => setActiveProvider(p)}
                          className={`px-2 py-1 text-[9px] font-extrabold uppercase rounded transition ${
                            activeProvider === p
                              ? "bg-slate-950 text-white shadow-sm"
                              : "text-slate-500 hover:text-slate-800"
                          }`}
                        >
                          {PROVIDER_LABELS[p]}
                        </button>
                      ))}
                    </div>
                    <span className="rounded-full bg-emerald-100 border border-emerald-200 text-emerald-800 px-2.5 py-0.5 text-[9px] font-extrabold flex items-center gap-1">
                      <span>Est: ${totalMinCost} - ${totalMaxCost}/mo</span>
                      {getProviderCostDeltaString(activeProvider) && (
                        <span className={`px-1 rounded font-black ${
                          ((architecture.reasoning.diff?.costDelta as Record<string, { min: number; max: number }> | undefined)?.[activeProvider]?.min || 0) < 0
                            ? "text-emerald-700 bg-emerald-50"
                            : "text-amber-700 bg-amber-50"
                        }`}>
                          {getProviderCostDeltaString(activeProvider)}
                        </span>
                      )}
                    </span>
                  </div>
                </div>

                {/* Team Maturity / Deployment Target Advisory */}
                {providerMaturityWarning && (
                  <div className="mt-4 flex items-start gap-2.5 rounded-2xl border border-amber-200 bg-amber-50/60 p-3.5 text-xs text-amber-950 shadow-sm animate-fadeIn">
                    <span className="text-sm">⚠️</span>
                    <div className="leading-relaxed">
                      <span className="font-extrabold uppercase text-[9px] tracking-wider text-amber-800 block">
                        Recommendation
                      </span>
                      {providerMaturityWarning}
                    </div>
                  </div>
                )}

                {/* Manual Editing Controls Toolbar */}
                {isEditing && draftHld && (
                  <div className="mt-4 border border-slate-200 bg-slate-50/50 rounded-[1.5rem] p-4 space-y-4 animate-fadeIn">
                    {/* Panel Title */}
                    <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                      <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">
                        🔧 Manual Editor Controls
                      </span>
                      <span className="text-[9px] font-bold text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">
                        Draft Mode
                      </span>
                    </div>

                    <div className="grid gap-4 md:grid-cols-2">
                      {/* Form 1: Add Component */}
                      <form onSubmit={handleAddComponent} className="space-y-3">
                        <div className="text-[10px] font-bold text-slate-700">➕ Add Generic Component</div>
                        <div className="flex flex-col gap-2">
                          <div className="flex gap-2">
                            <select
                              value={newNodeType}
                              onChange={(e) => setNewNodeType(e.target.value)}
                              className="bg-white border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs font-semibold focus:outline-none focus:ring-1 focus:ring-cyan-500 animate-fadeIn"
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
                              className="flex-1 bg-white border border-slate-200 rounded-xl px-3 py-1.5 text-xs font-semibold focus:outline-none focus:ring-1 focus:ring-cyan-500"
                            />
                          </div>
                          <input
                            type="text"
                            value={newNodeReasoning}
                            onChange={(e) => setNewNodeReasoning(e.target.value)}
                            placeholder="Optional: Rationale / Reason for adding..."
                            className="bg-white border border-slate-200 rounded-xl px-3 py-1.5 text-xs font-medium focus:outline-none focus:ring-1 focus:ring-cyan-500"
                          />
                          <button
                            type="submit"
                            className="w-full bg-cyan-600 hover:bg-cyan-700 text-white rounded-xl py-1.5 text-[10px] font-extrabold uppercase tracking-wide transition shadow-sm"
                          >
                            Add Component Node
                          </button>
                        </div>
                      </form>

                      {/* Form 2: Add Connection */}
                      <form onSubmit={handleAddConnection} className="space-y-3">
                        <div className="text-[10px] font-bold text-slate-700">🔗 Add Connection Link</div>
                        <div className="flex flex-col gap-2">
                          <div className="flex gap-2">
                            <select
                              value={newEdgeFrom}
                              onChange={(e) => setNewEdgeFrom(e.target.value)}
                              className="flex-1 bg-white border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs font-semibold focus:outline-none focus:ring-1 focus:ring-cyan-500"
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
                              className="flex-1 bg-white border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs font-semibold focus:outline-none focus:ring-1 focus:ring-cyan-500"
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
                              className="flex-1 bg-white border border-slate-200 rounded-xl px-3 py-1.5 text-xs font-semibold focus:outline-none focus:ring-1 focus:ring-cyan-500"
                            />
                            <button
                              type="submit"
                              className="bg-slate-900 hover:bg-slate-800 text-white rounded-xl px-4 py-1.5 text-[10px] font-extrabold uppercase tracking-wide transition shadow-sm"
                            >
                              Connect
                            </button>
                          </div>
                        </div>
                      </form>
                    </div>

                    {/* Active Connections List (for simple deletion) */}
                    <div className="border-t border-slate-100 pt-3">
                      <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest block mb-2">
                        Active Connection Links
                      </span>
                      <div className="flex flex-wrap gap-2 max-h-[100px] overflow-y-auto pr-1">
                        {draftHld.connections.length === 0 ? (
                          <span className="text-[10px] text-slate-400 italic">No active connections.</span>
                        ) : (
                          draftHld.connections.map((conn, idx) => {
                            const fromNode = draftHld.components.find((c) => c.id === conn.from);
                            const toNode = draftHld.components.find((c) => c.id === conn.to);
                            return (
                              <div
                                key={idx}
                                className="flex items-center gap-1.5 bg-white border border-slate-200 rounded-xl px-2.5 py-1 text-[10px] font-bold text-slate-700 shadow-sm"
                              >
                                <span>{fromNode?.name || conn.from}</span>
                                <span className="text-slate-400 font-normal">➜</span>
                                <span>{toNode?.name || conn.to}</span>
                                <span className="text-slate-400">({conn.protocol})</span>
                                <button
                                  type="button"
                                  onClick={() => handleRemoveConnection(conn.from, conn.to)}
                                  className="text-red-500 hover:text-red-700 font-black ml-1 scale-110"
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
                        className="flex items-start gap-2.5 rounded-2xl border border-red-200 bg-red-50 p-3 text-xs text-red-950 shadow-sm animate-fadeIn"
                      >
                        <span className="text-sm">❌</span>
                        <div className="leading-relaxed">
                          <span className="font-extrabold uppercase text-[9px] tracking-wider text-red-800 block">
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
                        className="flex items-start gap-2.5 rounded-2xl border border-amber-200 bg-amber-50/50 p-3 text-xs text-amber-950 shadow-sm animate-fadeIn"
                      >
                        <span className="text-sm">⚠️</span>
                        <div className="leading-relaxed">
                          <span className="font-extrabold uppercase text-[9px] tracking-wider text-amber-800 block">
                            Warning
                          </span>
                          {warn}
                        </div>
                      </div>
                    ))}

                    {validationResults.isValid &&
                      validationResults.errors.length === 0 &&
                      validationResults.warnings.length === 0 && (
                        <div className="flex items-center gap-2 rounded-2xl border border-emerald-200 bg-emerald-50/50 px-3 py-2.5 text-xs text-emerald-950 shadow-sm">
                          <span className="text-sm">✅</span>
                          <span className="font-semibold">All structural validation checks passed. Ready to save!</span>
                        </div>
                      )}
                  </div>
                )}

                {/* What Changed Diff Panel */}
                {architecture.reasoning.diff && (
                  <div className="mt-6 rounded-3xl border border-cyan-200/80 bg-cyan-50/10 p-5 shadow-sm">
                    <h4 className="font-extrabold text-slate-950 flex items-center gap-2 text-xs uppercase tracking-wider">
                      <span>🔄</span> What Changed in Version {architecture.version}
                    </h4>
                    <p className="text-[11px] text-slate-500 mt-1">
                      Delta modifications generated in response to growth triggers or updates:
                    </p>
                    <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-3 border-t border-slate-100 pt-4">
                      {/* Added Components */}
                      {architecture.reasoning.diff.added && architecture.reasoning.diff.added.length > 0 && (
                        <div className="space-y-2">
                          <span className="text-[9px] font-black text-emerald-700 uppercase tracking-widest block bg-emerald-100/60 border border-emerald-200 px-2 py-0.5 rounded w-max">
                            + Added
                          </span>
                          <ul className="text-xs space-y-2 text-slate-700">
                            {architecture.reasoning.diff.added.map((item: any, idx: number) => (
                              <li key={idx} className="leading-relaxed">
                                <span className="font-bold text-slate-950 block">{item.name}</span>
                                <span className="text-[10px] text-slate-400 font-semibold uppercase">{item.type}</span>
                                <span className="block text-[11px] text-slate-500 italic mt-0.5">{item.reasoning}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* Modified Components */}
                      {architecture.reasoning.diff.modified && architecture.reasoning.diff.modified.length > 0 && (
                        <div className="space-y-2">
                          <span className="text-[9px] font-black text-amber-700 uppercase tracking-widest block bg-amber-100/60 border border-amber-200 px-2 py-0.5 rounded w-max">
                            ~ Modified
                          </span>
                          <ul className="text-xs space-y-3 text-slate-700">
                            {architecture.reasoning.diff.modified.map((item: any, idx: number) => (
                              <li key={idx} className="leading-relaxed">
                                <span className="font-bold text-slate-950 block">{item.name}</span>
                                <div className="mt-1 space-y-1.5 pl-2 border-l-2 border-slate-200">
                                  {item.changes.map((ch: any, cIdx: number) => (
                                    <div key={cIdx} className="text-[11px]">
                                      <span className="font-semibold text-slate-600 block uppercase text-[9px]">{ch.parameter}</span>
                                      <span className="text-slate-400 line-through">{ch.oldVal}</span> ➜{" "}
                                      <span className="text-slate-950 font-bold">{ch.newVal}</span>
                                      <span className="block text-[10px] text-slate-500 italic mt-0.5">{ch.reasoning}</span>
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
                          <span className="text-[9px] font-black text-red-700 uppercase tracking-widest block bg-red-100/60 border border-red-200 px-2 py-0.5 rounded w-max">
                            − Removed
                          </span>
                          <ul className="text-xs space-y-2 text-slate-700">
                            {architecture.reasoning.diff.removed.map((item: any, idx: number) => (
                              <li key={idx} className="leading-relaxed">
                                <span className="font-bold text-slate-950 line-through block">{item.name}</span>
                                <span className="text-[10px] text-slate-400 font-semibold uppercase">{item.type}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* SVG Topology Diagram */}
                <div className="relative mt-6 rounded-[2rem] border border-slate-200/80 bg-slate-950 shadow-inner overflow-hidden flex items-center justify-center">
                  <svg viewBox="0 0 660 400" className="w-full h-auto max-h-[350px]">
                    {/* Connections */}
                    {(isEditing ? draftHld?.connections || [] : architecture.hld.connections).map((conn, idx) => {
                      const from = nodeCoords[conn.from];
                      const to = nodeCoords[conn.to];
                      if (!from || !to) return null;

                      const controlX = (from.x + to.x) / 2;
                      return (
                        <g key={idx}>
                          <path
                            d={`M ${from.x} ${from.y} C ${controlX} ${from.y}, ${controlX} ${to.y}, ${to.x} ${to.y}`}
                            fill="none"
                            className="stroke-cyan-500/30 stroke-2"
                          />
                          <path
                            d={`M ${from.x} ${from.y} C ${controlX} ${from.y}, ${controlX} ${to.y}, ${to.x} ${to.y}`}
                            fill="none"
                            className="stroke-cyan-400/80 stroke-[1.5px]"
                            strokeDasharray="5, 10"
                            strokeDashoffset="0"
                          >
                            <animate
                              attributeName="stroke-dashoffset"
                              values="60;0"
                              dur="3s"
                              repeatCount="indefinite"
                            />
                          </path>
                        </g>
                      );
                    })}

                    {/* Nodes */}
                    {(isEditing ? draftHld?.components || [] : architecture.hld.components).map((node) => {
                      const coord = nodeCoords[node.id];
                      if (!coord) return null;

                      const isSelected = selectedNodeId === node.id;
                      const colors = getNodeColor(node.type, isSelected);
                      const mapping = getMappingForProvider(node, activeProvider);
                      const serviceName = mapping?.serviceName || node.name;

                      return (
                        <g
                          key={node.id}
                          transform={`translate(${coord.x}, ${coord.y})`}
                          onClick={() => setSelectedNodeId(node.id)}
                          className="cursor-pointer group"
                        >
                          <rect
                            x="-70"
                            y="-25"
                            width="140"
                            height="50"
                            rx="12"
                            className={`transition-all duration-200 fill-none ${
                              isSelected
                                ? "stroke-cyan-500/50 stroke-[6px]"
                                : "group-hover:stroke-slate-500/20 group-hover:stroke-[4px]"
                            }`}
                          />
                          <rect
                            x="-65"
                            y="-20"
                            width="130"
                            height="40"
                            rx="10"
                            strokeDasharray={node.metadata?.overrideSource === "user" ? "4, 3" : undefined}
                            className={`transition duration-200 ${colors.bg} ${colors.border}`}
                          />
                          <text x="-52" y="5" className="text-base select-none">
                            {getNodeEmoji(node.type)}
                          </text>
                          <text
                            x="-30"
                            y="-4"
                            className="text-[7.5px] fill-slate-400 select-none font-bold uppercase tracking-wider"
                          >
                            {node.name.length > 20 ? `${node.name.substring(0, 17)}...` : node.name}
                          </text>
                          <text
                            x="-30"
                            y="8"
                            className="text-[8.5px] font-black fill-slate-800 select-none"
                          >
                            {serviceName.length > 20 ? `${serviceName.substring(0, 17)}...` : serviceName}
                          </text>

                          {/* User Override Indicator Badge */}
                          {node.metadata?.overrideSource === "user" && (
                            <g transform="translate(58, -16)" className="pointer-events-none">
                              <circle r="6" className="fill-amber-500 stroke-white stroke-1" />
                              <text y="2" textAnchor="middle" className="text-[6px] fill-white font-black select-none">
                                U
                              </text>
                            </g>
                          )}

                          {/* Compliance Component Badge — marks nodes added by industry rules
                              (audit log, tokenization, PHI vault, de-identification) */}
                          {isComplianceNode(node.type) && (
                            <g transform="translate(58, 16)" className="pointer-events-none">
                              <circle r="7" className="fill-white stroke-amber-500 stroke-[1.5]" />
                              <text y="3" textAnchor="middle" className="text-[8px] select-none">
                                🛡️
                              </text>
                            </g>
                          )}

                          {/* Edit Mode Deletion Cross button */}
                          {isEditing && (
                            <g
                              transform="translate(-62, -16)"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleRemoveNode(node.id);
                              }}
                              className="cursor-pointer hover:scale-115 transition"
                            >
                              <circle r="6" className="fill-red-600 stroke-white stroke-1" />
                              <text y="2.2" textAnchor="middle" className="text-[7.5px] fill-white font-black select-none">
                                ×
                              </text>
                            </g>
                          )}
                        </g>
                      );
                    })}
                  </svg>
                </div>
              </div>

              <div className="mt-6 border-t border-slate-100 pt-4 flex items-center justify-between">
                <span className="text-xs text-slate-500 font-medium">
                  Active Provider view: <strong className="uppercase">{activeProvider}</strong>
                </span>
                <button
                  onClick={handleGenerate}
                  disabled={isGenerationBlocked}
                  className="rounded-xl bg-slate-900 hover:bg-slate-800 text-white px-4 py-2 text-xs font-bold transition shadow-sm active:scale-95 disabled:opacity-50"
                >
                  Regenerate Design
                </button>
              </div>
            </div>

            {/* Topology Drawer (Right) */}
            <div className="w-full lg:w-[360px] bg-slate-50/50 p-6 overflow-y-auto flex flex-col justify-between border-t lg:border-t-0 border-slate-100">
              {selectedNode ? (
                <div className="space-y-6">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="rounded-full bg-cyan-100 border border-cyan-200 px-2 py-0.5 text-[9px] font-bold text-cyan-800 uppercase tracking-wider">
                        {selectedNode.type}
                      </span>
                      <span className="rounded-full bg-slate-200 border border-slate-300 px-2 py-0.5 text-[9px] font-bold text-slate-700 uppercase tracking-wider">
                        {activeProvider} Mapped
                      </span>
                    </div>
                    <h4 className="text-base font-bold text-slate-950 mt-2">
                      {selectedMapping?.serviceName || selectedNode.name}
                    </h4>
                    <p className="text-[10px] text-slate-400 font-semibold uppercase mt-0.5 tracking-wider">
                      Generic Component: {selectedNode.name}
                    </p>
                    <p className="text-xs text-slate-600 mt-2 leading-relaxed">{selectedNode.description}</p>

                    {isEditing && (
                      <div className="space-y-1.5 bg-white border border-slate-200 rounded-2xl p-3 mt-3 shadow-sm">
                        <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest block">
                          Component Override Rationale
                        </label>
                        <textarea
                          value={selectedNode.reasoning || ""}
                          placeholder="Why are manual overrides or adjustments needed?"
                          rows={3}
                          onChange={(e) => handleUpdateComponentReasoning(selectedNode.id, e.target.value)}
                          className="w-full text-xs text-slate-800 bg-slate-50 border border-slate-200 rounded-xl p-2 focus:outline-none focus:ring-1 focus:ring-cyan-500 leading-relaxed shadow-inner"
                        />
                      </div>
                    )}
                  </div>

                  {selectedMapping?.costEstimate && (
                    <div>
                      <h5 className="text-xs font-bold text-slate-500 uppercase tracking-wider">Estimated Cost</h5>
                      <div className="mt-2 rounded-2xl border border-emerald-100 bg-emerald-50/40 p-3.5">
                        <div className="text-sm font-extrabold text-emerald-950">
                          ${selectedMapping.costEstimate.min} - ${selectedMapping.costEstimate.max}/mo
                        </div>
                        <div className="text-[11px] text-emerald-900 font-medium leading-normal mt-1 italic">
                          Assumptions: {selectedMapping.costEstimate.assumptions}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Expandable LLD Configs section */}
                  {lldData && (
                    <div className="border-t border-slate-200/80 pt-4">
                      <button
                        onClick={() => setIsLldExpanded(!isLldExpanded)}
                        className="flex w-full items-center justify-between py-2 text-xs font-bold text-slate-700 uppercase tracking-wider hover:text-slate-950 transition"
                      >
                        <span>⚙️ Technical Details (LLD)</span>
                        <span>{isLldExpanded ? "▲" : "▼"}</span>
                      </button>

                      {isLldExpanded && (
                        <div className="mt-3 space-y-4 max-h-[300px] overflow-y-auto pr-1">
                          {Object.keys(lldData.config).map((key) => {
                            const val = lldData.config[key];
                            const note = lldData.reasoning?.[key];
                            return (
                              <div
                                key={key}
                                className="rounded-2xl border border-slate-200 bg-white p-3 space-y-2.5 shadow-sm"
                              >
                                <div className="flex justify-between items-center gap-2">
                                  <span className="font-mono text-[10px] font-bold text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded">
                                    {key}
                                  </span>
                                  {isEditing ? (
                                    <input
                                      type="text"
                                      value={val}
                                      onChange={(e) =>
                                        handleUpdateLldConfig(selectedNode.id, activeProvider, key, e.target.value)
                                      }
                                      className="font-mono text-[10px] font-bold text-slate-800 bg-slate-50 border border-slate-200 px-1.5 py-0.5 rounded text-right focus:outline-none focus:ring-1 focus:ring-cyan-500 w-32"
                                    />
                                  ) : (
                                    <span className="font-mono text-[10px] font-bold text-slate-800 bg-slate-100 px-1.5 py-0.5 rounded text-right">
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
                                    className="w-full text-[10px] text-slate-600 bg-slate-50 border border-slate-200 rounded-lg p-1.5 focus:outline-none focus:ring-1 focus:ring-cyan-500 leading-normal"
                                  />
                                ) : (
                                  note && (
                                    <p className="text-[10px] text-slate-500 font-medium leading-relaxed italic">
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

                  {selectedMapping?.alternatives && selectedMapping.alternatives.length > 0 && (
                    <div>
                      <h5 className="text-xs font-bold text-slate-500 uppercase tracking-wider">Alternatives Considered</h5>

                      {isEditing && (
                        <input
                          type="text"
                          value={swapReason}
                          onChange={(e) => setSwapReason(e.target.value)}
                          placeholder="Optional: reason for switching service..."
                          className="mt-2 w-full bg-white border border-slate-200 rounded-xl px-3 py-1.5 text-xs font-medium focus:outline-none focus:ring-1 focus:ring-cyan-500"
                        />
                      )}

                      <div className="mt-2 space-y-2">
                        {selectedMapping.alternatives.map((alt, idx) => (
                          <div
                            key={idx}
                            className="rounded-2xl border border-slate-200 bg-white p-3.5 text-xs text-slate-800 leading-normal"
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="font-bold text-slate-950">Alternative: {alt.serviceName}</div>
                              {isEditing && (
                                <button
                                  type="button"
                                  disabled={!alt.costEstimate}
                                  onClick={() => handleSwapService(selectedNode.id, activeProvider, idx)}
                                  title={!alt.costEstimate ? "Cost data unavailable for this alternative on this architecture version." : undefined}
                                  className="shrink-0 rounded-lg bg-cyan-600 hover:bg-cyan-700 text-white px-2 py-1 text-[9px] font-extrabold uppercase tracking-wide transition shadow-sm disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                  Switch to this
                                </button>
                              )}
                            </div>
                            <div className="text-slate-600 mt-1 font-medium leading-relaxed">{alt.reason}</div>
                            {alt.costEstimate && (
                              <div className="text-[11px] text-emerald-700 font-bold mt-1.5">
                                ${alt.costEstimate.min} - ${alt.costEstimate.max}/mo
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div>
                    <h5 className="text-xs font-bold text-slate-500 uppercase tracking-wider">Architect Rationale</h5>
                    <div className="mt-2 rounded-2xl border border-cyan-100 bg-cyan-50/30 p-3.5 text-xs text-cyan-950 font-medium leading-relaxed">
                      {selectedNode.reasoning}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex-1 flex flex-col justify-center items-center text-center text-slate-400">
                  <span className="text-3xl">👈</span>
                  <h4 className="font-semibold text-sm mt-3 text-slate-700">Select a Component</h4>
                  <p className="text-xs text-slate-500 max-w-[220px] mt-1">
                    Click elements in the diagram to inspect rationale, mapping, alternatives, and cost estimates.
                  </p>
                </div>
              )}
            </div>
          </div>
        ) : (
          /* Compare Clouds View Mode (Table/Grid) */
          <div className="h-full overflow-y-auto p-6 space-y-6">
            {/* Recommended Cloud Choice Banner */}
            <div className="rounded-3xl border border-cyan-200 bg-gradient-to-r from-cyan-50/50 to-emerald-50/30 p-6 shadow-sm">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="rounded-full bg-cyan-600 px-3 py-1 text-xs font-extrabold text-white uppercase tracking-wider">
                      ★ Recommended Provider
                    </span>
                    <span className="rounded-full bg-slate-950 px-3 py-1 text-xs font-extrabold text-white uppercase tracking-wider">
                      {recommendation.recommendedProvider}
                    </span>
                  </div>
                  <h4 className="text-lg font-black text-slate-950 mt-3">Architect&apos;s Overall Selection Rationale</h4>
                  <p className="text-sm text-slate-700 leading-relaxed mt-2 max-w-4xl">
                    {recommendation.rationale}
                  </p>
                </div>
              </div>

              {recommendation.keyTradeoffs && recommendation.keyTradeoffs.length > 0 && (
                <div className="mt-5 border-t border-slate-200/60 pt-4">
                  <h5 className="text-xs font-bold text-slate-500 uppercase tracking-wider">Key Trade-offs Considered</h5>
                  <ul className="mt-2.5 space-y-2 text-xs text-slate-700 font-medium">
                    {recommendation.keyTradeoffs.map((t, idx) => (
                      <li key={idx} className="flex gap-2.5">
                        <span className="text-cyan-500 font-extrabold">▪</span>
                        <span>{t}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {/* Side-by-Side Comparison Table */}
            <div className="rounded-[2rem] border border-slate-200 bg-white shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse table-fixed min-w-[1100px]">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200">
                      <th className="p-4 text-xs font-bold text-slate-500 uppercase tracking-wider w-[180px]">
                        Generic Component
                      </th>
                      <th className="p-4 text-xs font-bold text-slate-500 uppercase tracking-wider">
                        Amazon Web Services (AWS)
                      </th>
                      <th className="p-4 text-xs font-bold text-slate-500 uppercase tracking-wider">
                        Microsoft Azure
                      </th>
                      <th className="p-4 text-xs font-bold text-slate-500 uppercase tracking-wider">
                        Google Cloud Platform (GCP)
                      </th>
                      <th className="p-4 text-xs font-bold text-slate-500 uppercase tracking-wider">
                        Kubernetes
                      </th>
                      <th className="p-4 text-xs font-bold text-slate-500 uppercase tracking-wider">
                        Private Cloud
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-xs font-medium text-slate-700">
                    {architecture.hld.components.map((c) => {
                      const awsM = getMappingForProvider(c, "aws");
                      const azureM = getMappingForProvider(c, "azure");
                      const gcpM = getMappingForProvider(c, "gcp");
                      const k8sM = getMappingForProvider(c, "kubernetes");
                      const privateM = getMappingForProvider(c, "private");

                      return (
                        <tr key={c.id} className="hover:bg-slate-50/40">
                          {/* Component name */}
                          <td className="p-4 align-top">
                            <span className="font-extrabold text-slate-900 block">{c.name}</span>
                            <span className="text-[10px] text-slate-400 font-semibold block mt-0.5 uppercase tracking-wide">
                              {c.type}
                            </span>
                          </td>

                          {/* AWS Column */}
                          <td className="p-4 align-top space-y-1">
                            <div className="font-extrabold text-slate-900">{awsM?.serviceName || "—"}</div>
                            {awsM?.costEstimate && (
                              <div className="text-[11px] text-emerald-700 font-bold">
                                ${awsM.costEstimate.min} - ${awsM.costEstimate.max}/mo
                              </div>
                            )}
                            {awsM?.costEstimate.assumptions && (
                              <div className="text-[10px] text-slate-400 leading-normal font-medium">
                                {awsM.costEstimate.assumptions}
                              </div>
                            )}
                          </td>

                          {/* Azure Column */}
                          <td className="p-4 align-top space-y-1">
                            <div className="font-extrabold text-slate-900">{azureM?.serviceName || "—"}</div>
                            {azureM?.costEstimate && (
                              <div className="text-[11px] text-emerald-700 font-bold">
                                ${azureM.costEstimate.min} - ${azureM.costEstimate.max}/mo
                              </div>
                            )}
                            {azureM?.costEstimate.assumptions && (
                              <div className="text-[10px] text-slate-400 leading-normal font-medium">
                                {azureM.costEstimate.assumptions}
                              </div>
                            )}
                          </td>

                          {/* GCP Column */}
                          <td className="p-4 align-top space-y-1">
                            <div className="font-extrabold text-slate-900">{gcpM?.serviceName || "—"}</div>
                            {gcpM?.costEstimate && (
                              <div className="text-[11px] text-emerald-700 font-bold">
                                ${gcpM.costEstimate.min} - ${gcpM.costEstimate.max}/mo
                              </div>
                            )}
                            {gcpM?.costEstimate.assumptions && (
                              <div className="text-[10px] text-slate-400 leading-normal font-medium">
                                {gcpM.costEstimate.assumptions}
                              </div>
                            )}
                          </td>

                          {/* Kubernetes Column */}
                          <td className="p-4 align-top space-y-1">
                            <div className="font-extrabold text-slate-900">{k8sM?.serviceName || "—"}</div>
                            {k8sM?.costEstimate && (
                              <div className="text-[11px] text-emerald-700 font-bold">
                                ${k8sM.costEstimate.min} - ${k8sM.costEstimate.max}/mo
                              </div>
                            )}
                            {k8sM?.costEstimate.assumptions && (
                              <div className="text-[10px] text-slate-400 leading-normal font-medium">
                                {k8sM.costEstimate.assumptions}
                              </div>
                            )}
                          </td>

                          {/* Private Cloud Column */}
                          <td className="p-4 align-top space-y-1">
                            <div className="font-extrabold text-slate-900">{privateM?.serviceName || "—"}</div>
                            {privateM?.costEstimate && (
                              <div className="text-[11px] text-emerald-700 font-bold">
                                ${privateM.costEstimate.min} - ${privateM.costEstimate.max}/mo
                              </div>
                            )}
                            {privateM?.costEstimate.assumptions && (
                              <div className="text-[10px] text-slate-400 leading-normal font-medium">
                                {privateM.costEstimate.assumptions}
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}

                    {/* Totals Row */}
                    <tr className="bg-slate-50/80 font-black border-t-2 border-slate-200">
                      <td className="p-4 text-xs text-slate-900">Total Estimated Cost</td>
                      <td className="p-4 text-xs text-emerald-800 font-extrabold">
                        <div>${awsTotal.min} - ${awsTotal.max}/mo</div>
                        {getProviderCostDeltaString("aws") && (
                          <div className={`text-[10px] font-bold ${(architecture.reasoning.diff?.costDelta?.aws?.min || 0) < 0 ? "text-emerald-700" : "text-amber-700"}`}>
                            {getProviderCostDeltaString("aws")}
                          </div>
                        )}
                      </td>
                      <td className="p-4 text-xs text-emerald-800 font-extrabold">
                        <div>${azureTotal.min} - ${azureTotal.max}/mo</div>
                        {getProviderCostDeltaString("azure") && (
                          <div className={`text-[10px] font-bold ${(architecture.reasoning.diff?.costDelta?.azure?.min || 0) < 0 ? "text-emerald-700" : "text-amber-700"}`}>
                            {getProviderCostDeltaString("azure")}
                          </div>
                        )}
                      </td>
                      <td className="p-4 text-xs text-emerald-800 font-extrabold">
                        <div>${gcpTotal.min} - ${gcpTotal.max}/mo</div>
                        {getProviderCostDeltaString("gcp") && (
                          <div className={`text-[10px] font-bold ${(architecture.reasoning.diff?.costDelta?.gcp?.min || 0) < 0 ? "text-emerald-700" : "text-amber-700"}`}>
                            {getProviderCostDeltaString("gcp")}
                          </div>
                        )}
                      </td>
                      <td className="p-4 text-xs text-emerald-800 font-extrabold">
                        <div>${k8sTotal.min} - ${k8sTotal.max}/mo</div>
                      </td>
                      <td className="p-4 text-xs text-emerald-800 font-extrabold">
                        <div>${privateTotal.min} - ${privateTotal.max}/mo</div>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
