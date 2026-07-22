import { describe, expect, it } from "vitest";
import { computeHealthScore } from "./health-score";

type Comp = {
  id: string;
  name: string;
  type: string;
  cloudMappings?: Record<string, { lld?: { config?: Record<string, string> } } | undefined>;
};

function component(id: string, type: string, config?: Record<string, string>, provider = "aws"): Comp {
  const c: Comp = { id, type, name: id };
  if (config) {
    c.cloudMappings = { [provider]: { lld: { config } } };
  }
  return c;
}

describe("computeHealthScore", () => {
  describe("cost efficiency", () => {
    it("scores 100 when estimated cost fits within the stated budget", () => {
      const result = computeHealthScore([], [], "$1,000/month", [], "aws", 200, 800);
      expect(result.costEfficiency.score).toBe(100);
    });

    it("scores 25 when cost is exactly double the stated budget (ratio boundary)", () => {
      const result = computeHealthScore([], [], "$500/month", [], "aws", 400, 1000);
      // ratio = costMax / budget = 1000 / 500 = 2, which is NOT > 2 (strict), so falls into the
      // "far above" bucket's non-extreme branch (score 25) rather than the ratio > 2 branch (10).
      expect(result.costEfficiency.score).toBe(25);
    });

    it("scores very low when cost is far above (more than double) the stated budget", () => {
      const result = computeHealthScore([], [], "$100/month", [], "aws", 50, 300);
      expect(result.costEfficiency.score).toBe(10);
    });

    it("uses a neutral baseline score when no budget is stated", () => {
      const result = computeHealthScore([], [], undefined, [], "aws", 100, 200);
      expect(result.costEfficiency.score).toBe(65);
      expect(result.costEfficiency.reasoning[0]).toContain("No target budget was stated");
    });

    it("uses a neutral baseline score for a not_specified budget sentinel", () => {
      const result = computeHealthScore([], [], "not_specified", [], "aws", 100, 200);
      expect(result.costEfficiency.score).toBe(65);
    });

    it("scores 75 when cost is only slightly above budget", () => {
      const result = computeHealthScore([], [], "$1,000/month", [], "aws", 900, 1100);
      // ratio = 1100/1000 = 1.1 <= 1.2
      expect(result.costEfficiency.score).toBe(75);
    });
  });

  describe("scalability", () => {
    it("scores full marks when compute has autoscaling and databases have multi-AZ", () => {
      const components = [
        component("compute1", "compute", { minInstances: "2", maxInstances: "10" }),
        component("compute2", "compute", { minInstances: "2", maxInstances: "10" }),
        component("db", "database", { multiAZ: "true (Primary/Standby)" }),
      ];
      const result = computeHealthScore(components, [], "$5,000/month", [], "aws", 100, 200);
      expect(result.scalability.score).toBe(100);
    });

    it("deducts points when compute has no scaling configuration at all", () => {
      const components = [component("compute1", "compute", {}), component("compute2", "compute", {})];
      const result = computeHealthScore(components, [], undefined, [], "aws", 100, 200);
      expect(result.scalability.score).toBeLessThan(100);
      expect(result.scalability.reasoning.some((r) => r.includes("no scaling configuration"))).toBe(true);
    });

    it("deducts points for a fixed instance count with no autoscaling range", () => {
      const components = [
        component("compute1", "compute", { minInstances: "2" }),
        component("compute2", "compute", { minInstances: "2" }),
      ];
      const result = computeHealthScore(components, [], undefined, [], "aws", 100, 200);
      expect(result.scalability.reasoning.some((r) => r.includes("fixed instance count"))).toBe(true);
    });

    it("deducts points when a database has no multi-AZ failover configured", () => {
      const components = [
        component("compute1", "compute", { minInstances: "2", maxInstances: "10" }),
        component("compute2", "compute", { minInstances: "2", maxInstances: "10" }),
        component("db", "database", { multiAZ: "false (Single Node)" }),
      ];
      const result = computeHealthScore(components, [], undefined, [], "aws", 100, 200);
      expect(result.scalability.reasoning.some((r) => r.includes("no failover redundancy"))).toBe(true);
      expect(result.scalability.score).toBeLessThan(100);
    });

    it("deducts points for a single compute component (single point of failure)", () => {
      const components = [component("compute1", "compute", { minInstances: "2", maxInstances: "10" })];
      const result = computeHealthScore(components, [], undefined, [], "aws", 100, 200);
      expect(result.scalability.reasoning.some((r) => r.includes("Only one compute component"))).toBe(true);
    });
  });

  describe("security score", () => {
    it("scores 100 with no security findings", () => {
      const result = computeHealthScore([], [], undefined, [], "aws", 100, 200);
      expect(result.security.score).toBe(100);
      expect(result.security.reasoning).toEqual(["No security findings from the automated audit."]);
    });

    it("deducts 15 points per high-severity finding", () => {
      const result = computeHealthScore([], [], undefined, [{ severity: "high", title: "Finding A" }], "aws", 100, 200);
      expect(result.security.score).toBe(85);
    });

    it("deducts 8 points per medium-severity finding", () => {
      const result = computeHealthScore([], [], undefined, [{ severity: "medium", title: "Finding A" }], "aws", 100, 200);
      expect(result.security.score).toBe(92);
    });

    it("deducts 3 points per low-severity finding", () => {
      const result = computeHealthScore([], [], undefined, [{ severity: "low", title: "Finding A" }], "aws", 100, 200);
      expect(result.security.score).toBe(97);
    });

    it("accumulates deductions across multiple findings of mixed severity", () => {
      const result = computeHealthScore(
        [],
        [],
        undefined,
        [
          { severity: "high", title: "A" },
          { severity: "medium", title: "B" },
          { severity: "low", title: "C" },
        ],
        "aws",
        100,
        200
      );
      // 100 - 15 - 8 - 3 = 74
      expect(result.security.score).toBe(74);
    });

    it("clamps score at 0 when deductions exceed 100", () => {
      const manyFindings = Array.from({ length: 10 }, (_, i) => ({ severity: "high" as const, title: `Finding ${i}` }));
      const result = computeHealthScore([], [], undefined, manyFindings, "aws", 100, 200);
      expect(result.security.score).toBe(0);
    });
  });

  describe("vendor lock-in", () => {
    it("scores 95 for a kubernetes deployment target regardless of component types", () => {
      const components = [component("db", "database", {}), component("auth", "auth", {})];
      const result = computeHealthScore(components, [], undefined, [], "kubernetes", 100, 200);
      expect(result.vendorLockIn.score).toBe(95);
      expect(result.vendorLockIn.reasoning[0]).toContain("Self-hosted deployment target");
    });

    it("scores 95 for a private cloud deployment target", () => {
      const components = [component("db", "database", {})];
      const result = computeHealthScore(components, [], undefined, [], "private", 100, 200);
      expect(result.vendorLockIn.score).toBe(95);
    });

    it("scores 100 with no components to assess on a managed provider", () => {
      const result = computeHealthScore([], [], undefined, [], "aws", 100, 200);
      expect(result.vendorLockIn.score).toBe(100);
    });

    it("scores lower for a mix skewed toward low-portability component types on a managed provider", () => {
      const lowPortability = [component("auth", "auth", {}), component("tokenization", "tokenization", {})];
      const highPortability = [component("storage", "storage", {}), component("cache", "cache", {})];

      const lowResult = computeHealthScore(lowPortability, [], undefined, [], "aws", 100, 200);
      const highResult = computeHealthScore(highPortability, [], undefined, [], "aws", 100, 200);

      expect(lowResult.vendorLockIn.score).toBeLessThan(highResult.vendorLockIn.score);
    });

    it("scores the component types added since Phase 2 (lb/dns/monitoring/notification/search/analytics/ml/workflow), not the ?? 55 fallback", () => {
      const typedComponents = ["lb", "dns", "monitoring", "notification", "search", "analytics", "ml", "workflow"].map((type) =>
        component(type, type, {})
      );
      // A component whose type is genuinely absent from PORTABILITY_BY_TYPE would fall back to 55
      // for every one of them, averaging to exactly 55 -- asserting the average is NOT 55 confirms
      // these 8 types each have their own real entry, not the generic fallback.
      const result = computeHealthScore(typedComponents, [], undefined, [], "aws", 100, 200);
      expect(result.vendorLockIn.score).not.toBe(55);
    });

    it("scores workflow orchestrators (proprietary state-machine languages) lower than DNS (a standard protocol)", () => {
      const workflowResult = computeHealthScore([component("wf", "workflow", {})], [], undefined, [], "aws", 100, 200);
      const dnsResult = computeHealthScore([component("d", "dns", {})], [], undefined, [], "aws", 100, 200);
      expect(workflowResult.vendorLockIn.score).toBeLessThan(dnsResult.vendorLockIn.score);
    });
  });

  describe("overall score", () => {
    it("is the average of the four dimension scores", () => {
      const result = computeHealthScore([], [], "$1,000/month", [], "aws", 200, 800);
      const expectedAvg = Math.round(
        (result.costEfficiency.score + result.scalability.score + result.security.score + result.vendorLockIn.score) / 4
      );
      expect(result.overall).toBe(expectedAvg);
    });
  });
});
