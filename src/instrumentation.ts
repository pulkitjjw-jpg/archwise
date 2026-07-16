import * as Sentry from "@sentry/nextjs";

// Next.js 16's instrumentation.ts hook -- runs once per server/edge runtime start, before any
// request is handled. This is Sentry's own currently-documented App Router + Turbopack pattern
// (verified via context7 against docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup,
// which explicitly covers Next.js 15+ with Turbopack): register() imports the runtime-specific
// config file, and the two runtimes get separate files because the edge runtime can't use
// everything the Node.js SDK does. Lives under src/ (not the project root) because this app
// already uses the src-directory convention -- see src/proxy.ts, this project's middleware
// equivalent, for the same placement rule.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

// Captures errors from Server Components, Server Actions, and route handlers that Next.js's own
// error-instrumentation hook surfaces. A safe no-op call when Sentry was never initialized (see
// sentry.server.config.ts/sentry.edge.config.ts -- both skip Sentry.init() entirely while
// NEXT_PUBLIC_SENTRY_DSN is unset), same as every other Sentry.* call in this codebase.
export const onRequestError = Sentry.captureRequestError;
