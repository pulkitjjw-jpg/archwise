import { describe, expect, it } from "vitest";
import { getRedundancyBadge, isRedundantConfig } from "./redundancy";

describe("isRedundantConfig", () => {
  it("returns false for undefined/null/empty config", () => {
    expect(isRedundantConfig(undefined)).toBe(false);
    expect(isRedundantConfig(null)).toBe(false);
    expect(isRedundantConfig({})).toBe(false);
  });

  it("returns false when no recognized keys are present", () => {
    expect(isRedundantConfig({ instanceClass: "db.t4g.micro", storageSize: "20GB GP3" })).toBe(false);
  });

  // multiAZ -- real shapes from lld_rules.py's "database" branch (aws/azure/gcp)
  describe("multiAZ", () => {
    it("detects the high-scale/high-security relational-DB shape", () => {
      expect(isRedundantConfig({ multiAZ: "true (Primary/Standby)" })).toBe(true);
    });

    it("detects the PCI-DSS forced-enabled shape (same string, different code path)", () => {
      expect(isRedundantConfig({ multiAZ: "true (Primary/Standby)" })).toBe(true);
    });

    it("rejects the disabled/single-node shape", () => {
      expect(isRedundantConfig({ multiAZ: "false (Single Node)" })).toBe(false);
    });

    it("is case-insensitive", () => {
      expect(isRedundantConfig({ multiAZ: "TRUE (Primary/Standby)" })).toBe(true);
    });
  });

  // clusteringEnabled -- real shapes from lld_rules.py's "cache" branch
  describe("clusteringEnabled", () => {
    it("detects true", () => {
      expect(isRedundantConfig({ clusteringEnabled: "true" })).toBe(true);
    });

    it("rejects false", () => {
      expect(isRedundantConfig({ clusteringEnabled: "false" })).toBe(false);
    });
  });

  // minInstances -- real shapes from lld_rules.py's "compute" branch (container path)
  describe("minInstances", () => {
    it("detects a high-scale value of 2", () => {
      expect(isRedundantConfig({ minInstances: "2" })).toBe(true);
    });

    it("rejects a low-scale value of 1", () => {
      expect(isRedundantConfig({ minInstances: "1" })).toBe(false);
    });
  });

  // replicas -- real shapes from _run_kubernetes_lld across multiple component types
  describe("replicas", () => {
    it("detects a plain count > 1 (realtime/lb/compute)", () => {
      expect(isRedundantConfig({ replicas: "4" })).toBe(true);
      expect(isRedundantConfig({ replicas: "3" })).toBe(true);
      expect(isRedundantConfig({ replicas: "2" })).toBe(true);
    });

    it("rejects a plain count of 1", () => {
      expect(isRedundantConfig({ replicas: "1" })).toBe(false);
    });

    it("extracts the leading number from an annotated database shape", () => {
      expect(isRedundantConfig({ replicas: "3 (Primary + 2 Replicas)" })).toBe(true);
      expect(isRedundantConfig({ replicas: "1 (Single Instance)" })).toBe(false);
    });

    it("extracts the leading number from an annotated storage shape", () => {
      expect(isRedundantConfig({ replicas: "4 (Distributed Mode)" })).toBe(true);
      expect(isRedundantConfig({ replicas: "1 (Standalone)" })).toBe(false);
    });

    it("extracts the leading number from an annotated queue shape", () => {
      expect(isRedundantConfig({ replicas: "3 (Clustered)" })).toBe(true);
    });

    it("extracts the leading number from an annotated cache shape", () => {
      expect(isRedundantConfig({ replicas: "3 (Cluster Mode)" })).toBe(true);
      expect(isRedundantConfig({ replicas: "1 (Standalone)" })).toBe(false);
    });

    it("extracts the leading number from an annotated tokenization shape", () => {
      expect(isRedundantConfig({ replicas: "3 (Vault Raft HA)" })).toBe(true);
    });
  });

  it("short-circuits on the first matching signal without needing the others", () => {
    expect(isRedundantConfig({ multiAZ: "true (Primary/Standby)", replicas: "1 (Single Instance)" })).toBe(true);
  });
});

describe("getRedundancyBadge", () => {
  it("returns null for a non-redundant or empty config", () => {
    expect(getRedundancyBadge(undefined)).toBeNull();
    expect(getRedundancyBadge({})).toBeNull();
    expect(getRedundancyBadge({ minInstances: "1" })).toBeNull();
  });

  it("prefers an explicit ×N count from minInstances", () => {
    expect(getRedundancyBadge({ minInstances: "2" })).toBe("×2");
  });

  it("prefers an explicit ×N count from replicas, including annotated shapes", () => {
    expect(getRedundancyBadge({ replicas: "4" })).toBe("×4");
    expect(getRedundancyBadge({ replicas: "3 (Primary + 2 Replicas)" })).toBe("×3");
    expect(getRedundancyBadge({ replicas: "4 (Distributed Mode)" })).toBe("×4");
  });

  it("falls back to 'Multi-AZ' for the boolean-only multiAZ signal", () => {
    expect(getRedundancyBadge({ multiAZ: "true (Primary/Standby)" })).toBe("Multi-AZ");
  });

  it("falls back to 'HA' for the boolean-only clusteringEnabled signal", () => {
    expect(getRedundancyBadge({ clusteringEnabled: "true" })).toBe("HA");
  });
});
