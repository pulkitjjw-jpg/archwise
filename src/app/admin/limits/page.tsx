"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import AdminGuard from "@/app/components/AdminGuard";
import AdminNav from "@/app/components/AdminNav";

type Limits = { brainstormSessions: number; architectureGenerations: number; growthTriggerUpdates: number };
type AdvancedLimits = {
  whatifSimulator: number;
  componentSuggestions: number;
  chatProposals: number;
  proposalRefinements: number;
  requirementSuggestions: number;
  executiveSummaryExports: number;
};

const CORE_FIELDS: { key: keyof Limits; label: string }[] = [
  { key: "brainstormSessions", label: "Brainstorm sessions" },
  { key: "architectureGenerations", label: "Architecture generations" },
  { key: "growthTriggerUpdates", label: "Architecture updates" },
];

const ADVANCED_FIELDS: { key: keyof AdvancedLimits; label: string }[] = [
  { key: "whatifSimulator", label: "What-If Simulator" },
  { key: "componentSuggestions", label: "Component suggestions" },
  { key: "chatProposals", label: "Change proposals" },
  { key: "proposalRefinements", label: "Proposal refinements" },
  { key: "requirementSuggestions", label: "Requirement suggestions" },
  { key: "executiveSummaryExports", label: "Executive summary exports" },
];

function LimitGroup<T extends Record<string, number>>({
  title,
  hint,
  fields,
  values,
  onChange,
  disabled,
}: {
  title: string;
  hint: string;
  fields: { key: keyof T; label: string }[];
  values: T;
  onChange: (key: keyof T, value: number) => void;
  disabled: boolean;
}) {
  return (
    <div>
      <h2 className="text-sm font-bold uppercase tracking-wider text-ink-muted">{title}</h2>
      <p className="mt-1.5 text-xs text-ink-faint">{hint}</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {fields.map((f) => (
          <label key={String(f.key)} className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold text-ink-muted">{f.label}</span>
            <input
              type="number"
              min={0}
              value={values[f.key]}
              disabled={disabled}
              onChange={(e) => onChange(f.key, Number(e.target.value))}
              className="w-full rounded-2xl border border-line bg-white px-4 py-2.5 text-sm text-ink shadow-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
              required
            />
          </label>
        ))}
      </div>
    </div>
  );
}

function AdminLimitsPageInner() {
  const [free, setFree] = useState<Limits>({ brainstormSessions: 0, architectureGenerations: 0, growthTriggerUpdates: 0 });
  const [paid, setPaid] = useState<Limits>({ brainstormSessions: 0, architectureGenerations: 0, growthTriggerUpdates: 0 });
  const [paidAdvanced, setPaidAdvanced] = useState<AdvancedLimits>({
    whatifSimulator: 0,
    componentSuggestions: 0,
    chatProposals: 0,
    proposalRefinements: 0,
    requirementSuggestions: 0,
    executiveSummaryExports: 0,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    fetch("/api/admin/limits")
      .then((res) => res.json())
      .then((data) => {
        setFree(data.free);
        setPaid(data.paid);
        setPaidAdvanced(data.paidAdvanced);
      })
      .catch(() => setError("Failed to load limits."))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    setSuccess(false);
    try {
      const res = await fetch("/api/admin/limits", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          freeBrainstormSessions: free.brainstormSessions,
          freeArchitectureGenerations: free.architectureGenerations,
          freeGrowthTriggerUpdates: free.growthTriggerUpdates,
          paidBrainstormSessions: paid.brainstormSessions,
          paidArchitectureGenerations: paid.architectureGenerations,
          paidGrowthTriggerUpdates: paid.growthTriggerUpdates,
          paidWhatifSimulator: paidAdvanced.whatifSimulator,
          paidComponentSuggestions: paidAdvanced.componentSuggestions,
          paidChatProposals: paidAdvanced.chatProposals,
          paidProposalRefinements: paidAdvanced.proposalRefinements,
          paidRequirementSuggestions: paidAdvanced.requirementSuggestions,
          paidExecutiveSummaryExports: paidAdvanced.executiveSummaryExports,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save");
      setFree(data.free);
      setPaid(data.paid);
      setPaidAdvanced(data.paidAdvanced);
      setSuccess(true);
    } catch (err: any) {
      setError(err.message || "Failed to save limits.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="min-h-screen bg-paper px-6 py-10">
      <div className="mx-auto max-w-6xl space-y-8">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <Link href="/dashboard" className="text-xs font-semibold text-ink-faint hover:text-ink">
              &larr; Back to projects
            </Link>
            <h1 className="mt-1 text-2xl font-bold text-ink">Admin</h1>
            <p className="text-sm text-ink-muted">Usage limits</p>
          </div>
          <AdminNav />
        </header>

        {loading ? (
          <div className="flex items-center justify-center py-16 text-ink-muted">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          </div>
        ) : (
          <section className="max-w-3xl rounded-2xl border border-line bg-panel p-6 shadow-sm">
            <form onSubmit={handleSave} className="flex flex-col gap-8">
              <LimitGroup
                title="Free tier (resets weekly)"
                hint="Enough to try every main feature once. Renews automatically every 7 days per user."
                fields={CORE_FIELDS}
                values={free}
                onChange={(key, value) => setFree((prev) => ({ ...prev, [key]: value }))}
                disabled={saving}
              />
              <LimitGroup
                title="Paid tier (resets daily)"
                hint="A small daily allowance, renewing every 24 hours per user."
                fields={CORE_FIELDS}
                values={paid}
                onChange={(key, value) => setPaid((prev) => ({ ...prev, [key]: value }))}
                disabled={saving}
              />
              <div>
                <LimitGroup
                  title="Advanced AI features (paid only, resets daily)"
                  hint="Free-tier accounts don't get these at all — What-If Simulator, manual-editor suggestions, chat-based change proposals and their refinement, per-field requirement suggestions, and executive summary PDF exports. Paid accounts get their own daily allowance per feature."
                  fields={ADVANCED_FIELDS}
                  values={paidAdvanced}
                  onChange={(key, value) => setPaidAdvanced((prev) => ({ ...prev, [key]: value }))}
                  disabled={saving}
                />
              </div>
              {error && (
                <p role="alert" className="text-xs font-medium text-danger">
                  {error}
                </p>
              )}
              {success && !error && (
                <p role="status" className="text-xs font-medium text-success">
                  Saved — new limits are enforced immediately, no deploy needed.
                </p>
              )}
              <button
                type="submit"
                disabled={saving}
                className="flex items-center justify-center rounded-2xl bg-accent px-5 py-3 text-sm font-semibold text-white shadow-md transition-all hover:bg-accent-ink active:scale-[0.98] disabled:opacity-50"
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </form>
          </section>
        )}
      </div>
    </main>
  );
}

export default function AdminLimitsPage() {
  return (
    <AdminGuard>
      <AdminLimitsPageInner />
    </AdminGuard>
  );
}
