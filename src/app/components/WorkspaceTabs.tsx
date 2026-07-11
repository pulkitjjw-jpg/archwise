"use client";

import { useEffect, useState } from "react";
import RequirementsPanel from "./RequirementsPanel";
import ArchitectureWorkspace from "./ArchitectureWorkspace";

interface WorkspaceTabsProps {
  projectId: string;
  isBrainstormComplete: boolean;
}

export default function WorkspaceTabs({ projectId, isBrainstormComplete }: WorkspaceTabsProps) {
  const [activeTab, setActiveTab] = useState<"requirements" | "hld">("requirements");
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
          2. Architecture Diagram (HLD)
        </button>
      </div>

      {/* Tab Panels */}
      <div className="flex-1 overflow-hidden">
        {activeTab === "requirements" ? (
          <RequirementsPanel
            projectId={projectId}
            isBrainstormComplete={isBrainstormComplete}
            onSaveComplete={loadRequirements} // Update local state when requirements are modified
            focusField={focusField}
            clearFocusField={() => setFocusField(null)}
          />
        ) : (
          <ArchitectureWorkspace
            projectId={projectId}
            requirements={requirements}
            onRequirementsChange={loadRequirements}
            onSwitchTab={handleSwitchTab}
          />
        )}
      </div>
    </div>
  );
}
