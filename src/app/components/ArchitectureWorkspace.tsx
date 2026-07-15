"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@iconify/react";
import { TransformWrapper, TransformComponent } from "react-zoom-pan-pinch";
import { runLldRulesEngine } from "@/lib/lld-rules";
import { validateArchitectureLayout, getProviderMaturityWarning } from "@/lib/validation";
import { resolveServiceIcon } from "@/lib/service-icons";
import { getLearnContent, getPlainDescription } from "@/lib/component-descriptions";
import { exportDiagramAsPng, exportDiagramAsSvg, type PngExportEdge, type PngExportNode } from "@/lib/diagram-export";
import { buildFlowDocumentationMarkdown, downloadMarkdown, type FlowDocComponent } from "@/lib/flow-documentation-export";
import {
  verifyJourneyPath,
  buildStepEdgeColors,
  buildStructuralEdgeColors,
  getStepColor,
  type JourneyVerification,
} from "@/lib/journey-verification";
import { computeHealthScore, type HealthScore } from "@/lib/health-score";
import { useStagedLoadingMessage } from "@/app/hooks/useStagedLoadingMessage";
import { useGrowthTrigger } from "@/app/contexts/GrowthTriggerContext";
import { FIELD_EXPLANATIONS } from "@/lib/field-explanations";
import {
  computeDiagramLayoutAsync,
  buildRoundedPath,
  buildFlowBookends,
  USER_NODE_ID,
  CLIENT_NODE_ID,
  RESPONSE_NODE_ID,
  DIAGRAM_NODE_WIDTH,
  DIAGRAM_NODE_HEIGHT,
  type DiagramLayout,
  type FlowBookendNode,
} from "@/lib/diagram-layout";
import InfoTooltip from "./InfoTooltip";
import SourceCitations, { type Citation } from "./SourceCitations";
import BudgetInput from "./BudgetInput";
import NumericInput from "./NumericInput";

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

// Add Component dropdown options -- the source of truth for both rendering the <select> and
// checking whether an AI-suggested type (Workstream W) already has an option, so a suggestion
// whose type isn't in this fixed list (e.g. the LLM's "realtime") can still be reflected in the
// select via a dynamically-added fallback option rather than silently resetting to blank.
const NODE_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "compute", label: "Compute" },
  { value: "db", label: "Database" },
  { value: "cache", label: "Cache" },
  { value: "queue", label: "Queue" },
  { value: "cdn", label: "CDN" },
  { value: "storage", label: "Object Storage" },
  { value: "auth", label: "Auth" },
  { value: "lb", label: "Load Balancer" },
  { value: "tokenization", label: "Tokenization Layer" },
  { value: "audit-log", label: "Audit Log Store" },
  { value: "phi-vault", label: "PHI Data Vault" },
  { value: "deidentification", label: "De-identification Pipeline" },
];

type SubChoiceOption = {
  value: string;
  label: string;
  recommended: boolean;
  reasoning: string;
};

type SubChoiceDef = {
  key: string;
  label: string;
  currentSummaryKeys: string[];
};

// One level more granular than the existing whole-service swap ("Switch to this" under
// Alternatives Considered): these are internal variants WITHIN the already-chosen service
// (e.g. which engine Amazon RDS runs, not RDS-vs-DynamoDB). Deliberately scoped to the 4
// component types with a genuinely meaningful, real internal sub-choice -- not every type gets
// one. Gated on the presence of an LLD config key that only exists on the relevant branch of
// lld_rules.py (e.g. "instanceClass" only appears for relational databases), so a component
// that wouldn't actually offer this choice (a NoSQL database, a serverless function) doesn't
// show a nonsensical option list.
function getSubChoiceDef(nodeType: string, provider: CloudProviderKey, lldConfig: Record<string, string> | undefined): SubChoiceDef | null {
  const config = lldConfig || {};

  if (nodeType === "database" && config.instanceClass) {
    return { key: "engine", label: "Database Engine", currentSummaryKeys: ["engine", "instanceClass", "multiAZ"] };
  }
  if (nodeType === "compute" && (provider === "aws" || provider === "azure" || provider === "gcp") && config.instanceSize) {
    return { key: "containerPlatform", label: "Container Platform", currentSummaryKeys: ["containerPlatform", "instanceSize", "minInstances", "maxInstances"] };
  }
  if (nodeType === "queue" && config.queueType) {
    return { key: "queueType", label: "Queue Type", currentSummaryKeys: ["queueType", "visibilityTimeoutSec"] };
  }
  if (nodeType === "storage") {
    return { key: "storageClass", label: "Storage Class / Tier", currentSummaryKeys: ["storageClass", "lifecycleRule"] };
  }
  return null;
}

function getSubChoiceOptions(
  def: SubChoiceDef,
  provider: CloudProviderKey,
  lldConfig: Record<string, string> | undefined,
  requirements: any
): SubChoiceOption[] {
  const config = lldConfig || {};
  const compliance = (requirements?.nonFunctional?.compliance || "").toLowerCase();
  const teamMaturity = (requirements?.nonFunctional?.teamMaturity || "").toLowerCase();
  const isComplianceSensitive =
    compliance.includes("pci") || compliance.includes("hipaa") || compliance.includes("gdpr") || compliance.includes("soc2");

  if (def.key === "engine") {
    return [
      {
        value: "PostgreSQL 15",
        label: "PostgreSQL 15",
        recommended: !isComplianceSensitive,
        reasoning:
          "Strong ACID guarantees, rich indexing/JSON support, and no per-core licensing concerns -- the safest general-purpose default for transactional data like this.",
      },
      {
        value: "MySQL 8",
        label: "MySQL 8",
        recommended: false,
        reasoning:
          "Extremely wide tooling/hosting familiarity and a simpler default replication model, at the cost of a slightly less feature-rich SQL surface than PostgreSQL.",
      },
      {
        value: "MariaDB 10.11",
        label: "MariaDB 10.11",
        recommended: isComplianceSensitive,
        reasoning: isComplianceSensitive
          ? "A fully open-source MySQL fork with no Oracle affiliation -- often preferred once compliance/licensing review is in scope, with the same operational shape as MySQL."
          : "A fully open-source MySQL fork, functionally close to MySQL but without any Oracle-affiliated licensing ambiguity.",
      },
    ];
  }

  if (def.key === "containerPlatform") {
    const teamKnowsK8s =
      teamMaturity.includes("kubernetes") ||
      teamMaturity.includes("eks") ||
      teamMaturity.includes("aks") ||
      teamMaturity.includes("gke") ||
      teamMaturity.includes("experienced");
    const platformsByProvider: Partial<Record<CloudProviderKey, SubChoiceOption[]>> = {
      aws: [
        {
          value: "Amazon ECS Fargate",
          label: "Amazon ECS Fargate",
          recommended: !teamKnowsK8s,
          reasoning: "Fully managed container orchestration with no cluster to operate -- the lowest ops-overhead path to running containers on AWS.",
        },
        {
          value: "Amazon EKS",
          label: "Amazon EKS (Managed Kubernetes)",
          recommended: teamKnowsK8s,
          reasoning: "Full Kubernetes API access and portability, at the cost of owning cluster upgrades/add-ons -- worth it once the team already has Kubernetes experience.",
        },
        {
          value: "AWS App Runner",
          label: "AWS App Runner",
          recommended: false,
          reasoning: "The simplest possible path from a container image to a running HTTPS service, but with the least infrastructure control of the three.",
        },
      ],
      azure: [
        {
          value: "Azure Container Apps",
          label: "Azure Container Apps",
          recommended: !teamKnowsK8s,
          reasoning: "Serverless containers with built-in scale-to-zero and Dapr integration -- minimal ops overhead for most API workloads.",
        },
        {
          value: "Azure Kubernetes Service (AKS)",
          label: "Azure Kubernetes Service (AKS)",
          recommended: teamKnowsK8s,
          reasoning: "Full managed Kubernetes -- the right call once the team already operates Kubernetes elsewhere.",
        },
        {
          value: "Azure App Service (Containers)",
          label: "Azure App Service (Containers)",
          recommended: false,
          reasoning: "The most mature/battle-tested option for a single container-per-app model, with less flexibility for multi-container workloads.",
        },
      ],
      gcp: [
        {
          value: "Google Cloud Run",
          label: "Google Cloud Run",
          recommended: !teamKnowsK8s,
          reasoning: "Fully managed, scale-to-zero container platform -- the lowest ops-overhead path on GCP for most API workloads.",
        },
        {
          value: "Google Kubernetes Engine (GKE)",
          label: "Google Kubernetes Engine (GKE)",
          recommended: teamKnowsK8s,
          reasoning: "Full managed Kubernetes with Autopilot available -- makes sense once the team already operates Kubernetes elsewhere.",
        },
        {
          value: "Compute Engine (Managed Instance Group)",
          label: "Compute Engine (Managed Instance Group)",
          recommended: false,
          reasoning: "VM-level control for workloads with unusual requirements a container platform can't accommodate, at the cost of managing the VM image/OS yourself.",
        },
      ],
    };
    return platformsByProvider[provider] || [];
  }

  if (def.key === "queueType") {
    const isCurrentlyFifo = (config.queueType || "").startsWith("FIFO");
    return [
      {
        value: "Standard",
        label: "Standard (at-least-once, best-effort order)",
        recommended: !isCurrentlyFifo,
        reasoning: "Higher throughput and simpler scaling -- the right default unless message order or exactly-once processing genuinely matters.",
      },
      {
        value: "FIFO (Strict Ordering)",
        label: "FIFO (strict ordering, exactly-once)",
        recommended: isCurrentlyFifo,
        reasoning:
          "Guarantees messages are processed in the exact order they were sent and exactly once -- required whenever out-of-order or duplicate processing would corrupt state (e.g. sequential financial transactions).",
      },
    ];
  }

  if (def.key === "storageClass") {
    const current = config.storageClass || "Standard (Hot)";
    return [
      {
        value: "Standard (Hot)",
        label: "Standard (Hot)",
        recommended: current === "Standard (Hot)",
        reasoning: "Optimized for frequently-accessed data with no retrieval latency or fee -- the right default for anything actively read/written.",
      },
      {
        value: "Infrequent Access (Cool)",
        label: "Infrequent Access (Cool)",
        recommended: current === "Infrequent Access (Cool)",
        reasoning: "Lower per-GB storage cost in exchange for a small retrieval fee -- fits data accessed roughly monthly or less, like older exports or backups.",
      },
      {
        value: "Archive (Cold)",
        label: "Archive (Cold)",
        recommended: current === "Archive (Cold)",
        reasoning: "The lowest storage cost available, but retrieval can take minutes to hours -- appropriate only for compliance/regulatory retention data you rarely if ever need to read back.",
      },
    ];
  }

  return [];
}

// Honest, staged descriptions of what the generation call is actually doing server-side —
// shown progressively (not tied to real server progress events) to make the ~30-45s wait
// legible instead of a single unmoving spinner.
const GENERATION_STAGES = [
  "Analyzing your requirements...",
  "Working through your requirements...",
  "Validating decisions with AI...",
  "Mapping to cloud services (AWS/Azure/GCP)...",
  "Working out the technical details for each service...",
  "Finalizing cost estimates...",
];
const GENERATION_STAGE_INTERVAL_MS = 8000;

// Staged phrases for the growth-trigger analyze/apply lifecycle (GrowthTriggerContext) -- shorter
// and faster-cycling than GENERATION_STAGES above since propose-changes/manual-save are both much
// lighter calls than a full architecture generation.
const GROWTH_ANALYZING_STAGES = [
  "Reviewing your requested changes...",
  "Working out which components this affects...",
  "Almost done...",
];
const GROWTH_APPLYING_STAGES = ["Updating the architecture...", "Saving the new version..."];
const GROWTH_STAGE_INTERVAL_MS = 3200;

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
  // Knowledge-base RAG (architecture/software-engineering book corpus) -- only present when
  // retrieval genuinely found something the LLM drew on for THIS component; absent (not an empty
  // array) is the normal case for most components.
  sources?: Citation[];
  // Domain-awareness feature -- a short, visibly-labeled note when this component's reasoning
  // genuinely drew on a well-known DOMAIN-TYPICAL pattern (e.g. "common e-commerce pattern")
  // rather than being derived purely from this project's own stated requirements. Kept as its own
  // field (never blended into "reasoning") so the UI can render it distinctly from both the plain
  // reasoning text and the book citations in "sources" -- three different kinds of grounding.
  domainPattern?: string;
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

type JourneyStep = {
  userAction: string;
  systemResponse: string;
  componentIds: string[];
};

type SecurityFinding = {
  severity: "high" | "medium" | "low";
  title: string;
  description: string;
  componentId: string | null;
  componentName: string | null;
  recommendation: string;
};

type MigrationPhase = {
  phase: number;
  title: string;
  whatChanges: string;
  why: string;
  usesStranglerFig: boolean;
  effort: "small" | "medium" | "large";
  domainPattern?: string;
};

