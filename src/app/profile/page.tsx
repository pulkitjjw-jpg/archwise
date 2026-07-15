"use client";

import { useState } from "react";
import Link from "next/link";
import { useAuth } from "@/app/contexts/AuthContext";

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

export default function ProfilePage() {
  const { user, loading } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword.length < 8) {
      setError("New password must be at least 8 characters.");
      return;
    }
    setSaving(true);
    setError("");
    setSuccess(false);
    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to change password");
      setSuccess(true);
      setCurrentPassword("");
      setNewPassword("");
    } catch (err: any) {
      setError(err.message || "Failed to change password.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,var(--color-accent-soft),transparent_36%)] bg-paper px-6 py-8 text-ink sm:py-12">
      <div className="mx-auto max-w-lg">
        <Link
          href="/dashboard"
          className="mb-6 flex items-center gap-2 text-sm font-bold text-ink-muted transition hover:text-ink"
        >
          ← Back to dashboard
        </Link>

        <div className="rounded-[2rem] border border-white/70 bg-white/80 p-6 shadow-xl backdrop-blur-md sm:p-8">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/25 bg-accent-soft px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-accent-ink">
            👤 Profile
          </span>
          <h1 className="mt-3 text-2xl font-black tracking-tight text-ink">Your account</h1>

          {loading || !user ? (
            <div className="mt-6 flex justify-center">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
            </div>
          ) : (
            <>
              <dl className="mt-5 space-y-3 border-t border-line pt-5">
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wider text-ink-faint">Email</dt>
                  <dd className="mt-1 text-sm text-ink">{user.email}</dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wider text-ink-faint">Member since</dt>
                  <dd className="mt-1 text-sm text-ink">{formatDate(user.createdAt)}</dd>
                </div>
              </dl>

              <div className="mt-7 border-t border-line pt-6">
                <h2 className="text-sm font-bold uppercase tracking-wider text-ink-muted">Change password</h2>
                <form onSubmit={handleChangePassword} className="mt-3 flex flex-col gap-3">
                  <div>
                    <label htmlFor="currentPassword" className="block text-xs font-semibold uppercase tracking-wider text-ink-muted">
                      Current password
                    </label>
                    <input
                      type="password"
                      id="currentPassword"
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                      disabled={saving}
                      autoComplete="current-password"
                      className="mt-2 w-full rounded-2xl border border-line bg-white px-4 py-3 text-sm text-ink shadow-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
                      required
                    />
                  </div>
                  <div>
                    <label htmlFor="newPassword" className="block text-xs font-semibold uppercase tracking-wider text-ink-muted">
                      New password
                    </label>
                    <input
                      type="password"
                      id="newPassword"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      disabled={saving}
                      autoComplete="new-password"
                      minLength={8}
                      className="mt-2 w-full rounded-2xl border border-line bg-white px-4 py-3 text-sm text-ink shadow-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
                      required
                    />
                    <p className="mt-1.5 text-[11px] text-ink-faint">At least 8 characters.</p>
                  </div>

                  {error && <p className="text-xs font-medium text-danger">{error}</p>}
                  {success && !error && <p className="text-xs font-medium text-success">Password updated.</p>}

                  <button
                    type="submit"
                    disabled={saving}
                    className="mt-1 flex items-center justify-center rounded-2xl bg-accent px-5 py-3 text-sm font-semibold text-white shadow-md transition-all hover:bg-accent-ink active:scale-[0.98] disabled:opacity-50"
                  >
                    {saving ? "Saving..." : "Update Password"}
                  </button>
                </form>
              </div>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
