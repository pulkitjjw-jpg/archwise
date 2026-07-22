import { describe, expect, it } from "vitest";
import { runLldRulesEngine, type IndustryContext } from "./lld-rules";

type Requirements = Parameters<typeof runLldRulesEngine>[3];

function makeRequirements(overrides: Partial<Requirements["nonFunctional"]> & { functional?: string[] } = {}): Requirements {
  const { functional, ...nfrOverrides } = overrides;
  return {
    functional: functional ?? ["Standard product functionality."],
    nonFunctional: {
      expectedScale: "moderate, 1,000 users",
      readWritePattern: "balanced",
      dataNature: "relational",
      latencySensitivity: "moderate",
      budget: "$1,000/month",
      teamMaturity: "experienced team",
      compliance: "none",
      ...nfrOverrides,
    },
  };
}

const HIGH_SCALE = { expectedScale: "high scale, 1 million users" };
const FINTECH: IndustryContext = { industry: "fintech", rationale: "", complianceAnswers: [], flags: {} };

// This client-side mirror exists purely for instant LLD preview while a user is manually editing
// the diagram (see lld-rules.ts's own docstring) -- these tests cover the component types added
// since Phase 2 (lb/dns/waf/monitoring/notification/search/analytics/ml/workflow), which had
// fallen through to the generic "Generic Config" placeholder in this file even though the backend
// (lld_rules.py) had real config for all of them.
describe("runLldRulesEngine -- component types added since Phase 2", () => {
  describe("aws/azure/gcp", () => {
    it("realtime gets a real WebSocket config, not the generic placeholder", () => {
      const result = runLldRulesEngine("aws", "realtime", "realtime", makeRequirements());
      expect(result.config.connectionModel).toBe("Persistent bidirectional (WebSocket)");
      expect(result.config.genericType).toBeUndefined();
    });

    it("lb resolves to a load-balancer-shaped config for a container-compute team", () => {
      const result = runLldRulesEngine("aws", "lb", "lb", makeRequirements({ teamMaturity: "experienced platform team" }));
      expect(result.config.healthCheckPath).toBe("/health");
      expect(result.config.gatewayType).toBeUndefined();
    });

    it("lb resolves to an API-gateway-shaped config when serviceNameOverride says so", () => {
      const result = runLldRulesEngine("aws", "lb", "lb", makeRequirements(), "Amazon API Gateway");
      expect(result.config.gatewayType).toBe("HTTP API (Regional)");
    });

    it("lb includes WAF config when high scale", () => {
      const result = runLldRulesEngine("aws", "lb", "lb", makeRequirements(HIGH_SCALE));
      expect(result.config.wafEnabled).toBe("true");
      expect(result.config.wafRuleSet).toContain("AWS Managed Rules");
    });

    it("cdn includes WAF config, disabled by default at low scale/security", () => {
      const result = runLldRulesEngine("aws", "cdn", "cdn", makeRequirements());
      expect(result.config.wafEnabled).toBe("false");
    });

    it("cdn enables WAF for a fintech project regardless of scale", () => {
      const result = runLldRulesEngine("aws", "cdn", "cdn", makeRequirements(), undefined, FINTECH);
      expect(result.config.wafEnabled).toBe("true");
    });

    it("dns gets a real hosted-zone config", () => {
      const result = runLldRulesEngine("aws", "dns", "dns", makeRequirements());
      expect(result.config.hostedZoneType).toBe("Public");
      expect(result.config.routingPolicy).toBe("Simple");
    });

    it("monitoring gets a real observability config, scale-sensitive tracing sample rate", () => {
      const low = runLldRulesEngine("aws", "monitoring", "monitoring", makeRequirements());
      const high = runLldRulesEngine("aws", "monitoring", "monitoring", makeRequirements(HIGH_SCALE));
      expect(low.config.tracingSampleRate).toBe("100% (full trace)");
      expect(high.config.tracingSampleRate).toBe("5% (sampled)");
    });

    it("notification infers delivery channels from functional requirements", () => {
      const result = runLldRulesEngine(
        "aws",
        "notification",
        "notification",
        makeRequirements({ functional: ["Send SMS alerts and push notifications to users."] })
      );
      expect(result.config.deliveryChannels).toContain("SMS");
      expect(result.config.deliveryChannels).toContain("Push");
    });

    it("notification defaults to email when no channel is mentioned", () => {
      const result = runLldRulesEngine("aws", "notification", "notification", makeRequirements());
      expect(result.config.deliveryChannels).toBe("Email");
    });

    it("search flags PII redaction for a healthtech project", () => {
      const healthtech: IndustryContext = { industry: "healthtech", rationale: "", complianceAnswers: [], flags: {} };
      const result = runLldRulesEngine("aws", "search", "search", makeRequirements(), undefined, healthtech);
      expect(result.config.piiRedactionRequired).toBe("true");
    });

    it("search does not require PII redaction for a generic project", () => {
      const result = runLldRulesEngine("aws", "search", "search", makeRequirements());
      expect(result.config.piiRedactionRequired).toBe("false");
    });

    it("analytics uses on-demand serverless scaling on a tight budget", () => {
      const result = runLldRulesEngine("aws", "analytics", "analytics", makeRequirements({ budget: "$50/month" }));
      expect(result.config.scalingMode).toContain("On-demand serverless");
    });

    it("analytics gets the compliance-mandated encryptionInTransit key like database/storage/cache", () => {
      const result = runLldRulesEngine("aws", "analytics", "analytics", makeRequirements(), undefined, FINTECH);
      expect(result.config.encryptionInTransit).toBe("TLS 1.2+ (Enforced)");
    });

    it("ml chooses GPU instances at high scale, CPU otherwise", () => {
      const low = runLldRulesEngine("aws", "ml", "ml", makeRequirements());
      const high = runLldRulesEngine("aws", "ml", "ml", makeRequirements(HIGH_SCALE));
      expect(low.config.instanceType).toContain("CPU-backed");
      expect(high.config.instanceType).toContain("GPU-backed");
    });

    it("ml flags the data compliance boundary for a fintech project", () => {
      const result = runLldRulesEngine("aws", "ml", "ml", makeRequirements(), undefined, FINTECH);
      expect(result.config.dataComplianceBoundary).toContain("true");
    });

    it("workflow chooses Standard execution by default, Express at high scale", () => {
      const low = runLldRulesEngine("aws", "workflow", "workflow", makeRequirements());
      const high = runLldRulesEngine("aws", "workflow", "workflow", makeRequirements(HIGH_SCALE));
      expect(low.config.executionType).toContain("Standard");
      expect(high.config.executionType).toContain("Express");
    });

    it("azure/gcp lb and cdn get provider-specific WAF rule sets", () => {
      const azure = runLldRulesEngine("azure", "cdn", "cdn", makeRequirements(HIGH_SCALE));
      const gcp = runLldRulesEngine("gcp", "cdn", "cdn", makeRequirements(HIGH_SCALE));
      expect(azure.config.wafRuleSet).toContain("Azure");
      expect(gcp.config.wafRuleSet).toContain("Cloud Armor");
    });
  });

  describe("kubernetes", () => {
    it("realtime gets pod-shaped config with a shared pub/sub backplane", () => {
      const result = runLldRulesEngine("kubernetes", "realtime", "realtime", makeRequirements());
      expect(result.config.namespace).toBe("app");
      expect(result.config.backplane).toContain("Redis Pub/Sub");
    });

    it("lb and cdn both flag no native WAF availability", () => {
      const lb = runLldRulesEngine("kubernetes", "lb", "lb", makeRequirements());
      const cdn = runLldRulesEngine("kubernetes", "cdn", "cdn", makeRequirements());
      expect(lb.config.wafNote).toContain("Not natively available");
      expect(cdn.config.wafNote).toContain("Not natively available");
    });

    it("dns runs as an ExternalDNS operator", () => {
      const result = runLldRulesEngine("kubernetes", "dns", "dns", makeRequirements());
      expect(result.config.deploymentMode).toContain("ExternalDNS");
    });

    it("search, analytics, ml, and workflow each get real per-type config, not the generic fallback", () => {
      for (const type of ["search", "analytics", "ml", "workflow"]) {
        const result = runLldRulesEngine("kubernetes", type, type, makeRequirements());
        expect(result.config.genericType).toBeUndefined();
        expect(Object.keys(result.config).length).toBeGreaterThan(0);
      }
    });

    it("analytics is modeled as an external network destination, not an in-cluster workload", () => {
      const result = runLldRulesEngine("kubernetes", "analytics", "analytics", makeRequirements());
      expect(result.config.deploymentMode).toContain("External");
    });
  });

  describe("private cloud", () => {
    it("lb and cdn both flag no native WAF availability", () => {
      const lb = runLldRulesEngine("private", "lb", "lb", makeRequirements());
      const cdn = runLldRulesEngine("private", "cdn", "cdn", makeRequirements());
      expect(lb.config.wafNote).toContain("Not natively available");
      expect(cdn.config.wafNote).toContain("Not natively available");
    });

    it("dns requires manual record management", () => {
      const result = runLldRulesEngine("private", "dns", "dns", makeRequirements());
      expect(result.config.deploymentMode).toContain("Manual record management");
    });

    it("search, analytics, ml, and workflow each get real per-type config, not the generic fallback", () => {
      for (const type of ["search", "analytics", "ml", "workflow"]) {
        const result = runLldRulesEngine("private", type, type, makeRequirements());
        expect(result.config.genericType).toBeUndefined();
        expect(Object.keys(result.config).length).toBeGreaterThan(0);
      }
    });

    it("analytics flags no on-premises managed equivalent", () => {
      const result = runLldRulesEngine("private", "analytics", "analytics", makeRequirements());
      expect(result.config.deploymentMode).toContain("No managed equivalent on-premises");
    });
  });

  describe("generic project baseline is unaffected", () => {
    it("a plain compute/database architecture still gets its existing config shape", () => {
      const result = runLldRulesEngine("aws", "compute", "compute", makeRequirements());
      expect(result.config.instanceSize).toBeDefined();
    });
  });
});
