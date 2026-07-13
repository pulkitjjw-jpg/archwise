"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

// Workstream Z1 -- the app's first admin surface, deliberately its own top-level /admin route
// (not mixed into user-facing pages) so gating this behind an admin-only check once the app has
// auth is a route-prefix change, not a per-page audit. This page is the LLM Usage dashboard;
// future admin features (e.g. user management) would land as siblings under /admin, not bolted
// onto this file.

type PerModelStat = {
  model: string;
  tier: number | null;
  servedCount: number;
  servedPercent: number;
  attemptCount: number;
  successRate: number;
  avgLatencyMs: number | null;
  totalCostUsd: number;
};

type UsageSummary = {
  totalCalls: number;
  totalSuccess: number;
  totalFailure: number;
  successRate: number;
  totalCostUsd: number;
  paidFallbackModel: string | null;
  perModel: PerModelStat[];
};

type TimeseriesPoint = { bucket: string; callCount: number; successCount: number };
type Timeseries = { granularity: string; points: TimeseriesPoint[] };

type UsageCall = {
  callGroupId: string;
  startedAt: string;
  endpoint: string;
  requestedModel: string;
  servedModel: string | null;
  status: "success" | "failure";
  totalLatencyMs: number;
  totalCostUsd: number;
};

type UsageCallsResponse = { calls: UsageCall[]; total: number; limit: number; offset: number };

// Short display names -- the full OpenRouter slugs are long and repetitive in a table.
function shortModelName(model: string): string {
  return model.replace(":free", "").split("/")[1] ?? model;
}

