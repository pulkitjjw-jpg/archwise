"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { UserButton } from "@clerk/nextjs";
import { Icon } from "@iconify/react";
import ConfirmDialog from "@/app/components/ConfirmDialog";
import HoverTooltip from "@/app/components/HoverTooltip";
import IntakeForm from "@/app/components/IntakeForm";
import { LogoMark } from "@/app/components/LogoMark";

type ProjectStatus =
  | "just_started"
  | "brainstorm_in_progress"
  | "requirements_complete"
  | "architecture_ready";

type ProjectSummary = {
  id: string;
  name: string;
  owner: string | null;
  createdAt: string;
  currentVersion: string;
  lastUpdated: string;
  conversationCount: number;
  requirementCount: number;
  architectureCount: number;
  status: ProjectStatus;
};

type ViewMode = "grid" | "list";

const VIEW_MODE_STORAGE_KEY = "dashboard-view-mode";

const STATUS_META: Record<ProjectStatus, { label: string; classes: string }> = {
  just_started: {
    label: "Just Started",
    classes: "bg-paper text-ink-muted border-line",
  },
  brainstorm_in_progress: {
    label: "Brainstorm In Progress",
    classes: "bg-accent-soft text-accent-ink border-accent/25",
  },
  requirements_complete: {
    label: "Requirements Complete",
    classes: "bg-warning-soft text-warning border-warning/25",
  },
  architecture_ready: {
    label: "Architecture Ready",
    classes: "bg-success-soft text-success border-success/25",
  },
};

function StatusBadge({ status }: { status: ProjectStatus }) {
  const meta = STATUS_META[status];
  return (
    <span
      className={`inline-flex items-center rounded-full border px-3 py-1 text-[10px] font-bold uppercase tracking-wider ${meta.classes}`}
    >
      {meta.label}
    </span>
  );
}

function formatDate(value: string) {
  // Locale pinned explicitly -- an unspecified locale can resolve differently between the Node
  // SSR pass and the browser, causing a hydration mismatch even with the same format options.
  return new Date(value).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// The exact time (not just the date) only on hover -- useful for telling apart two versions of
// the same project regenerated close together, or seeing exactly when something was last
// modified, without permanently showing a second line of text on every single card.
function formatDateTime(value: string) {
  return new Date(value).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function DateStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-semibold uppercase tracking-wider text-ink-faint">{label}</dt>
      <HoverTooltip text={formatDateTime(value)}>
        <dd className="mt-1 cursor-default font-mono text-ink-muted">{formatDate(value)}</dd>
      </HoverTooltip>
    </div>
  );
}

// A real <button> can't validly contain another <button> (the delete action) -- role="button" +
// tabIndex + Enter/Space handling gives the same semantics/keyboard behavior without that HTML
// nesting restriction, same pattern already used for the diagram's own clickable nodes
// (ArchitectureWorkspace.tsx).
function ProjectCard({
  project,
  onOpen,
  onDeleteClick,
}: {
  project: ProjectSummary;
  onOpen: (id: string) => void;
  onDeleteClick: (project: ProjectSummary) => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(project.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(project.id);
        }
      }}
      className="group relative flex h-full cursor-pointer flex-col gap-4 rounded-[2rem] border border-line bg-white/85 p-6 text-left shadow-sm backdrop-blur transition hover:-translate-y-0.5 hover:shadow-xl hover:shadow-ink/80"
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDeleteClick(project);
        }}
        aria-label={`Delete ${project.name}`}
        className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full text-ink-faint opacity-0 transition hover:bg-danger-soft hover:text-danger group-hover:opacity-100"
      >
        <Icon icon="mdi:trash-can-outline" width={16} height={16} />
      </button>

      <div className="flex items-start justify-between gap-3 pr-8">
        {/* line-clamp-2 -- names of very different lengths used to leave a different amount of
            space above the status badge on every card, so nothing lined up row to row. Clamping
            to a fixed 2 lines gives every card the same header height regardless of name length;
            `title` keeps the full name reachable (as a native tooltip) for anything truncated. */}
        <h3 title={project.name} className="line-clamp-2 text-lg font-bold tracking-tight text-ink">
          {project.name}
        </h3>
        <span className="shrink-0 rounded-full bg-ink px-2.5 py-1 font-mono text-[10px] font-semibold text-white">
          v{project.currentVersion}
        </span>
      </div>

      <StatusBadge status={project.status} />

      <dl className="mt-auto grid grid-cols-2 gap-3 border-t border-line pt-4 text-xs">
        <DateStat label="Created" value={project.createdAt} />
        <DateStat label="Last Updated" value={project.lastUpdated} />
      </dl>

      <div className="flex items-center justify-end text-xs font-semibold text-accent-ink opacity-0 transition group-hover:opacity-100">
        Open workspace ➜
      </div>
    </div>
  );
}

