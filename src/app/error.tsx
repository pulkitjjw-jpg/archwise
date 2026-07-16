"use client";

import * as Sentry from "@sentry/nextjs";
import Link from "next/link";
import { useEffect } from "react";

// Next.js App Router's route-segment error boundary -- catches any render/render-lifecycle
// error thrown by a Server or Client Component under this segment and replaces just that
// segment's tree with this UI, instead of the white-screen the whole app previously had on any
// component exception (no error.tsx existed anywhere before this). Must be a Client Component
// (Next.js requirement) and receives `error` + `reset` as props automatically.
//
// Visual style deliberately matches AuthShell.tsx (rounded-[2rem] card, backdrop blur, same
// badge/heading/body pattern) so this reads as part of the product rather than a generic crash
// page -- danger tokens swapped in for accent, since this communicates a failure rather than
// a neutral/positive state.
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Sentry.captureException is a safe no-op when the SDK was never initialized (unset
    // NEXT_PUBLIC_SENTRY_DSN, the current default) -- see src/instrumentation-client.ts.
    Sentry.captureException(error);
  }, [error]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_top_left,var(--color-danger-soft),transparent_36%)] bg-paper px-6 py-12 text-ink">
      <div className="w-full max-w-md">
        <div className="rounded-[2rem] border border-white/70 bg-white/80 p-6 shadow-xl backdrop-blur-md sm:p-8">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-danger/25 bg-danger-soft px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-danger">
            Something went wrong
          </span>
          <h1 className="mt-3 text-2xl font-black tracking-tight text-ink">We hit a snag</h1>
          <p className="mt-2 text-sm leading-relaxed text-ink-muted">
            An unexpected error interrupted this page. It&apos;s been reported automatically —
            try again, or head back home if the problem keeps happening.
          </p>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <button
              onClick={() => reset()}
              className="flex-1 rounded-xl bg-ink px-4 py-2.5 text-sm font-bold text-white transition hover:opacity-90"
            >
              Try again
            </button>
            <Link
              href="/"
              className="flex-1 rounded-xl border border-line px-4 py-2.5 text-center text-sm font-bold text-ink-muted transition hover:bg-line/50"
            >
              Back to home
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
