"use client";

import { useState, type ReactNode } from "react";
import WorkspaceTabs from "./WorkspaceTabs";

interface ProjectWorkspaceGridProps {
  chatArea: ReactNode;
  projectId: string;
  isBrainstormComplete: boolean;
}

// Client wrapper around the chat/workspace grid so the workspace side (specifically Compare
// Clouds, which is a wide comparison table with no use for chat context) can reclaim the chat
// column's width on demand. page.tsx has to stay a server component (it does the backend fetch
// directly), so this state can't live there -- it needs its own client boundary.
export default function ProjectWorkspaceGrid({ chatArea, projectId, isBrainstormComplete }: ProjectWorkspaceGridProps) {
  const [focusMode, setFocusMode] = useState(false);

  return (
    <div className="grid gap-8 lg:grid-cols-12">
      {/* Chat Workspace (Left) -- narrower than the workspace panel: it's a plain message
          thread, while the architecture side packs a 5-provider toggle, drawer, and
          comparison table that need the room (see ArchitectureWorkspace's provider-row
          overflow fix -- this ratio is the other half of that fix). Hidden entirely in focus
          mode rather than just shrunk, since a sliver of chat isn't useful and the space is
          better spent on the comparison table. */}
      <div className={`lg:col-span-4 ${focusMode ? "hidden" : ""}`}>{chatArea}</div>

      {/* Architecture Workspace / Requirements Panel (Right) */}
      <div className={focusMode ? "lg:col-span-12" : "lg:col-span-8"}>
        <WorkspaceTabs
          projectId={projectId}
          isBrainstormComplete={isBrainstormComplete}
          focusMode={focusMode}
          onToggleFocusMode={() => setFocusMode((v) => !v)}
        />
      </div>
    </div>
  );
}
