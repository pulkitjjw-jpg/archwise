import * as Sentry from "@sentry/nextjs";

// Edge runtime Sentry init (proxy.ts/middleware runs here), imported by src/instrumentation.ts's
// register(). See sentry.server.config.ts for why this reads NEXT_PUBLIC_SENTRY_DSN rather than
// a separate var, and why staying inert while it's unset is the required behavior, not a gap.
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV,
    tracesSampleRate: 0,
  });
}