// Compact row -- same info, denser layout, more projects visible per screen without scrolling.
function ProjectListRow({
  project,
  onOpen,
  onDeleteClick,
}: {
  project: ProjectSummary;
  onOpen: (id: string) => void;
  onDeleteClick: (project: ProjectSummary) => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(project.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(project.id);
        }
      }}
      className="group flex cursor-pointer items-center gap-4 rounded-2xl border border-line bg-white/85 px-5 py-3.5 text-left shadow-sm backdrop-blur transition hover:border-line-strong hover:shadow-md"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2.5">
          <h3 title={project.name} className="truncate text-sm font-bold tracking-tight text-ink">
            {project.name}
          </h3>
          <span className="shrink-0 rounded-full bg-ink px-2 py-0.5 font-mono text-[9px] font-semibold text-white">
            v{project.currentVersion}
          </span>
        </div>
      </div>

      <div className="hidden shrink-0 sm:block">
        <StatusBadge status={project.status} />
      </div>

      <div className="hidden shrink-0 md:block">
        <HoverTooltip text={formatDateTime(project.lastUpdated)}>
          <span className="cursor-default font-mono text-xs text-ink-muted">
            Updated {formatDate(project.lastUpdated)}
          </span>
        </HoverTooltip>
      </div>

      <span className="shrink-0 text-xs font-semibold text-accent-ink opacity-0 transition group-hover:opacity-100">
        Open ➜
      </span>

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDeleteClick(project);
        }}
        aria-label={`Delete ${project.name}`}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-faint transition hover:bg-danger-soft hover:text-danger"
      >
        <Icon icon="mdi:trash-can-outline" width={16} height={16} />
      </button>
    </div>
  );
}

