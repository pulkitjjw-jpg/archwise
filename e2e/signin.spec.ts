import { expect, test } from "@playwright/test";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import { CLERK_TEST_OTP, TEST_PASSWORD, signUpNewUser, testEmail } from "./helpers";

// Reproduces the device-verification bug fixed during this session's live Clerk testing (see
// login/page.tsx's handleSignIn comment on the "needs_client_trust" branch): signing in from a
// browser/device Clerk hasn't seen before for this account requires one extra emailed-code step
// before the session activates. A fresh Playwright browser context has no Clerk device-trust
// cookie, so signing in there for the very first time (even with the correct password) should
// reliably hit that branch -- this is the actual reproduction, not a mocked-out shortcut.
test("sign-in from a fresh browser context requires device verification, then succeeds", async ({ browser }) => {
  const email = testEmail("signin");

  // Context A: create the account. This also establishes an implicitly-trusted device for
  // context A itself (irrelevant here -- context A is discarded), but the account now exists
  // with a real password on file.
  const contextA = await browser.newContext();
  const pageA = await contextA.newPage();
  await setupClerkTestingToken({ page: pageA });
  await signUpNewUser(pageA, email);
  await contextA.close();

  // Context B: brand-new cookies, same account, same password -- the device-trust check has
  // never seen this browser before.
  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  await setupClerkTestingToken({ page: pageB });

  await pageB.goto("/login");
  await pageB.getByLabel("Email", { exact: true }).fill(email);
  await pageB.getByLabel("Password", { exact: true }).fill(TEST_PASSWORD);
  await pageB.getByRole("button", { name: /^sign in$/i }).click();

  // The device-verification step -- login/page.tsx's mode === "verify-device" screen.
  await expect(pageB.getByText(/confirm it's you/i)).toBeVisible({ timeout: 20_000 });
  await expect(pageB.getByText(new RegExp(email.replace(/[+.]/g, "\\$&"), "i"))).toBeVisible();

  await pageB.getByLabel(/verification code/i).fill(CLERK_TEST_OTP);
  await pageB.getByRole("button", { name: /verify & sign in/i }).click();

  await expect(pageB).toHaveURL(/\/dashboard/, { timeout: 30_000 });
  await expect(pageB.getByText("Workspace Dashboard")).toBeVisible();

  await contextB.close();
});
