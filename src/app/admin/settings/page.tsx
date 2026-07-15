"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import AdminNav from "@/app/components/AdminNav";

export default function AdminSettingsPage() {
  const [appName, setAppName] = useState("");
  const [saved, setSaved] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    fetch("/api/settings")
      .then((res) => res.json())
      .then((data) => {
        setAppName(data.appName || "");
        setSaved(data.appName || "");
      })
      .catch(() => setError("Failed to load settings."))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    setSuccess(false);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save");
      setSaved(data.appName);
      setSuccess(true);
    } catch (err: any) {
      setError(err.message || "Failed to save settings.");
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
            <p className="text-sm text-ink-muted">App settings</p>
          </div>
          <AdminNav />
        </header>

        {loading ? (
          <div className="flex items-center justify-center py-16 text-ink-muted">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          </div>
        ) : (
          <section className="max-w-lg rounded-2xl border border-line bg-panel p-6 shadow-sm">
            <h2 className="text-sm font-bold uppercase tracking-wider text-ink-muted">App Name</h2>
            <p className="mt-1.5 text-xs text-ink-faint">
              Shown on the landing page, page title, and dashboard. Change it here if the current
              name ever needs to — no deploy required.
            </p>
            <form onSubmit={handleSave} className="mt-4 flex flex-col gap-3">
              <input
                type="text"
                value={appName}
                onChange={(e) => setAppName(e.target.value)}
                maxLength={80}
                disabled={saving}
                className="w-full rounded-2xl border border-line bg-white px-4 py-3 text-sm text-ink shadow-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
                required
              />
              {error && <p className="text-xs font-medium text-danger">{error}</p>}
              {success && !error && (
                <p className="text-xs font-medium text-success">Saved — now showing as &quot;{saved}&quot;.</p>
              )}
              <button
                type="submit"
                disabled={saving || appName.trim() === saved}
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
