"use client";

import Link from "next/link";
import { useClerk, useUser } from "@clerk/nextjs";

function formatDate(value: Date) {
  return value.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

export default function ProfilePage() {
  const { user, isLoaded } = useUser();
  const { openUserProfile } = useClerk();

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

          {!isLoaded || !user ? (
            <div className="mt-6 flex justify-center">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
            </div>
          ) : (
            <>
              <dl className="mt-5 space-y-3 border-t border-line pt-5">
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wider text-ink-faint">Email</dt>
                  <dd className="mt-1 text-sm text-ink">{user.primaryEmailAddress?.emailAddress}</dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wider text-ink-faint">Member since</dt>
                  <dd className="mt-1 text-sm text-ink">{user.createdAt ? formatDate(user.createdAt) : "—"}</dd>
                </div>
              </dl>

              {/* Password, sessions, and any other security settings are managed entirely by
                  Clerk now -- this app has no password of its own to change anymore. Opens
                  Clerk's own account-management UI rather than reimplementing it. */}
              <div className="mt-7 border-t border-line pt-6">
                <h2 className="text-sm font-bold uppercase tracking-wider text-ink-muted">Account & security</h2>
                <p className="mt-2 text-xs leading-relaxed text-ink-faint">
                  Change your password or manage sign-in security from your account settings.
                </p>
                <button
                  type="button"
                  onClick={() => openUserProfile()}
                  className="mt-4 flex items-center justify-center rounded-2xl bg-accent px-5 py-3 text-sm font-semibold text-white shadow-md transition-all hover:bg-accent-ink active:scale-[0.98]"
                >
                  Manage Account
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