function ViewModeToggle({ mode, onChange }: { mode: ViewMode; onChange: (mode: ViewMode) => void }) {
  return (
    <div className="flex items-center gap-1 rounded-xl border border-line bg-white p-1 shadow-sm">
      <button
        type="button"
        onClick={() => onChange("grid")}
        aria-label="Grid view"
        aria-pressed={mode === "grid"}
        className={`flex h-7 w-7 items-center justify-center rounded-lg transition ${
          mode === "grid" ? "bg-ink text-white" : "text-ink-muted hover:text-ink"
        }`}
      >
        <Icon icon="mdi:view-grid-outline" width={15} height={15} />
      </button>
      <button
        type="button"
        onClick={() => onChange("list")}
        aria-label="List view"
        aria-pressed={mode === "list"}
        className={`flex h-7 w-7 items-center justify-center rounded-lg transition ${
          mode === "list" ? "bg-ink text-white" : "text-ink-muted hover:text-ink"
        }`}
      >
        <Icon icon="mdi:view-list-outline" width={15} height={15} />
      </button>
    </div>
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState("");
  const [showIntake, setShowIntake] = useState(false);
  const [appName, setAppName] = useState("Archwise");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [deleteTarget, setDeleteTarget] = useState<ProjectSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const loadProjects = async () => {
    try {
      setError("");
      const res = await fetch("/api/projects");
      if (!res.ok) throw new Error("Failed to load projects");
      const data = await res.json();
      setProjects(data.projects || []);
    } catch (err: any) {
      setError(
        err.message
          ? `We couldn't load your projects: ${err.message}`
          : "We couldn't load your projects. Please refresh the page or try again in a moment."
      );
      setProjects([]);
    }
  };

  useEffect(() => {
    loadProjects();
    fetch("/api/settings")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => data?.appName && setAppName(data.appName))
      .catch(() => {});
    const stored = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    if (stored === "grid" || stored === "list") setViewMode(stored);
  }, []);

  const changeViewMode = (mode: ViewMode) => {
    setViewMode(mode);
    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
  };

  const openProject = (id: string) => router.push(`/projects/${id}`);

  const handleDeleteConfirmed = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError("");
    try {
      const res = await fetch(`/api/projects/${deleteTarget.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || data.detail || "Failed to delete project");
      }
      setProjects((prev) => prev?.filter((p) => p.id !== deleteTarget.id) ?? null);
      setDeleteTarget(null);
    } catch (err: any) {
      setDeleteError(err.message || "Failed to delete project. Please try again.");
    } finally {
      setDeleting(false);
    }
  };

  const loading = projects === null;
  const isEmpty = !loading && projects.length === 0;

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,var(--color-accent-soft),transparent_36%)] bg-paper px-6 py-8 text-ink sm:py-12">
      <div className="mx-auto max-w-6xl">
        {/* Header */}
        <div className="overflow-hidden rounded-[2.5rem] border border-white/70 bg-ink shadow-2xl shadow-ink/40">
          <div className="flex flex-col gap-4 p-8 sm:flex-row sm:items-center sm:justify-between sm:p-10">
            <div>
              <span className="rounded-full bg-white/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-accent-on-dark">
                Workspace Dashboard
              </span>
              <h1 className="mt-4 flex items-center gap-3 text-3xl font-black tracking-tight text-white sm:text-4xl">
                <LogoMark className="h-9 w-9 sm:h-10 sm:w-10" />
                {appName}
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-ink-faint">
                Describe a product idea in plain English and get a full cloud architecture —
                diagrams, cost estimates, detailed technical specs, and ready-to-deploy
                infrastructure code.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              {!isEmpty && (
                <button
                  onClick={() => setShowIntake((v) => !v)}
                  className="flex items-center justify-center rounded-2xl bg-accent px-5 py-3 text-sm font-semibold text-white shadow-md transition-all hover:bg-accent-ink active:scale-[0.98]"
                >
                  {showIntake ? "Cancel" : "+ New Project"}
                </button>
              )}
              <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/5 px-4 py-2">
                <Link href="/profile" className="text-xs font-semibold text-ink-faint transition hover:text-white">
                  Profile
                </Link>
                <span className="text-white/15">|</span>
                <UserButton appearance={{ elements: { avatarBox: "h-6 w-6" } }} />
              </div>
            </div>
          </div>
        </div>

        {error && (
          <div className="mt-6 rounded-2xl border border-danger/25 bg-danger-soft p-4 text-sm text-danger shadow-sm">
            {error}
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div className="mt-16 flex flex-col items-center justify-center text-ink-muted">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-accent border-t-transparent" />
            <span className="mt-4 text-sm font-semibold">Loading projects...</span>
          </div>
        )}

        {/* Empty state */}
        {isEmpty && (
          <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_1.1fr] lg:items-center">
            <div className="rounded-[2rem] border-2 border-dashed border-line bg-white/60 p-10 text-center lg:text-left">
              <span className="text-4xl">🧭</span>
              <h2 className="mt-4 text-2xl font-black tracking-tight text-ink">
                No projects yet
              </h2>
              <p className="mt-3 text-sm leading-6 text-ink-muted">
                Create your first project to answer a few quick questions about what you&apos;re
                building. We&apos;ll turn your answers into a complete architecture — showing you
                exactly which AWS, Azure, or Google Cloud services to use, what it&apos;ll cost, and
                a plain-English explanation for every decision.
              </p>
            </div>
            <IntakeForm />
          </div>
        )}

        {/* New project panel (toggle, only when projects already exist) */}
        {!loading && !isEmpty && showIntake && (
          <div className="mt-8 max-w-xl">
            <IntakeForm />
          </div>
        )}

        {/* Project grid/list */}
        {!loading && !isEmpty && (
          <div className="mt-8">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold uppercase tracking-wider text-ink-muted">
                {projects.length} {projects.length === 1 ? "Project" : "Projects"}
              </h2>
              <ViewModeToggle mode={viewMode} onChange={changeViewMode} />
            </div>
            {viewMode === "grid" ? (
              <div className="mt-4 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {projects.map((project) => (
                  <ProjectCard
                    key={project.id}
                    project={project}
                    onOpen={openProject}
                    onDeleteClick={setDeleteTarget}
                  />
                ))}
              </div>
            ) : (
              <div className="mt-4 flex flex-col gap-2.5">
                {projects.map((project) => (
                  <ProjectListRow
                    key={project.id}
                    project={project}
                    onOpen={openProject}
                    onDeleteClick={setDeleteTarget}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {deleteTarget && (
        <ConfirmDialog
          title={`Delete "${deleteTarget.name}"?`}
          message={`This permanently deletes the project along with its brainstorm history, requirements, and every generated architecture version. This can't be undone.${
            deleteError ? `\n\n${deleteError}` : ""
          }`}
          confirmLabel="Delete Project"
          danger
          busy={deleting}
          onConfirm={handleDeleteConfirmed}
          onCancel={() => {
            setDeleteTarget(null);
            setDeleteError("");
          }}
        />
      )}
    </main>
  );
}
