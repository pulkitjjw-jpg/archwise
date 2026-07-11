def run_industry_rules(industry_context: dict, functional: list[str]) -> dict:
    """Layers industry-specific compliance components and risks on top of the baseline HLD
    produced by rules_engine.py. Never runs in isolation -- always called after
    run_rules_engine() so its connections can reference baseline component ids (e.g. "compute")
    that are guaranteed to exist. A generic (industry == "none") project gets an empty result
    and the rest of the pipeline is unaffected."""
    components: list[dict] = []
    connections: list[dict] = []
    rules_trace: list[str] = []
    risks: list[str] = []

    if industry_context["industry"] == "none":
        return {"components": components, "connections": connections, "rulesTrace": rules_trace, "risks": risks}

    if industry_context["industry"] == "fintech":
        # Mandatory: immutable audit log, regardless of any other flag.
        components.append(
            {
                "id": "audit-log",
                "name": "Audit Log Store",
                "type": "audit-log",
                "description": "Immutable, append-only store for every compliance-relevant system event.",
                "rulesFired": [
                    "Rule-Fintech-AuditLog-Mandatory: PCI-DSS Requirement 10 mandates an immutable audit trail for systems adjacent to cardholder data."
                ],
                "reasoning": "Mandatory for fintech: PCI-DSS Requirement 10 requires tracking and monitoring all access to network resources and cardholder data via an audit trail that cannot be altered or deleted after the fact.",
            }
        )
        rules_trace.append("Rule-Fintech-AuditLog-Mandatory")
        connections.append({"from": "compute", "to": "audit-log", "protocol": "HTTPS"})

        if industry_context["flags"].get("handlesCardDataDirectly"):
            components.append(
                {
                    "id": "tokenization",
                    "name": "Tokenization Layer",
                    "type": "tokenization",
                    "description": "Intercepts and tokenizes raw cardholder data before it reaches application compute or storage.",
                    "rulesFired": [
                        "Rule-Fintech-Tokenization-DirectCardHandling: Direct card data handling requires tokenization to minimize PCI-DSS scope."
                    ],
                    "reasoning": "Fired because the project handles card data directly rather than through a processor. Tokenizing card data at the edge means the raw PAN (Primary Account Number) never touches application servers or the primary database, which dramatically shrinks the PCI-DSS compliance scope of the rest of the system.",
                }
            )
            rules_trace.append("Rule-Fintech-Tokenization-DirectCardHandling")
            connections.append({"from": "compute", "to": "tokenization", "protocol": "HTTPS"})
            connections.append({"from": "tokenization", "to": "audit-log", "protocol": "HTTPS"})
        else:
            risks.append(
                "Card data is handled via a third-party processor, not directly — full PCI-DSS scope still applies to any system that touches processor tokens, webhooks, or redirect flows. Verify the processor's SAQ (Self-Assessment Questionnaire) level covers this integration."
            )

    if industry_context["industry"] == "healthtech":
        # Mandatory: immutable audit log, same rationale as fintech but under HIPAA.
        components.append(
            {
                "id": "audit-log",
                "name": "Audit Log Store",
                "type": "audit-log",
                "description": "Immutable, append-only store for every access event to systems containing PHI.",
                "rulesFired": [
                    "Rule-Healthtech-AuditLog-Mandatory: HIPAA's Security Rule (45 CFR 164.312(b)) requires audit controls recording activity in systems that contain or use PHI."
                ],
                "reasoning": "Mandatory for healthtech: HIPAA's Security Rule requires hardware, software, and procedural mechanisms that record and examine activity in any system containing Protected Health Information.",
            }
        )
        rules_trace.append("Rule-Healthtech-AuditLog-Mandatory")
        connections.append({"from": "compute", "to": "audit-log", "protocol": "HTTPS"})

        if industry_context["flags"].get("storesPHI"):
            components.append(
                {
                    "id": "phi-vault",
                    "name": "PHI Data Vault",
                    "type": "phi-vault",
                    "description": "Dedicated, encrypted storage for Protected Health Information, isolated from general application data.",
                    "rulesFired": [
                        "Rule-Healthtech-PHIVault-Mandatory: Storing PHI requires a dedicated, access-logged, encrypted data store under HIPAA's Security Rule."
                    ],
                    "reasoning": "Fired because the project stores or processes Protected Health Information. HIPAA requires PHI to be encrypted at rest and in transit with strict, logged access controls — isolating it into a dedicated vault rather than the general database keeps the compliance boundary small and auditable instead of spreading PHI obligations across the whole data layer.",
                }
            )
            rules_trace.append("Rule-Healthtech-PHIVault-Mandatory")
            connections.append({"from": "compute", "to": "phi-vault", "protocol": "HTTPS"})
            connections.append({"from": "phi-vault", "to": "audit-log", "protocol": "HTTPS"})

            func_str = " ".join(functional).lower()
            mentions_analytics = (
                "analytic" in func_str or "dashboard" in func_str or "report" in func_str
            )
            if mentions_analytics:
                components.append(
                    {
                        "id": "deidentification",
                        "name": "De-identification Pipeline",
                        "type": "deidentification",
                        "description": "Strips or masks the 18 HIPAA-defined identifiers from PHI before it is used for analytics or reporting.",
                        "rulesFired": [
                            "Rule-Healthtech-Deidentification-Analytics: Analytics/reporting functionality combined with PHI requires a de-identification step before data leaves the compliance boundary."
                        ],
                        "reasoning": "Suggested because the product includes analytics, dashboard, or reporting functionality alongside PHI storage. Running analytics directly on identifiable PHI would expand the HIPAA compliance boundary to every downstream system that touches those results; de-identifying first (per the Safe Harbor method) lets analytics run on data that is no longer regulated as PHI.",
                    }
                )
                rules_trace.append("Rule-Healthtech-Deidentification-Analytics")
                connections.append({"from": "phi-vault", "to": "deidentification", "protocol": "Batch/ETL"})
        else:
            risks.append(
                "Healthtech project detected but PHI storage was not confirmed — if any patient-identifiable clinical data is later stored, HIPAA's Security and Privacy Rules apply in full and this architecture should be re-evaluated with storesPHI enabled."
            )

        residency = industry_context["flags"].get("dataResidency")
        if residency and residency != "not_specified":
            rules_trace.append("Rule-Healthtech-DataResidency-Flagged")
            risks.append(
                f'Data residency was specified as "{residency}". Any multi-region replication or cross-border backup/CDN configuration must keep PHI within this jurisdiction — verify each selected cloud region and any managed service\'s underlying data location before deployment.'
            )

    return {"components": components, "connections": connections, "rulesTrace": rules_trace, "risks": risks}
