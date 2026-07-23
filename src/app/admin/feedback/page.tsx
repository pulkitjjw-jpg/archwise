"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import AdminGuard from "@/app/components/AdminGuard";
import AdminNav from "@/app/components/AdminNav";

type FeedbackItem = {
  id: string;
  userId: string | null;
  email: string;
  category: string | null;
  message: string;
  createdAt: string;
};

function formatDate(value: string) {
  return new Date(value).toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function AdminFeedbackPageInner() {
  const [items, setItems] = useState<FeedbackItem[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/feedback");
      if (!res.ok) throw new Error("Failed to load feedback");
      const data = await res.json();
      setItems(data.feedback || []);
    } catch (err) {
      console.error(err);
      setError("Failed to load feedback.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const loading = items === null;

  return (
    <main className="min-h-screen bg-paper px-6 py-10">
      <div className="mx-auto max-w-6xl space-y-8">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <Link href="/dashboard" className="text-xs font-semibold text-ink-faint hover:text-ink">
              &larr; Back to projects
            </Link>
            <h1 className="mt-1 text-2xl font-bold text-ink">Admin</h1>
            <p className="text-sm text-ink-muted">User feedback</p>
          </div>
          <AdminNav />
        </header>

        {error && (
          <div className="rounded-xl border border-danger/25 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-16 text-ink-muted">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-2xl border border-line bg-panel p-10 text-center text-sm text-ink-muted shadow-sm">
            No feedback submitted yet.
          </div>
        ) : (
          <section className="rounded-2xl border border-line bg-panel p-6 shadow-sm">
            <h2 className="mb-4 text-sm font-bold uppercase tracking-wider text-ink-muted">
              {items.length} {items.length === 1 ? "Submission" : "Submissions"}
            </h2>
            <div className="space-y-4">
              {items.map((f) => (
                <div key={f.id} className="rounded-xl border border-line bg-white p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-ink">{f.email}</span>
                    <div className="flex items-center gap-2">
                      {f.category && (
                        <span className="inline-flex items-center rounded-full border border-accent/25 bg-accent-soft px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-accent-ink">
                          {f.category}
                        </span>
                      )}
                      <span className="font-mono text-xs text-ink-faint">{formatDate(f.createdAt)}</span>
                    </div>
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-ink-muted">{f.message}</p>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

export default function AdminFeedbackPage() {
  return (
    <AdminGuard>
      <AdminFeedbackPageInner />
    </AdminGuard>
  );
}
