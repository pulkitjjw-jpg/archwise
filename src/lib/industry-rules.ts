import { AbstractComponent, AbstractConnection } from "./rules-engine";
import { IndustryContext } from "@/db/schema";

export type IndustryRulesResult = {
  components: AbstractComponent[];
  connections: AbstractConnection[];
  rulesTrace: string[];
  risks: string[];
};

/**
 * Layers industry-specific compliance components and risks on top of the baseline HLD produced
 * by rules-engine.ts. Never runs in isolation — always called after runRulesEngine() so its
 * connections can reference baseline component ids (e.g. "compute") that are guaranteed to exist.
 * A generic (industryContext.industry === "none") project gets an empty result and the rest of
 * the pipeline is unaffected.
 */
export function runIndustryRules(
  industryContext: IndustryContext,
  functional: string[]
): IndustryRulesResult {
  const components: AbstractComponent[] = [];
  const connections: AbstractConnection[] = [];
  const rulesTrace: string[] = [];
  const risks: string[] = [];

  if (industryContext.industry === "none") {
    return { components, connections, rulesTrace, risks };
  }

  if (industryContext.industry === "fintech") {
    // Mandatory: immutable audit log, regardless of any other flag.
    components.push({
      id: "audit-log",
      name: "Audit Log Store",
      type: "audit-log",
      description: "Immutable, append-only store for every compliance-relevant system event.",
      rulesFired: [
        "Rule-Fintech-AuditLog-Mandatory: PCI-DSS Requirement 10 mandates an immutable audit trail for systems adjacent to cardholder data.",
      ],
      reasoning:
        "Mandatory for fintech: PCI-DSS Requirement 10 requires tracking and monitoring all access to network resources and cardholder data via an audit trail that cannot be altered or deleted after the fact.",
    });
    rulesTrace.push("Rule-Fintech-AuditLog-Mandatory");
    connections.push({ from: "compute", to: "audit-log", protocol: "HTTPS" });

    if (industryContext.flags.handlesCardDataDirectly) {
      components.push({
        id: "tokenization",
        name: "Tokenization Layer",
        type: "tokenization",
        description: "Intercepts and tokenizes raw cardholder data before it reaches application compute or storage.",
        rulesFired: [
          "Rule-Fintech-Tokenization-DirectCardHandling: Direct card data handling requires tokenization to minimize PCI-DSS scope.",
        ],
        reasoning:
          "Fired because the project handles card data directly rather than through a processor. Tokenizing card data at the edge means the raw PAN (Primary Account Number) never touches application servers or the primary database, which dramatically shrinks the PCI-DSS compliance scope of the rest of the system.",
      });
      rulesTrace.push("Rule-Fintech-Tokenization-DirectCardHandling");
      connections.push({ from: "compute", to: "tokenization", protocol: "HTTPS" });
      connections.push({ from: "tokenization", to: "audit-log", protocol: "HTTPS" });
    } else {
      risks.push(
        "Card data is handled via a third-party processor, not directly — full PCI-DSS scope still applies to any system that touches processor tokens, webhooks, or redirect flows. Verify the processor's SAQ (Self-Assessment Questionnaire) level covers this integration."
      );
    }
  }

  if (industryContext.industry === "healthtech") {
    // Mandatory: immutable audit log, same rationale as fintech but under HIPAA.
    components.push({
      id: "audit-log",
      name: "Audit Log Store",
      type: "audit-log",
      description: "Immutable, append-only store for every access event to systems containing PHI.",
      rulesFired: [
        "Rule-Healthtech-AuditLog-Mandatory: HIPAA's Security Rule (45 CFR 164.312(b)) requires audit controls recording activity in systems that contain or use PHI.",
      ],
      reasoning:
        "Mandatory for healthtech: HIPAA's Security Rule requires hardware, software, and procedural mechanisms that record and examine activity in any system containing Protected Health Information.",
    });
    rulesTrace.push("Rule-Healthtech-AuditLog-Mandatory");
    connections.push({ from: "compute", to: "audit-log", protocol: "HTTPS" });

    if (industryContext.flags.storesPHI) {
      components.push({
        id: "phi-vault",
        name: "PHI Data Vault",
        type: "phi-vault",
        description: "Dedicated, encrypted storage for Protected Health Information, isolated from general application data.",
        rulesFired: [
          "Rule-Healthtech-PHIVault-Mandatory: Storing PHI requires a dedicated, access-logged, encrypted data store under HIPAA's Security Rule.",
        ],
        reasoning:
          "Fired because the project stores or processes Protected Health Information. HIPAA requires PHI to be encrypted at rest and in transit with strict, logged access controls — isolating it into a dedicated vault rather than the general database keeps the compliance boundary small and auditable instead of spreading PHI obligations across the whole data layer.",
      });
      rulesTrace.push("Rule-Healthtech-PHIVault-Mandatory");
      connections.push({ from: "compute", to: "phi-vault", protocol: "HTTPS" });
      connections.push({ from: "phi-vault", to: "audit-log", protocol: "HTTPS" });

      const funcStr = functional.join(" ").toLowerCase();
      const mentionsAnalytics =
        funcStr.includes("analytic") || funcStr.includes("dashboard") || funcStr.includes("report");
      if (mentionsAnalytics) {
        components.push({
          id: "deidentification",
          name: "De-identification Pipeline",
          type: "deidentification",
          description: "Strips or masks the 18 HIPAA-defined identifiers from PHI before it is used for analytics or reporting.",
          rulesFired: [
            "Rule-Healthtech-Deidentification-Analytics: Analytics/reporting functionality combined with PHI requires a de-identification step before data leaves the compliance boundary.",
          ],
          reasoning:
            "Suggested because the product includes analytics, dashboard, or reporting functionality alongside PHI storage. Running analytics directly on identifiable PHI would expand the HIPAA compliance boundary to every downstream system that touches those results; de-identifying first (per the Safe Harbor method) lets analytics run on data that is no longer regulated as PHI.",
        });
        rulesTrace.push("Rule-Healthtech-Deidentification-Analytics");
        connections.push({ from: "phi-vault", to: "deidentification", protocol: "Batch/ETL" });
      }
    } else {
      risks.push(
        "Healthtech project detected but PHI storage was not confirmed — if any patient-identifiable clinical data is later stored, HIPAA's Security and Privacy Rules apply in full and this architecture should be re-evaluated with storesPHI enabled."
      );
    }

    const residency = industryContext.flags.dataResidency;
    if (residency && residency !== "not_specified") {
      rulesTrace.push("Rule-Healthtech-DataResidency-Flagged");
      risks.push(
        `Data residency was specified as "${residency}". Any multi-region replication or cross-border backup/CDN configuration must keep PHI within this jurisdiction — verify each selected cloud region and any managed service's underlying data location before deployment.`
      );
    }
  }

  return { components, connections, rulesTrace, risks };
}
