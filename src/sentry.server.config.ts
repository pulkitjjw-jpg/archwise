import * as Sentry from "@sentry/nextjs";

// Node.js runtime Sentry init, imported by src/instrumentation.ts's register(). Reads the same
// NEXT_PUBLIC_SENTRY_DSN var the client config does (see src/instrumentation-client.ts) rather
// than a separate server-only var -- this app has exactly one frontend Sentry project, and
// NEXT_PUBLIC_* vars are readable on the server too (Next.js only *additionally* inlines them
// into the client bundle, it doesn't restrict server-side access), so one env var configures
// every runtime instead of three that could drift out of sync.
//
// No real Sentry account/DSN exists for this app yet -- this must stay fully inert (Sentry.init
// is simply never called) until NEXT_PUBLIC_SENTRY_DSN is set to a real value. Every other
// Sentry.* call in this app (error.tsx, global-error.tsx, instrumentation.ts's
// onRequestError) is already safe to call unconditionally even when the SDK was never
// initialized -- the JS SDK no-ops rather than throwing.
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV,
    // Tracing/performance monitoring is off by default -- this app has no Sentry quota
    // provisioned, and error tracking (the actual gap this scaffolding closes) doesn't need it.
    // Flip this from a real Sentry project's settings once one exists.
    tracesSampleRate: 0,
  });
}
