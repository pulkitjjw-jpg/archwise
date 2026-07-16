import { defineConfig, devices } from "@playwright/test";

// Base URL matches this app's local dev stack (see CLAUDE.md's "Running locally"): Next.js on
// :3000 proxying to the FastAPI backend on :8000. Deliberately does NOT start `npm run dev` or
// `docker compose up` itself via Playwright's `webServer` option -- this app's own operational
// notes (this session) found that running `next build` against an already-running `next dev`
// corrupts its `.next` cache, and the same caution applies to letting an automated test runner
// manage the dev server's lifecycle. The real stack (docker compose + `npm run dev`) must already
// be running before `npm run test:e2e`.
const baseURL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000";

export default defineConfig({
  testDir: "./e2e",
  // Generous: signup/signin chain multiple real Clerk network round trips (create, send code,
  // verify code, finalize) plus this app's own device-trust step -- see ArchitectureWorkspace.tsx's
  // JOB_POLL_TIMEOUT_MS (90s) for this app's own established convention of giving real
  // network/LLM-backed flows comfortable headroom rather than a tight default.
  timeout: 90_000,
  expect: {
    timeout: 15_000,
  },
  // Signup/signin both create real Clerk users against the same test instance and the
  // per-suite Testing Token from clerkSetup() -- keep runs serial rather than parallel to avoid
  // rate-limit/flakiness surprises across a small spec count where parallelism buys little.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: "setup",
      testMatch: /global\.setup\.ts/,
    },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
    },
  ],
});
