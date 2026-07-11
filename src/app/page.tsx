"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import IntakeForm from "@/app/components/IntakeForm";

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
  return new Date(value).toLocaleDateString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function ProjectCard({ project, onOpen }: { project: ProjectSummary; onOpen: (id: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(project.id)}
      className="group flex flex-col gap-4 rounded-[2rem] border border-line bg-white/85 p-6 text-left shadow-sm backdrop-blur transition hover:-translate-y-0.5 hover:shadow-xl hover:shadow-ink/80"
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-lg font-bold tracking-tight text-ink">{project.name}</h3>
        <span className="shrink-0 rounded-full bg-ink px-2.5 py-1 font-mono text-[10px] font-semibold text-white">
          v{project.currentVersion}
        </span>
      </div>

      <StatusBadge status={project.status} />

      <dl className="mt-auto grid grid-cols-2 gap-3 border-t border-line pt-4 text-xs">
        <div>
          <dt className="font-semibold uppercase tracking-wider text-ink-faint">Created</dt>
          <dd className="mt-1 font-mono text-ink-muted">{formatDate(project.createdAt)}</dd>
        </div>
        <div>
          <dt className="font-semibold uppercase tracking-wider text-ink-faint">Last Updated</dt>
          <dd className="mt-1 font-mono text-ink-muted">{formatDate(project.lastUpdated)}</dd>
        </div>
      </dl>

      <div className="flex items-center justify-end text-xs font-semibold text-accent-ink opacity-0 transition group-hover:opacity-100">
        Open workspace ➜
      </div>
    </button>
  );
}

export default function HomePage() {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState("");
  const [showIntake, setShowIntake] = useState(false);

  const loadProjects = async () => {
    try {
      setError("");
      const res = await fetch("/api/projects");
      if (!res.ok) throw new Error("Failed to load projects");
      const data = await res.json();
      setProjects(data.projects || []);
    } catch (err: any) {
      setError(err.message || "Failed to load projects.");
      setProjects([]);
    }
  };

  useEffect(() => {
    loadProjects();
  }, []);

  const openProject = (id: string) => router.push(`/projects/${id}`);

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
              <h1 className="mt-4 text-3xl font-black tracking-tight text-white sm:text-4xl">
                AI Cloud Architecture Generator
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-ink-faint">
                Describe a product idea, brainstorm requirements, and generate a genuinely-reasoned
                multi-cloud architecture — with cost estimates, LLD detail, and Terraform export.
              </p>
            </div>
            {!isEmpty && (
              <button
                onClick={() => setShowIntake((v) => !v)}
                className="flex shrink-0 items-center justify-center rounded-2xl bg-accent px-5 py-3 text-sm font-semibold text-white shadow-md transition-all hover:bg-accent-ink active:scale-[0.98]"
              >
                {showIntake ? "Cancel" : "+ New Project"}
              </button>
            )}
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
                Create your first project to start the discovery brainstorm. Once requirements are
                gathered, you&apos;ll get a rule-engine-driven architecture with AWS, Azure, and GCP
                mappings, cost bands, and a full reasoning trace for every decision.
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

        {/* Project grid */}
        {!loading && !isEmpty && (
          <div className="mt-8">
            <h2 className="text-sm font-bold uppercase tracking-wider text-ink-muted">
              {projects.length} {projects.length === 1 ? "Project" : "Projects"}
            </h2>
            <div className="mt-4 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {projects.map((project) => (
                <ProjectCard key={project.id} project={project} onOpen={openProject} />
              ))}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
