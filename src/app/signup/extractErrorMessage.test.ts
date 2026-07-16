import { describe, expect, it } from "vitest";
import { extractErrorMessage } from "./page";

// Identical helper/precedence to login/page.tsx's (see that file's extractErrorMessage.test.ts
// for the detailed rationale) -- covered again here since signup/page.tsx keeps its own copy
// rather than importing login's, and a regression in one wouldn't necessarily show up in the
// other.

describe("extractErrorMessage (signup)", () => {
  it("prefers a field error (emailAddress) over a global error", () => {
    const errors = {
      global: [{ message: "generic failure" }],
      fields: { emailAddress: { message: "that email is already taken" } },
    };
    expect(extractErrorMessage(errors, ["emailAddress", "password"])).toBe("that email is already taken");
  });

  it("checks fieldOrder in sequence -- password error surfaces when emailAddress has none", () => {
    const errors = {
      global: null,
      fields: { password: { message: "password is too weak" } },
    };
    expect(extractErrorMessage(errors, ["emailAddress", "password"])).toBe("password is too weak");
  });

  it("falls back to global when no listed field has an error", () => {
    const errors = { global: [{ message: "verification code incorrect" }], fields: {} };
    expect(extractErrorMessage(errors, ["code"])).toBe("verification code incorrect");
  });

  it("uses the generic fallback message when nothing else is available", () => {
    const errors = { global: null, fields: {} };
    expect(extractErrorMessage(errors, [])).toBe("Something went wrong. Please try again.");
  });
});
