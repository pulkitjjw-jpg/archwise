"use client";

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

// Shared, ALWAYS-MOUNTED state for the chat-driven "growth trigger" enhancement flow (propose
// changes -> review -> apply), so it survives the user switching tabs mid-process instead of
// being lost. Previously this lived entirely as local state inside ArchitectureWorkspace,
// triggered by a one-shot `window` CustomEvent from ChatArea -- which meant the event was
// silently dropped whenever ArchitectureWorkspace wasn't mounted (e.g. the user was on the
// Requirements tab, which is the default), and any in-progress proposals were lost if the user
// switched tabs away and back (WorkspaceTabs fully unmounts the inactive tab, it doesn't just
// hide it). Mounting this provider ABOVE the tab-switching boundary (see ProjectWorkspaceGrid)
// fixes both: the analysis itself now runs here, independent of which tab is visible, and
// ArchitectureWorkspace's review panel just reads whatever state already exists on mount.

export type GrowthTriggerStatus = "idle" | "analyzing" | "ready" | "applying" | "done" | "error";

export type ProposedChange = {
  action: "add" | "modify";
  componentId: string;
  componentType: string;
  componentName: string;
  reasoning: string;
  serviceName: string;
  component?: any;
  newConnections?: any[];
  previousReasoning?: string;
  domainPattern?: string;
};

interface GrowthTriggerContextValue {
  status: GrowthTriggerStatus;
  description: string | null;
  proposals: ProposedChange[];
  provider: string | null;
  error: string;
  appliedVersion: string | null;
  startGrowthTrigger: (projectId: string, description: string) => void;
  updateProposal: (componentId: string, updated: ProposedChange) => void;
  markApplying: () => void;
  markApplied: (newVersion: string) => void;
  markApplyFailed: (message: string) => void;
  dismiss: () => void;
  clearAppliedVersion: () => void;
}

const GrowthTriggerCtx = createContext<GrowthTriggerContextValue | null>(null);

export function GrowthTriggerProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<GrowthTriggerStatus>("idle");
  const [description, setDescription] = useState<string | null>(null);
  const [proposals, setProposals] = useState<ProposedChange[]>([]);
  const [provider, setProvider] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [appliedVersion, setAppliedVersion] = useState<string | null>(null);
  // Guards against a double-trigger (e.g. a fast double-send) re-running the analysis fetch
  // while one is already in flight for this same provider instance.
  const inFlight = useRef(false);

  const startGrowthTrigger = useCallback((projectId: string, desc: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setStatus("analyzing");
    setDescription(desc);
    setError("");
    setProposals([]);

    (async () => {
      try {
        const archRes = await fetch(`/api/projects/${projectId}/architectures`);
        if (!archRes.ok) throw new Error("Failed to load the current architecture");
        const archData = await archRes.json();
        const architecture = archData.architecture;
        if (!architecture) throw new Error("No architecture exists yet to update");
        const activeProvider = architecture.cloudProvider || "aws";
        setProvider(activeProvider);

        const res = await fetch(
          `/api/projects/${projectId}/architectures/${architecture.id}/propose-changes?provider=${activeProvider}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ description: desc, provider: activeProvider }),
          }
        );
        if (!res.ok) throw new Error("Failed to analyze the requested changes");
        const data = await res.json();
        setProposals(data.proposals || []);
        setStatus("ready");
      } catch (err: any) {
        setError(err.message || "Failed to analyze the requested changes.");
        setStatus("error");
      } finally {
        inFlight.current = false;
      }
    })();
  }, []);

  const updateProposal = useCallback((componentId: string, updated: ProposedChange) => {
    setProposals((prev) => prev.map((p) => (p.componentId === componentId ? updated : p)));
  }, []);

  const markApplying = useCallback(() => setStatus("applying"), []);

  const markApplied = useCallback((newVersion: string) => {
    setStatus("done");
    setAppliedVersion(newVersion);
    setDescription(null);
    setProposals([]);
    setProvider(null);
  }, []);

  const markApplyFailed = useCallback((message: string) => {
    setStatus("ready");
    setError(message);
  }, []);

  const dismiss = useCallback(() => {
    setStatus("idle");
    setDescription(null);
    setProposals([]);
    setProvider(null);
    setError("");
  }, []);

  const clearAppliedVersion = useCallback(() => {
    setAppliedVersion(null);
    setStatus("idle");
  }, []);

  return (
    <GrowthTriggerCtx.Provider
      value={{
        status,
        description,
        proposals,
        provider,
        error,
        appliedVersion,
        startGrowthTrigger,
        updateProposal,
        markApplying,
        markApplied,
        markApplyFailed,
        dismiss,
        clearAppliedVersion,
      }}
    >
      {children}
    </GrowthTriggerCtx.Provider>
  );
}

export function useGrowthTrigger(): GrowthTriggerContextValue {
  const ctx = useContext(GrowthTriggerCtx);
  if (!ctx) throw new Error("useGrowthTrigger must be used within a GrowthTriggerProvider");
  return ctx;
}
