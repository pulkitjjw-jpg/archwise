import { expect, test } from "@playwright/test";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import { signUpNewUser, testEmail } from "./helpers";

// Confirms backend/app/dependencies.py's _load_project_with_role behavior: a project that exists
// but belongs to someone else (no ProjectMembership row either) resolves as 404, the same
// response as a genuinely nonexistent project id -- never 403. Per that function's own docstring,
// this is deliberate: "never reveal a project id exists to someone with no access to it." A 403
// would leak that existence; a 404 doesn't.
test("a user cannot see another user's project -- 404, not 403", async ({ browser }) => {
  const contextA = await browser.newContext();
  const pageA = await contextA.newPage();
  await setupClerkTestingToken({ page: pageA });
  await signUpNewUser(pageA, testEmail("isoA"));

  const createRes = await pageA.request.post("/api/projects", {
    data: {
      name: "User A's private project",
      ideaText: "An internal inventory tracker for a single warehouse.",
    },
    timeout: 60_000, // this endpoint makes a best-effort LLM call for the first brainstorm question
  });
  expect(createRes.ok()).toBe(true);
  const { projectId } = await createRes.json();
  expect(typeof projectId).toBe("string");
  expect(projectId.length).toBeGreaterThan(0);

  // Sanity check: the owner can actually read their own project back (proves the 404 below is
  // real isolation, not just a broken endpoint returning 404 for everyone).
  const ownerRead = await pageA.request.get(`/api/projects/${projectId}`);
  expect(ownerRead.status()).toBe(200);

  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  await setupClerkTestingToken({ page: pageB });
  await signUpNewUser(pageB, testEmail("isoB"));

  const strangerRead = await pageB.request.get(`/api/projects/${projectId}`);
  expect(strangerRead.status()).toBe(404);
  expect(strangerRead.status()).not.toBe(403);

  const body = await strangerRead.json().catch(() => null);
  if (body) {
    // Matches _load_project_with_role's literal detail message -- also confirms the error body
    // doesn't leak anything ownership-specific (e.g. no owner email/id in the response).
    expect(JSON.stringify(body).toLowerCase()).toContain("not found");
  }

  await contextA.close();
  await contextB.close();
});