type ArchitectureData = {
  id: string;
  version: string;
  hld: {
    components: ComponentData[];
    connections: ConnectionData[];
  };
  flowStory?: Record<string, string>;
  flowStorySources?: Record<string, Citation[]>;
  journeySteps?: Record<string, JourneyStep[]>;
  layoutOverrides?: Record<string, { x: number; y: number }>;
  securityFindings?: Record<string, SecurityFinding[]>;
  migrationRoadmap?: Record<string, MigrationPhase[]>;
  reasoning: {
    decisions: any[];
    assumptions: string[];
    risks: string[];
    recommendation?: {
      recommendedProvider: "aws" | "azure" | "gcp";
      rationale: string;
      keyTradeoffs: string[];
      sources?: Citation[];
      domainPattern?: string;
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
  const generationStage = useStagedLoadingMessage(generating, GENERATION_STAGES, GENERATION_STAGE_INTERVAL_MS);
  const growthTrigger = useGrowthTrigger();
  const growthAnalyzingStage = useStagedLoadingMessage(
    growthTrigger.status === "analyzing",
    GROWTH_ANALYZING_STAGES,
    GROWTH_STAGE_INTERVAL_MS
  );
  const growthApplyingStage = useStagedLoadingMessage(
    growthTrigger.status === "applying",
    GROWTH_APPLYING_STAGES,
    GROWTH_STAGE_INTERVAL_MS
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [activeProvider, setActiveProvider] = useState<CloudProviderKey>("aws");
  const [viewMode, setViewMode] = useState<"diagram" | "comparison" | "journey" | "migration">("diagram");
  const [isLldExpanded, setIsLldExpanded] = useState(false);
  // Collapsed by default -- learning depth is available on demand, not imposed on expert users
  // who already know what a message queue is.
  const [isLearnExpanded, setIsLearnExpanded] = useState(false);
  // Simple is the default for every new session -- matches the goal of being usable with
  // zero architecture background. Technical is one click away, not buried.
  const [explanationMode, setExplanationMode] = useState<"simple" | "technical">("simple");
  const [error, setError] = useState("");
  // Paired with `error` so the Retry button always re-attempts whatever actually failed. Six
  // different handlers write to the shared `error` state above (generate, both exports, docs
  // export, manual save, apply-proposals) -- without this, the render-site Retry button was
  // hard-wired to handleGenerate regardless of which of those six actually threw, so clicking
  // Retry after e.g. a failed export silently kicked off a full architecture regeneration
  // instead. Wrapped in `() => fn` when set, since useState would otherwise call a bare function
  // value immediately as an updater.
  const [errorRetryAction, setErrorRetryAction] = useState<(() => void) | null>(null);
  const [versionList, setVersionList] = useState<ArchitectureData[]>([]);
  // Evolution History -- collapsed by default, a supplementary deep-dive next to the always-
  // visible Flow Story, not a replacement for it.
  const [isEvolutionHistoryExpanded, setIsEvolutionHistoryExpanded] = useState(false);

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

  // Manual Editor Controls (Workstream W) -- AI-suggested components worth adding next, based on
  // the current draft + real requirements. Fetched once on entering edit mode and via a manual
  // refresh, not on every draft change, since it calls the LLM.
  const [componentSuggestions, setComponentSuggestions] = useState<
    { type: string; name: string; reasoning: string }[]
  >([]);
  const [componentSuggestionsLoading, setComponentSuggestionsLoading] = useState(false);

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
  // not an extra click) and closed in Simple mode; the Learn panel always starts collapsed --
  // both re-applied whenever the selected node changes so switching components doesn't leave a
  // stale expand/collapse state behind.
  useEffect(() => {
    setIsLldExpanded(explanationMode === "technical");
    setIsLearnExpanded(false);
  }, [selectedNodeId, explanationMode]);

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
      setErrorRetryAction(null);
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
      // Workstream X: "Regenerate Design" now goes through a preview step first (see
      // handlePreviewRegenerate below) -- once the real version is actually created here, that
      // preview is stale, so clear it rather than leave a confirm/discard panel referencing a
      // version that's already been superseded.
      setRegeneratePreview(null);
    } catch (err: any) {
      setError(err.message || "An unexpected error occurred during generation.");
      setErrorRetryAction(() => handleGenerate);
    } finally {
      setGenerating(false);
    }
  };

  // Workstream X: "Regenerate Design" used to call handleGenerate directly and silently create a
  // new persisted version with no preview -- every other edit pathway here (Manual Editor
  // Controls, service swap, chat enhancement proposals, What-If) stages a draft/preview before an
  // explicit confirm. This closes that gap by reusing the EXACT SAME whatif-preview endpoint, just
  // called with the project's current real requirements unchanged -- since generate_architecture_
  // bundle is called identically either way (same reqs_context, same latest-architecture diff
  // baseline), the preview this returns is byte-for-byte what "Regenerate Design" would actually
  // produce, without persisting anything until the user explicitly applies it.
  const [regeneratePreview, setRegeneratePreview] = useState<WhatIfPreviewData | null>(null);
  const [regeneratePreviewLoading, setRegeneratePreviewLoading] = useState(false);
  const [regenerateError, setRegenerateError] = useState("");
  const regeneratePreviewRef = useRef<HTMLDivElement>(null);

  const handlePreviewRegenerate = async () => {
    if (isGenerationBlocked || !requirements) return;
    setRegenerateError("");
    setRegeneratePreviewLoading(true);
    setRegeneratePreview(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/architectures/whatif-preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          functional: requirements.functional,
          nonFunctional: requirements.nonFunctional,
          industryContext: requirements.industryContext,
        }),
      });
      if (!res.ok) throw new Error("Failed to preview the regenerated design");
      const data = await res.json();
      setRegeneratePreview(data);
    } catch (err: any) {
      setRegenerateError(err.message || "Something went wrong generating this preview.");
    } finally {
      setRegeneratePreviewLoading(false);
    }
  };

  const regenerateCostPreview = (): { before: { min: number; max: number }; after: { min: number; max: number } } | null => {
    if (!architecture || !regeneratePreview) return null;
    const before = calculateTotalCost(activeProvider);
    const after = regeneratePreview.components.reduce(
      (acc, c) => {
        const mapping = getMappingForProvider(c, activeProvider);
        return { min: acc.min + (mapping?.costEstimate.min || 0), max: acc.max + (mapping?.costEstimate.max || 0) };
      },
      { min: 0, max: 0 }
    );
    return { before, after };
  };

  const handleExport = async () => {
    if (!architecture) return;
    try {
      setManifestExportBusy(true);
      setError("");
      setErrorRetryAction(null);

      const res = await fetch(`/api/projects/${projectId}/export?provider=${activeProvider}`);
      if (!res.ok) {
        // Previously a raw `window.location.href` navigation -- a backend error (404, 500, an
        // expired session) navigated the whole tab away to a raw JSON error body with zero
        // feedback and no way to retry without reloading. Fetching first means a failure can be
        // caught and surfaced the same way every other export failure already is.
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to export. Please try again.");
      }

      const blob = await res.blob();
      // Reuse the filename the backend already computed (safe_name-export_label-provider.zip)
      // rather than re-deriving it client-side -- one source of truth for the naming scheme.
      const disposition = res.headers.get("Content-Disposition") || "";
      const filenameMatch = disposition.match(/filename="([^"]+)"/);
      const filename = filenameMatch ? filenameMatch[1] : `architecture-${activeProvider}.zip`;

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      console.error("Manifest export failed:", err);
      setError(err.message || "Failed to export. Please try again.");
      setErrorRetryAction(() => () => handleExport());
    } finally {
      setManifestExportBusy(false);
    }
  };

  // Exports the diagram itself as an image -- a separate concern from handleExport above, which
  // downloads deployable Terraform/K8s config. This just captures the picture.
  const handleExportDiagramImage = async (format: "svg" | "png") => {
    setImageExportOpen(false);
    if (!architecture) return;
    const filenameBase = `architecture-diagram-v${architecture.version}`;
    try {
      setImageExportBusy(true);
      setError("");
      setErrorRetryAction(null);
      if (format === "svg") {
        const svgEl = diagramSvgRef.current;
        if (!svgEl) return;
        exportDiagramAsSvg(svgEl, filenameBase);
      } else {
        // Pure-SVG twin, not the live foreignObject-based DOM -- canvas.toBlob() throws on any
        // SVG containing foreignObject regardless of content, so PNG export builds its own
        // simplified rect/text representation from the same layout data instead (see
        // diagram-export.ts for why).
        const realPngNodes: PngExportNode[] = diagramComponents
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

        // End-to-end flow bookends (Workstream R) -- included so the exported image matches
        // what's on screen, same principle as the orthogonal routing/drag positions above.
        const bookendPngNodes: PngExportNode[] = [];
        for (const n of bookendNodes) {
          const coord = nodeCoords[n.id];
          if (!coord) continue;
          bookendPngNodes.push({
            id: n.id,
            x: coord.x,
            y: coord.y,
            width: coord.width,
            height: coord.height,
            label: n.kind === "user" ? "Start" : n.kind === "client" ? "Frontend" : "End",
            serviceName: n.name,
            isCompliance: false,
            isOverride: false,
            accentHex: "#12161F",
            isBookend: true,
          });
        }

        const pngNodes: PngExportNode[] = [...realPngNodes, ...bookendPngNodes];

        const pngEdges: PngExportEdge[] = layoutConnections
          .map((conn) => {
            const points = diagramLayout.edgePoints[`${conn.from}->${conn.to}`];
            if (!points || points.length < 2) return null;
            // Same rounded-corner path builder the live diagram uses (see below) -- export must
            // match what's on screen exactly, orthogonal routing and manual repositioning
            // included, not a simplified straight-line re-derivation.
            return { d: buildRoundedPath(points) };
          })
          .filter((e): e is PngExportEdge => e !== null);

        await exportDiagramAsPng(pngNodes, pngEdges, diagramLayout.width, diagramLayout.height, filenameBase);
      }
    } catch (err) {
      console.error("Diagram image export failed:", err);
      setError("Failed to export diagram image. Please try again.");
      setErrorRetryAction(() => () => handleExportDiagramImage(format));
    } finally {
      setImageExportBusy(false);
    }
  };

  const [docsExportBusy, setDocsExportBusy] = useState(false);

  // Separate export action from both Export TF (deployable code) and Export Image (just the
  // picture) -- this is the only one with narrative explanation baked in, by design.
  const handleExportFlowDocs = async () => {
    if (!architecture) return;
    setImageExportOpen(false);
    try {
      setDocsExportBusy(true);
      setError("");
      setErrorRetryAction(null);

      const [projectRes, summaryRes] = await Promise.all([
        fetch(`/api/projects/${projectId}`),
        fetch(`/api/projects/${projectId}/requirements/summary`, { method: "POST" }),
      ]);
      const projectName = projectRes.ok ? (await projectRes.json())?.project?.name : undefined;
      const conversationSummary = summaryRes.ok ? (await summaryRes.json())?.summary : null;

      const components: FlowDocComponent[] = architecture.hld.components.map((c) => {
        const mapping = getMappingForProvider(c, activeProvider);
        return {
          name: c.name,
          type: c.type,
          serviceName: mapping?.serviceName || c.name,
          reasoning: c.reasoning || "",
        };
      });

      const costs = calculateTotalCost(activeProvider);
      const markdown = buildFlowDocumentationMarkdown({
        projectName: projectName || "Untitled Project",
        providerLabel: PROVIDER_LABELS[activeProvider],
        version: architecture.version,
        conversationSummary,
        flowStory: currentFlowStory || null,
        components,
        costMin: costs.min,
        costMax: costs.max,
      });

      downloadMarkdown(markdown, `architecture-docs-v${architecture.version}-${activeProvider}`);
    } catch (err) {
      console.error("Flow documentation export failed:", err);
      setError("Failed to export architecture documentation. Please try again.");
      setErrorRetryAction(() => handleExportFlowDocs);
    } finally {
      setDocsExportBusy(false);
    }
  };

  const [execSummaryExportBusy, setExecSummaryExportBusy] = useState(false);

  // Executive Summary Export (Workstream T2) -- the one export meant for a non-technical reader:
  // no diagrams, no code, no component/service names. A fetch+blob download (not a raw
  // window.location navigation like handleExport below) since this round-trips through an LLM
  // call and needs a loading state / error handling a plain navigation can't show.
  const handleExportExecutiveSummary = async () => {
    if (!architecture) return;
    setImageExportOpen(false);
    try {
      setExecSummaryExportBusy(true);
      setError("");
      setErrorRetryAction(null);
      const res = await fetch(`/api/projects/${projectId}/export/executive-summary?provider=${activeProvider}`);
      if (!res.ok) throw new Error("Failed to generate the executive summary");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `executive-summary-v${architecture.version}-${activeProvider}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Executive summary export failed:", err);
      setError("Failed to generate the executive summary. Please try again.");
      setErrorRetryAction(() => handleExportExecutiveSummary);
    } finally {
      setExecSummaryExportBusy(false);
    }
  };

  const loadComponentSuggestions = (components: ComponentData[], connections: { from: string; to: string; protocol?: string }[]) => {
    setComponentSuggestionsLoading(true);
    fetch(`/api/projects/${projectId}/architectures/component-suggestions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ components, connections }),
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("Failed to load component suggestions"))))
      .then((data) => setComponentSuggestions(data.suggestions || []))
      .catch((err) => console.error("Failed to load component suggestions:", err))
      .finally(() => setComponentSuggestionsLoading(false));
  };

  const handleEnterEditMode = () => {
    if (!architecture) return;
    const components = JSON.parse(JSON.stringify(architecture.hld.components));
    const connections = JSON.parse(JSON.stringify(architecture.hld.connections));
    setDraftHld({ components, connections });
    setIsEditing(true);
    setError("");
    const firstNode = architecture.hld.components[0]?.id || "";
    const secondNode = architecture.hld.components[1]?.id || "";
    setNewEdgeFrom(firstNode);
    setNewEdgeTo(secondNode);
    setComponentSuggestions([]);
    loadComponentSuggestions(components, connections);
  };

  const applyComponentSuggestion = (s: { type: string; name: string; reasoning: string }) => {
    setNewNodeType(s.type);
    setNewNodeName(s.name);
    setNewNodeReasoning(s.reasoning);
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
      setErrorRetryAction(null);
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
      setErrorRetryAction(() => handleSaveManualChanges);
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

  // Workstream X: a running draft-vs-current-saved-version summary for Manual Editor Controls --
  // every other draft edit pathway here (What-If, Regenerate) shows a before/after diff before its
  // confirm button; the manual editor previously only showed the live-edited diagram itself with
  // no explicit comparison against the last saved version. Purely a client-side structural diff
  // (id presence/name/type/service changes) -- unlike compute_architecture_diff server-side, there's
  // no LLM reasoning to generate here, just "what's different from what's saved."
  const draftDiffSummary = useMemo(() => {
    if (!isEditing || !draftHld || !architecture) return null;
    const savedById = new Map(architecture.hld.components.map((c) => [c.id, c]));
    const draftById = new Map(draftHld.components.map((c) => [c.id, c]));
    const added = draftHld.components.filter((c) => !savedById.has(c.id));
    const removed = architecture.hld.components.filter((c) => !draftById.has(c.id));
    const modified = draftHld.components
      .filter((c) => savedById.has(c.id))
      .map((c) => {
        const original = savedById.get(c.id)!;
        const changes: { parameter: string; oldVal: string; newVal: string }[] = [];
        if (original.name !== c.name) changes.push({ parameter: "name", oldVal: original.name, newVal: c.name });
        if (original.type !== c.type) changes.push({ parameter: "type", oldVal: original.type, newVal: c.type });
        const origService = getMappingForProvider(original, activeProvider)?.serviceName;
        const draftService = getMappingForProvider(c, activeProvider)?.serviceName;
        if (origService && draftService && origService !== draftService) {
          changes.push({ parameter: "service", oldVal: origService, newVal: draftService });
        }
        return { id: c.id, name: c.name, changes };
      })
      .filter((m) => m.changes.length > 0);
    const connectionKey = (conns: ConnectionData[]) =>
      [...conns].map((c) => `${c.from}->${c.to}:${c.protocol}`).sort().join("|");
    const connectionsChanged = connectionKey(draftHld.connections) !== connectionKey(architecture.hld.connections);
    return {
      added,
      removed,
      modified,
      connectionsChanged,
      hasChanges: added.length > 0 || removed.length > 0 || modified.length > 0 || connectionsChanged,
    };
  }, [isEditing, draftHld, architecture, activeProvider]);

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

  // End-to-end flow bookends (Workstream R) -- purely a rendering-layer overlay, never written
  // to hld.components/connections, never exported to Terraform, never priced. diagramComponents/
  // diagramConnections (real infra data used everywhere else: drawer, editing, sub-choices,
  // Terraform export) stay completely untouched; these are merged in ONLY for layout+rendering+
  // image export, computed fresh from whatever the current graph shape is so every existing
  // project gets this immediately with no migration.
  const { nodes: bookendNodes, connections: bookendConnections } = buildFlowBookends(diagramComponents, diagramConnections);
  const layoutComponents = [...diagramComponents, ...bookendNodes];
  const layoutConnections = [...diagramConnections, ...bookendConnections];

  // Manual drag-to-reposition overrides (Workstream Q) -- local state seeded from whatever the
  // loaded architecture version already has saved, optimistically updated on drag and persisted
  // via a lightweight PATCH that merges into the CURRENT version's layout_overrides without
  // creating a new version (purely cosmetic, not a content change -- same precedent as
  // flow_story/journey_steps elsewhere on this same model).
  const [layoutOverrides, setLayoutOverrides] = useState<Record<string, { x: number; y: number }>>({});
  useEffect(() => {
    setLayoutOverrides(architecture?.layoutOverrides || {});
  }, [architecture?.id]);

  const [diagramLayout, setDiagramLayout] = useState<DiagramLayout>({ nodes: {}, edgePoints: {}, width: 400, height: 300 });
  // ELK's layout() is async (unlike the old dagre call), so this has to be an effect rather than
  // a plain computed value. Keyed off a flattened string rather than the raw arrays/objects
  // directly, since diagramComponents/diagramConnections are freshly-derived (non-stable
  // reference) on every render -- depending on them directly would re-run ELK on every render.
  const layoutKey = `${layoutComponents.map((c) => c.id).join(",")}|${layoutConnections
    .map((c) => `${c.from}-${c.to}`)
    .join(",")}|${JSON.stringify(layoutOverrides)}`;
  useEffect(() => {
    let cancelled = false;
    computeDiagramLayoutAsync(layoutComponents, layoutConnections, layoutOverrides).then((result) => {
      if (!cancelled) setDiagramLayout(result);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey]);

  const nodeCoords = diagramLayout.nodes;

  // Drag-to-reposition (Workstream Q) -- live drag preview is a separate, ephemeral piece of
  // state from layoutOverrides so dragging doesn't trigger an ELK re-layout on every pointer-move
  // frame (only the final drop does, via layoutOverrides). renderCoords overlays the live drag
  // position onto nodeCoords for whichever single node is currently being dragged, so both the
  // node itself and its connected edges track the pointer smoothly.
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [dragPreviewPos, setDragPreviewPos] = useState<{ x: number; y: number } | null>(null);
  const dragStartRef = useRef<{ screenX: number; screenY: number; nodeX: number; nodeY: number } | null>(null);
  const renderCoords =
    draggingNodeId && dragPreviewPos
      ? { ...nodeCoords, [draggingNodeId]: { ...nodeCoords[draggingNodeId], ...dragPreviewPos } }
      : nodeCoords;

  const handleNodePointerDown = (e: React.PointerEvent, nodeId: string) => {
    // Left-button/primary pointer only, and never while manually connecting edges (the "+ Add
    // Connection" flow) or the node is being clicked for its own remove button, which stops
    // propagation before this ever fires.
    if (e.button !== 0) return;
    e.stopPropagation();
    const coord = nodeCoords[nodeId];
    if (!coord) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragStartRef.current = { screenX: e.clientX, screenY: e.clientY, nodeX: coord.x, nodeY: coord.y };
    setDraggingNodeId(nodeId);
  };

  const handleNodePointerMove = (e: React.PointerEvent) => {
    if (!draggingNodeId || !dragStartRef.current) return;
    const scale = diagramTransformRef.current?.state?.scale || 1;
    const dx = (e.clientX - dragStartRef.current.screenX) / scale;
    const dy = (e.clientY - dragStartRef.current.screenY) / scale;
    setDragPreviewPos({ x: dragStartRef.current.nodeX + dx, y: dragStartRef.current.nodeY + dy });
  };

  const handleNodePointerUp = async (e: React.PointerEvent, nodeId: string) => {
    if (draggingNodeId !== nodeId) return;
    const start = dragStartRef.current;
    dragStartRef.current = null;
    setDraggingNodeId(null);

    if (!start || !dragPreviewPos || !architecture) {
      setDragPreviewPos(null);
      return;
    }
    const moved = Math.hypot(e.clientX - start.screenX, e.clientY - start.screenY) > 3;
    const finalPos = dragPreviewPos;
    setDragPreviewPos(null);
    if (!moved) return; // a plain click, not a drag -- let the node's own onClick select it

    setLayoutOverrides((prev) => ({ ...prev, [nodeId]: finalPos }));
    try {
      await fetch(`/api/projects/${projectId}/architectures/${architecture.id}/layout`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ componentId: nodeId, x: finalPos.x, y: finalPos.y }),
      });
    } catch (err) {
      console.error("Failed to persist node position:", err);
    }
  };

  const selectedNode = isEditing
    ? draftHld?.components.find((c) => c.id === selectedNodeId)
    : architecture?.hld.components.find((c) => c.id === selectedNodeId);

  // Plain-language data-flow context for the drawer -- who this component sends requests to,
  // and who sends requests to it, using the component names a non-architect would recognize
  // rather than raw ids.
  const nodeNameById = (id: string) => diagramComponents.find((c) => c.id === id)?.name || id;

  // Evolution History -- entirely derived from versionList (already fetched in full for the
  // version dropdown) and each version's already-computed reasoning.diff, never a new fetch or
  // LLM call. versionList arrives newest-first (matches the dropdown); this reverses it to
  // chronological order so "Initial" is first and each later entry is the delta from the one
  // right before it, exactly as already stored per version at generation/save time.
  type EvolutionPhase = {
    version: string;
    createdAt: string;
    isInitial: boolean;
    componentCount: number;
    added: NonNullable<ArchitectureData["reasoning"]["diff"]>["added"];
    removed: NonNullable<ArchitectureData["reasoning"]["diff"]>["removed"];
    modified: NonNullable<ArchitectureData["reasoning"]["diff"]>["modified"];
  };
  const evolutionPhases: EvolutionPhase[] = [...versionList].reverse().map((v) => ({
    version: v.version,
    createdAt: v.createdAt,
    isInitial: !v.reasoning.diff,
    componentCount: v.hld.components.length,
    added: v.reasoning.diff?.added || [],
    removed: v.reasoning.diff?.removed || [],
    modified: v.reasoning.diff?.modified || [],
  }));
  const initialPhaseComponents = versionList.length > 0 ? [...versionList].reverse()[0].hld.components : [];

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
  const [manifestExportBusy, setManifestExportBusy] = useState(false);
  const imageExportRef = useRef<HTMLSpanElement>(null);

  // Fullscreen diagram mode (Workstream Q) -- more room to visually untangle complex
  // architectures. Escape exits it, same as any other fullscreen/modal UI convention.
  const [isDiagramFullscreen, setIsDiagramFullscreen] = useState(false);
  useEffect(() => {
    if (!isDiagramFullscreen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsDiagramFullscreen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = "";
    };
  }, [isDiagramFullscreen]);

  // Architecture Flow Story -- generated per provider, cached both server-side (on the
  // architecture row) and here client-side (so toggling between providers you've already
  // viewed doesn't even cost a network round trip). Refetches only when the architecture
  // version or active provider actually changes.
  const [flowStoryCache, setFlowStoryCache] = useState<Record<string, string>>({});
  const [flowStorySourcesCache, setFlowStorySourcesCache] = useState<Record<string, Citation[]>>({});
  const [flowStoryLoading, setFlowStoryLoading] = useState(false);
  const flowStoryKey = architecture ? `${architecture.id}:${activeProvider}` : null;
  const currentFlowStory = flowStoryKey ? flowStoryCache[flowStoryKey] : undefined;
  const currentFlowStorySources = flowStoryKey ? flowStorySourcesCache[flowStoryKey] : undefined;

  useEffect(() => {
    if (!architecture) return;
    const key = `${architecture.id}:${activeProvider}`;
    if (flowStoryCache[key]) return;

    const embedded = architecture.flowStory?.[activeProvider];
    if (embedded) {
      setFlowStoryCache((prev) => ({ ...prev, [key]: embedded }));
      const embeddedSources = architecture.flowStorySources?.[activeProvider];
      if (embeddedSources) setFlowStorySourcesCache((prev) => ({ ...prev, [key]: embeddedSources }));
      return;
    }

    let cancelled = false;
    setFlowStoryLoading(true);
    fetch(`/api/projects/${projectId}/architectures/${architecture.id}/flow-story?provider=${activeProvider}`, {
      method: "POST",
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("Failed to load flow story"))))
      .then((data) => {
        if (cancelled) return;
        setFlowStoryCache((prev) => ({ ...prev, [key]: data.story }));
        setFlowStorySourcesCache((prev) => ({ ...prev, [key]: data.sources || [] }));
      })
      .catch((err) => console.error("Failed to load flow story:", err))
      .finally(() => {
        if (!cancelled) setFlowStoryLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [architecture, activeProvider]);

  // User Journey Architecture -- restructures the flow story (above) into discrete end-user
  // steps, per provider. Fetched lazily only when this tab is opened OR the Topology View's
  // "Flow Steps" color overlay is switched on (unlike flow story, which is always visible under
  // the diagram) to avoid an extra LLM call most sessions never need; cached the same way once
  // fetched.
  const [journeyCache, setJourneyCache] = useState<Record<string, JourneyStep[]>>({});
  const [journeyVerificationCache, setJourneyVerificationCache] = useState<Record<string, JourneyVerification>>({});
  const [journeyLoading, setJourneyLoading] = useState(false);
  const [showFlowSteps, setShowFlowSteps] = useState(false);
  const [flowStepsExpanded, setFlowStepsExpanded] = useState(false);
  const journeyKey = architecture ? `${architecture.id}:${activeProvider}` : null;
  const currentJourney = journeyKey ? journeyCache[journeyKey] : undefined;
  const currentJourneyVerification = journeyKey ? journeyVerificationCache[journeyKey] : undefined;

  useEffect(() => {
    if ((viewMode !== "journey" && !showFlowSteps) || !architecture) return;
    const key = `${architecture.id}:${activeProvider}`;
    if (journeyCache[key]) return;

    // Verification is recomputed here client-side (mirroring backend/app/services/
    // path_verification.py) rather than trusted from the fetch response alone, so the "Verified"
    // badge is correct even on the embedded-cache path below, which never hits the endpoint that
    // computes it server-side.
    const embedded = architecture.journeySteps?.[activeProvider];
    if (embedded) {
      setJourneyCache((prev) => ({ ...prev, [key]: embedded }));
      setJourneyVerificationCache((prev) => ({
        ...prev,
        [key]: verifyJourneyPath(embedded, diagramComponents, diagramConnections),
      }));
      return;
    }

    let cancelled = false;
    setJourneyLoading(true);
    fetch(`/api/projects/${projectId}/architectures/${architecture.id}/journey?provider=${activeProvider}`, {
      method: "POST",
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("Failed to load user journey"))))
      .then((data) => {
        if (cancelled) return;
        setJourneyCache((prev) => ({ ...prev, [key]: data.journeySteps }));
        setJourneyVerificationCache((prev) => ({
          ...prev,
          [key]: data.verification || verifyJourneyPath(data.journeySteps, diagramComponents, diagramConnections),
        }));
      })
      .catch((err) => console.error("Failed to load user journey:", err))
      .finally(() => {
        if (!cancelled) setJourneyLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [viewMode, showFlowSteps, architecture, activeProvider]);

  // Migration Roadmap (Workstream T5) -- a phased plan from the project's stated existing system
  // (captured at intake) to this target architecture. Fetched lazily only when this tab is
  // opened, same caching discipline as flow story / user journey above.
  const [migrationCache, setMigrationCache] = useState<Record<string, MigrationPhase[]>>({});
  const [migrationLoading, setMigrationLoading] = useState(false);
  const [migrationError, setMigrationError] = useState("");
  const migrationKey = architecture ? `${architecture.id}:${activeProvider}` : null;
  const currentMigrationRoadmap = migrationKey ? migrationCache[migrationKey] : undefined;

  useEffect(() => {
    if (viewMode !== "migration" || !architecture) return;
    const key = `${architecture.id}:${activeProvider}`;
    if (migrationCache[key]) return;

    const embedded = architecture.migrationRoadmap?.[activeProvider];
    if (embedded) {
      setMigrationCache((prev) => ({ ...prev, [key]: embedded }));
      return;
    }

    let cancelled = false;
    setMigrationLoading(true);
    setMigrationError("");
    fetch(`/api/projects/${projectId}/architectures/${architecture.id}/migration-roadmap?provider=${activeProvider}`, {
      method: "POST",
    })
      .then((res) => (res.ok ? res.json() : res.json().then((d) => Promise.reject(new Error(d.detail || "Failed to load the migration roadmap")))))
      .then((data) => {
        if (cancelled) return;
        setMigrationCache((prev) => ({ ...prev, [key]: data.phases }));
      })
      .catch((err) => {
        if (!cancelled) setMigrationError(err.message || "Failed to load the migration roadmap");
      })
      .finally(() => {
        if (!cancelled) setMigrationLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [viewMode, architecture, activeProvider]);

  // Multi-colored flow paths (Workstream S) -- an overlay ONLY: recolors the stroke of edges
  // ELK already routed, never recomputes their geometry. Each journey step gets a fixed color;
  // an edge wholly within one step, or bridging step i to step i+1, is colored accordingly.
  // Not memoized -- cheap pure function over a handful of connections, consistent with
  // diagramComponents/diagramConnections above, which are also plain recomputed consts.
  const stepEdgeInfo = showFlowSteps && currentJourney ? buildStepEdgeColors(currentJourney, diagramConnections) : {};
  // Fallback for connections the currently-traced journey doesn't touch at all -- without this,
  // most of a real diagram stayed a single undifferentiated blue, making it impossible to tell
  // which of several parallel/overlapping lines went to which component.
  const structuralEdgeColors = showFlowSteps ? buildStructuralEdgeColors(diagramConnections) : {};

  const handleJourneyComponentClick = (componentId: string) => {
    setViewMode("diagram");
    setSelectedNodeId(componentId);
  };

  // Chat-based Enhancement Proposals -- triggered when a growth-trigger chat conversation
  // concludes. The analyze/review/apply lifecycle (status, description, the fetched proposals
  // themselves) lives in GrowthTriggerContext, mounted above the tab-switching boundary in
  // ProjectWorkspaceGrid -- NOT as local state here -- so it survives the user switching away
  // from this tab mid-process, and so the analysis actually starts the moment the chat side
  // triggers it even if this component isn't mounted yet. Only per-review-session UI state that's
  // fine to lose if the tab remounts (which decisions/discussions are open, not the proposals
  // themselves) stays local below. Nothing is persisted to the architecture until the user
  // approves individual cards and clicks Apply, which reuses the same manual-save endpoint/
  // versioning the manual editor already uses.
  type ProposedChange = {
    action: "add" | "modify";
    componentId: string;
    componentType: string;
    componentName: string;
    reasoning: string;
    serviceName: string;
    component?: ComponentData;
    newConnections?: ConnectionData[];
    previousReasoning?: string;
    domainPattern?: string;
  };
  const pendingDescription = growthTrigger.description;
  const proposals = growthTrigger.proposals as ProposedChange[];
  const proposalsLoading = growthTrigger.status === "analyzing";
  const [proposalDecisions, setProposalDecisions] = useState<Record<string, "approved" | "rejected">>({});
  const [applyingProposals, setApplyingProposals] = useState(false);

  // Batch selection -- independent of proposalDecisions (accept/reject). A checkbox here just
  // marks a card as "in scope" for the next Accept Selected / Reject Selected click; individual
  // per-card Accept/Reject buttons still work standalone without touching selection at all.
  const [selectedProposalIds, setSelectedProposalIds] = useState<Set<string>>(new Set());

  // Inline discuss/refine, scoped per proposal. Keyed by componentId so multiple cards could in
  // principle have independent histories; only one thread is expanded (openDiscussionId) at a
  // time for layout simplicity, but that's a display choice only -- accepting/rejecting any
  // OTHER card is never blocked by an open discussion, since decisions live in the separate
  // proposalDecisions map untouched by this state.
  type DiscussMessage = { role: "user" | "assistant"; text: string };
  const [proposalDiscussions, setProposalDiscussions] = useState<Record<string, DiscussMessage[]>>({});
  const [openDiscussionId, setOpenDiscussionId] = useState<string | null>(null);
  const [discussionInput, setDiscussionInput] = useState("");
  const [discussionLoading, setDiscussionLoading] = useState(false);

  // What-If Simulator (Workstream T1, extended per explicit feedback) -- a sandbox for exploring
  // a hypothetical that varies ANY requirement field (not just scale/budget): functional
  // capabilities, all 7 non-functional fields, industry/compliance context, plus a freeform note
  // for anything that doesn't map to a structured field. Runs the exact same rules-engine + LLM
  // pipeline real generation uses (architecture_generation.py's generate_architecture_bundle,
  // called via the new /architectures/whatif-preview endpoint) against these hypothetical values,
  // never persisting anything. Kept as entirely separate state from proposals/pendingDescription
  // above so exploring a what-if scenario never clobbers (or gets clobbered by) a live
  // growth-trigger review.
  type WhatIfNFR = {
    expectedScale: string;
    readWritePattern: string;
    dataNature: string;
    latencySensitivity: string;
    budget: string;
    teamMaturity: string;
    compliance: string;
  };
  const BLANK_NFR: WhatIfNFR = {
    expectedScale: "",
    readWritePattern: "",
    dataNature: "",
    latencySensitivity: "",
    budget: "",
    teamMaturity: "",
    compliance: "",
  };
  const NFR_FIELD_LABELS: Record<keyof WhatIfNFR, string> = {
    expectedScale: "Expected Traffic / Scale",
    readWritePattern: "Mostly Saving or Looking Up Data?",
    dataNature: "Data Types",
    latencySensitivity: "How Fast It Needs to Feel",
    budget: "Budget Range",
    teamMaturity: "Your Team's Cloud/Tech Experience",
    compliance: "Security & Compliance",
  };
  type WhatIfIndustry = "none" | "fintech" | "healthtech";
  type WhatIfPreviewData = {
    components: ComponentData[];
    connections: ConnectionData[];
    assumptions: string[];
    risks: string[];
    recommendation?: { recommendedProvider: string; rationale: string; keyTradeoffs: string[] };
    diff: {
      added: { id: string; name: string; type: string; reasoning: string }[];
      removed: { id: string; name: string; type: string }[];
      modified: { id: string; name: string; type: string; changes: { parameter: string; oldVal: string; newVal: string; reasoning: string }[] }[];
    } | null;
    securityFindings: Record<string, SecurityFinding[]>;
  };

  // Workstream V -- AI-suggested HYPOTHETICAL variations per field, replacing the earlier
  // pre-fill-with-current-value approach: fields start empty, and these chips (fetched from
  // /whatif-suggestions) are the primary way to fill them, same chip pattern RequirementsPanel
  // already uses for its own (differently-framed) suggestions.
  type WhatIfSuggestion = { value: string; why: string };
  type WhatIfSuggestions = Partial<Record<keyof WhatIfNFR | "functional" | "industry", WhatIfSuggestion[]>>;

  // Shareable Read-Only Review Links (Workstream T7) -- lets the creator generate an unguessable
  // no-login link (and manage/revoke existing ones) for this project. The link itself is served
  // by a completely separate page/component (src/app/share/[token]/page.tsx + ShareView.tsx) that
  // never imports any edit/save code, so this panel only ever creates/lists/revokes tokens -- it
  // never renders the shared view itself.
  type ShareLink = { id: string; token: string; createdAt: string; revokedAt: string | null; isActive: boolean };
  const [shareMenuOpen, setShareMenuOpen] = useState(false);
  const [shareLinks, setShareLinks] = useState<ShareLink[]>([]);
  const [shareLinksLoading, setShareLinksLoading] = useState(false);
  const [shareCreating, setShareCreating] = useState(false);
  const [copiedShareId, setCopiedShareId] = useState<string | null>(null);

  const loadShareLinks = () => {
    setShareLinksLoading(true);
    fetch(`/api/projects/${projectId}/share-links`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("Failed to load share links"))))
      .then((data) => setShareLinks(data.shareLinks || []))
      .catch((err) => console.error("Failed to load share links:", err))
      .finally(() => setShareLinksLoading(false));
  };

  const handleOpenShareMenu = () => {
    setShareMenuOpen((v) => !v);
    if (!shareMenuOpen) loadShareLinks();
  };

  const handleCreateShareLink = async () => {
    try {
      setShareCreating(true);
      const res = await fetch(`/api/projects/${projectId}/share-links`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to create share link");
      const data = await res.json();
      setShareLinks((prev) => [data.shareLink, ...prev]);
    } catch (err) {
      console.error("Failed to create share link:", err);
    } finally {
      setShareCreating(false);
    }
  };

  const handleRevokeShareLink = async (id: string) => {
    try {
      const res = await fetch(`/api/projects/${projectId}/share-links/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to revoke share link");
      const data = await res.json();
      setShareLinks((prev) => prev.map((l) => (l.id === id ? data.shareLink : l)));
    } catch (err) {
      console.error("Failed to revoke share link:", err);
    }
  };

  const handleCopyShareLink = (link: ShareLink) => {
    const url = `${window.location.origin}/share/${link.token}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopiedShareId(link.id);
      setTimeout(() => setCopiedShareId(null), 2000);
    });
  };

  const [whatIfMode, setWhatIfMode] = useState(false);
  // Additional capabilities to explore adding, one per line -- appended to the current functional
  // list at submit time, never replaces it (see resolveWhatIfFunctional below).
  const [whatIfFunctional, setWhatIfFunctional] = useState("");
  // Starts BLANK, not pre-filled with the current value -- per explicit feedback, the primary
  // experience should be picking an AI-suggested hypothetical, not editing what's already true.
  // A blank field falls back to the real current value at submit time (resolveWhatIfNFR below),
  // so leaving something untouched still means "keep this as it really is", not "unspecified".
  const [whatIfNFR, setWhatIfNFR] = useState<WhatIfNFR>(BLANK_NFR);
  const [whatIfIndustry, setWhatIfIndustry] = useState<WhatIfIndustry>("none");
  const [whatIfHandlesCardData, setWhatIfHandlesCardData] = useState(false);
  const [whatIfStoresPHI, setWhatIfStoresPHI] = useState(false);
  const [whatIfAdditionalContext, setWhatIfAdditionalContext] = useState("");
  const [whatIfProvider, setWhatIfProvider] = useState<CloudProviderKey>(activeProvider);
  // Industry is a fixed-choice toggle, not free text -- there's no meaningful "blank" state for
  // it, so it starts at the CURRENT selection and "changed" just means picking a different one.
  const [whatIfCurrentIndustry, setWhatIfCurrentIndustry] = useState<WhatIfIndustry>("none");
  const [whatIfPreview, setWhatIfPreview] = useState<WhatIfPreviewData | null>(null);
  const [whatIfLoading, setWhatIfLoading] = useState(false);
  const [whatIfApplying, setWhatIfApplying] = useState(false);
  const [whatIfError, setWhatIfError] = useState("");
  const [whatIfSuggestions, setWhatIfSuggestions] = useState<WhatIfSuggestions>({});
  const [whatIfSuggestionsLoading, setWhatIfSuggestionsLoading] = useState(false);
  const whatIfResultsRef = useRef<HTMLDivElement>(null);

  const loadWhatIfSuggestions = () => {
    setWhatIfSuggestionsLoading(true);
    setWhatIfSuggestions({});
    fetch(`/api/projects/${projectId}/architectures/whatif-suggestions`, { method: "POST" })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("Failed to load suggestions"))))
      .then((data) => setWhatIfSuggestions(data.suggestions || {}))
      .catch((err) => console.error("Failed to load what-if suggestions:", err))
      .finally(() => setWhatIfSuggestionsLoading(false));
  };

  const openWhatIf = () => {
    setWhatIfFunctional("");
    setWhatIfNFR(BLANK_NFR);
    const currentIndustry: WhatIfIndustry = requirements?.industryContext?.industry || "none";
    setWhatIfIndustry(currentIndustry);
    setWhatIfCurrentIndustry(currentIndustry);
    setWhatIfHandlesCardData(!!requirements?.industryContext?.flags?.handlesCardDataDirectly);
    setWhatIfStoresPHI(!!requirements?.industryContext?.flags?.storesPHI);
    setWhatIfAdditionalContext("");
    setWhatIfProvider(activeProvider);
    setWhatIfPreview(null);
    setWhatIfError("");
    setWhatIfMode(true);
    loadWhatIfSuggestions();
  };

  const closeWhatIf = () => {
    setWhatIfMode(false);
    setWhatIfPreview(null);
    setWhatIfError("");
  };

  const isNFRFieldChanged = (field: keyof WhatIfNFR) => whatIfNFR[field].trim() !== "";
  const isFunctionalChanged = whatIfFunctional.trim() !== "";
  const isIndustryChanged = whatIfIndustry !== whatIfCurrentIndustry;
  const hasAnyWhatIfChange =
    isFunctionalChanged ||
    isIndustryChanged ||
    whatIfAdditionalContext.trim() !== "" ||
    (Object.keys(BLANK_NFR) as (keyof WhatIfNFR)[]).some(isNFRFieldChanged);

  const applyWhatIfNFRSuggestion = (field: keyof WhatIfNFR, value: string) => {
    setWhatIfNFR((prev) => ({ ...prev, [field]: value }));
  };
  const applyWhatIfFunctionalSuggestion = (value: string) => {
    setWhatIfFunctional((prev) => (prev.trim() ? `${prev.replace(/\n+$/, "")}\n${value}` : value));
  };

  // Blank fields fall back to the project's real current value -- exploring one change should
  // never silently discard everything the user left untouched.
  const resolveWhatIfNFR = (): WhatIfNFR => {
    const current = (requirements?.nonFunctional || {}) as Partial<WhatIfNFR>;
    const resolved = {} as WhatIfNFR;
    (Object.keys(BLANK_NFR) as (keyof WhatIfNFR)[]).forEach((field) => {
      resolved[field] = whatIfNFR[field].trim() || current[field] || "not_specified";
    });
    return resolved;
  };

  const resolveWhatIfFunctional = (): string[] => {
    const current = requirements?.functional || [];
    const additional = whatIfFunctional
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    return [...current, ...additional];
  };

  const buildWhatIfIndustryContext = () => ({
    industry: whatIfIndustry,
    rationale: requirements?.industryContext?.rationale || "",
    complianceAnswers: requirements?.industryContext?.complianceAnswers || [],
    flags: {
      ...(whatIfIndustry === "fintech" ? { handlesCardDataDirectly: whatIfHandlesCardData } : {}),
      ...(whatIfIndustry === "healthtech" ? { storesPHI: whatIfStoresPHI } : {}),
    },
  });

  // Auto-scroll to the results panel once a simulation completes, rather than leaving the user to
  // notice/scroll for it themselves -- the panel is well below the fold on a normal viewport.
  useEffect(() => {
    if (whatIfPreview && whatIfResultsRef.current) {
      whatIfResultsRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [whatIfPreview]);

  useEffect(() => {
    if (regeneratePreview && regeneratePreviewRef.current) {
      regeneratePreviewRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [regeneratePreview]);

  const runWhatIfSimulation = async () => {
    if (!architecture) return;
    if (!hasAnyWhatIfChange) {
      setWhatIfError("Pick at least one suggestion (or type your own value) before running a simulation.");
      return;
    }
    setWhatIfError("");
    setWhatIfLoading(true);
    setWhatIfPreview(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/architectures/whatif-preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          functional: resolveWhatIfFunctional(),
          nonFunctional: resolveWhatIfNFR(),
          industryContext: buildWhatIfIndustryContext(),
          additionalContext: whatIfAdditionalContext,
        }),
      });
      if (!res.ok) throw new Error("Failed to run this simulation");
      const data = await res.json();
      setWhatIfPreview(data);
    } catch (err: any) {
      setWhatIfError(err.message || "Something went wrong running this simulation.");
    } finally {
      setWhatIfLoading(false);
    }
  };

  // Pure client-side cost projection -- the preview already returns full alternate components
  // (with real cloudMappings from the same generation pipeline), so this just re-runs the same
  // cost reduction calculateTotalCost already uses, over the preview's components instead of
  // architecture.hld.components. Never touches architecture state.
  const whatIfCostPreview = (): { before: { min: number; max: number }; after: { min: number; max: number } } | null => {
    if (!architecture || !whatIfPreview) return null;
    const before = calculateTotalCost(whatIfProvider);
    const after = whatIfPreview.components.reduce(
      (acc, c) => {
        const mapping = getMappingForProvider(c, whatIfProvider);
        return { min: acc.min + (mapping?.costEstimate.min || 0), max: acc.max + (mapping?.costEstimate.max || 0) };
      },
      { min: 0, max: 0 }
    );
    return { before, after };
  };

  // "Make this real" -- applies ALL changed fields, not just scale/budget: saves a new
  // requirements version (functional + every NFR field + industryContext, extending the existing
  // PUT /requirements endpoint) and then regenerates through the REAL auto-generate endpoint from
  // those just-saved requirements, so the resulting architecture version is produced by the exact
  // same path as a normal "Regenerate" -- not a separate, parallel save mechanism.
  const handleMakeWhatIfReal = async () => {
    if (!architecture) return;
    try {
      setWhatIfApplying(true);
      setWhatIfError("");

      const functionalList = resolveWhatIfFunctional();
      // A confirmed freeform scenario note becomes a real, permanent functional requirement --
      // the preview already folds it into the same functional-requirements channel, so making it
      // "real" means persisting it there too rather than silently dropping it.
      if (whatIfAdditionalContext.trim()) {
        functionalList.push(whatIfAdditionalContext.trim());
      }

      const reqRes = await fetch(`/api/projects/${projectId}/requirements`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          functional: functionalList,
          nonFunctional: resolveWhatIfNFR(),
          industryContext: buildWhatIfIndustryContext(),
        }),
      });
      if (!reqRes.ok) throw new Error("Failed to save the updated requirements");

      const archRes = await fetch(`/api/projects/${projectId}/architectures`, { method: "POST" });
      if (!archRes.ok) {
        const errData = await archRes.json().catch(() => ({}));
        throw new Error(errData.detail || errData.error || "Failed to generate the new architecture version");
      }
      const archData = await archRes.json();

      closeWhatIf();
      onRequirementsChange();
      await loadArchitecture(archData.architecture.version);
    } catch (err: any) {
      setWhatIfError(err.message || "An error occurred while saving this scenario.");
    } finally {
      setWhatIfApplying(false);
    }
  };

  // Analysis is triggered and fetched by GrowthTriggerContext itself (see ChatArea's
  // growthTrigger.startGrowthTrigger call) -- this component just resets its own local
  // review-session UI state whenever a fresh batch of proposals lands, mirroring what the old
  // fetchProposals did inline before each fetch.
  useEffect(() => {
    setProposalDecisions({});
    setSelectedProposalIds(new Set());
    setProposalDiscussions({});
    setOpenDiscussionId(null);
  }, [proposals]);

  const decideProposal = (componentId: string, decision: "approved" | "rejected") => {
    setProposalDecisions((prev) => ({ ...prev, [componentId]: decision }));
  };

  const approvedProposalCount = proposals.filter((p) => proposalDecisions[p.componentId] === "approved").length;

  const toggleProposalSelected = (componentId: string) => {
    setSelectedProposalIds((prev) => {
      const next = new Set(prev);
      if (next.has(componentId)) next.delete(componentId);
      else next.add(componentId);
      return next;
    });
  };
  const selectAllProposals = () => setSelectedProposalIds(new Set(proposals.map((p) => p.componentId)));
  const deselectAllProposals = () => setSelectedProposalIds(new Set());
  const acceptSelectedProposals = () => {
    setProposalDecisions((prev) => {
      const next = { ...prev };
      selectedProposalIds.forEach((id) => {
        next[id] = "approved";
      });
      return next;
    });
  };
  const rejectSelectedProposals = () => {
    setProposalDecisions((prev) => {
      const next = { ...prev };
      selectedProposalIds.forEach((id) => {
        next[id] = "rejected";
      });
      return next;
    });
  };

  const toggleDiscussion = (componentId: string) => {
    setOpenDiscussionId((prev) => (prev === componentId ? null : componentId));
    setDiscussionInput("");
  };

  const handleSendDiscussion = async (proposal: ProposedChange) => {
    const message = discussionInput.trim();
    if (!message || !architecture) return;

    const priorMessages = proposalDiscussions[proposal.componentId] || [];
    setProposalDiscussions((prev) => ({
      ...prev,
      [proposal.componentId]: [...priorMessages, { role: "user", text: message }],
    }));
    setDiscussionInput("");
    setDiscussionLoading(true);

    try {
      const res = await fetch(
        `/api/projects/${projectId}/architectures/${architecture.id}/refine-proposal?provider=${activeProvider}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            originalProposal: {
              action: proposal.action,
              componentId: proposal.componentId,
              componentType: proposal.componentType,
              componentName: proposal.componentName,
              reasoning: proposal.reasoning,
            },
            discussionMessage: message,
            priorMessages,
            provider: activeProvider,
          }),
        }
      );
      if (!res.ok) throw new Error("Failed to refine this proposal");
      const data = await res.json();

      setProposalDiscussions((prev) => ({
        ...prev,
        [proposal.componentId]: [
          ...(prev[proposal.componentId] || []),
          { role: "assistant", text: data.assistantReply },
        ],
      }));

      // Swap the refined proposal into place in-line -- same componentId, updated fields.
      // Any existing accept/reject decision for this card is cleared since the underlying
      // proposal just changed and deserves a fresh look before being (re-)approved.
      growthTrigger.updateProposal(proposal.componentId, data.proposal);
      setProposalDecisions((prev) => {
        const next = { ...prev };
        delete next[proposal.componentId];
        return next;
      });
    } catch (err) {
      console.error("Failed to refine proposal:", err);
      setProposalDiscussions((prev) => ({
        ...prev,
        [proposal.componentId]: [
          ...(prev[proposal.componentId] || []),
          { role: "assistant", text: "Sorry, I couldn't process that -- please try rephrasing." },
        ],
      }));
    } finally {
      setDiscussionLoading(false);
    }
  };

  const dismissProposals = () => {
    growthTrigger.dismiss();
    setProposalDecisions({});
    setSelectedProposalIds(new Set());
    setProposalDiscussions({});
    setOpenDiscussionId(null);
  };

  const handleApplyProposals = async () => {
    if (!architecture) return;
    const approved = proposals.filter((p) => proposalDecisions[p.componentId] === "approved");
    if (approved.length === 0) return;

    let newComponents = [...architecture.hld.components];
    let newConnections = [...architecture.hld.connections];

    for (const p of approved) {
      if (p.action === "add" && p.component) {
        newComponents = [...newComponents, p.component];
        newConnections = [...newConnections, ...(p.newConnections || [])];
      } else if (p.action === "modify") {
        newComponents = newComponents.map((c) => (c.id === p.componentId ? { ...c, reasoning: p.reasoning } : c));
      }
    }

    try {
      setApplyingProposals(true);
      growthTrigger.markApplying();
      setError("");
      setErrorRetryAction(null);
      const res = await fetch(`/api/projects/${projectId}/architectures/manual`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ components: newComponents, connections: newConnections }),
      });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || "Failed to apply approved changes");
      }
      const data = await res.json();
      setProposalDecisions({});
      setSelectedProposalIds(new Set());
      setProposalDiscussions({});
      setOpenDiscussionId(null);
      growthTrigger.markApplied(data.architecture.version);
      await loadArchitecture(data.architecture.version);
    } catch (err: any) {
      const message = err.message || "An error occurred while applying approved changes.";
      setError(message);
      setErrorRetryAction(() => handleApplyProposals);
      growthTrigger.markApplyFailed(message);
    } finally {
      setApplyingProposals(false);
    }
  };

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

  // Security Findings (Workstream T4) -- computed server-side, deterministically, at
  // generate/manual-save time (see run_security_rules), stored per-provider since LLD config
  // (and therefore findings) genuinely differs per provider. Older architecture versions saved
  // before this feature existed simply have an empty findings list, not an error.
  const currentSecurityFindings: SecurityFinding[] = architecture?.securityFindings?.[activeProvider] || [];
  const [securityFindingsExpanded, setSecurityFindingsExpanded] = useState(false);
  const SEVERITY_ORDER: Record<SecurityFinding["severity"], number> = { high: 0, medium: 1, low: 2 };
  const sortedSecurityFindings = [...currentSecurityFindings].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
  );
  const highSeverityCount = currentSecurityFindings.filter((f) => f.severity === "high").length;

  // Architecture Health Score (Workstream T3) -- deterministic, rule-based, computed client-side
  // from data already loaded (never another LLM call). Security dimension deliberately reuses
  // currentSecurityFindings above rather than re-running its own audit, per the spec's "share the
  // same checks" requirement.
  const healthScore: HealthScore | null = architecture
    ? computeHealthScore(
        architecture.hld.components,
        architecture.hld.connections,
        requirements?.nonFunctional?.budget,
        currentSecurityFindings,
        activeProvider,
        totalMinCost,
        totalMaxCost
      )
    : null;
  const [expandedHealthDimension, setExpandedHealthDimension] = useState<keyof Omit<HealthScore, "overall"> | null>(null);
  const HEALTH_DIMENSION_LABELS: Record<keyof Omit<HealthScore, "overall">, string> = {
    costEfficiency: "Cost Efficiency",
    scalability: "Scalability",
    security: "Security",
    vendorLockIn: "Vendor Lock-in",
  };
  const healthScoreColor = (score: number) => (score >= 75 ? "success" : score >= 50 ? "warning" : "danger");

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
        <span className="mt-4 text-base font-semibold text-ink font-bold">{generationStage}</span>
        <span className="mt-2 text-xs text-ink-muted max-w-sm">
          Estimating costs and picking the best-fit cloud services across AWS, Azure, and GCP.
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

  // Sub-choice suggestions -- one level more granular than the whole-service swap above (e.g.
  // which engine Amazon RDS runs, not RDS-vs-DynamoDB). Only defined for component types with a
  // genuinely meaningful internal variant; null for everything else.
  const subChoiceDef = selectedNode ? getSubChoiceDef(selectedNode.type, activeProvider, lldData?.config) : null;
  const subChoiceOptions = subChoiceDef ? getSubChoiceOptions(subChoiceDef, activeProvider, lldData?.config, requirements) : [];

  // Updates both the LLD config value and its reasoning in a single setDraftHld call.
  // handleUpdateLldConfig/handleUpdateLldReasoning each independently close over `draftHld`, so
  // calling them back-to-back here would have the second call's setDraftHld silently overwrite
  // the first (both read the same pre-update `draftHld` since React hasn't re-rendered between
  // the two synchronous calls) -- the config change would be lost, only the reasoning would
  // stick. Doing both fields in one pass avoids that.
  const handleSelectSubChoice = (subChoiceKey: string, option: SubChoiceOption) => {
    if (!draftHld || !selectedNode) return;
    const updatedComponents = draftHld.components.map((c) => {
      if (c.id !== selectedNode.id) return c;
      const mapping = c.cloudMappings?.[activeProvider];
      if (!mapping) return c;
      const currentLld = mapping.lld || { config: {}, reasoning: {} };
      return {
        ...c,
        metadata: { ...c.metadata, overrideSource: "user" as const },
        cloudMappings: {
          ...c.cloudMappings,
          [activeProvider]: {
            ...mapping,
            lld: {
              config: { ...currentLld.config, [subChoiceKey]: option.value },
              reasoning: { ...currentLld.reasoning, [subChoiceKey]: option.reasoning },
            },
          },
        },
      } as ComponentData;
    });
    setDraftHld({ components: updatedComponents, connections: draftHld.connections });
  };

  if (!architecture) {
    return (
      <div className="p-6 sm:p-8 flex flex-col h-full justify-between overflow-y-auto">
        <div>
          <h3 className="text-xl font-bold text-ink">Build Your Architecture</h3>
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
                  onClick={() => {
                    setError("");
                    setErrorRetryAction(null);
                  }}
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
                <span>⚠️</span> A Few Things We Still Need
              </h4>
              <p className="mt-2 text-sm text-warning leading-relaxed">
                We need a bit more information before we can design your architecture. Fill in the items below:
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
                Everything we need has been filled in — you&apos;re ready to generate your architecture.
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

  const fallbackRecommendation: NonNullable<ArchitectureData["reasoning"]["recommendation"]> = {
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
              Diagram
            </button>
            <button
              onClick={() => setViewMode("comparison")}
              className={`px-3 py-1.5 text-xs font-bold rounded-lg transition ${
                viewMode === "comparison" ? "bg-white text-ink shadow-sm" : "text-ink-muted hover:text-ink"
              }`}
            >
              Compare Clouds
            </button>
            <button
              onClick={() => setViewMode("journey")}
              className={`px-3 py-1.5 text-xs font-bold rounded-lg transition ${
                viewMode === "journey" ? "bg-white text-ink shadow-sm" : "text-ink-muted hover:text-ink"
              }`}
            >
              🧭 User Journey
            </button>
            {/* Migration Roadmap (Workstream T5) -- only shown for a project that actually
                declared an existing system at intake; a plain greenfield project never sees a
                dead tab with nothing to show. */}
            {requirements?.existingSystem && (
              <button
                onClick={() => setViewMode("migration")}
                className={`px-3 py-1.5 text-xs font-bold rounded-lg transition ${
                  viewMode === "migration" ? "bg-white text-ink shadow-sm" : "text-ink-muted hover:text-ink"
                }`}
              >
                🛤️ Migration Roadmap
              </button>
            )}
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
                <option key={v.id} value={v.version}>
                  v{v.version} {v.version === versionList[0]?.version ? "(Latest)" : ""}
                </option>
              ))}
            </select>
            <InfoTooltip text="Every regenerate or manual save creates a new version instead of overwriting — older versions stay here, read-only, so you can always see what the design looked like before a change." />
          </div>

          {/* Shareable Read-Only Review Links (Workstream T7) -- available regardless of
              viewMode/isEditing, since sharing a link doesn't touch draft state at all. */}
          {architecture && (
            <span className="relative inline-flex items-center gap-1">
              <button
                onClick={handleOpenShareMenu}
                className={`flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-bold uppercase transition shadow-sm active:scale-95 ${
                  shareMenuOpen ? "bg-accent text-white" : "bg-paper border border-line text-ink-muted hover:text-ink"
                }`}
              >
                <Icon icon="mdi:share-variant-outline" width={14} height={14} />
                Share
              </button>
              {shareMenuOpen && (
                <div className="absolute right-0 top-full z-30 mt-1.5 w-80 rounded-2xl border border-line bg-white p-3 shadow-lg animate-fadeIn">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-extrabold uppercase tracking-wide text-ink-faint">Read-only review links</span>
                    <button
                      onClick={() => setShareMenuOpen(false)}
                      className="text-ink-faint hover:text-ink"
                      aria-label="Close"
                    >
                      <Icon icon="mdi:close" width={14} height={14} />
                    </button>
                  </div>
                  <p className="mt-1 text-[10.5px] text-ink-muted">
                    Anyone with a link can view this architecture (diagram, cost, flow story) without an account -- no
                    edit, export, or generate controls. Revoke anytime.
                  </p>

                  <button
                    onClick={handleCreateShareLink}
                    disabled={shareCreating}
                    className="mt-2.5 w-full rounded-xl bg-accent px-3 py-1.5 text-xs font-bold uppercase text-white shadow-sm transition hover:opacity-90 active:scale-95 disabled:opacity-50"
                  >
                    {shareCreating ? "Creating..." : "+ Create new link"}
                  </button>

                  <div className="mt-3 max-h-64 space-y-1.5 overflow-y-auto">
                    {shareLinksLoading ? (
                      <p className="text-center text-[11px] text-ink-muted">Loading...</p>
                    ) : shareLinks.length === 0 ? (
                      <p className="text-center text-[11px] text-ink-muted">No links yet.</p>
                    ) : (
                      shareLinks.map((link) => (
                        <div
                          key={link.id}
                          className={`rounded-xl border p-2.5 text-[11px] ${
                            link.isActive ? "border-line-strong bg-paper/60" : "border-line bg-paper/30 opacity-60"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className={`font-bold ${link.isActive ? "text-ink" : "text-ink-faint line-through"}`}>
                              {link.isActive ? "Active" : "Revoked"}
                            </span>
                            <span className="text-[9.5px] text-ink-faint">
                              {/* Locale pinned explicitly to avoid a server/client hydration
                                  mismatch -- an unspecified locale/format is the runtime default,
                                  which can differ between the Node SSR pass and the browser. */}
                              {new Date(link.createdAt).toLocaleDateString("en-US")}
                            </span>
                          </div>
                          {link.isActive && (
                            <div className="mt-1.5 flex items-center gap-1.5">
                              <button
                                onClick={() => handleCopyShareLink(link)}
                                className="flex-1 rounded-lg border border-line-strong bg-white px-2 py-1 text-left font-mono text-[10px] text-ink-muted hover:border-accent hover:text-accent-ink"
                              >
                                {copiedShareId === link.id ? "Copied!" : `/share/${link.token.slice(0, 14)}...`}
                              </button>
                              <button
                                onClick={() => handleRevokeShareLink(link.id)}
                                className="rounded-lg bg-danger-soft px-2 py-1 font-bold uppercase text-danger transition hover:bg-danger/20"
                              >
                                Revoke
                              </button>
                            </div>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </span>
          )}

          {/* What-If Simulator (Workstream T1) -- a sandbox, deliberately separate from the
              manual-edit toggle below: exploring a hypothetical never creates a version, and is
              disabled while actually mid-edit to avoid two competing "draft" states at once. */}
          {viewMode === "diagram" && architecture && !isEditing && (
            <span className="inline-flex items-center gap-1.5">
              <button
                onClick={() => (whatIfMode ? closeWhatIf() : openWhatIf())}
                className={`rounded-xl px-3 py-1.5 text-xs font-bold uppercase transition shadow-sm active:scale-95 ${
                  whatIfMode ? "bg-accent text-white" : "bg-paper border border-line text-ink-muted hover:text-ink"
                }`}
              >
                🔮 What-If
              </button>
              <InfoTooltip text="Explore a hypothetical that changes ANY requirement -- scale, budget, data types, compliance, or a freeform scenario -- and preview the cost/component impact using the exact same generation pipeline real architectures use, WITHOUT creating a saved version. Nothing changes unless you click 'Make this real' on the preview." />
            </span>
          )}

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
              onClick={() => (errorRetryAction ?? handleGenerate)()}
              className="rounded-lg bg-danger-soft hover:bg-danger/15 text-danger px-2 py-1 text-xs font-bold transition"
            >
              Retry
            </button>
            <button
              onClick={() => {
                setError("");
                setErrorRetryAction(null);
              }}
              className="text-danger transition hover:opacity-70 font-extrabold text-xs px-2 py-1"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Chat-Based Enhancement Proposals -- state lives in GrowthTriggerContext (see
          ArchitectureWorkspace's top-level growthTrigger hook), not local state, so this panel
          reflects reality even if analysis started/finished while this component wasn't mounted.
          Review-and-approve only; nothing here mutates the architecture until "Apply Approved
          Changes" is clicked. Positioned outside any viewMode branch so it's visible regardless
          of which view (Topology/Compare Clouds/User Journey/Migration) is active -- "don't show
          a stale/blank view with no indication that new work is in progress." */}
      {pendingDescription && (
        <div className="mx-6 mt-4 rounded-2xl border border-accent/25 bg-accent-soft/60 p-4">
          <div className="flex items-start justify-between gap-2">
            <span className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-accent-ink">
              <span>💬</span> Chat-Proposed Changes — {PROVIDER_LABELS[activeProvider]}
              <InfoTooltip text="Generated from what you described in the chat's growth trigger, scoped to the cloud provider currently active here. Nothing is applied to your architecture until you accept individual changes below and click Apply." />
            </span>
            <button
              onClick={dismissProposals}
              disabled={applyingProposals}
              className="text-xs font-bold text-ink-muted transition hover:text-ink disabled:opacity-40"
            >
              Dismiss
            </button>
          </div>
          <p className="mt-1.5 text-xs italic text-ink-muted">&ldquo;{pendingDescription}&rdquo;</p>

          {applyingProposals ? (
            <div className="mt-3 flex items-center gap-2 text-xs font-semibold text-accent-ink">
              <span className="h-3 w-3 flex-none animate-spin rounded-full border-2 border-accent border-t-transparent" />
              {growthApplyingStage}
            </div>
          ) : proposalsLoading ? (
            <div className="mt-3 flex items-center gap-2 text-xs text-ink-muted">
              <span className="h-3 w-3 flex-none animate-spin rounded-full border-2 border-accent border-t-transparent" />
              {growthAnalyzingStage}
            </div>
          ) : growthTrigger.status === "error" ? (
            <p className="mt-2 text-xs font-medium text-danger">
              {growthTrigger.error || "Something went wrong analyzing the requested changes."}{" "}
              {/* Retry re-runs the SAME analysis via the description GrowthTriggerContext already
                  kept (only dismiss()/markApplied() clear it) -- previously the only option here
                  was Dismiss, which cleared it, forcing the user to retype the whole change
                  request in chat from scratch. */}
              <button
                onClick={() => growthTrigger.startGrowthTrigger(projectId, growthTrigger.description || "")}
                className="font-bold underline hover:no-underline"
              >
                Retry
              </button>{" "}
              <button onClick={dismissProposals} className="font-bold underline hover:no-underline">
                Dismiss
              </button>
            </p>
          ) : proposals.length === 0 ? (
            <p className="mt-2 text-xs text-ink-muted">
              No architecture changes are needed for this on {PROVIDER_LABELS[activeProvider]} -- your existing
              components already cover it.
            </p>
          ) : (
            <>
              {/* Batch controls -- selection (checkboxes) is independent of the accept/reject
                  decision each card already supports standalone; these just apply that same
                  per-card action to every currently-checked card in one click. */}
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line/60 pb-2.5 text-[10px] font-bold uppercase tracking-wide text-ink-muted">
                <span>{selectedProposalIds.size} of {proposals.length} selected</span>
                <button onClick={selectAllProposals} className="text-accent-ink hover:underline">
                  Select All
                </button>
                <button onClick={deselectAllProposals} className="text-ink-muted hover:underline">
                  Deselect All
                </button>
                <span className="mx-0.5 text-line-strong">|</span>
                <button
                  onClick={acceptSelectedProposals}
                  disabled={selectedProposalIds.size === 0}
                  className="rounded-lg bg-success-soft px-2 py-1 text-success transition hover:bg-success/20 disabled:opacity-40"
                >
                  Accept Selected
                </button>
                <button
                  onClick={rejectSelectedProposals}
                  disabled={selectedProposalIds.size === 0}
                  className="rounded-lg bg-danger-soft px-2 py-1 text-danger transition hover:bg-danger/20 disabled:opacity-40"
                >
                  Reject Selected
                </button>
              </div>

              <div className="mt-3 space-y-2">
                {proposals.map((p) => {
                  const decision = proposalDecisions[p.componentId];
                  const isSelected = selectedProposalIds.has(p.componentId);
                  const isDiscussing = openDiscussionId === p.componentId;
                  const discussion = proposalDiscussions[p.componentId] || [];
                  return (
                    <div
                      key={p.componentId}
                      className={`rounded-xl border p-3 text-xs transition ${
                        decision === "approved"
                          ? "border-success/40 bg-success-soft/40"
                          : decision === "rejected"
                            ? "border-line bg-paper/60 opacity-50"
                            : "border-line-strong bg-white"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-start gap-2">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleProposalSelected(p.componentId)}
                            className="mt-0.5 h-3.5 w-3.5 flex-none accent-accent"
                            aria-label={`Select ${p.componentName} for batch action`}
                          />
                          <div>
                            <span className="font-bold text-ink">
                              {p.action === "add" ? "+ Add" : "✎ Modify"}: {p.componentName}
                            </span>
                            <div className="mt-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent-ink">
                              For {PROVIDER_LABELS[activeProvider]}: {p.serviceName}
                            </div>
                          </div>
                        </div>
                        <div className="flex flex-none items-center gap-1.5">
                          <button
                            onClick={() => toggleDiscussion(p.componentId)}
                            className={`rounded-lg px-2.5 py-1 text-[10px] font-bold transition ${
                              isDiscussing ? "bg-ink text-white" : "bg-line text-ink-muted hover:bg-line-strong"
                            }`}
                          >
                            💬 Discuss
                          </button>
                          <button
                            onClick={() => decideProposal(p.componentId, "approved")}
                            className={`rounded-lg px-2.5 py-1 text-[10px] font-bold transition ${
                              decision === "approved"
                                ? "bg-success text-white"
                                : "bg-success-soft text-success hover:bg-success/20"
                            }`}
                          >
                            Accept
                          </button>
                          <button
                            onClick={() => decideProposal(p.componentId, "rejected")}
                            className={`rounded-lg px-2.5 py-1 text-[10px] font-bold transition ${
                              decision === "rejected"
                                ? "bg-danger text-white"
                                : "bg-danger-soft text-danger hover:bg-danger/20"
                            }`}
                          >
                            Reject
                          </button>
                        </div>
                      </div>
                      <p className="mt-2 leading-relaxed text-ink-muted">{p.reasoning}</p>
                      {p.domainPattern && (
                        <div className="mt-2 flex items-start gap-1.5 rounded-xl border border-warning/30 bg-warning-soft/40 p-2 text-[10.5px] text-ink-muted leading-relaxed">
                          <span className="flex-none">🧭</span>
                          <span>
                            <span className="mr-1 font-bold uppercase tracking-wide text-[9px] text-warning">Domain Pattern</span>
                            <InfoTooltip text="A practice commonly used by similar products in this industry — not specific to your stated requirements, but worth knowing." />
                            {p.domainPattern}
                          </span>
                        </div>
                      )}

                      {/* Inline discuss/refine thread -- scoped to just this card. Sending a
                          message here never touches proposalDecisions for any other card, so
                          accepting/rejecting the rest of the batch is never blocked by this
                          being open. */}
                      {isDiscussing && (
                        <div className="mt-3 rounded-xl border border-line bg-paper/70 p-2.5">
                          {discussion.length > 0 && (
                            <div className="mb-2 space-y-1.5">
                              {discussion.map((m, i) => (
                                <div
                                  key={i}
                                  className={`rounded-lg px-2.5 py-1.5 text-[11px] leading-relaxed ${
                                    m.role === "user"
                                      ? "ml-6 bg-accent/10 text-ink"
                                      : "mr-6 bg-white text-ink-muted border border-line"
                                  }`}
                                >
                                  {m.text}
                                </div>
                              ))}
                            </div>
                          )}
                          {discussionLoading && (
                            <div className="mb-2 flex items-center gap-1.5 text-[10px] text-ink-faint italic">
                              <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                              Thinking...
                            </div>
                          )}
                          <div className="flex gap-1.5">
                            <input
                              type="text"
                              value={discussionInput}
                              onChange={(e) => setDiscussionInput(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" && !discussionLoading) handleSendDiscussion(p);
                              }}
                              placeholder="e.g. can you use a cheaper alternative for this?"
                              disabled={discussionLoading}
                              className="flex-1 rounded-lg border border-line bg-white px-2.5 py-1.5 text-[11px] focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
                            />
                            <button
                              onClick={() => handleSendDiscussion(p)}
                              disabled={discussionLoading || !discussionInput.trim()}
                              className="flex-none rounded-lg bg-accent px-3 py-1.5 text-[10px] font-bold text-white transition hover:bg-accent-ink disabled:opacity-40"
                            >
                              Send
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <button
                onClick={handleApplyProposals}
                disabled={approvedProposalCount === 0 || applyingProposals}
                className="mt-3 rounded-xl bg-ink px-4 py-2 text-xs font-bold text-white transition hover:bg-ink/90 disabled:opacity-40"
              >
                {applyingProposals ? "Applying..." : `Apply Approved Changes (${approvedProposalCount})`}
              </button>
            </>
          )}
        </div>
      )}

      {/* What-If Simulator panel (Workstream T1, reworked per Workstream V feedback) --
          explicitly NOT the same block/state as Chat-Based Enhancement Proposals above. Every
          field starts EMPTY: AI-suggested hypothetical chips (fetched fresh on open) are the
          primary way to fill them in, not the project's current value -- a "current: ..." caption
          shows what's real today for context, without pre-filling the input itself. Nothing here
          is ever auto-applied -- only "Make this real" below can turn it into an actual saved
          version. */}
      {whatIfMode && viewMode === "diagram" && architecture && (
        <div className="mx-6 mt-4 rounded-2xl border border-accent/25 bg-white shadow-sm">
          <div className="flex items-center justify-between gap-2 border-b border-accent/15 bg-accent-soft/40 px-4 py-3 rounded-t-2xl">
            <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-accent-ink">
              <Icon icon="mdi:flask-outline" width={15} height={15} />
              What-If Simulator
              <InfoTooltip text="A sandbox for exploring a hypothetical. Pick a suggested variation (or type your own) for whichever fields you want to change -- anything left blank stays at its real current value. Running a simulation re-runs the same process the app used to build your real architecture, without saving anything." />
            </span>
            <button onClick={closeWhatIf} className="text-xs font-bold text-ink-muted transition hover:text-ink">
              Close
            </button>
          </div>

          <div className="space-y-6 px-4 py-4">
            <p className="text-[11px] text-ink-muted leading-relaxed">
              Pick a suggested variation below, or type your own. Anything you leave blank keeps its real current
              value -- only what you actually fill in gets explored.
              {whatIfSuggestionsLoading && (
                <span className="ml-1.5 inline-flex items-center gap-1 text-accent-ink">
                  <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                  Generating tailored suggestions...
                </span>
              )}
            </p>

            {/* Functional capabilities -- additional/new ones to explore, appended to the real
                current list at submit time rather than replacing it. */}
            <div>
              <label className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-ink">
                Capabilities to Explore Adding
                <InfoTooltip text={FIELD_EXPLANATIONS.functional} />
                {isFunctionalChanged && (
                  <span className="rounded-full bg-accent-soft px-1.5 py-0.5 text-[8px] font-extrabold uppercase text-accent-ink">
                    Exploring
                  </span>
                )}
              </label>
              <textarea
                value={whatIfFunctional}
                onChange={(e) => setWhatIfFunctional(e.target.value)}
                placeholder="One per line -- e.g. real-time collaboration"
                rows={2}
                className={`mt-1.5 w-full rounded-xl border bg-white px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-accent/30 ${
                  isFunctionalChanged ? "border-accent ring-1 ring-accent/30" : "border-line"
                }`}
              />
              {(whatIfSuggestions.functional?.length ?? 0) > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {whatIfSuggestions.functional!.map((s, idx) => (
                    <span
                      key={idx}
                      className="inline-flex max-w-full items-center gap-1 rounded-full border border-accent/25 bg-accent-soft py-0.5 pl-2 pr-1.5 transition hover:border-accent hover:bg-accent/15"
                    >
                      <button
                        type="button"
                        onClick={() => applyWhatIfFunctionalSuggestion(s.value)}
                        title={s.value}
                        className="max-w-[260px] truncate text-[10px] font-medium text-accent-ink"
                      >
                        + {s.value}
                      </button>
                      {s.why && <InfoTooltip text={`Why suggested: ${s.why}`} />}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* All 7 non-functional fields -- same set/labels as the Requirements tab */}
            <div className="grid gap-4 sm:grid-cols-2">
              {(Object.keys(NFR_FIELD_LABELS) as (keyof WhatIfNFR)[]).map((field) => {
                const changed = isNFRFieldChanged(field);
                const currentValue = requirements?.nonFunctional?.[field];
                const suggestions = whatIfSuggestions[field] || [];
                return (
                  <div key={field}>
                    <label className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-ink">
                      {NFR_FIELD_LABELS[field]}
                      {FIELD_EXPLANATIONS[field] && <InfoTooltip text={FIELD_EXPLANATIONS[field]} />}
                      {changed && (
                        <span className="rounded-full bg-accent-soft px-1.5 py-0.5 text-[8px] font-extrabold uppercase text-accent-ink">
                          Exploring
                        </span>
                      )}
                    </label>
                    {currentValue && currentValue.toLowerCase() !== "not_specified" && (
                      <p className="mt-1 truncate text-[10px] text-ink-faint" title={currentValue}>
                        Current: {currentValue}
                      </p>
                    )}
                    {field === "budget" ? (
                      <BudgetInput
                        value={whatIfNFR.budget}
                        onChange={(next) => setWhatIfNFR((prev) => ({ ...prev, budget: next }))}
                        className="mt-1.5"
                      />
                    ) : (
                      <input
                        type="text"
                        value={whatIfNFR[field]}
                        onChange={(e) => setWhatIfNFR((prev) => ({ ...prev, [field]: e.target.value }))}
                        placeholder="Leave blank to keep the current value"
                        // A generous limit for descriptive prose, not a short categorical value --
                        // matches the same fields' limit on the Requirements tab.
                        maxLength={300}
                        className={`mt-1.5 w-full rounded-xl border bg-white px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-accent/30 ${
                          changed ? "border-accent ring-1 ring-accent/30" : "border-line"
                        }`}
                      />
                    )}
                    {suggestions.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {suggestions.map((s, idx) => (
                          <span
                            key={idx}
                            className="inline-flex max-w-full items-center gap-1 rounded-full border border-accent/25 bg-accent-soft py-0.5 pl-2 pr-1.5 transition hover:border-accent hover:bg-accent/15"
                          >
                            <button
                              type="button"
                              onClick={() => applyWhatIfNFRSuggestion(field, s.value)}
                              title={s.value}
                              className="max-w-[200px] truncate text-[10px] font-medium text-accent-ink"
                            >
                              {s.value}
                            </button>
                            {s.why && <InfoTooltip text={`Why suggested: ${s.why}`} />}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Industry / compliance context */}
            <div className={`rounded-xl border p-3.5 ${isIndustryChanged ? "border-accent ring-1 ring-accent/30" : "border-line"}`}>
              <label className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-ink">
                Industry / Compliance Regime
                <InfoTooltip text={FIELD_EXPLANATIONS.industry} />
                {isIndustryChanged && (
                  <span className="rounded-full bg-accent-soft px-1.5 py-0.5 text-[8px] font-extrabold uppercase text-accent-ink">
                    Exploring
                  </span>
                )}
              </label>
              <p className="mt-1 text-[10px] text-ink-faint">
                Current: {whatIfCurrentIndustry === "none" ? "General (no regulated industry)" : whatIfCurrentIndustry === "fintech" ? "Fintech" : "Healthtech"}
              </p>
              <div className="mt-2 flex w-max bg-paper/80 p-0.5 rounded-lg border border-line shadow-sm">
                {(["none", "fintech", "healthtech"] as const).map((ind) => (
                  <button
                    key={ind}
                    onClick={() => setWhatIfIndustry(ind)}
                    className={`px-2.5 py-1.5 text-[9px] font-extrabold uppercase rounded transition ${
                      whatIfIndustry === ind ? "bg-ink text-white shadow-sm" : "text-ink-muted hover:text-ink"
                    }`}
                  >
                    {ind === "none" ? "General" : ind === "fintech" ? "Fintech" : "Healthtech"}
                  </button>
                ))}
              </div>
              {whatIfSuggestions.industry && whatIfSuggestions.industry.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {whatIfSuggestions.industry.map((s, idx) => (
                    <span
                      key={idx}
                      className="inline-flex items-center gap-1 rounded-full border border-accent/25 bg-accent-soft py-0.5 pl-2 pr-1.5 transition hover:border-accent hover:bg-accent/15"
                    >
                      <button
                        type="button"
                        onClick={() => setWhatIfIndustry(s.value as WhatIfIndustry)}
                        className="text-[10px] font-medium text-accent-ink"
                      >
                        {s.value === "none" ? "General" : s.value === "fintech" ? "Fintech" : "Healthtech"}
                      </button>
                      {s.why && <InfoTooltip text={`Why suggested: ${s.why}`} />}
                    </span>
                  ))}
                </div>
              )}
              {whatIfIndustry === "fintech" && (
                <label className="mt-3 flex items-center gap-1.5 text-[11px] font-semibold text-ink-muted">
                  <input
                    type="checkbox"
                    checked={whatIfHandlesCardData}
                    onChange={(e) => setWhatIfHandlesCardData(e.target.checked)}
                    className="h-3.5 w-3.5 accent-accent"
                  />
                  Handles cardholder data directly (adds PCI-DSS safeguards like tokenization)
                </label>
              )}
              {whatIfIndustry === "healthtech" && (
                <label className="mt-3 flex items-center gap-1.5 text-[11px] font-semibold text-ink-muted">
                  <input
                    type="checkbox"
                    checked={whatIfStoresPHI}
                    onChange={(e) => setWhatIfStoresPHI(e.target.checked)}
                    className="h-3.5 w-3.5 accent-accent"
                  />
                  Stores PHI (adds HIPAA safeguards like a dedicated PHI vault)
                </label>
              )}
            </div>

            <div>
              <label className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-ink">
                Preview for Provider
                <InfoTooltip text="Which cloud provider's service names, technical configuration, and cost figures the preview below uses. Switching this doesn't change any of the fields above -- it only changes which provider's real pricing/services the simulation is shown against." />
              </label>
              <div className="mt-1.5 flex w-max bg-paper/80 p-0.5 rounded-lg border border-line shadow-sm">
                {(["aws", "azure", "gcp", "kubernetes", "private"] as const).map((p) => (
                  <button
                    key={p}
                    onClick={() => setWhatIfProvider(p)}
                    className={`px-2.5 py-1.5 text-[9px] font-extrabold uppercase rounded transition ${
                      whatIfProvider === p ? "bg-ink text-white shadow-sm" : "text-ink-muted hover:text-ink"
                    }`}
                  >
                    {PROVIDER_LABELS[p]}
                  </button>
                ))}
              </div>
            </div>

            {/* Freeform note -- works ALONGSIDE the structured fields above, for anything that
                doesn't map cleanly to one of them (e.g. "add multi-region failover"). Visually
                separated from the structured fields by a divider, per the "clear grouping"
                feedback. */}
            <div className="border-t border-line pt-5">
              <label className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-ink">
                Anything Else? (freeform, optional)
                <InfoTooltip text="For a hypothetical that doesn't map to one of the structured fields above -- e.g. 'what if we add multi-region failover?'. Folded into the same functional-requirements channel the rules engine and LLM already read from." />
              </label>
              <textarea
                value={whatIfAdditionalContext}
                onChange={(e) => setWhatIfAdditionalContext(e.target.value)}
                placeholder="e.g. what if we add multi-region failover?"
                rows={2}
                className="mt-1.5 w-full rounded-xl border border-line bg-white px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-accent/30"
              />
            </div>

            {whatIfError && <p className="text-xs font-semibold text-danger">{whatIfError}</p>}

            <div>
              <button
                onClick={runWhatIfSimulation}
                disabled={whatIfLoading}
                className="rounded-xl bg-accent px-4 py-2 text-xs font-bold uppercase text-white shadow-sm transition hover:opacity-90 active:scale-95 disabled:opacity-50"
              >
                {whatIfLoading ? "Simulating (this can take 30–60 seconds)..." : "Run Simulation"}
              </button>
              {whatIfLoading && (
                <p className="mt-1.5 text-[10.5px] text-ink-faint">
                  This runs the real generation pipeline, so it can take 30-60 seconds. Results will appear below.
                </p>
              )}
            </div>
          </div>

          {whatIfPreview && (
            <div ref={whatIfResultsRef} className="border-t border-line px-4 py-4 space-y-3 scroll-mt-4">
              <span className="inline-flex items-center gap-1 rounded-full bg-ink px-2.5 py-1 text-[9px] font-extrabold uppercase tracking-wide text-white">
                <Icon icon="mdi:eye-outline" width={11} height={11} />
                Preview only — not saved
              </span>

              {(() => {
                const costPreview = whatIfCostPreview();
                if (!costPreview) return null;
                const wentUp = costPreview.after.min + costPreview.after.max > costPreview.before.min + costPreview.before.max;
                return (
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                    <span className="text-ink-muted">Projected cost for {PROVIDER_LABELS[whatIfProvider]}:</span>
                    <span className="font-bold text-ink">
                      ${costPreview.before.min} - ${costPreview.before.max}/mo
                    </span>
                    <Icon icon="mdi:arrow-right" width={12} height={12} className="text-ink-faint" />
                    <span className={`font-bold ${wentUp ? "text-warning" : "text-success"}`}>
                      ${costPreview.after.min} - ${costPreview.after.max}/mo
                    </span>
                  </div>
                );
              })()}

              {whatIfPreview.recommendation && (
                <p className="mt-2 text-[11px] text-ink-muted">
                  <span className="font-bold text-ink">Recommended provider: </span>
                  {whatIfPreview.recommendation.recommendedProvider.toUpperCase()} — {whatIfPreview.recommendation.rationale}
                </p>
              )}

              {/* Full diff (added/modified/removed) -- the same shape and rendering style as the
                  "What Changed in Version X" panel elsewhere in Topology View, since this preview
                  and that panel are both compute_architecture_diff output. */}
              {whatIfPreview.diff &&
              (whatIfPreview.diff.added?.length || whatIfPreview.diff.modified?.length || whatIfPreview.diff.removed?.length) ? (
                <div className="mt-3 grid gap-3 sm:grid-cols-3 border-t border-line pt-3">
                  {whatIfPreview.diff.added?.length > 0 && (
                    <div className="space-y-1.5">
                      <span className="text-[9px] font-black text-success uppercase tracking-widest block bg-success-soft/60 border border-success/25 px-2 py-0.5 rounded w-max">
                        + Added
                      </span>
                      <ul className="text-xs space-y-1.5 text-ink-muted">
                        {whatIfPreview.diff.added.map((item, idx) => (
                          <li key={idx}>
                            <span className="font-bold text-ink block">{item.name}</span>
                            <span className="block text-[10.5px] italic">{item.reasoning}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {whatIfPreview.diff.modified?.length > 0 && (
                    <div className="space-y-1.5">
                      <span className="text-[9px] font-black text-warning uppercase tracking-widest block bg-warning-soft/60 border border-warning/25 px-2 py-0.5 rounded w-max">
                        ~ Modified
                      </span>
                      <ul className="text-xs space-y-2 text-ink-muted">
                        {whatIfPreview.diff.modified.map((item, idx) => (
                          <li key={idx}>
                            <span className="font-bold text-ink block">{item.name}</span>
                            {item.changes.map((ch, cIdx) => (
                              <div key={cIdx} className="mt-0.5 pl-2 border-l-2 border-line text-[10.5px]">
                                <span className="text-ink-faint line-through">{ch.oldVal}</span> ➜{" "}
                                <span className="font-bold text-ink">{ch.newVal}</span>
                              </div>
                            ))}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {whatIfPreview.diff.removed?.length > 0 && (
                    <div className="space-y-1.5">
                      <span className="text-[9px] font-black text-danger uppercase tracking-widest block bg-danger-soft/60 border border-danger/25 px-2 py-0.5 rounded w-max">
                        − Removed
                      </span>
                      <ul className="text-xs space-y-1.5 text-ink-muted">
                        {whatIfPreview.diff.removed.map((item, idx) => (
                          <li key={idx}>
                            <span className="font-bold text-ink line-through block">{item.name}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              ) : (
                <p className="mt-2 text-xs text-ink-muted">
                  No architecture changes were needed for this scenario -- your existing components already cover it.
                </p>
              )}

              <div className="mt-3 flex items-center gap-2">
                <button
                  onClick={handleMakeWhatIfReal}
                  disabled={whatIfApplying}
                  className="rounded-xl bg-success px-3 py-1.5 text-xs font-bold uppercase text-white shadow-sm transition hover:opacity-90 active:scale-95 disabled:opacity-40"
                >
                  {whatIfApplying ? "Saving..." : "✓ Make this real"}
                </button>
                <button
                  onClick={() => setWhatIfPreview(null)}
                  className="rounded-xl bg-ink-muted px-3 py-1.5 text-xs font-bold uppercase text-white shadow-sm transition hover:bg-ink active:scale-95"
                >
                  Discard
                </button>
              </div>
            </div>
          )}
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
                    <InfoTooltip text="Each box is a piece of your infrastructure (a database, a compute service, etc). Click one to see cost, config, and why it was chosen. The animated lines show data flowing between components, and the arrowhead points in the direction of the request — from the component that calls, to the component that's called." />
                  </span>

                  <div className="flex flex-wrap items-center gap-2">
                    {/* Export Button */}
                    <span className="inline-flex items-center gap-1">
                      <button
                        onClick={handleExport}
                        disabled={manifestExportBusy}
                        className="rounded-xl bg-accent hover:bg-accent-ink text-white px-3 py-1.5 text-[9.5px] font-extrabold uppercase transition shadow-sm active:scale-95 flex items-center gap-1 disabled:opacity-50"
                      >
                        <span>📥</span>{" "}
                        {manifestExportBusy
                          ? "Exporting..."
                          : activeProvider === "kubernetes"
                            ? "Export Kubernetes Config"
                            : "Export Terraform"}
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
                      <InfoTooltip text="Downloads the diagram as an image (PNG) or scalable vector (SVG) — for docs, slides, or sharing. This is just the picture; use Export Terraform for the actual deployable infrastructure code." />
                    </span>

                    {/* Export Flow Documentation -- the one export with narrative explanation
                        baked in, kept separate from both the image (no explanation) and the
                        Terraform/K8s export (deployable code, no explanation) by design. */}
                    <span className="inline-flex items-center gap-1">
                      <button
                        onClick={handleExportFlowDocs}
                        disabled={docsExportBusy}
                        className="rounded-xl border border-line-strong bg-panel hover:bg-paper text-ink-muted px-3 py-1.5 text-[9.5px] font-extrabold uppercase transition shadow-sm active:scale-95 flex items-center gap-1 disabled:opacity-50"
                      >
                        <span>📄</span> {docsExportBusy ? "Exporting..." : "Export Docs"}
                      </button>
                      <InfoTooltip text="Downloads a Markdown file with the project summary, this provider's flow story, and the full component list with reasoning — real documentation, not just a picture or raw code." />
                    </span>

                    {/* Executive Summary Export (Workstream T2) -- the only export meant for a
                        non-technical reader: no diagrams, no code, no service/component names,
                        just cost/scalability/compliance/risk in plain business language. */}
                    <span className="inline-flex items-center gap-1">
                      <button
                        onClick={handleExportExecutiveSummary}
                        disabled={execSummaryExportBusy}
                        className="rounded-xl border border-line-strong bg-panel hover:bg-paper text-ink-muted px-3 py-1.5 text-[9.5px] font-extrabold uppercase transition shadow-sm active:scale-95 flex items-center gap-1 disabled:opacity-50"
                      >
                        <span>📊</span> {execSummaryExportBusy ? "Generating..." : "Executive Summary"}
                      </button>
                      <InfoTooltip text="Downloads a one-page PDF in plain business language for a non-technical reader (investor, exec) — cost, scalability story, compliance posture, and top risks. No diagrams, no code, no service names." />
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

                {/* Architecture Health Score (Workstream T3) -- a report-card badge, deliberately
                    placed right under the cost line so it's one of the first things visible, not
                    buried below the fold. Deterministic, not another LLM guess -- see
                    src/lib/health-score.ts. Each dimension expands in place to show WHY it scored
                    the way it did, reusing the same reasoning-trace pattern the rest of the app
                    already uses for decisions/risks. */}
                {healthScore && (
                  <div className="mt-4 rounded-2xl border border-line bg-white p-4 shadow-sm">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <div
                          className={`flex h-14 w-14 flex-none items-center justify-center rounded-2xl border-2 text-lg font-black ${
                            healthScoreColor(healthScore.overall) === "success"
                              ? "border-success/30 bg-success-soft text-success"
                              : healthScoreColor(healthScore.overall) === "warning"
                                ? "border-warning/30 bg-warning-soft text-warning"
                                : "border-danger/30 bg-danger-soft text-danger"
                          }`}
                        >
                          {healthScore.overall}
                        </div>
                        <div>
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-extrabold uppercase tracking-wider text-ink">Architecture Health Score</span>
                            <InfoTooltip text="A deterministic, rule-based grade (0-100) across four dimensions -- cost efficiency, scalability readiness, security posture, and vendor lock-in risk (how hard it'd be to switch cloud providers later). Not an LLM guess: every point is computed from this design's actual configuration. Click a dimension below to see exactly why it scored the way it did." />
                          </div>
                          <p className="text-[11px] text-ink-muted">out of 100, for {PROVIDER_LABELS[activeProvider]}</p>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {(Object.keys(HEALTH_DIMENSION_LABELS) as (keyof Omit<HealthScore, "overall">)[]).map((dim) => {
                          const d = healthScore[dim];
                          const color = healthScoreColor(d.score);
                          const isExpanded = expandedHealthDimension === dim;
                          return (
                            <button
                              key={dim}
                              onClick={() => setExpandedHealthDimension(isExpanded ? null : dim)}
                              className={`flex flex-col items-start rounded-xl border px-3 py-1.5 text-left transition ${
                                isExpanded ? "border-accent ring-2 ring-accent-soft" : "border-line-strong hover:border-ink-faint"
                              }`}
                            >
                              <span className="text-[9px] font-bold uppercase tracking-wide text-ink-faint">
                                {HEALTH_DIMENSION_LABELS[dim]}
                              </span>
                              <span
                                className={`text-sm font-extrabold ${
                                  color === "success" ? "text-success" : color === "warning" ? "text-warning" : "text-danger"
                                }`}
                              >
                                {d.score}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    {expandedHealthDimension && (
                      <div className="mt-3 rounded-xl border border-line bg-paper/60 p-3 text-xs">
                        <span className="font-bold text-ink">
                          Why {HEALTH_DIMENSION_LABELS[expandedHealthDimension]} scored {healthScore[expandedHealthDimension].score}:
                        </span>
                        <ul className="mt-1.5 list-disc space-y-1 pl-4 text-ink-muted">
                          {healthScore[expandedHealthDimension].reasoning.map((r, i) => (
                            <li key={i}>{r}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}

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


                {/* Security Findings (Workstream T4) -- a deterministic, rule-based audit (no
                    LLM), collapsed by default so a clean design doesn't read as alarming, but the
                    header always shows a severity-colored summary so a real problem is never
                    hidden behind a click. */}
                {architecture.securityFindings && (
                  <div className="mt-4 rounded-2xl border border-line bg-white shadow-sm overflow-hidden">
                    {/* InfoTooltip renders its own <button> internally, so it must be a SIBLING
                        of the expand/collapse button below, never a descendant -- a <button>
                        nested inside a <button> is invalid HTML and breaks hydration. */}
                    <div className="flex w-full items-center justify-between gap-2 px-4 py-3">
                      <button
                        onClick={() => setSecurityFindingsExpanded((v) => !v)}
                        className="flex flex-1 items-center gap-2 text-left"
                      >
                        <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-ink">
                          <Icon icon="mdi:shield-search-outline" width={15} height={15} />
                          Security Findings
                          {currentSecurityFindings.length === 0 ? (
                            <span className="rounded-full bg-success-soft border border-success/25 px-2 py-0.5 text-[9px] font-extrabold text-success">
                              No issues found
                            </span>
                          ) : (
                            <span
                              className={`rounded-full border px-2 py-0.5 text-[9px] font-extrabold ${
                                highSeverityCount > 0
                                  ? "bg-danger-soft border-danger/25 text-danger"
                                  : "bg-warning-soft border-warning/25 text-warning"
                              }`}
                            >
                              {currentSecurityFindings.length} finding{currentSecurityFindings.length === 1 ? "" : "s"}
                              {highSeverityCount > 0 ? ` — ${highSeverityCount} high` : ""}
                            </span>
                          )}
                        </span>
                        <Icon icon={securityFindingsExpanded ? "mdi:chevron-up" : "mdi:chevron-down"} width={16} height={16} className="ml-auto text-ink-faint" />
                      </button>
                      <InfoTooltip text="An automated, deterministic audit (not an LLM guess) checking for common gaps: missing encryption, public components connecting straight to a data store, missing authentication, missing audit logging, missing database failover/backups. Scoped to the currently selected provider, since the underlying configuration differs per provider." />
                    </div>
                    {securityFindingsExpanded && (
                      <div className="border-t border-line px-4 py-3">
                        {sortedSecurityFindings.length === 0 ? (
                          <p className="text-xs text-ink-muted">
                            No security gaps detected by this design&apos;s automated checks for {PROVIDER_LABELS[activeProvider]}.
                          </p>
                        ) : (
                          <div className="space-y-2">
                            {sortedSecurityFindings.map((f, idx) => (
                              <div
                                key={idx}
                                className={`rounded-xl border p-3 text-xs ${
                                  f.severity === "high"
                                    ? "border-danger/25 bg-danger-soft/40"
                                    : f.severity === "medium"
                                      ? "border-warning/25 bg-warning-soft/40"
                                      : "border-line bg-paper/60"
                                }`}
                              >
                                <div className="flex items-start justify-between gap-2">
                                  <span className="font-bold text-ink">{f.title}</span>
                                  <span
                                    className={`flex-none rounded-full px-2 py-0.5 text-[9px] font-extrabold uppercase ${
                                      f.severity === "high"
                                        ? "bg-danger text-white"
                                        : f.severity === "medium"
                                          ? "bg-warning text-white"
                                          : "bg-line-strong text-ink-muted"
                                    }`}
                                  >
                                    {f.severity}
                                  </span>
                                </div>
                                <p className="mt-1 text-ink-muted">{f.description}</p>
                                {f.componentName && (
                                  <button
                                    onClick={() => f.componentId && setSelectedNodeId(f.componentId)}
                                    className="mt-1.5 inline-flex items-center gap-1 rounded-full border border-line-strong bg-white px-2 py-0.5 text-[10px] font-semibold text-ink-muted hover:border-accent hover:text-accent-ink"
                                  >
                                    <Icon icon="mdi:cube-outline" width={11} height={11} />
                                    {f.componentName}
                                  </button>
                                )}
                                <p className="mt-1.5 flex items-start gap-1 text-[11px] text-ink">
                                  <Icon icon="mdi:wrench-outline" width={12} height={12} className="mt-0.5 flex-none text-ink-faint" />
                                  {f.recommendation}
                                </p>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* What Changed Diff Panel */}
                {architecture.reasoning.diff && (
                  <div className="mt-6 rounded-3xl border border-accent/25/80 bg-accent-soft/10 p-5 shadow-sm">
                    <h4 className="font-extrabold text-ink flex items-center gap-2 text-xs uppercase tracking-wider">
                      <span>🔄</span> What Changed in Version {architecture.version}
                    </h4>
                    <p className="text-[11px] text-ink-muted mt-1">
                      What changed and why — generated automatically as your requirements grew or were updated:
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

                {/* Topology Diagram — ELK-laid-out SVG canvas with pan/zoom for larger graphs.
                    Fullscreen mode (Workstream Q) reuses this exact same element rather than a
                    duplicated copy -- it just becomes a fixed full-viewport overlay instead of
                    an inline card, so every handler (drag, export, zoom) and every byte of data
                    stays identical between the two states by construction. Portaled to
                    document.body when fullscreen: several ancestor cards use backdrop-blur,
                    which (like transform/filter) creates a CSS containing block for
                    position:fixed descendants -- without the portal, "fullscreen" would only
                    ever fill that ancestor's box, not the real viewport. */}
                {(() => {
                  const diagramNode = (
                <div
                  ref={diagramViewportRef}
                  className={
                    isDiagramFullscreen
                      ? "fixed inset-0 z-50 bg-paper"
                      : "relative mt-6 rounded-2xl border border-line bg-paper shadow-inner overflow-hidden"
                  }
                  style={isDiagramFullscreen ? undefined : { height: "min(780px, calc(100vh - 260px))" }}
                >
                  <TransformWrapper ref={diagramTransformRef} initialScale={1} minScale={0.15} maxScale={2.5}>
                    {({ zoomIn, zoomOut }) => (
                      <>
                        {/* Legend for the arrows -- placed directly on the canvas rather than
                            only in the header tooltip above, since the header can scroll out of
                            view while a large diagram is still on screen. */}
                        <div className="absolute left-3 top-3 z-10 flex flex-col items-start gap-1.5">
                          <div className="flex items-center gap-1.5 rounded-lg border border-line-strong bg-panel px-2 py-1.5 shadow-sm">
                            <svg width="20" height="10" viewBox="0 0 20 10" className="flex-none">
                              <path d="M1 5 H16" stroke="#5B4FE8" strokeWidth={1.5} strokeDasharray="3 3" />
                              <path d="M14 2 L18 5 L14 8 Z" fill="#5B4FE8" />
                            </svg>
                            <span className="text-[9px] font-bold uppercase tracking-wide text-ink-muted">Flow direction</span>
                            <InfoTooltip text="The arrowhead points from the component that makes the call to the component that receives it — e.g. compute → database means the app queries the database, not the other way around." />
                          </div>
                          {/* Multi-colored flow paths (Workstream S) -- a pure stroke-color
                              overlay on the SAME ELK/elbow edge geometry, keyed to the numbered
                              User Journey steps. Off by default so the default topology look is
                              unchanged unless explicitly requested. */}
                          <button
                            onClick={() => setShowFlowSteps((v) => !v)}
                            className={`flex items-center gap-1.5 rounded-lg border px-2 py-1.5 shadow-sm transition ${
                              showFlowSteps
                                ? "border-accent bg-accent text-white"
                                : "border-line-strong bg-panel text-ink-muted hover:text-ink"
                            }`}
                          >
                            <Icon icon="mdi:palette-outline" width={13} height={13} />
                            <span className="text-[9px] font-bold uppercase tracking-wide">Flow steps</span>
                          </button>
                          {showFlowSteps && currentJourney && currentJourney.length > 0 && (
                            <div
                              className={`flex flex-col gap-1.5 rounded-lg border border-line-strong bg-panel px-2.5 py-2 shadow-sm ${
                                flowStepsExpanded ? "w-[340px]" : "w-[220px]"
                              }`}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-[9px] font-extrabold uppercase tracking-wide text-ink-faint">
                                  {currentJourney.length} step flow
                                </span>
                                <button
                                  onClick={() => setFlowStepsExpanded((v) => !v)}
                                  className="flex items-center gap-0.5 rounded px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide text-accent-ink hover:bg-accent-soft"
                                >
                                  {flowStepsExpanded ? "Collapse" : "Expand"}
                                  <Icon icon={flowStepsExpanded ? "mdi:chevron-up" : "mdi:chevron-down"} width={12} height={12} />
                                </button>
                              </div>
                              {currentJourney.map((step, idx) => (
                                <div key={idx} className="flex items-start gap-1.5">
                                  <span
                                    className="mt-0.5 flex h-3.5 w-3.5 flex-none items-center justify-center rounded-full text-[7px] font-extrabold text-white"
                                    style={{ backgroundColor: getStepColor(idx) }}
                                  >
                                    {idx + 1}
                                  </span>
                                  {flowStepsExpanded ? (
                                    <div className="min-w-0 flex-1">
                                      <p className="text-[10.5px] font-bold leading-snug text-ink">{step.userAction}</p>
                                      <p className="mt-0.5 text-[9.5px] leading-relaxed text-ink-muted">{step.systemResponse}</p>
                                      {step.componentIds.length > 0 && (
                                        <div className="mt-1 flex flex-wrap gap-1">
                                          {step.componentIds.map((cid) => (
                                            <button
                                              key={cid}
                                              onClick={() => setSelectedNodeId(cid)}
                                              className="rounded-full border border-line-strong bg-paper px-1.5 py-0.5 text-[8.5px] font-semibold text-ink-muted transition hover:border-accent hover:text-accent-ink"
                                            >
                                              {nodeNameById(cid)}
                                            </button>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                  ) : (
                                    <span className="min-w-0 flex-1 text-[9.5px] font-semibold leading-snug text-ink-muted">
                                      {step.userAction}
                                    </span>
                                  )}
                                </div>
                              ))}
                              {currentJourneyVerification && (
                                <div
                                  className={`mt-0.5 flex items-center gap-1 border-t border-line pt-1 text-[9px] font-bold uppercase tracking-wide ${
                                    currentJourneyVerification.verified ? "text-success" : "text-warning"
                                  }`}
                                >
                                  <Icon
                                    icon={currentJourneyVerification.verified ? "mdi:check-decagram" : "mdi:alert-circle-outline"}
                                    width={11}
                                    height={11}
                                  />
                                  {currentJourneyVerification.verified
                                    ? "Verified"
                                    : `${currentJourneyVerification.issues.length} issue(s)`}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
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
                          <button
                            onClick={() => setIsDiagramFullscreen((v) => !v)}
                            className={`flex h-8 w-8 items-center justify-center rounded-lg border shadow-sm transition ${
                              isDiagramFullscreen
                                ? "border-accent bg-accent text-white"
                                : "border-line-strong bg-panel text-ink-muted hover:text-ink"
                            }`}
                            aria-label={isDiagramFullscreen ? "Exit fullscreen" : "Expand to fullscreen"}
                          >
                            <Icon icon={isDiagramFullscreen ? "mdi:fullscreen-exit" : "mdi:fullscreen"} width={18} height={18} />
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
                            {/* Connections — routed through ELK's own orthogonal waypoints, so
                                skip-rank edges (e.g. into the compliance cluster) don't cut through
                                unrelated nodes and don't overlap other edges. While a node is being
                                dragged, its connected edges fall back to a live straight line
                                between renderCoords instead (ELK's stored bend points are only
                                valid for its own pre-drag positions). */}
                            {layoutConnections.map((conn, idx) => {
                              const isLiveDragging =
                                draggingNodeId && (conn.from === draggingNodeId || conn.to === draggingNodeId);
                              const points = isLiveDragging
                                ? [renderCoords[conn.from], renderCoords[conn.to]].filter(Boolean)
                                : diagramLayout.edgePoints[`${conn.from}->${conn.to}`];
                              if (!points || points.length < 2) return null;
                              const d = buildRoundedPath(points);
                              // Flow-step color is a stroke override only -- `d` above came from
                              // the exact same ELK/elbow geometry every other edge uses, never a
                              // different, simpler line for colored edges.
                              const edgeInfo = stepEdgeInfo[`${conn.from}->${conn.to}`];
                              // Numbered badges (below) only ever apply to journey-covered edges --
                              // the structural fallback gives every OTHER edge its own distinct
                              // color too, so the whole diagram is legible, but it's not part of
                              // a numbered step and gets no badge.
                              const stepColor = edgeInfo?.color || structuralEdgeColors[`${conn.from}->${conn.to}`];
                              // Badge placed at the polyline's middle vertex -- good enough to sit
                              // ON the route (per the ask to mark steps directly on the diagram,
                              // not only in the side legend) without full arc-length math.
                              const midPoint = points[Math.floor((points.length - 1) / 2)];
                              return (
                                <g key={idx}>
                                  <path
                                    d={d}
                                    fill="none"
                                    className={stepColor ? undefined : "stroke-accent/25"}
                                    style={stepColor ? { stroke: stepColor, opacity: 0.3 } : undefined}
                                    strokeWidth={stepColor ? 4 : 2.5}
                                  />
                                  <path
                                    d={d}
                                    fill="none"
                                    className={stepColor ? undefined : "stroke-accent/70"}
                                    style={stepColor ? { stroke: stepColor } : undefined}
                                    strokeWidth={1.5}
                                    strokeDasharray="5, 9"
                                    markerEnd="url(#flow-arrow)"
                                  >
                                    <animate attributeName="stroke-dashoffset" values="56;0" dur="3s" repeatCount="indefinite" />
                                  </path>
                                  {edgeInfo && midPoint && (
                                    <g>
                                      <circle cx={midPoint.x} cy={midPoint.y} r={8} fill={edgeInfo.color} stroke="white" strokeWidth={1.5} />
                                      <text
                                        x={midPoint.x}
                                        y={midPoint.y + 3}
                                        textAnchor="middle"
                                        fontSize={9}
                                        fontWeight={800}
                                        fill="white"
                                      >
                                        {edgeInfo.stepIndex + 1}
                                      </text>
                                    </g>
                                  )}
                                </g>
                              );
                            })}

                            {/* Compliance cluster — a subtle bounding box around HIPAA/PCI-style
                                compliance components so they read as a group at any graph size. */}
                            {(() => {
                              const complianceBoxes = diagramComponents
                                .filter((c) => isComplianceNode(c.type))
                                .map((c) => renderCoords[c.id])
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
                            {layoutComponents.map((node) => {
                              const coord = renderCoords[node.id];
                              if (!coord) return null;

                              // End-to-end flow bookends (Workstream R) -- visually distinct
                              // (dark card, person/device/reply icon, no per-service icon or
                              // cost) and non-interactive: they're not real components, so no
                              // selection, no drag, no drawer.
                              if ("kind" in node) {
                                const bookendIcon =
                                  node.kind === "user"
                                    ? "mdi:account-circle"
                                    : node.kind === "client"
                                      ? "mdi:monitor-cellphone"
                                      : "mdi:reply-outline";
                                const bookendLabel =
                                  node.kind === "user" ? "Start" : node.kind === "client" ? "Frontend" : "End";
                                return (
                                  <foreignObject
                                    key={node.id}
                                    x={coord.x - coord.width / 2}
                                    y={coord.y - coord.height / 2}
                                    width={coord.width}
                                    height={coord.height}
                                  >
                                    <div className="flex h-full w-full items-center gap-2.5 rounded-2xl border-2 border-dashed border-white/30 bg-ink px-3 py-2 shadow-sm">
                                      <div className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-white/15">
                                        <Icon icon={bookendIcon} width={20} height={20} className="text-white" />
                                      </div>
                                      <div className="min-w-0 flex-1">
                                        <div className="truncate text-[9.5px] font-bold uppercase tracking-wide text-white/50">
                                          {bookendLabel}
                                        </div>
                                        <div className="truncate text-[12.5px] font-bold text-white">{node.name}</div>
                                      </div>
                                    </div>
                                  </foreignObject>
                                );
                              }

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
                                    onPointerDown={(e) => handleNodePointerDown(e, node.id)}
                                    onPointerMove={handleNodePointerMove}
                                    onPointerUp={(e) => handleNodePointerUp(e, node.id)}
                                    title="Drag to reposition"
                                    className={`group relative flex h-full w-full cursor-grab items-center gap-2.5 rounded-2xl border bg-panel px-3 py-2 shadow-sm transition-all active:cursor-grabbing ${
                                      isSelected
                                        ? "border-accent ring-2 ring-accent-soft"
                                        : isComplianceNode(node.type)
                                          ? "border-warning/50 hover:border-warning"
                                          : "border-line-strong hover:border-ink-faint"
                                    } ${isOverride ? "border-dashed" : ""} ${draggingNodeId === node.id ? "opacity-80 shadow-lg" : ""}`}
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
                                      <span title="Compliance/security component — required by a regulation (e.g. PCI-DSS or HIPAA) detected in your requirements.">
                                        <Icon icon="mdi:shield-check-outline" width={15} height={15} className="flex-none text-warning" />
                                      </span>
                                    )}
                                    {isOverride && (
                                      <span
                                        title="Manually added or edited by a user, not generated by the rules engine."
                                        className="absolute -right-1.5 -top-1.5 flex h-4 w-4 flex-none items-center justify-center rounded-full bg-warning text-[8px] font-black text-white ring-2 ring-panel"
                                      >
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
                  );
                  return isDiagramFullscreen && typeof document !== "undefined"
                    ? createPortal(diagramNode, document.body)
                    : diagramNode;
                })()}

                {/* Architecture Flow Story -- plain-language, step-by-step walkthrough of
                    request/data flow for the currently active provider, synthesized from each
                    component's real service name + stored reasoning on that provider. Refetches
                    (from cache, usually) whenever the provider tab changes. */}
                <div className="mt-6 rounded-3xl border border-accent/25 bg-accent-soft/10 p-5 shadow-sm">
                  <h4 className="flex items-center gap-2 text-xs font-extrabold uppercase tracking-wider text-ink">
                    <span>🗺️</span> Architecture Flow Story
                    <span className="rounded-full bg-ink px-2 py-0.5 text-[9px] font-bold text-white uppercase">
                      {PROVIDER_LABELS[activeProvider]}
                    </span>
                    <InfoTooltip text="A step-by-step, plain-language walkthrough of how a request actually moves through this design on the selected provider — generated from the real service names and reasoning above, not a generic description." />
                  </h4>
                  {flowStoryLoading ? (
                    <div className="mt-3 flex items-center gap-1.5 text-xs text-ink-faint italic">
                      <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                      Writing the flow story for {PROVIDER_LABELS[activeProvider]}...
                    </div>
                  ) : currentFlowStory ? (
                    <>
                      <p className="mt-3 text-sm text-ink-muted leading-relaxed whitespace-pre-line">
                        {currentFlowStory}
                      </p>
                      <SourceCitations sources={currentFlowStorySources} />
                    </>
                  ) : (
                    <p className="mt-3 text-xs text-ink-faint italic">Flow story unavailable.</p>
                  )}
                </div>

                {/* Evolution History -- supplementary deep-dive, collapsed by default, entirely
                    derived from versionList + each version's already-stored reasoning.diff (see
                    evolutionPhases above). Never a replacement for the always-visible Flow Story
                    above it. */}
                {evolutionPhases.length > 0 && (
                  <div className="mt-4 rounded-3xl border border-line bg-white shadow-sm">
                    {/* A <div role="button"> rather than a real <button> -- InfoTooltip renders
                        its own <button> for the "i" icon, and nesting a <button> inside a
                        <button> is invalid HTML that React (correctly) flags as a hydration
                        error. */}
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => setIsEvolutionHistoryExpanded((v) => !v)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setIsEvolutionHistoryExpanded((v) => !v);
                        }
                      }}
                      className="flex w-full cursor-pointer items-center justify-between gap-2 p-5 text-left"
                    >
                      <span className="flex items-center gap-2 text-xs font-extrabold uppercase tracking-wider text-ink">
                        <span>🕰️</span> Evolution History
                        <span className="rounded-full bg-line px-2 py-0.5 text-[9px] font-bold text-ink-muted">
                          {evolutionPhases.length} version{evolutionPhases.length === 1 ? "" : "s"}
                        </span>
                        <InfoTooltip text="A phase-by-phase breakdown of how this architecture got to its current state -- what was built initially and what changed at each later version, and why. Derived from the same version history and diffs already computed and stored for the version dropdown, not a new summary." />
                      </span>
                      <span className="text-xs font-bold text-ink-muted">{isEvolutionHistoryExpanded ? "▲ Collapse" : "▼ Expand"}</span>
                    </div>

                    {isEvolutionHistoryExpanded && (
                      <div className="space-y-4 border-t border-line px-5 pb-5 pt-4">
                        {evolutionPhases.map((phase, idx) => (
                          <div key={phase.version} className="relative pl-6">
                            {idx < evolutionPhases.length - 1 && (
                              <span className="absolute left-[7px] top-6 bottom-[-16px] w-0.5 bg-line" />
                            )}
                            <span className="absolute left-0 top-1 h-3.5 w-3.5 rounded-full border-2 border-accent bg-white" />
                            <div className="flex flex-wrap items-baseline gap-2">
                              <h5 className="text-sm font-bold text-ink">
                                {phase.isInitial ? "Initial" : `Enhancement ${idx}`} (v{phase.version})
                              </h5>
                              <span className="text-[10px] font-semibold text-ink-faint">
                                {new Date(phase.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}
                              </span>
                            </div>

                            {phase.isInitial ? (
                              <p className="mt-1 text-xs text-ink-muted leading-relaxed">
                                Built {phase.componentCount} component{phase.componentCount === 1 ? "" : "s"}:{" "}
                                {initialPhaseComponents.map((c, i) => (
                                  <span key={c.id}>
                                    {i > 0 && ", "}
                                    <span className="font-semibold text-ink">{c.name}</span>
                                  </span>
                                ))}
                                .
                              </p>
                            ) : (
                              <div className="mt-1.5 space-y-1.5 text-xs text-ink-muted">
                                {phase.added.length === 0 && phase.removed.length === 0 && phase.modified.length === 0 && (
                                  <p className="italic">No structural changes recorded for this version.</p>
                                )}
                                {phase.added.map((c) => (
                                  <p key={`add-${c.id}`} className="leading-relaxed">
                                    <span className="font-bold text-success">+ Added {c.name}:</span> {c.reasoning}
                                  </p>
                                ))}
                                {phase.modified.map((c) => (
                                  <div key={`mod-${c.id}`} className="leading-relaxed">
                                    <span className="font-bold text-accent-ink">✎ Modified {c.name}:</span>{" "}
                                    {c.changes.map((ch, i) => (
                                      <span key={i}>
                                        {i > 0 && "; "}
                                        {ch.parameter} {ch.oldVal} → {ch.newVal} ({ch.reasoning})
                                      </span>
                                    ))}
                                  </div>
                                ))}
                                {phase.removed.map((c) => (
                                  <p key={`rem-${c.id}`} className="leading-relaxed">
                                    <span className="font-bold text-danger">− Removed {c.name}</span>
                                  </p>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Manual Editing Controls Toolbar -- container/header/card treatment matches the
                    Security Findings panel above (rounded-2xl border border-line bg-white
                    shadow-sm, px-4 py-3 header row) rather than its own ad-hoc styling, per the
                    established pattern for a bordered white content card in this column. */}
                {isEditing && draftHld && (
                  <div className="mt-4 rounded-2xl border border-line bg-white shadow-sm animate-fadeIn">
                    <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
                      <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-ink">
                        <Icon icon="mdi:wrench-outline" width={15} height={15} />
                        Manual Editor Controls
                      </span>
                      <span className="rounded-full border border-line-strong bg-paper px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-wide text-ink-faint">
                        Draft Mode
                      </span>
                    </div>

                    {/* Draft-vs-saved comparison (Workstream X) -- a running tally of everything
                        that would change if "Save Changes" above is clicked, so the confirm step
                        isn't a leap of faith. Same Added/Modified/Removed shape as the What-If and
                        Regenerate preview diffs elsewhere on this page. */}
                    {draftDiffSummary && (
                      <div className="border-b border-line px-4 py-3 bg-paper/40">
                        <span className="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-wide text-ink-faint">
                          Changes So Far (vs. Saved Version)
                          <InfoTooltip text="Everything currently different in this draft compared to what's actually saved. Nothing here is permanent until you click 'Save Changes' above." />
                        </span>
                        {!draftDiffSummary.hasChanges ? (
                          <p className="mt-1.5 text-xs italic text-ink-faint">No changes yet.</p>
                        ) : (
                          <div className="mt-1.5 flex flex-wrap gap-1.5">
                            {draftDiffSummary.added.map((c) => (
                              <span
                                key={`added-${c.id}`}
                                className="rounded-full border border-success/25 bg-success-soft px-2 py-0.5 text-[10px] font-bold text-success"
                              >
                                + {c.name}
                              </span>
                            ))}
                            {draftDiffSummary.modified.map((m) => (
                              <span
                                key={`mod-${m.id}`}
                                title={m.changes.map((ch) => `${ch.parameter}: ${ch.oldVal} → ${ch.newVal}`).join("; ")}
                                className="rounded-full border border-warning/25 bg-warning-soft px-2 py-0.5 text-[10px] font-bold text-warning"
                              >
                                ~ {m.name}
                              </span>
                            ))}
                            {draftDiffSummary.removed.map((c) => (
                              <span
                                key={`rem-${c.id}`}
                                className="rounded-full border border-danger/25 bg-danger-soft px-2 py-0.5 text-[10px] font-bold text-danger line-through"
                              >
                                {c.name}
                              </span>
                            ))}
                            {draftDiffSummary.connectionsChanged && (
                              <span className="rounded-full border border-line-strong bg-paper px-2 py-0.5 text-[10px] font-bold text-ink-muted">
                                Connections changed
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    <div className="space-y-6 px-4 py-4">
                      {/* Form 1: Add Component -- fields stacked full-width rather than squeezed
                          two-up: this column is narrow enough (diagram + drawer share the page)
                          that a side-by-side select+input pair left every field too cramped to
                          read at normal viewport widths, regardless of breakpoint. */}
                      <form onSubmit={handleAddComponent}>
                        <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-ink">
                          <Icon icon="mdi:cube-plus-outline" width={14} height={14} />
                          Add Component
                          <InfoTooltip text="Adds a new box to the draft diagram -- pick a type, give it a name, and optionally note why it's needed. It only joins the diagram once you click 'Add Component Node' below, and only becomes permanent once you save the draft." />
                        </div>
                        {(componentSuggestionsLoading || componentSuggestions.length > 0) && (
                          <div className="mt-2.5">
                            <span className="text-[9px] font-bold uppercase tracking-wide text-ink-faint">
                              {componentSuggestionsLoading ? "Suggesting relevant components..." : "AI-suggested, based on your requirements:"}
                            </span>
                            {componentSuggestions.length > 0 && (
                              <div className="mt-1.5 flex flex-wrap gap-1">
                                {componentSuggestions.map((s, idx) => (
                                  <span
                                    key={idx}
                                    className="inline-flex max-w-full items-center gap-1 rounded-full border border-accent/25 bg-accent-soft py-0.5 pl-2 pr-1.5 transition hover:border-accent hover:bg-accent/15"
                                  >
                                    <button
                                      type="button"
                                      onClick={() => applyComponentSuggestion(s)}
                                      title={`${s.name}: ${s.reasoning}`}
                                      className="max-w-[220px] truncate text-[10px] font-medium text-accent-ink"
                                    >
                                      + {s.name}
                                    </button>
                                    <InfoTooltip text={`Why suggested: ${s.reasoning}`} />
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                        <div className="mt-3 space-y-2.5">
                          <select
                            value={newNodeType}
                            onChange={(e) => setNewNodeType(e.target.value)}
                            className="w-full bg-white border border-line rounded-xl px-3 py-2 text-xs font-semibold focus:outline-none focus:ring-1 focus:ring-accent"
                          >
                            {NODE_TYPE_OPTIONS.map((opt) => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label}
                              </option>
                            ))}
                            {!NODE_TYPE_OPTIONS.some((opt) => opt.value === newNodeType) && (
                              <option value={newNodeType}>{TYPE_LABELS[newNodeType] || newNodeType}</option>
                            )}
                          </select>
                          <input
                            type="text"
                            value={newNodeName}
                            onChange={(e) => setNewNodeName(e.target.value)}
                            placeholder="Component name (e.g. MemoryDB)"
                            className="w-full bg-white border border-line rounded-xl px-3 py-2 text-xs font-semibold focus:outline-none focus:ring-1 focus:ring-accent"
                          />
                          <input
                            type="text"
                            value={newNodeReasoning}
                            onChange={(e) => setNewNodeReasoning(e.target.value)}
                            placeholder="Optional: rationale / reason for adding..."
                            className="w-full bg-white border border-line rounded-xl px-3 py-2 text-xs font-medium focus:outline-none focus:ring-1 focus:ring-accent"
                          />
                          <button
                            type="submit"
                            className="w-full rounded-xl bg-accent hover:bg-accent-ink text-white px-4 py-2 text-xs font-bold uppercase transition shadow-sm active:scale-95"
                          >
                            Add Component Node
                          </button>
                        </div>
                      </form>

                      {/* Form 2: Add Connection -- separated from Add Component by a visible
                          divider, not just column position, since both now stack vertically. */}
                      <form onSubmit={handleAddConnection} className="border-t border-line pt-6">
                        <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-ink">
                          <Icon icon="mdi:transit-connection-variant" width={14} height={14} />
                          Add Connection
                          <InfoTooltip text="Draws a link between two existing components in the diagram, meaning data or requests flow between them. Pick the source, the destination, and the protocol they talk over (e.g. HTTPS, TCP, gRPC)." />
                        </div>
                        <div className="mt-3 space-y-2.5">
                          <div>
                            <label className="mb-1 flex items-center gap-1 text-[9px] font-bold uppercase tracking-wide text-ink-faint">
                              From
                              <InfoTooltip text="The component the connection starts at -- the one initiating the request or sending the data." />
                            </label>
                            <select
                              value={newEdgeFrom}
                              onChange={(e) => setNewEdgeFrom(e.target.value)}
                              className="w-full bg-white border border-line rounded-xl px-3 py-2 text-xs font-semibold focus:outline-none focus:ring-1 focus:ring-accent"
                            >
                              <option value="">Select from...</option>
                              {draftHld.components.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.name} ({c.type})
                                </option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className="mb-1 flex items-center gap-1 text-[9px] font-bold uppercase tracking-wide text-ink-faint">
                              To
                              <InfoTooltip text="The component the connection ends at -- the one receiving the request or data." />
                            </label>
                            <select
                              value={newEdgeTo}
                              onChange={(e) => setNewEdgeTo(e.target.value)}
                              className="w-full bg-white border border-line rounded-xl px-3 py-2 text-xs font-semibold focus:outline-none focus:ring-1 focus:ring-accent"
                            >
                              <option value="">Select to...</option>
                              {draftHld.components.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.name} ({c.type})
                                </option>
                              ))}
                            </select>
                          </div>
                          <div className="flex gap-2.5">
                            <input
                              type="text"
                              value={newEdgeProtocol}
                              onChange={(e) => setNewEdgeProtocol(e.target.value)}
                              placeholder="Protocol (e.g. HTTPS, TCP)"
                              className="flex-1 min-w-0 bg-white border border-line rounded-xl px-3 py-2 text-xs font-semibold focus:outline-none focus:ring-1 focus:ring-accent"
                            />
                            <button
                              type="submit"
                              className="flex-none rounded-xl bg-ink hover:bg-ink/90 text-white px-4 py-2 text-xs font-bold uppercase transition shadow-sm active:scale-95"
                            >
                              Connect
                            </button>
                          </div>
                        </div>
                      </form>

                      {/* Active Connections List (for simple deletion) -- one connection per row
                          rather than wrapped chips, so long component names never crowd two
                          entries onto the same visual line. */}
                      <div className="border-t border-line pt-6">
                        <span className="mb-2.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-ink">
                          Active Connection Links
                          <InfoTooltip text="Every connection currently in the draft diagram. Click the × on a row to remove that link -- like everything else here, it's only permanent once you save the draft." />
                        </span>
                        <div className="flex flex-col gap-2 max-h-[180px] overflow-y-auto pr-1">
                          {draftHld.connections.length === 0 ? (
                            <span className="text-xs italic text-ink-faint">No active connections.</span>
                          ) : (
                            draftHld.connections.map((conn, idx) => {
                              const fromNode = draftHld.components.find((c) => c.id === conn.from);
                              const toNode = draftHld.components.find((c) => c.id === conn.to);
                              return (
                                <div
                                  key={idx}
                                  className="flex items-center justify-between gap-2 rounded-xl border border-line bg-paper/60 px-3 py-2 text-xs font-semibold text-ink-muted"
                                >
                                  <span className="min-w-0 truncate">
                                    <span className="text-ink">{fromNode?.name || conn.from}</span>
                                    <span className="mx-1.5 text-ink-faint font-normal">➜</span>
                                    <span className="text-ink">{toNode?.name || conn.to}</span>
                                    <span className="ml-1.5 text-ink-faint">({conn.protocol})</span>
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => handleRemoveConnection(conn.from, conn.to)}
                                    className="flex-none rounded-lg px-1.5 py-0.5 font-black text-danger transition hover:bg-danger-soft"
                                    aria-label={`Remove connection from ${fromNode?.name || conn.from} to ${toNode?.name || conn.to}`}
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
                        <div className="flex items-start gap-2.5 rounded-2xl border border-success/25 bg-success-soft p-3 text-xs text-success shadow-sm animate-fadeIn">
                          <span className="text-sm">✅</span>
                          <div className="leading-relaxed">
                            <span className="font-extrabold uppercase text-[9px] tracking-wider text-success block">
                              All Clear
                            </span>
                            All structural validation checks passed. Ready to save!
                          </div>
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
                  <InfoTooltip text="Previews what regenerating from your current requirements would produce -- a new version (e.g. v0.1.0 → v0.1.1) compared against this one. Nothing is created until you review the preview and explicitly apply it. Past versions stay browsable from the Version dropdown above." />
                  <button
                    onClick={handlePreviewRegenerate}
                    disabled={isGenerationBlocked || regeneratePreviewLoading}
                    className="rounded-xl bg-ink hover:bg-ink/90 text-white px-4 py-2 text-xs font-bold transition shadow-sm active:scale-95 disabled:opacity-50"
                  >
                    {regeneratePreviewLoading ? "Generating Preview..." : "Regenerate Design"}
                  </button>
                </span>
              </div>

              {/* Regenerate preview panel (Workstream X) -- reuses the exact same diff/cost
                  rendering shape as the What-If preview above (both are compute_architecture_diff
                  output), since "regenerate" is really just "what if nothing changed", run through
                  the same preview-then-confirm pattern every other edit pathway here follows. */}
              {regenerateError && <p className="mt-3 text-xs font-semibold text-danger">{regenerateError}</p>}
              {regeneratePreview && (
                <div ref={regeneratePreviewRef} className="mt-4 rounded-2xl border border-line bg-white shadow-sm animate-fadeIn scroll-mt-4">
                  <div className="px-4 py-4 space-y-3">
                    <span className="inline-flex items-center gap-1 rounded-full bg-ink px-2.5 py-1 text-[9px] font-extrabold uppercase tracking-wide text-white">
                      <Icon icon="mdi:eye-outline" width={11} height={11} />
                      Preview only — not saved
                    </span>

                    {(() => {
                      const costPreview = regenerateCostPreview();
                      if (!costPreview) return null;
                      const wentUp = costPreview.after.min + costPreview.after.max > costPreview.before.min + costPreview.before.max;
                      return (
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                          <span className="text-ink-muted">Projected cost for {PROVIDER_LABELS[activeProvider]}:</span>
                          <span className="font-bold text-ink">
                            ${costPreview.before.min} - ${costPreview.before.max}/mo
                          </span>
                          <Icon icon="mdi:arrow-right" width={12} height={12} className="text-ink-faint" />
                          <span className={`font-bold ${wentUp ? "text-warning" : "text-success"}`}>
                            ${costPreview.after.min} - ${costPreview.after.max}/mo
                          </span>
                        </div>
                      );
                    })()}

                    {regeneratePreview.recommendation && (
                      <p className="mt-2 text-[11px] text-ink-muted">
                        <span className="font-bold text-ink">Recommended provider: </span>
                        {regeneratePreview.recommendation.recommendedProvider.toUpperCase()} — {regeneratePreview.recommendation.rationale}
                      </p>
                    )}

                    {regeneratePreview.diff &&
                    (regeneratePreview.diff.added?.length || regeneratePreview.diff.modified?.length || regeneratePreview.diff.removed?.length) ? (
                      <div className="mt-3 grid gap-3 sm:grid-cols-3 border-t border-line pt-3">
                        {regeneratePreview.diff.added?.length > 0 && (
                          <div className="space-y-1.5">
                            <span className="text-[9px] font-black text-success uppercase tracking-widest block bg-success-soft/60 border border-success/25 px-2 py-0.5 rounded w-max">
                              + Added
                            </span>
                            <ul className="text-xs space-y-1.5 text-ink-muted">
                              {regeneratePreview.diff.added.map((item, idx) => (
                                <li key={idx}>
                                  <span className="font-bold text-ink block">{item.name}</span>
                                  <span className="block text-[10.5px] italic">{item.reasoning}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {regeneratePreview.diff.modified?.length > 0 && (
                          <div className="space-y-1.5">
                            <span className="text-[9px] font-black text-warning uppercase tracking-widest block bg-warning-soft/60 border border-warning/25 px-2 py-0.5 rounded w-max">
                              ~ Modified
                            </span>
                            <ul className="text-xs space-y-2 text-ink-muted">
                              {regeneratePreview.diff.modified.map((item, idx) => (
                                <li key={idx}>
                                  <span className="font-bold text-ink block">{item.name}</span>
                                  {item.changes.map((ch, cIdx) => (
                                    <div key={cIdx} className="mt-0.5 pl-2 border-l-2 border-line text-[10.5px]">
                                      <span className="text-ink-faint line-through">{ch.oldVal}</span> ➜{" "}
                                      <span className="font-bold text-ink">{ch.newVal}</span>
                                    </div>
                                  ))}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {regeneratePreview.diff.removed?.length > 0 && (
                          <div className="space-y-1.5">
                            <span className="text-[9px] font-black text-danger uppercase tracking-widest block bg-danger-soft/60 border border-danger/25 px-2 py-0.5 rounded w-max">
                              − Removed
                            </span>
                            <ul className="text-xs space-y-1.5 text-ink-muted">
                              {regeneratePreview.diff.removed.map((item, idx) => (
                                <li key={idx}>
                                  <span className="font-bold text-ink line-through block">{item.name}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    ) : (
                      <p className="mt-2 text-xs text-ink-muted">
                        No architecture changes detected -- regenerating would create an identical new version.
                      </p>
                    )}

                    <div className="mt-3 flex items-center gap-2">
                      <button
                        onClick={handleGenerate}
                        disabled={generating}
                        className="rounded-xl bg-success px-3 py-1.5 text-xs font-bold uppercase text-white shadow-sm transition hover:opacity-90 active:scale-95 disabled:opacity-40"
                      >
                        {generating ? "Saving..." : "✓ Apply as New Version"}
                      </button>
                      <button
                        onClick={() => setRegeneratePreview(null)}
                        className="rounded-xl bg-ink-muted px-3 py-1.5 text-xs font-bold uppercase text-white shadow-sm transition hover:bg-ink active:scale-95"
                      >
                        Discard
                      </button>
                    </div>
                  </div>
                </div>
              )}
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
                          {PROVIDER_LABELS[activeProvider]} Mapped
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
                    <p className="text-[10px] text-ink-faint font-semibold uppercase mt-0.5 tracking-wider inline-flex items-center gap-1">
                      Also known as: {selectedNode.name}
                      <InfoTooltip text="The name for this piece of your architecture that doesn't depend on any specific cloud provider." />
                    </p>

                    <div className="mt-3 rounded-2xl border border-accent/25 bg-accent-soft p-3.5 text-xs text-ink leading-relaxed">
                      {getPlainDescription(selectedNode.type, selectedNode.id)}
                    </div>

                    {/* Learn toggle -- collapsed by default so it doesn't clutter the
                        professional view. Teaches the underlying concept with a real-world
                        analogy; deliberately not a tutorial screen or forced walkthrough, just
                        depth available on demand for whoever wants it. */}
                    {(() => {
                      const learn = getLearnContent(selectedNode.type, selectedNode.id);
                      if (!learn) return null;
                      return (
                        <div className="mt-2">
                          <button
                            onClick={() => setIsLearnExpanded((v) => !v)}
                            className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-accent-ink hover:underline"
                          >
                            <span>{isLearnExpanded ? "▲" : "▼"}</span>
                            <span>🎓 Learn: what is this, really?</span>
                          </button>
                          {isLearnExpanded && (
                            <div className="mt-2 rounded-2xl border border-line bg-white p-3.5 text-xs text-ink-muted leading-relaxed space-y-2 animate-fadeIn">
                              <p>
                                <span className="font-bold text-ink">Think of it like: </span>
                                {learn.analogy}
                              </p>
                              <p>{learn.deeper}</p>
                            </div>
                          )}
                        </div>
                      );
                    })()}

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

                  {/* Sub-choice suggestions -- one level more granular than the whole-service
                      swap under "Alternatives Considered" below: variants WITHIN the
                      already-chosen service (e.g. which engine Amazon RDS runs), not a
                      different service entirely. Shown in the same modes as the whole-service
                      swap section. */}
                  {subChoiceDef && subChoiceOptions.length > 0 && (explanationMode === "technical" || isEditing) && (
                    <div className="border-t border-line/80 pt-4">
                      <h5 className="flex items-center gap-1.5 text-xs font-bold text-ink-muted uppercase tracking-wider">
                        {subChoiceDef.label}
                        <InfoTooltip text="A more granular choice within the service already selected above -- e.g. which database engine Amazon RDS runs. Switching here updates the low-level config, not which top-level cloud service is used." />
                      </h5>

                      {/* Current internal configuration state, shown before the alternatives so
                          it's clear what's already selected, not just a flat option list. */}
                      <div className="mt-2 rounded-2xl border border-line bg-white p-3 text-[11px] text-ink-muted">
                        <span className="font-bold text-ink">Currently configured: </span>
                        {subChoiceDef.currentSummaryKeys
                          .filter((k) => lldData?.config?.[k])
                          .map((k, i) => (
                            <span key={k}>
                              {i > 0 && " · "}
                              <span className="font-semibold text-ink">{k}:</span> {lldData!.config[k]}
                            </span>
                          ))}
                      </div>

                      <div className="mt-2 space-y-2">
                        {subChoiceOptions.map((opt) => {
                          const isCurrent = lldData?.config?.[subChoiceDef.key] === opt.value;
                          return (
                            <div
                              key={opt.value}
                              className={`rounded-2xl border p-3.5 text-xs leading-normal ${
                                isCurrent ? "border-accent/40 bg-accent-soft/40" : "border-line bg-white text-ink"
                              }`}
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div className="font-bold text-ink">
                                  {opt.label}
                                  {isCurrent && (
                                    <span className="ml-1.5 rounded-full bg-accent px-1.5 py-0.5 text-[8px] font-extrabold uppercase tracking-wide text-white">
                                      Current
                                    </span>
                                  )}
                                  {!isCurrent && opt.recommended && (
                                    <span className="ml-1.5 rounded-full bg-success-soft px-1.5 py-0.5 text-[8px] font-extrabold uppercase tracking-wide text-success">
                                      Recommended
                                    </span>
                                  )}
                                </div>
                                {isEditing && !isCurrent && (
                                  <button
                                    type="button"
                                    onClick={() => handleSelectSubChoice(subChoiceDef.key, opt)}
                                    className="shrink-0 rounded-lg bg-accent hover:bg-accent-ink text-white px-2 py-1 text-[9px] font-extrabold uppercase tracking-wide transition shadow-sm"
                                  >
                                    Select
                                  </button>
                                )}
                              </div>
                              <div className="text-ink-muted mt-1 font-medium leading-relaxed">{opt.reasoning}</div>
                            </div>
                          );
                        })}
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
                                    // LLD config values are a mix of genuinely numeric settings
                                    // (replica counts, storage sizes) and categorical strings
                                    // (instance types, region names, "true"/"false") sharing one
                                    // generic key/value editor -- inferred from the CURRENT
                                    // value's shape (not a hardcoded key-name allowlist, which
                                    // would go stale) rather than restricting every field.
                                    /^-?\d+(\.\d+)?$/.test(val) ? (
                                      <NumericInput
                                        value={val}
                                        onChange={(next) =>
                                          handleUpdateLldConfig(selectedNode.id, activeProvider, key, next)
                                        }
                                        maxLength={12}
                                        className="font-mono text-[10px] font-bold text-ink bg-paper border border-line px-1.5 py-0.5 rounded text-right focus:outline-none focus:ring-1 focus:ring-accent w-32"
                                      />
                                    ) : (
                                      <input
                                        type="text"
                                        value={val}
                                        onChange={(e) =>
                                          handleUpdateLldConfig(selectedNode.id, activeProvider, key, e.target.value)
                                        }
                                        maxLength={100}
                                        className="font-mono text-[10px] font-bold text-ink bg-paper border border-line px-1.5 py-0.5 rounded text-right focus:outline-none focus:ring-1 focus:ring-accent w-32"
                                      />
                                    )
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
                        <SourceCitations sources={selectedNode.sources} />
                      </div>
                      {/* Domain-awareness (kept visually SEPARATE from the reasoning box above --
                          a different kind of grounding, from general domain-typical knowledge
                          rather than this project's own stated requirements, so it must never
                          read as if it were part of the same claim). */}
                      {selectedNode.domainPattern && (
                        <div className="mt-2 flex items-start gap-1.5 rounded-2xl border border-warning/30 bg-warning-soft/40 p-3 text-[11px] text-ink-muted leading-relaxed">
                          <span className="flex-none text-sm">🧭</span>
                          <span>
                            <span className="mr-1 font-bold uppercase tracking-wide text-[9px] text-warning">Domain Pattern</span>
                            <InfoTooltip text="A practice commonly used by similar products in this industry — not specific to your stated requirements, but worth knowing." />
                            <br />
                            {selectedNode.domainPattern}
                          </span>
                        </div>
                      )}
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
        ) : viewMode === "comparison" ? (
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
                  <SourceCitations sources={recommendation.sources} />
                  {recommendation.domainPattern && (
                    <div className="mt-2 flex max-w-4xl items-start gap-1.5 rounded-2xl border border-warning/30 bg-warning-soft/40 p-3 text-[11px] text-ink-muted leading-relaxed">
                      <span className="flex-none text-sm">🧭</span>
                      <span>
                        <span className="mr-1 font-bold uppercase tracking-wide text-[9px] text-warning">Domain Pattern</span>
                        <InfoTooltip text="A practice commonly used by similar products in this industry — not specific to your stated requirements, but worth knowing." />
                        <br />
                        {recommendation.domainPattern}
                      </span>
                    </div>
                  )}
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
                        What You Need
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
        ) : viewMode === "journey" ? (
          /* User Journey Architecture View -- end-user-centric, step-by-step, distinct from the
             infra-centric topology diagram but linkable to it (clicking a step's component chip
             jumps back to Topology View with that component selected). Synthesized from the
             Flow Story (Workstream G) rather than an independent narrative. */
          <div className="h-full overflow-y-auto p-6">
            <div className="mx-auto max-w-3xl">
              <div className="flex flex-wrap items-center justify-between gap-y-2">
                <div className="flex items-center gap-2">
                  <h4 className="text-lg font-black text-ink">User Journey Architecture</h4>
                  <InfoTooltip text="A step-by-step walkthrough from the end user's perspective -- what they do, what happens behind the scenes, and which real components are involved at each step. Synthesized from the Architecture Flow Story for this provider, restructured into discrete steps. Click a component chip to jump to it in the Diagram." />
                  {currentJourneyVerification && (
                    <span
                      className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9.5px] font-extrabold uppercase tracking-wide ${
                        currentJourneyVerification.verified
                          ? "border-success/25 bg-success-soft text-success"
                          : "border-warning/25 bg-warning-soft text-warning"
                      }`}
                      title={
                        currentJourneyVerification.verified
                          ? "Every step's components exist and consecutive steps are linked by a real connection in this architecture."
                          : currentJourneyVerification.issues.join(" ")
                      }
                    >
                      <Icon
                        icon={currentJourneyVerification.verified ? "mdi:check-decagram" : "mdi:alert-circle-outline"}
                        width={12}
                        height={12}
                      />
                      {currentJourneyVerification.verified ? "Verified" : "Unverified"}
                    </span>
                  )}
                </div>
                {/* Provider toggle, mirroring the one in Topology View -- the journey text and
                    component names genuinely differ per provider, so switching shouldn't
                    require leaving this view. */}
                <div className="flex bg-paper/80 p-0.5 rounded-lg border border-line shadow-sm">
                  {(["aws", "azure", "gcp", "kubernetes", "private"] as const).map((p) => (
                    <button
                      key={p}
                      onClick={() => setActiveProvider(p)}
                      className={`px-2 py-1 text-[9px] font-extrabold uppercase rounded transition ${
                        activeProvider === p ? "bg-ink text-white shadow-sm" : "text-ink-muted hover:text-ink"
                      }`}
                    >
                      {PROVIDER_LABELS[p]}
                    </button>
                  ))}
                </div>
              </div>
              <p className="mt-1.5 text-xs text-ink-muted leading-relaxed">
                How a real user moves through this product end-to-end, mapped to the actual infrastructure behind each step -- the way a solutions architect would walk through it in a design review.
              </p>

              {currentJourneyVerification && !currentJourneyVerification.verified && (
                <div className="mt-4 flex items-start gap-2.5 rounded-2xl border border-warning/25 bg-warning-soft/60 p-3.5 text-xs text-warning shadow-sm">
                  <Icon icon="mdi:alert-circle-outline" width={16} height={16} className="mt-0.5 flex-none" />
                  <div className="leading-relaxed">
                    <span className="font-extrabold uppercase text-[9px] tracking-wider text-warning block">
                      This journey doesn&apos;t fully match the architecture
                    </span>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4">
                      {currentJourneyVerification.issues.map((issue, i) => (
                        <li key={i}>{issue}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}

              {journeyLoading ? (
                <div className="mt-8 flex items-center justify-center gap-2 text-xs text-ink-muted">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                  Synthesizing the user journey for {PROVIDER_LABELS[activeProvider]}...
                </div>
              ) : !currentJourney || currentJourney.length === 0 ? (
                <div className="mt-8 text-center text-xs text-ink-muted">
                  No journey could be generated yet for this provider.
                </div>
              ) : (
                <ol className="mt-6 space-y-0">
                  {currentJourney.map((step, idx) => (
                    <li key={idx} className="relative pl-10 pb-8 last:pb-0">
                      {idx < currentJourney.length - 1 && (
                        <span className="absolute left-[15px] top-8 bottom-0 w-0.5 bg-line" />
                      )}
                      <span
                        className="absolute left-0 top-0 flex h-8 w-8 items-center justify-center rounded-full text-xs font-extrabold text-white"
                        style={{ backgroundColor: getStepColor(idx) }}
                        title="Matches this step's color in the Diagram when 'Flow steps' is on"
                      >
                        {idx + 1}
                      </span>
                      <div className="rounded-2xl border border-line bg-white p-4 shadow-sm">
                        <div className="flex items-start gap-1.5">
                          <span className="mt-0.5 flex-none text-sm">🙋</span>
                          <p className="text-sm font-bold text-ink leading-snug">{step.userAction}</p>
                        </div>
                        <div className="mt-2 flex items-start gap-1.5">
                          <span className="mt-0.5 flex-none text-sm">⚙️</span>
                          <p className="text-xs text-ink-muted leading-relaxed">{step.systemResponse}</p>
                        </div>
                        {step.componentIds.length > 0 && (
                          <div className="mt-3 flex flex-wrap items-center gap-1.5">
                            <span className="text-[9px] font-bold uppercase tracking-wide text-ink-faint">
                              Components touched:
                            </span>
                            {step.componentIds.map((cid) => (
                              <button
                                key={cid}
                                onClick={() => handleJourneyComponentClick(cid)}
                                className="rounded-full border border-accent/30 bg-accent-soft px-2 py-0.5 text-[10px] font-semibold text-accent-ink transition hover:border-accent hover:bg-accent/15"
                              >
                                {nodeNameById(cid)}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        ) : (
          /* Migration Roadmap View (Workstream T5) -- a phased plan from the project's stated
             existing system to this target architecture. Only reachable via the tab, which is
             itself only shown when requirements.existingSystem is set, so this view never
             renders for a plain greenfield project. */
          <div className="h-full overflow-y-auto p-6">
            <div className="mx-auto max-w-3xl">
              <div className="flex flex-wrap items-center justify-between gap-y-2">
                <div className="flex items-center gap-2">
                  <h4 className="text-lg font-black text-ink">Migration Roadmap</h4>
                  <InfoTooltip text="A phased plan for migrating from your existing system to this target architecture, using the strangler-fig pattern where it genuinely applies -- incrementally routing traffic to new components while the legacy system keeps running, rather than one risky cutover. Grounded in this provider's actual target components." />
                </div>
                <div className="flex bg-paper/80 p-0.5 rounded-lg border border-line shadow-sm">
                  {(["aws", "azure", "gcp", "kubernetes", "private"] as const).map((p) => (
                    <button
                      key={p}
                      onClick={() => setActiveProvider(p)}
                      className={`px-2 py-1 text-[9px] font-extrabold uppercase rounded transition ${
                        activeProvider === p ? "bg-ink text-white shadow-sm" : "text-ink-muted hover:text-ink"
                      }`}
                    >
                      {PROVIDER_LABELS[p]}
                    </button>
                  ))}
                </div>
              </div>
              <p className="mt-1.5 text-xs text-ink-muted leading-relaxed">
                From what you described about your existing system to this target architecture for {PROVIDER_LABELS[activeProvider]}.
              </p>

              {requirements?.existingSystem && (
                <div className="mt-4 rounded-2xl border border-line bg-paper/60 p-3.5 text-xs">
                  <span className="text-[9px] font-bold uppercase tracking-wide text-ink-faint">Your existing system</span>
                  <p className="mt-1 text-ink-muted">
                    <span className="font-semibold text-ink">Stack: </span>
                    {requirements.existingSystem.techStack || "not specified"}
                  </p>
                  <p className="mt-1 text-ink-muted">
                    <span className="font-semibold text-ink">Deployment: </span>
                    {requirements.existingSystem.deployment || "not specified"}
                  </p>
                  <p className="mt-1 text-ink-muted">
                    <span className="font-semibold text-ink">Pain points: </span>
                    {requirements.existingSystem.painPoints || "not specified"}
                  </p>
                </div>
              )}

              {migrationLoading ? (
                <div className="mt-8 flex items-center justify-center gap-2 text-xs text-ink-muted">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                  Planning the migration for {PROVIDER_LABELS[activeProvider]}...
                </div>
              ) : migrationError ? (
                <div className="mt-8 text-center text-xs text-danger">{migrationError}</div>
              ) : !currentMigrationRoadmap || currentMigrationRoadmap.length === 0 ? (
                <div className="mt-8 text-center text-xs text-ink-muted">No migration roadmap could be generated yet for this provider.</div>
              ) : (
                <ol className="mt-6 space-y-0">
                  {currentMigrationRoadmap.map((p, idx) => {
                    const EFFORT_COLOR: Record<MigrationPhase["effort"], string> = {
                      small: "bg-success-soft border-success/25 text-success",
                      medium: "bg-warning-soft border-warning/25 text-warning",
                      large: "bg-danger-soft border-danger/25 text-danger",
                    };
                    return (
                      <li key={idx} className="relative pl-10 pb-8 last:pb-0">
                        {idx < currentMigrationRoadmap.length - 1 && (
                          <span className="absolute left-[15px] top-8 bottom-0 w-0.5 bg-line" />
                        )}
                        <span className="absolute left-0 top-0 flex h-8 w-8 items-center justify-center rounded-full bg-ink text-xs font-extrabold text-white">
                          {p.phase}
                        </span>
                        <div className="rounded-2xl border border-line bg-white p-4 shadow-sm">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-sm font-bold text-ink">{p.title}</span>
                            <div className="flex items-center gap-1.5">
                              {p.usesStranglerFig && (
                                <span className="inline-flex items-center gap-1 rounded-full border border-accent/25 bg-accent-soft px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-wide text-accent-ink">
                                  Strangler-fig
                                  <InfoTooltip text="Strangler-fig: gradually route traffic to the new system piece by piece, instead of switching everything over at once." />
                                </span>
                              )}
                              <span className={`rounded-full border px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-wide ${EFFORT_COLOR[p.effort]}`}>
                                {p.effort} effort
                              </span>
                            </div>
                          </div>
                          <div className="mt-2 flex items-start gap-1.5">
                            <span className="mt-0.5 flex-none text-sm">🔧</span>
                            <p className="text-xs text-ink leading-relaxed">{p.whatChanges}</p>
                          </div>
                          <div className="mt-2 flex items-start gap-1.5">
                            <span className="mt-0.5 flex-none text-sm">💡</span>
                            <p className="text-xs text-ink-muted leading-relaxed">{p.why}</p>
                          </div>
                          {p.domainPattern && (
                            <div className="mt-2 flex items-start gap-1.5 rounded-xl border border-warning/30 bg-warning-soft/40 p-2.5 text-[11px] text-ink-muted leading-relaxed">
                              <span className="flex-none text-sm">🧭</span>
                              <span>
                                <span className="mr-1 font-bold uppercase tracking-wide text-[9px] text-warning">Domain Pattern</span>
                                <InfoTooltip text="A practice commonly used by similar products in this industry — not specific to your stated requirements, but worth knowing." />
                                <br />
                                {p.domainPattern}
                              </span>
                            </div>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
