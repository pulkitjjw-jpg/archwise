import { describe, expect, it } from "vitest";
import { getAccountStrategyBanner, isMultiAccountActive } from "./account-strategy";

describe("isMultiAccountActive", () => {
  it("returns false for undefined/null/empty config", () => {
    expect(isMultiAccountActive(undefined)).toBe(false);
    expect(isMultiAccountActive(null)).toBe(false);
    expect(isMultiAccountActive({})).toBe(false);
  });

  it("returns false when accountSeparation key is absent but other compute config keys exist", () => {
    expect(isMultiAccountActive({ instanceSize: "0.5 vCPU + 1GB RAM", minInstances: "2" })).toBe(false);
  });

  it('returns true only for the exact string "true"', () => {
    expect(isMultiAccountActive({ accountSeparation: "true" })).toBe(true);
  });

  it('returns false for any other accountSeparation value, including "false"', () => {
    expect(isMultiAccountActive({ accountSeparation: "false" })).toBe(false);
    expect(isMultiAccountActive({ accountSeparation: "True" })).toBe(false);
    expect(isMultiAccountActive({ accountSeparation: "1" })).toBe(false);
  });
});

describe("getAccountStrategyBanner", () => {
  it("returns null when multi-account separation is not active", () => {
    expect(getAccountStrategyBanner({ accountSeparation: "false" })).toBe(null);
    expect(getAccountStrategyBanner({})).toBe(null);
    expect(getAccountStrategyBanner(undefined)).toBe(null);
    expect(getAccountStrategyBanner(null)).toBe(null);
  });

  it("returns the banner text when active", () => {
    expect(getAccountStrategyBanner({ accountSeparation: "true" })).toBe(
      "Deployed independently across separate Dev / Staging / Prod accounts for blast-radius isolation."
    );
  });

  it("returns the same banner text regardless of provider-specific accountStructure/crossAccountAccessPattern content", () => {
    // The banner is a single whole-diagram notice, not provider-specific copy -- accountStructure
    // (e.g. "Separate AWS accounts...") is real detail available in the component drawer's LLD
    // section, not duplicated into this banner.
    const aws = getAccountStrategyBanner({
      accountSeparation: "true",
      accountStructure: "Separate AWS accounts per environment (dev/staging/prod)",
      crossAccountAccessPattern: "Cross-account IAM role assumption (sts:AssumeRole) from a central CI/CD identity into a per-account TerraformDeployRole",
    });
    const gcp = getAccountStrategyBanner({
      accountSeparation: "true",
      accountStructure: "Separate GCP projects per environment (dev/staging/prod)",
      crossAccountAccessPattern: "A project-scoped service account per GCP project, impersonated by the central CI/CD pipeline via short-lived credentials",
    });
    expect(aws).toBe(gcp);
  });
});
