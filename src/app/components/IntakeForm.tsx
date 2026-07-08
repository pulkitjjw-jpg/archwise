"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function IntakeForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [ideaText, setIdeaText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

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
        body: JSON.stringify({ name, ideaText }),
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
      <h3 className="text-xl font-bold text-slate-950">Start a New Architecture Project</h3>
      <p className="mt-2 text-sm text-slate-600">
        Enter a project name and a brief description of the product you want to build. We will brainstorm details together.
      </p>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <div>
          <label htmlFor="project-name" className="block text-xs font-semibold uppercase tracking-wider text-slate-500">
            Project Name
          </label>
          <input
            type="text"
            id="project-name"
            placeholder="e.g. FinTech Payment Gateway, SaaS CRM"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={loading}
            className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500 disabled:opacity-50"
            required
          />
        </div>

        <div>
          <label htmlFor="product-idea" className="block text-xs font-semibold uppercase tracking-wider text-slate-500">
            Product Idea & Context
          </label>
          <textarea
            id="product-idea"
            rows={4}
            placeholder="Describe what your product does, who uses it, key requirements, expected traffic scale, etc."
            value={ideaText}
            onChange={(e) => setIdeaText(e.target.value)}
            disabled={loading}
            className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500 disabled:opacity-50 resize-none"
            required
          />
        </div>

        {error && <p className="text-xs font-medium text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="flex w-full items-center justify-center rounded-2xl bg-cyan-600 px-5 py-3 text-sm font-semibold text-white shadow-md transition-all hover:bg-cyan-700 active:scale-[0.98] disabled:opacity-50"
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
