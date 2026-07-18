import { describe, expect, it } from "vitest";
import { getDrBadge, getDrStrategy } from "./dr-strategy";

describe("getDrStrategy", () => {
  it("returns null for undefined/null/empty config", () => {
    expect(getDrStrategy(undefined)).toBe(null);
    expect(getDrStrategy(null)).toBe(null);
    expect(getDrStrategy({})).toBe(null);
  });

  it("returns null when routingPolicy is the default non-DR value", () => {
    expect(getDrStrategy({ routingPolicy: "Simple" })).toBe(null);
  });

  it("returns null when routingPolicy key is absent but other dns config keys exist", () => {
    expect(getDrStrategy({ hostedZoneType: "Public", ttlSeconds: "300" })).toBe(null);
  });

  it('detects pilot-light from the exact "Failover (Active-Passive)" string', () => {
    expect(getDrStrategy({ routingPolicy: "Failover (Active-Passive)" })).toBe("pilot-light");
  });

  it('detects warm-standby from the "Latency-based routing..." prefix', () => {
    expect(getDrStrategy({ routingPolicy: "Latency-based routing with health-check failover" })).toBe("warm-standby");
  });

  it("returns null for an unrecognized routingPolicy string", () => {
    expect(getDrStrategy({ routingPolicy: "Weighted" })).toBe(null);
  });
});

describe("getDrBadge", () => {
  it("returns null when no DR is active", () => {
    expect(getDrBadge({ routingPolicy: "Simple" })).toBe(null);
    expect(getDrBadge(undefined)).toBe(null);
  });

  it("returns the pilot-light badge text", () => {
    expect(getDrBadge({ routingPolicy: "Failover (Active-Passive)" })).toBe("DR: Pilot Light");
  });

  it("returns the warm-standby badge text", () => {
    expect(getDrBadge({ routingPolicy: "Latency-based routing with health-check failover" })).toBe("DR: Warm Standby");
  });
});
