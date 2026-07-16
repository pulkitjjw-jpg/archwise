import * as Sentry from "@sentry/nextjs";

// Browser-side Sentry init. Next.js 15.3+ / Turbopack requires this exact filename and location
// (src/instrumentation-client.ts, since this app uses the src-directory convention -- see
// src/proxy.ts) -- the older sentry.client.config.ts pattern is Pages Router/Webpack-only and is
// NOT picked up automatically under Turbopack. Verified against docs.sentry.io's current
// "Manual Setup" guide for Next.js App Router + Turbopack via context7, not assumed from
// training data (Sentry's Next.js setup conventions have changed across SDK versions).
//
// NEXT_PUBLIC_ prefix required -- this runs in the browser, and only NEXT_PUBLIC_*-prefixed env
// vars get inlined into the client bundle at build time (same constraint this codebase already
// handles for NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY -- see the root Dockerfile's build ARG). No real
// Sentry DSN exists for this app yet, so this must stay fully inert (no Sentry.init call, no
// sentry.io network request) while it's unset -- that's the default, current state.
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV,
    tracesSampleRate: 0,
  });
}
