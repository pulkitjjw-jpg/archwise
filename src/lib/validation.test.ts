import { describe, expect, it } from "vitest";
import { getProviderMaturityWarning, validateArchitectureLayout } from "./validation";

function component(id: string, type: string, name = id) {
  return { id, type, name };
}

function connection(from: string, to: string) {
  return { from, to, protocol: "HTTPS" };
}

const baseRequirements = {
  functional: ["Users can sign up"],
  nonFunctional: {
    expectedScale: "1000 users",
    readWritePattern: "read-heavy",
    dataNature: "structured",
    latencySensitivity: "medium",
    budget: "not_specified",
    teamMaturity: "not_specified",
    compliance: "none",
  },
};

describe("validateArchitectureLayout", () => {
  it("passes a valid, fully-connected layout with no errors or warnings", () => {
    const components = [component("lb", "lb"), component("compute", "compute"), component("db", "database")];
    const connections = [connection("lb", "compute"), connection("compute", "db")];

    const result = validateArchitectureLayout(components, connections);

    expect(result.isValid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("flags an orphaned component that has no connection at all", () => {
    const components = [component("compute", "compute"), component("db", "database"), component("cache", "cache")];
    // cache is never referenced by any connection
    const connections = [connection("compute", "db")];

    const result = validateArchitectureLayout(components, connections);

    expect(result.isValid).toBe(false);
    expect(result.errors).toEqual([
      expect.stringContaining('"cache" is orphaned'),
    ]);
  });

  it("does not flag orphans when there is only a single component", () => {
    const components = [component("solo", "compute")];
    const result = validateArchitectureLayout(components, []);
    // Single-component layouts skip the orphan check entirely (components.length > 1 guard) --
    // but the compute-without-database check still fires since there's no db component.
    expect(result.errors.some((e) => e.includes("orphaned"))).toBe(false);
  });

  it("flags compute present without any database or object storage", () => {
    const components = [component("compute", "compute"), component("cache", "cache")];
    const connections = [connection("compute", "cache")];

    const result = validateArchitectureLayout(components, connections);

    expect(result.isValid).toBe(false);
    expect(result.errors).toEqual([
      expect.stringContaining("Broken dependency"),
    ]);
  });

  it("accepts object storage as satisfying the compute-needs-a-datastore check", () => {
    const components = [component("compute", "compute"), component("storage", "storage")];
    const connections = [connection("compute", "storage")];

    const result = validateArchitectureLayout(components, connections);

    expect(result.errors.some((e) => e.includes("Broken dependency"))).toBe(false);
  });

  it("detects a circular dependency and reports the cycle path", () => {
    const components = [component("a", "compute"), component("b", "compute"), component("c", "database")];
    const connections = [connection("a", "b"), connection("b", "c"), connection("c", "a")];

    const result = validateArchitectureLayout(components, connections);

    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => e.includes("circular dependency"))).toBe(true);
  });

  it("warns (does not error) when a CDN connects directly to a database", () => {
    const components = [component("cdn", "cdn"), component("db", "database"), component("compute", "compute")];
    // compute keeps the "compute needs a datastore" check satisfied without being the direct
    // reason for the warning under test.
    const connections = [connection("cdn", "db"), connection("compute", "db")];

    const result = validateArchitectureLayout(components, connections);

    expect(result.isValid).toBe(true); // warnings never flip isValid to false
    expect(result.warnings).toEqual([
      expect.stringContaining("CDN"),
    ]);
  });

  it("warns when a load balancer connects directly to a database", () => {
    const components = [component("lb", "lb"), component("db", "database"), component("compute", "compute")];
    const connections = [connection("lb", "db"), connection("compute", "db")];

    const result = validateArchitectureLayout(components, connections);

    expect(result.isValid).toBe(true);
    expect(result.warnings.some((w) => w.includes("Load Balancer"))).toBe(true);
  });

  it("flags a low-stated-budget layout whose active provider cost exceeds it as a warning, not an error", () => {
    const components = [component("compute", "compute"), component("db", "database")];
    const connections = [connection("compute", "db")];
    const requirements = {
      ...baseRequirements,
      nonFunctional: { ...baseRequirements.nonFunctional, budget: "tight, around $100/mo" },
    };

    const result = validateArchitectureLayout(components, connections, requirements, { min: 250, max: 400 });

    expect(result.isValid).toBe(true); // still valid -- budget overrun is a soft warning
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((w) => w.includes("budget"))).toBe(true);
  });

  it("does not warn about budget when costs are within a stated low budget", () => {
    const components = [component("compute", "compute"), component("db", "database")];
    const connections = [connection("compute", "db")];
    const requirements = {
      ...baseRequirements,
      nonFunctional: { ...baseRequirements.nonFunctional, budget: "low, $50/mo" },
    };

    const result = validateArchitectureLayout(components, connections, requirements, { min: 40, max: 90 });

    expect(result.warnings.some((w) => w.includes("budget"))).toBe(false);
  });

  it("does not warn about budget for a non-low budget string even if costs are high", () => {
    const components = [component("compute", "compute"), component("db", "database")];
    const connections = [connection("compute", "db")];
    const requirements = {
      ...baseRequirements,
      nonFunctional: { ...baseRequirements.nonFunctional, budget: "enterprise, flexible" },
    };

    const result = validateArchitectureLayout(components, connections, requirements, { min: 5000, max: 9000 });

    expect(result.warnings.some((w) => w.includes("budget"))).toBe(false);
  });

  it("reports every independent problem at once rather than short-circuiting on the first", () => {
    // orphaned "cache" + compute-without-database (db not connected... actually db exists but
    // let's remove it to also trigger the broken-dependency check) both fire simultaneously.
    const components = [component("compute", "compute"), component("cache", "cache")];
    const connections: ReturnType<typeof connection>[] = [];

    const result = validateArchitectureLayout(components, connections);

    expect(result.isValid).toBe(false);
    // Both components orphaned + compute-without-database => at least 3 errors.
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe("getProviderMaturityWarning", () => {
  it("returns null for aws/azure/gcp regardless of team maturity", () => {
    const requirements = { nonFunctional: { teamMaturity: "junior team", budget: "tight" } };
    expect(getProviderMaturityWarning("aws", requirements)).toBeNull();
    expect(getProviderMaturityWarning("azure", requirements)).toBeNull();
    expect(getProviderMaturityWarning("gcp", requirements)).toBeNull();
  });

  it("returns null for kubernetes/private when requirements are absent", () => {
    expect(getProviderMaturityWarning("kubernetes")).toBeNull();
    expect(getProviderMaturityWarning("private")).toBeNull();
  });

  it("warns for kubernetes when the team is described as junior/small/new", () => {
    const requirements = { nonFunctional: { teamMaturity: "small team, mostly junior", budget: "flexible" } };
    const warning = getProviderMaturityWarning("kubernetes", requirements);
    expect(warning).not.toBeNull();
    expect(warning).toContain("Kubernetes");
  });

  it("warns for private cloud when the budget is tight, even with a mature team", () => {
    const requirements = { nonFunctional: { teamMaturity: "senior, experienced platform team", budget: "very tight" } };
    const warning = getProviderMaturityWarning("private", requirements);
    expect(warning).not.toBeNull();
    expect(warning).toContain("private cloud");
  });

  it("does not warn for kubernetes when the team is mature and the budget is generous", () => {
    const requirements = { nonFunctional: { teamMaturity: "senior, experienced platform team", budget: "generous, flexible" } };
    expect(getProviderMaturityWarning("kubernetes", requirements)).toBeNull();
  });

  it("treats not_specified team maturity as low maturity (conservative default)", () => {
    const requirements = { nonFunctional: { teamMaturity: "not_specified", budget: "flexible" } };
    expect(getProviderMaturityWarning("kubernetes", requirements)).not.toBeNull();
  });
});
