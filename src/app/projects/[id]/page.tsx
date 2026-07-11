import Link from "next/link";
import { notFound } from "next/navigation";
import ChatArea from "@/app/components/ChatArea";
import WorkspaceTabs from "@/app/components/WorkspaceTabs";

export const dynamic = "force-dynamic";

interface ProjectPageProps {
  params: Promise<{ id: string }>;
}

type ConversationRecord = {
  id: string;
  role: string;
  message: string;
  stage: string;
  createdAt: string;
};

// Server component -- runs on the Next.js server itself, so it reaches the backend directly
// over the same private path the catch-all proxy uses (BACKEND_URL + X-Internal-Auth), rather
// than looping back through its own proxy route over HTTP.
async function backendFetch(path: string) {
  const backendUrl = process.env.BACKEND_URL;
  const internalAuthSecret = process.env.INTERNAL_AUTH_SECRET;
  if (!backendUrl || !internalAuthSecret) {
    throw new Error("Backend is not configured");
  }
  return fetch(`${backendUrl}${path}`, {
    headers: { "x-internal-auth": internalAuthSecret },
    cache: "no-store",
  });
}

export default async function ProjectPage({ params }: ProjectPageProps) {
  const { id } = await params;

  const projectRes = await backendFetch(`/api/projects/${id}`);
  if (projectRes.status === 404) {
    notFound();
  }
  if (!projectRes.ok) {
    throw new Error("Failed to load project");
  }
  const { project } = await projectRes.json();

  const conversationsRes = await backendFetch(`/api/projects/${id}/conversations`);
  if (!conversationsRes.ok) {
    throw new Error("Failed to load conversations");
  }
  const { conversations }: { conversations: ConversationRecord[] } = await conversationsRes.json();

  // Determine if brainstorming is complete (at least one turn has stage === "requirement_gathering")
  const isBrainstormComplete = conversations.some((c) => c.stage === "requirement_gathering");

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,var(--color-accent-soft),transparent_36%)] bg-paper px-6 py-8 text-ink sm:py-12">
      <div className="mx-auto max-w-[1800px]">
        {/* Navigation / Header */}
        <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="group flex h-10 w-10 items-center justify-center rounded-full border border-line bg-white/80 shadow-sm transition hover:bg-paper"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
                className="h-5 w-5 text-ink-muted transition group-hover:-translate-x-0.5"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18" />
              </svg>
            </Link>
            <div>
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-accent-soft border border-accent/25 px-2.5 py-0.5 text-xs font-semibold text-accent-ink">
                  Active Workspace
                </span>
                <span className="text-xs text-ink-muted font-medium">
                  Version {project.currentVersion}
                </span>
              </div>
              <h1 className="mt-1 text-3xl font-black tracking-tight text-ink">
                {project.name}
              </h1>
            </div>
          </div>

          <div className="text-left sm:text-right">
            <p className="text-xs font-semibold uppercase tracking-wider text-ink-faint">Created At</p>
            <p className="text-sm font-semibold text-ink-muted mt-1">
              {new Date(project.createdAt).toLocaleDateString([], {
                year: "numeric",
                month: "long",
                day: "numeric",
              })}
            </p>
          </div>
        </header>

        {/* Dynamic Workspace Layout */}
        <div className="grid gap-8 lg:grid-cols-12">
          {/* Chat Workspace (Left) -- narrower than the workspace panel: it's a plain message
              thread, while the architecture side packs a 5-provider toggle, drawer, and
              comparison table that need the room (see ArchitectureWorkspace's provider-row
              overflow fix -- this ratio is the other half of that fix). */}
          <div className="lg:col-span-4">
            <ChatArea
              projectId={project.id}
              initialConversations={conversations.map((c) => ({
                id: c.id,
                role: c.role,
                message: c.message,
                stage: c.stage,
                createdAt: c.createdAt,
              }))}
            />
          </div>

          {/* Architecture Workspace / Requirements Panel (Right) */}
          <div className="lg:col-span-8">
            <WorkspaceTabs
              projectId={project.id}
              isBrainstormComplete={isBrainstormComplete}
            />
          </div>
        </div>
      </div>
    </main>
  );
}
