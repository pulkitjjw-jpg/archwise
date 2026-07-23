import { describe, expect, it } from "vitest";
import { isSecurityFindingFixable } from "./security-fix";

describe("isSecurityFindingFixable", () => {
  it.each([
    ["database", "Database has no explicit encryption configuration recorded", "aws"],
    ["database", "Database has no automatic failover configured", "azure"],
    ["database", "Database backup retention is effectively disabled", "gcp"],
    ["cache", "Cache layer has no encryption configuration recorded", "aws"],
    ["auth", "Multi-factor authentication is not required", "aws"],
    ["auth", "Unrestricted self-service sign-up on a sensitive-data system", "aws"],
    ["lb", "Public-facing edge has no WAF despite handling sensitive data", "aws"],
    ["cdn", "Public-facing edge has no WAF despite handling sensitive data", "gcp"],
  ])("is fixable: %s / %s / %s", (type, title, provider) => {
    expect(isSecurityFindingFixable(type, title, provider)).toBe(true);
  });

  it.each([["aws"], ["azure"], ["gcp"]])("DR finding is fixable on %s", (provider) => {
    expect(
      isSecurityFindingFixable(
        "database",
        "No disaster-recovery strategy for a system that can't afford extended downtime",
        provider
      )
    ).toBe(true);
  });

  it.each([["kubernetes"], ["private"]])(
    "DR finding is NOT fixable on %s -- no DR convention exists for this provider",
    (provider) => {
      expect(
        isSecurityFindingFixable(
          "database",
          "No disaster-recovery strategy for a system that can't afford extended downtime",
          provider
        )
      ).toBe(false);
    }
  );

  it("returns false for a finding type with no fix handler at all", () => {
    expect(isSecurityFindingFixable(undefined as unknown as string, "No audit logging component", "aws")).toBe(false);
    expect(isSecurityFindingFixable("auth", "No authentication layer guarding stored data", "aws")).toBe(false);
  });

  it("returns false for an unrecognized title on an otherwise-fixable component type", () => {
    expect(isSecurityFindingFixable("database", "Some future finding not in the registry", "aws")).toBe(false);
  });

  it("returns false for a component type with no fixable findings at all", () => {
    expect(isSecurityFindingFixable("compute", "Anything", "aws")).toBe(false);
  });
});
