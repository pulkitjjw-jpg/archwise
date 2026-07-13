"use client";

import { useEffect } from "react";
import { useGrowthTrigger } from "@/app/contexts/GrowthTriggerContext";

const AUTO_DISMISS_MS = 6000;

/**
 * A page-level confirmation that appears the moment a growth-trigger's approved changes finish
 * saving as a new architecture version -- so the user doesn't have to notice a version number
 * silently changed somewhere in the diagram header. Rendered once, above the tab-switching
 * boundary (see ProjectWorkspaceGrid), so it's visible regardless of which tab is active when the
 * apply actually completes.
 */
export default function GrowthTriggerToast() {
  const { appliedVersion, clearAppliedVersion } = useGrowthTrigger();

  useEffect(() => {
    if (!appliedVersion) return;
    const timer = setTimeout(clearAppliedVersion, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [appliedVersion, clearAppliedVersion]);

  if (!appliedVersion) return null;

  return (
    <div className="fixed bottom-6 right-6 z-50 flex items-center gap-3 rounded-2xl border border-success/25 bg-panel px-4 py-3 shadow-xl">
      <span className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-success-soft text-success">
        ✓
      </span>
      <div>
        <p className="text-sm font-bold text-ink">Architecture updated</p>
        <p className="text-xs text-ink-muted">Now on version {appliedVersion}</p>
      </div>
      <button
        onClick={clearAppliedVersion}
        className="ml-2 text-xs font-bold text-ink-faint transition hover:text-ink"
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}
