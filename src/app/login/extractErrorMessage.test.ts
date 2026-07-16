import { describe, expect, it } from "vitest";
import { extractErrorMessage } from "./page";

// extractErrorMessage's whole reason for existing: Clerk returns some real rejection reasons
// (e.g. "this password has appeared in a data breach") as a FIELD error rather than a global
// one. Missing that precedence meant genuine rejection reasons were silently replaced with a
// generic "Something went wrong" message -- these tests pin the precedence order so a future
// change can't quietly regress it.

describe("extractErrorMessage (login)", () => {
  it("prefers a field error over a global error when both are present, in fieldOrder", () => {
    const errors = {
      global: [{ message: "Something went wrong globally" }],
      fields: { password: { message: "This password has appeared in a data breach" } },
    };
    expect(extractErrorMessage(errors, ["identifier", "password"])).toBe(
      "This password has appeared in a data breach"
    );
  });

  it("checks fields in the given fieldOrder, returning the first one that has an error", () => {
    const errors = {
      global: null,
      fields: {
        password: { message: "bad password" },
        identifier: { message: "bad identifier" },
      },
    };
    // fieldOrder puts identifier first -- identifier's error should win even though password
    // also has one.
    expect(extractErrorMessage(errors, ["identifier", "password"])).toBe("bad identifier");
  });

  it("prefers longMessage over message when a field error has both", () => {
    const errors = {
      global: null,
      fields: { password: { message: "short", longMessage: "a much longer explanation" } },
    };
    expect(extractErrorMessage(errors, ["password"])).toBe("a much longer explanation");
  });

  it("falls back to the first global error when no listed field has an error", () => {
    const errors = {
      global: [{ message: "Invalid credentials" }],
      fields: {},
    };
    expect(extractErrorMessage(errors, ["identifier", "password"])).toBe("Invalid credentials");
  });

  it("prefers global longMessage over global message", () => {
    const errors = {
      global: [{ message: "short", longMessage: "long global explanation" }],
      fields: {},
    };
    expect(extractErrorMessage(errors, [])).toBe("long global explanation");
  });

  it("falls back to a generic message when there is no field error and no global error", () => {
    const errors = { global: null, fields: {} };
    expect(extractErrorMessage(errors, ["identifier"])).toBe("Something went wrong. Please try again.");
  });

  it("falls back to the generic message when global is an empty array", () => {
    const errors = { global: [], fields: {} };
    expect(extractErrorMessage(errors, [])).toBe("Something went wrong. Please try again.");
  });

  it("skips a field listed in fieldOrder that has no actual error and checks the next one", () => {
    const errors = {
      global: null,
      fields: { identifier: undefined, password: { message: "wrong password" } },
    };
    expect(extractErrorMessage(errors, ["identifier", "password"])).toBe("wrong password");
  });
});
