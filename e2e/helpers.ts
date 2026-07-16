import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

// Clerk's dedicated test-email convention (dev instances only): any address containing
// "+clerk_test" never sends a real email and always accepts the fixed OTP below instead of a
// real generated code. A random suffix keeps every test run's accounts unique so re-running the
// suite doesn't collide with a previous run's leftover users.
export function testEmail(label: string): string {
  return `e2e_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}+clerk_test@example.com`;
}

export const CLERK_TEST_OTP = "424242";
export const TEST_PASSWORD = "Correct-Horse-Battery-Staple-42!";

/** Drives this app's own custom sign-up form (src/app/signup/page.tsx) end to end: fills
 * email+password, submits, waits for the verify-code step, and enters the fixed test OTP.
 * Assumes setupClerkTestingToken({ page }) has already been called for this page. */
export async function signUpNewUser(page: Page, email: string, password = TEST_PASSWORD) {
  await page.goto("/signup");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: /create account/i }).click();

  await expect(page.getByLabel(/verification code/i)).toBeVisible({ timeout: 20_000 });
  await page.getByLabel(/verification code/i).fill(CLERK_TEST_OTP);
  await page.getByRole("button", { name: /verify & create account/i }).click();

  await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
}