function formatLatency(ms: number | null): string {
  if (ms === null) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(6)}`;
  return `$${usd.toFixed(4)}`;
}

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function SummaryCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-2xl border border-line bg-panel p-5 shadow-sm">
      <div className="text-[10px] font-bold uppercase tracking-wider text-ink-faint">{label}</div>
      <div className="mt-1.5 text-2xl font-bold text-ink">{value}</div>
      {sub && <div className="mt-1 text-xs text-ink-muted">{sub}</div>}
    </div>
  );
}

function TimeseriesChart({ data }: { data: Timeseries | null }) {
  if (!data || data.points.length === 0) {
    return <div className="py-8 text-center text-sm text-ink-faint">No calls recorded yet.</div>;
  }
  const max = Math.max(...data.points.map((p) => p.callCount), 1);
  return (
    <div className="flex h-40 items-end gap-1.5 overflow-x-auto pb-1">
      {data.points.map((p) => {
        const heightPercent = Math.max(4, (p.callCount / max) * 100);
        const failureCount = p.callCount - p.successCount;
        return (
          <div key={p.bucket} className="flex min-w-[28px] flex-1 flex-col items-center gap-1">
            <div className="flex h-32 w-full flex-col justify-end">
              <div
                className="w-full rounded-t bg-accent/25"
                style={{ height: `${heightPercent}%` }}
                title={`${p.callCount} call${p.callCount === 1 ? "" : "s"} (${failureCount} failed)`}
              >
                <div
                  className="w-full rounded-t bg-accent"
                  style={{ height: `${p.callCount ? (p.successCount / p.callCount) * 100 : 0}%` }}
                />
              </div>
            </div>
            <span className="text-[9px] text-ink-faint">
              {new Date(p.bucket).toLocaleString("en-US", {
                month: "numeric",
                day: "numeric",
                ...(data.granularity === "hour" ? { hour: "numeric", hour12: true } : {}),
              })}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default function AdminPage() {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [timeseries, setTimeseries] = useState<Timeseries | null>(null);
  const [granularity, setGranularity] = useState<"hour" | "day">("day");
  const [callsData, setCallsData] = useState<UsageCallsResponse | null>(null);
  const [statusFilter, setStatusFilter] = useState<"" | "success" | "failure">("");
  const [modelFilter, setModelFilter] = useState("");
  const [sort, setSort] = useState<"started_at" | "total_latency_ms" | "total_cost_usd">("started_at");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadSummaryAndTimeseries = useCallback(async () => {
    try {
      const [summaryRes, timeseriesRes] = await Promise.all([
        fetch("/api/admin/usage-summary"),
        fetch(`/api/admin/usage-timeseries?granularity=${granularity}`),
      ]);
      if (!summaryRes.ok || !timeseriesRes.ok) throw new Error("Failed to load usage summary");
      setSummary(await summaryRes.json());
      setTimeseries(await timeseriesRes.json());
    } catch (err) {
      console.error(err);
      setError("Failed to load usage summary.");
    }
  }, [granularity]);

  const loadCalls = useCallback(async () => {
    try {
      const params = new URLSearchParams({ sort, order, limit: "25" });
      if (statusFilter) params.set("status", statusFilter);
      if (modelFilter) params.set("model", modelFilter);
      const res = await fetch(`/api/admin/usage-calls?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to load calls");
      setCallsData(await res.json());
    } catch (err) {
      console.error(err);
      setError("Failed to load recent calls.");
    }
  }, [statusFilter, modelFilter, sort, order]);

  useEffect(() => {
    setLoading(true);
    Promise.all([loadSummaryAndTimeseries(), loadCalls()]).finally(() => setLoading(false));
  }, [loadSummaryAndTimeseries, loadCalls]);

  const knownModels = summary?.perModel.map((m) => m.model) ?? [];
  // Coverage is everything served WITHOUT ever needing to fall all the way through to the paid
  // last-resort tier -- matched by model slug (from the backend's settings.llm_chain[-1]), not
  // array position, since perModel can omit a tier that's never been attempted yet.
  const paidTierStat = summary?.perModel.find((m) => m.model === summary.paidFallbackModel);
  const freeTierCoveragePercent = summary ? Math.round((100 - (paidTierStat?.servedPercent ?? 0)) * 10) / 10 : 0;

  return (
    <main className="min-h-screen bg-paper px-6 py-10">
      <div className="mx-auto max-w-6xl space-y-8">
        <header className="flex items-center justify-between">
          <div>
            <Link href="/" className="text-xs font-semibold text-ink-faint hover:text-ink">
              &larr; Back to projects
            </Link>
            <h1 className="mt-1 text-2xl font-bold text-ink">Admin</h1>
            <p className="text-sm text-ink-muted">LLM usage across the model fallback chain</p>
          </div>
        </header>

        {error && (
          <div className="rounded-xl border border-danger/25 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
        )}

        {loading && !summary ? (
          <div className="flex flex-col items-center justify-center py-20 text-ink-muted">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-accent border-t-transparent" />
            <span className="mt-4 text-sm font-semibold">Loading usage data...</span>
          </div>
        ) : (
          <>
            {/* Summary cards */}
            <section className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <SummaryCard label="Total Calls" value={String(summary?.totalCalls ?? 0)} />
              <SummaryCard
                label="Success Rate"
                value={`${summary?.successRate ?? 0}%`}
                sub={`${summary?.totalSuccess ?? 0} ok / ${summary?.totalFailure ?? 0} failed`}
              />
              <SummaryCard label="Estimated Cost" value={formatCost(summary?.totalCostUsd ?? 0)} />
              <SummaryCard
                label="Free Tier Coverage"
                value={`${freeTierCoveragePercent}%`}
                sub="served without reaching paid fallback"
              />
            </section>

            {/* Per-model breakdown -- the fallback-tier stat */}
            <section className="rounded-2xl border border-line bg-panel p-6 shadow-sm">
              <h2 className="text-sm font-bold uppercase tracking-wider text-ink-faint">
                Fallback Chain — Per-Model Breakdown
              </h2>
              <p className="mt-1 text-xs text-ink-muted">
                Ordered by chain position. &ldquo;Served&rdquo; is how often that tier actually produced the response used;
                &ldquo;Success rate&rdquo; is how often that tier itself succeeded whenever it was tried.
              </p>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-line text-[10px] font-bold uppercase tracking-wider text-ink-faint">
                      <th className="pb-2 pr-4">Tier</th>
                      <th className="pb-2 pr-4">Model</th>
                      <th className="pb-2 pr-4">Served</th>
                      <th className="pb-2 pr-4">Attempts</th>
                      <th className="pb-2 pr-4">Success Rate</th>
                      <th className="pb-2 pr-4">Avg Latency</th>
                      <th className="pb-2">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary?.perModel.map((m) => (
                      <tr key={m.model} className="border-b border-line/60 last:border-0">
                        <td className="py-2.5 pr-4 font-mono-app text-xs text-ink-faint">{m.tier ?? "—"}</td>
                        <td className="py-2.5 pr-4 font-semibold text-ink">
                          {shortModelName(m.model)}
                          {m.model === summary.paidFallbackModel && (
                            <span className="ml-2 rounded-full bg-warning-soft px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-warning">
                              paid
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 pr-4 text-ink-muted">
                          {m.servedCount} <span className="text-ink-faint">({m.servedPercent}%)</span>
                        </td>
                        <td className="py-2.5 pr-4 text-ink-muted">{m.attemptCount}</td>
                        <td className="py-2.5 pr-4">
                          <span
                            className={
                              m.successRate >= 70
                                ? "text-success"
                                : m.successRate >= 30
                                  ? "text-warning"
                                  : "text-danger"
                            }
                          >
                            {m.successRate}%
                          </span>
                        </td>
                        <td className="py-2.5 pr-4 text-ink-muted">{formatLatency(m.avgLatencyMs)}</td>
                        <td className="py-2.5 text-ink-muted">{formatCost(m.totalCostUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            {/* Time series */}
            <section className="rounded-2xl border border-line bg-panel p-6 shadow-sm">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-bold uppercase tracking-wider text-ink-faint">Calls Over Time</h2>
                <div className="flex gap-1 rounded-lg bg-paper p-1">
                  {(["hour", "day"] as const).map((g) => (
                    <button
                      key={g}
                      onClick={() => setGranularity(g)}
                      className={`rounded-md px-3 py-1 text-xs font-semibold capitalize transition ${
                        granularity === g ? "bg-panel text-ink shadow-sm" : "text-ink-muted hover:text-ink"
                      }`}
                    >
                      {g}
                    </button>
                  ))}
                </div>
              </div>
              <div className="mt-4">
                <TimeseriesChart data={timeseries} />
              </div>
            </section>

            {/* Recent calls table */}
            <section className="rounded-2xl border border-line bg-panel p-6 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-sm font-bold uppercase tracking-wider text-ink-faint">Recent Calls</h2>
                <div className="flex flex-wrap gap-2">
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value as "" | "success" | "failure")}
                    className="rounded-lg border border-line bg-panel px-2.5 py-1.5 text-xs text-ink"
                  >
                    <option value="">All statuses</option>
                    <option value="success">Success</option>
                    <option value="failure">Failure</option>
                  </select>
                  <select
                    value={modelFilter}
                    onChange={(e) => setModelFilter(e.target.value)}
                    className="rounded-lg border border-line bg-panel px-2.5 py-1.5 text-xs text-ink"
                  >
                    <option value="">All models</option>
                    {knownModels.map((m) => (
                      <option key={m} value={m}>
                        {shortModelName(m)}
                      </option>
                    ))}
                  </select>
                  <select
                    value={`${sort}:${order}`}
                    onChange={(e) => {
                      const [s, o] = e.target.value.split(":") as [typeof sort, typeof order];
                      setSort(s);
                      setOrder(o);
                    }}
                    className="rounded-lg border border-line bg-panel px-2.5 py-1.5 text-xs text-ink"
                  >
                    <option value="started_at:desc">Newest first</option>
                    <option value="started_at:asc">Oldest first</option>
                    <option value="total_latency_ms:desc">Slowest first</option>
                    <option value="total_latency_ms:asc">Fastest first</option>
                    <option value="total_cost_usd:desc">Most expensive first</option>
                  </select>
                </div>
              </div>

              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-line text-[10px] font-bold uppercase tracking-wider text-ink-faint">
                      <th className="pb-2 pr-4">Endpoint</th>
                      <th className="pb-2 pr-4">Requested</th>
                      <th className="pb-2 pr-4">Served By</th>
                      <th className="pb-2 pr-4">Status</th>
                      <th className="pb-2 pr-4">Latency</th>
                      <th className="pb-2 pr-4">Cost</th>
                      <th className="pb-2">When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {callsData?.calls.length === 0 && (
                      <tr>
                        <td colSpan={7} className="py-8 text-center text-ink-faint">
                          No calls match these filters.
                        </td>
                      </tr>
                    )}
                    {callsData?.calls.map((c) => (
                      <tr key={c.callGroupId} className="border-b border-line/60 last:border-0">
                        <td className="py-2.5 pr-4 text-ink">{c.endpoint}</td>
                        <td className="py-2.5 pr-4 text-ink-faint">{shortModelName(c.requestedModel)}</td>
                        <td className="py-2.5 pr-4 font-semibold text-ink">
                          {c.servedModel ? shortModelName(c.servedModel) : "—"}
                        </td>
                        <td className="py-2.5 pr-4">
                          <span
                            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                              c.status === "success" ? "bg-success-soft text-success" : "bg-danger-soft text-danger"
                            }`}
                          >
                            {c.status}
                          </span>
                        </td>
                        <td className="py-2.5 pr-4 text-ink-muted">{formatLatency(c.totalLatencyMs)}</td>
                        <td className="py-2.5 pr-4 text-ink-muted">{formatCost(c.totalCostUsd)}</td>
                        <td className="py-2.5 text-ink-faint">{formatTimestamp(c.startedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {callsData && callsData.total > callsData.calls.length && (
                <p className="mt-3 text-xs text-ink-faint">
                  Showing {callsData.calls.length} of {callsData.total} calls.
                </p>
              )}
            </section>
          </>
        )}
      </div>
    </main>
  );
}
