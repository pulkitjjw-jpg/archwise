"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import RequirementsPanel from "./RequirementsPanel";
import ArchitectureWorkspaceErrorBoundary from "./ArchitectureWorkspaceErrorBoundary";
import CollaborationPanel from "./CollaborationPanel";

// ArchitectureWorkspace is 5000+ lines (SVG diagram rendering, manual editor, multi-provider
// cloud mapping, terraform export) but the "Requirements" tab is always what's active first --
// see activeTab's initial value below. Loading it via next/dynamic instead of a static import
// keeps all of that code out of this route's initial JS chunk; it's fetched only once the user
// actually clicks over to the "Architecture Diagram" tab. ssr: false because this component is
// never part of the server-rendered first paint anyway (it's gated behind client-only tab state
// that starts on "requirements"), and it does browser-only things (document.body portal for
// fullscreen, pointer-based drag) that have no meaningful server render.
const ArchitectureWorkspace = dynamic(() => import("./ArchitectureWorkspace"), {
  ssr: false,
  loading: () => (
    <div className="flex h-96 flex-col items-center justify-center p-8 text-ink-muted">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-accent border-t-transparent" />
      <span className="mt-4 text-sm font-semibold">Loading architecture workspace...</span>
    </div>
  ),
});

interface WorkspaceTabsProps {
  projectId: string;
  isBrainstormComplete: boolean;
  focusMode?: boolean;
  onToggleFocusMode?: () => void;
}

export default function WorkspaceTabs({
  projectId,
  isBrainstormComplete,
  focusMode,
  onToggleFocusMode,
}: WorkspaceTabsProps) {
  const [activeTab, setActiveTab] = useState<"requirements" | "hld" | "team">("requirements");
  const [requirements, setRequirements] = useState<any>(null);
  const [focusField, setFocusField] = useState<string | null>(null);

  const loadRequirements = async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/requirements`);
      if (res.ok) {
        const data = await res.json();
        setRequirements(data.requirements);
      } else {
        setRequirements(null);
      }
    } catch (err) {
      console.error("Error loading requirements in tabs:", err);
    }
  };

  const handleSwitchTab = (tab: "requirements" | "hld", fieldToFocus?: string) => {
    setActiveTab(tab);
    if (fieldToFocus) {
      setFocusField(fieldToFocus);
    }
  };

  useEffect(() => {
    loadRequirements();
  }, [projectId, isBrainstormComplete]);

  useEffect(() => {
    window.addEventListener("requirementsUpdated", loadRequirements);
    return () => window.removeEventListener("requirementsUpdated", loadRequirements);
  }, [projectId]);

  return (
    <div className="flex h-full flex-col rounded-[2rem] border border-white/60 bg-white/70 shadow-xl backdrop-blur-md overflow-hidden">
      {/* Tabs Header */}
      <div className="border-b border-line bg-paper/50 px-6 py-3 flex gap-4">
        <button
          onClick={() => setActiveTab("requirements")}
          className={`px-4 py-2 text-xs font-bold uppercase tracking-wider rounded-xl transition ${
            activeTab === "requirements"
              ? "bg-ink text-white shadow-sm"
              : "text-ink-muted hover:bg-line/50"
          }`}
        >
          1. Requirements
        </button>
        <button
          onClick={() => setActiveTab("hld")}
          className={`px-4 py-2 text-xs font-bold uppercase tracking-wider rounded-xl transition ${
            activeTab === "hld"
              ? "bg-ink text-white shadow-sm"
              : "text-ink-muted hover:bg-line/50"
          }`}
        >
          2. Architecture Diagram
        </button>
        <button
          onClick={() => setActiveTab("team")}
          className={`px-4 py-2 text-xs font-bold uppercase tracking-wider rounded-xl transition ${
            activeTab === "team"
              ? "bg-ink text-white shadow-sm"
              : "text-ink-muted hover:bg-line/50"
          }`}
        >
          Team
        </button>
      </div>

      {/* Tab Panels */}
      <div className="flex-1 overflow-hidden">
        {activeTab === "requirements" && (
          <RequirementsPanel
            projectId={projectId}
            isBrainstormComplete={isBrainstormComplete}
            onSaveComplete={loadRequirements} // Update local state when requirements are modified
            focusField={focusField}
            clearFocusField={() => setFocusField(null)}
            onGoToArchitecture={() => setActiveTab("hld")}
          />
        )}
        {activeTab === "hld" && (
          <ArchitectureWorkspaceErrorBoundary>
            <ArchitectureWorkspace
              projectId={projectId}
              requirements={requirements}
              onRequirementsChange={loadRequirements}
              onSwitchTab={handleSwitchTab}
              focusMode={focusMode}
              onToggleFocusMode={onToggleFocusMode}
            />
          </ArchitectureWorkspaceErrorBoundary>
        )}
        {activeTab === "team" && <CollaborationPanel projectId={projectId} />}
      </div>
    </div>
  );
}
