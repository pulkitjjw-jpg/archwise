"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import AdminGuard from "@/app/components/AdminGuard";
import AdminNav from "@/app/components/AdminNav";

type AdminUser = {
  id: string;
  email: string;
  isAdmin: boolean;
  createdAt: string;
  projectCount: number;
  plan: string;
  bypassLimits: boolean;
  usage: { brainstormSessions: number; architectureGenerations: number; growthTriggerUpdates: number };
  windowStartedAt: string | null;
};

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function AdminUsersPageInner() {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/users");
      if (!res.ok) throw new Error("Failed to load users");
      const data = await res.json();
      setUsers(data.users || []);
    } catch (err) {
      console.error(err);
      setError("Failed to load users.");
    }
  }, []);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  const toggleAdmin = async (user: AdminUser) => {
    setPendingId(user.id);
    setError("");
    try {
      const res = await fetch(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isAdmin: !user.isAdmin }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to update user");
      setUsers((prev) => prev?.map((u) => (u.id === user.id ? { ...u, isAdmin: data.isAdmin } : u)) ?? null);
    } catch (err: any) {
      setError(err.message || "Failed to update user.");
    } finally {
      setPendingId(null);
    }
  };

  const toggleUsageOverride = async (user: AdminUser) => {
    setPendingId(user.id);
    setError("");
    try {
      const res = await fetch(`/api/admin/users/${user.id}/usage-override`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bypassLimits: !user.bypassLimits }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to update access");
      setUsers((prev) => prev?.map((u) => (u.id === user.id ? { ...u, bypassLimits: data.bypassLimits } : u)) ?? null);
    } catch (err: any) {
      setError(err.message || "Failed to update access.");
    } finally {
      setPendingId(null);
    }
  };

  const resetUsage = async (user: AdminUser) => {
    setPendingId(user.id);
    setError("");
    try {
      const res = await fetch(`/api/admin/users/${user.id}/usage-reset`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to reset usage");
      setUsers(
        (prev) =>
          prev?.map((u) => (u.id === user.id ? { ...u, usage: data.usage, windowStartedAt: data.windowStartedAt } : u)) ??
          null
      );
    } catch (err: any) {
      setError(err.message || "Failed to reset usage.");
    } finally {
      setPendingId(null);
    }
  };

  const loading = users === null;

  return (
    <main className="min-h-screen bg-paper px-6 py-10">
      <div className="mx-auto max-w-6xl space-y-8">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <Link href="/dashboard" className="text-xs font-semibold text-ink-faint hover:text-ink">
              &larr; Back to projects
            </Link>
            <h1 className="mt-1 text-2xl font-bold text-ink">Admin</h1>
            <p className="text-sm text-ink-muted">Users and access</p>
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
        ) : (
          <section className="rounded-2xl border border-line bg-panel p-6 shadow-sm">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-bold uppercase tracking-wider text-ink-muted">
                {users.length} {users.length === 1 ? "User" : "Users"}
              </h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-left text-sm">
                <thead>
                  <tr className="border-b border-line text-[10px] font-bold uppercase tracking-wider text-ink-faint">
                    <th className="pb-2 pr-4">Email</th>
                    <th className="pb-2 pr-4">Joined</th>
                    <th className="pb-2 pr-4">Projects</th>
                    <th className="pb-2 pr-4">Plan</th>
                    <th className="pb-2 pr-4">Usage (B/A/G)</th>
                    <th className="pb-2 pr-4">Role</th>
                    <th className="pb-2 pr-4">Full Access</th>
                    <th className="pb-2 pr-4"></th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id} className="border-b border-line last:border-0">
                      <td className="py-3 pr-4 font-medium text-ink">{u.email}</td>
                      <td className="py-3 pr-4 font-mono text-xs text-ink-muted">{formatDate(u.createdAt)}</td>
                      <td className="py-3 pr-4 text-ink-muted">{u.projectCount}</td>
                      <td className="py-3 pr-4 text-ink-muted capitalize">{u.plan}</td>
                      <td className="py-3 pr-4 font-mono text-xs text-ink-muted">
                        {u.usage.brainstormSessions}/{u.usage.architectureGenerations}/{u.usage.growthTriggerUpdates}
                      </td>
                      <td className="py-3 pr-4">
                        <span
                          className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                            u.isAdmin
                              ? "border-accent/25 bg-accent-soft text-accent-ink"
                              : "border-line bg-paper text-ink-muted"
                          }`}
                        >
                          {u.isAdmin ? "Admin" : "User"}
                        </span>
                      </td>
                      <td className="py-3 pr-4">
                        {u.bypassLimits && (
                          <span className="inline-flex items-center rounded-full border border-success/25 bg-success-soft px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-success">
                            Unlocked
                          </span>
                        )}
                      </td>
                      <td className="py-3 pr-4 text-right whitespace-nowrap">
                        <button
                          onClick={() => toggleAdmin(u)}
                          disabled={pendingId === u.id}
                          className="mr-3 text-xs font-semibold text-accent-ink transition hover:underline disabled:opacity-50"
                        >
                          {u.isAdmin ? "Remove admin" : "Make admin"}
                        </button>
                        <button
                          onClick={() => toggleUsageOverride(u)}
                          disabled={pendingId === u.id}
                          className="mr-3 text-xs font-semibold text-accent-ink transition hover:underline disabled:opacity-50"
                        >
                          {u.bypassLimits ? "Revoke full access" : "Grant full access"}
                        </button>
                        <button
                          onClick={() => resetUsage(u)}
                          disabled={pendingId === u.id}
                          className="text-xs font-semibold text-ink-muted transition hover:text-ink hover:underline disabled:opacity-50"
                        >
                          Reset usage
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

export default function AdminUsersPage() {
  return (
    <AdminGuard>
      <AdminUsersPageInner />
    </AdminGuard>
  );
}
