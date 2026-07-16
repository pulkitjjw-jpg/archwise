import { expect, test } from "@playwright/test";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import { signUpNewUser, testEmail } from "./helpers";

// Reproduces this session's manual live-tested sign-up flow (see login/page.tsx and
// signup/page.tsx's own comments on the Clerk SDK staleness workarounds this exercises) as a
// permanent, reproducible spec: email+password -> Clerk sends (a test) verification code ->
// enter the fixed 424242 OTP -> land on /dashboard with an active session.
test("sign up with email verification reaches the dashboard", async ({ page }) => {
  await setupClerkTestingToken({ page });

  const email = testEmail("signup");
  await signUpNewUser(page, email);

  // A real, distinguishing assertion beyond just the URL -- the dashboard's own header badge,
  // only rendered once actually signed in and past the app's own auth guard (src/app/dashboard/
  // page.tsx), not the /login page's "Welcome back" copy.
  await expect(page.getByText("Workspace Dashboard")).toBeVisible();
});
