import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  // Emits .next/standalone -- a minimal, self-contained server bundle (only the deps this app
  // actually uses at runtime, not the full node_modules tree) that a Docker image can COPY and
  // run directly with `node server.js`, no `npm install` needed inside the final image. Doesn't
  // change `next dev`/local behavior at all -- purely additive to what `next build` emits.
  output: "standalone",
};

// withSentryConfig adds a build-time plugin (React component annotation, optional source map
// upload) on top of the runtime SDK init in src/instrumentation*.ts/sentry.*.config.ts. Only
// applied when NEXT_PUBLIC_SENTRY_DSN is actually set -- this app has no real Sentry account yet,
// and skipping the wrapper entirely (not just configuring it inert) keeps a from-scratch
// `npm run build` byte-for-byte the plain Next.js build it was before this scaffolding existed:
// no extra webpack/turbopack plugin work, no "skipping source map upload, no auth token" noise.
const sentryEnabled = Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN);

export default sentryEnabled
  ? withSentryConfig(nextConfig, {
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      // Only needed for source map upload -- undefined is fine (and expected) until this app has
      // a real Sentry project; the plugin skips the upload step and warns instead of failing the
      // build when it's missing.
      authToken: process.env.SENTRY_AUTH_TOKEN,
      // Only print the Sentry build plugin's own logs in CI, not local `npm run build`.
      silent: !process.env.CI,
      widenClientFileUpload: true,
    })
  : nextConfig;
