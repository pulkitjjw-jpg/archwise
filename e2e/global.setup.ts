import { clerkSetup } from "@clerk/testing/playwright";
import { test as setup } from "@playwright/test";

// Fetches a Clerk Testing Token once at the start of the suite (used by every spec's
// setupClerkTestingToken() call to bypass Clerk's bot-protection challenge, which would otherwise
// block a headless browser from completing sign-up/sign-in). Reads CLERK_SECRET_KEY and
// NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY from the environment -- same .env this app's dev server
// already needs (see CLAUDE.md's "Running locally"), no separate E2E-only credentials.
setup.describe.configure({ mode: "serial" });

setup("global setup", async () => {
  await clerkSetup();
});
