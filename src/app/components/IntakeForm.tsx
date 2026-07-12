"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function IntakeForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [ideaText, setIdeaText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Workstream T5 -- lets a team modernizing an existing app (not starting from scratch) say so
  // up front. The brainstorm then also asks about current stack/deployment/pain points, and once
  // a target architecture exists, a phased Migration Roadmap becomes available.
  const [hasExistingSystem, setHasExistingSystem] = useState(false);
  const [existingSystemText, setExistingSystemText] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !ideaText.trim()) {
      setError("Please fill in all fields.");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name, ideaText, hasExistingSystem, existingSystemText }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to create project");
      }

      const { projectId } = await response.json();
      router.push(`/projects/${projectId}`);
    } catch (err: any) {
      setError(err.message || "An unexpected error occurred.");
      setLoading(false);
    }
  };

  return (
    <div className="rounded-[2rem] border border-white/70 bg-white/80 p-6 shadow-xl backdrop-blur-md sm:p-8">
      <span className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft border border-accent/25 px-2.5 py-1 text-[10px] font-bold text-accent-ink uppercase tracking-wider">
        🧭 New Project
      </span>
      <h3 className="mt-3 text-2xl font-black tracking-tight text-ink">Start a New Architecture Project</h3>
      <p className="mt-2 text-sm text-ink-muted leading-relaxed">
        Enter a project name and a brief description of the product you want to build. We will brainstorm details together, then generate a fully-reasoned multi-cloud architecture.
      </p>

      {/* Process strip -- sets expectations for what happens after submit, since the next
          screen (chat) isn't self-explanatory to a first-time user. */}
      <div className="mt-5 grid grid-cols-3 gap-3 rounded-2xl border border-line bg-paper/70 p-3.5">
        {[
          { step: "1", label: "Describe" },
          { step: "2", label: "Brainstorm" },
          { step: "3", label: "Get Architecture" },
        ].map((s) => (
          <div key={s.step} className="flex items-center gap-2">
            <span className="flex h-5 w-5 flex-none items-center justify-center rounded-full bg-ink text-[10px] font-bold text-white">
              {s.step}
            </span>
            <span className="text-[11px] font-semibold text-ink-muted leading-tight">{s.label}</span>
          </div>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <div>
          <label htmlFor="project-name" className="block text-xs font-semibold uppercase tracking-wider text-ink-muted">
            Project Name
          </label>
          <input
            type="text"
            id="project-name"
            placeholder="e.g. FinTech Payment Gateway, SaaS CRM"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={loading}
            className="mt-2 w-full rounded-2xl border border-line bg-white px-4 py-3 text-sm text-ink shadow-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
            required
          />
        </div>

        <div>
          <label htmlFor="product-idea" className="block text-xs font-semibold uppercase tracking-wider text-ink-muted">
            Product Idea & Context
          </label>
          <textarea
            id="product-idea"
            rows={4}
            placeholder="Describe what your product does, who uses it, key requirements, expected traffic scale, etc."
            value={ideaText}
            onChange={(e) => setIdeaText(e.target.value)}
            disabled={loading}
            className="mt-2 w-full rounded-2xl border border-line bg-white px-4 py-3 text-sm text-ink shadow-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50 resize-none"
            required
          />
        </div>

        <div className="rounded-2xl border border-line bg-paper/70 p-3.5">
          <label className="flex items-center gap-2 text-xs font-semibold text-ink">
            <input
              type="checkbox"
              checked={hasExistingSystem}
              onChange={(e) => setHasExistingSystem(e.target.checked)}
              disabled={loading}
              className="h-4 w-4 accent-accent"
            />
            I have an existing system (modernizing, not starting from scratch)
          </label>
          {hasExistingSystem && (
            <textarea
              rows={3}
              placeholder="Briefly describe what you have today -- tech stack, how it's deployed, and the main pain points (e.g. &quot;a monolithic PHP app on a single VM, no CI/CD, manual deploys, struggling to scale past 500 users&quot;). You can also just check the box and we'll ask about this during the brainstorm."
              value={existingSystemText}
              onChange={(e) => setExistingSystemText(e.target.value)}
              disabled={loading}
              className="mt-2.5 w-full rounded-xl border border-line bg-white px-3 py-2.5 text-xs text-ink shadow-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50 resize-none"
            />
          )}
        </div>

        {error && <p className="text-xs font-medium text-danger">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="flex w-full items-center justify-center rounded-2xl bg-accent px-5 py-3 text-sm font-semibold text-white shadow-md transition-all hover:bg-accent-ink active:scale-[0.98] disabled:opacity-50"
        >
          {loading ? (
            <span className="flex items-center gap-2">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
              Initializing Workspace...
            </span>
          ) : (
            "Launch Brainstorm Workspace"
          )}
        </button>
      </form>
    </div>
  );
}
