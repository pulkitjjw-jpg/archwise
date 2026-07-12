"""Deterministic security-posture audit (Workstream T4) -- same pattern as rules_engine.py/
lld_rules.py/industry_rules.py: plain Python pattern-matching over the already-generated
components/connections/LLD config, never an LLM guess. Findings feed both the "Security Findings"
UI section and the security dimension of the Architecture Health Score (Workstream T3).

Every LLD config value is a free-text string (see lld_rules.py), and key NAMES vary by component
type (e.g. "encryptionAtRest" for phi-vault, "encryptionAlgorithm" for storage, "encryptionType"
only on non-relational databases) -- there is no universal boolean "encrypted" field anywhere in
the data model. Checks below match against the real keys each component type actually gets,
confirmed against lld_rules.py, not guessed.
"""

HIGH = "high"
MEDIUM = "medium"
LOW = "low"

# Component types industry_rules.py can add for PCI/HIPAA-style compliance -- referenced here to
# decide whether "no audit-log component" etc. is actually a gap, not just absent-by-design.
_SENSITIVE_DATA_TYPES = ("phi-vault", "tokenization")
_DATA_STORE_TYPES = ("database", "storage", "cache")
_PUBLIC_ENTRY_TYPES = ("cdn",)


def _find(components: list[dict], component_type: str) -> list[dict]:
    return [c for c in components if c.get("type") == component_type]


def _lld_config(component: dict, provider: str) -> dict:
    mapping = (component.get("cloudMappings") or {}).get(provider) or {}
    return (mapping.get("lld") or {}).get("config") or {}


def _finding(severity: str, title: str, description: str, component: dict | None, recommendation: str) -> dict:
    return {
        "severity": severity,
        "title": title,
        "description": description,
        "componentId": component.get("id") if component else None,
        "componentName": component.get("name") if component else None,
        "recommendation": recommendation,
    }


def run_security_rules(components: list[dict], connections: list[dict], industry_context: dict, provider: str) -> list[dict]:
    findings: list[dict] = []
    by_id = {c["id"]: c for c in components if "id" in c}
    industry = (industry_context or {}).get("industry", "none")

    # 1. Missing encryption at rest -- key name varies by component type, matched against the
    #    actual keys lld_rules.py sets for each (see module docstring).
    for c in _find(components, "database"):
        config = _lld_config(c, provider)
        has_encryption_signal = "encryptionType" in config or "encryptionInTransit" in config
        if not has_encryption_signal:
            findings.append(
                _finding(
                    MEDIUM,
                    "Database has no explicit encryption configuration recorded",
                    f'"{c.get("name", c["id"])}" has no encryption-at-rest or in-transit setting recorded in its '
                    "configuration for this provider. The underlying managed service may default to encryption, "
                    "but this design doesn't record it explicitly.",
                    c,
                    "Explicitly enable encryption at rest (e.g. a customer-managed key) and enforce TLS for connections.",
                )
            )
    for c in _find(components, "cache"):
        config = _lld_config(c, provider)
        if "encryptionInTransit" not in config:
            findings.append(
                _finding(
                    LOW,
                    "Cache layer has no encryption configuration recorded",
                    f'"{c.get("name", c["id"])}" has no in-transit encryption setting recorded. Cached data is '
                    "often considered lower-risk than primary storage, but this depends on what's cached.",
                    c,
                    "Enable in-transit encryption for the cache if it may ever hold sensitive or session data.",
                )
            )

    # 2. Missing network segmentation -- inferred from topology, since no component/connection
    #    field for public/private tier exists anywhere in this data model (confirmed: only type +
    #    connections are available). Mirrors the existing bypass-check style in validation.py.
    for conn in connections:
        from_c = by_id.get(conn.get("from"))
        to_c = by_id.get(conn.get("to"))
        if not from_c or not to_c:
            continue
        if from_c.get("type") in _PUBLIC_ENTRY_TYPES and to_c.get("type") in (*_DATA_STORE_TYPES, *_SENSITIVE_DATA_TYPES, "audit-log"):
            findings.append(
                _finding(
                    HIGH,
                    "Public-facing component connects directly to a data store",
                    f'"{from_c.get("name", from_c["id"])}" (public-facing) connects directly to '
                    f'"{to_c.get("name", to_c["id"])}" with no compute/application layer in between, bypassing '
                    "normal request validation and network segmentation.",
                    to_c,
                    "Route this connection through an application/compute layer instead of exposing the data store directly.",
                )
            )

    # 3. Overly permissive access patterns -- inferred from the auth component's own LLD config,
    #    and from the absence of an auth component at all when data stores exist.
    auth_components = _find(components, "auth")
    has_data_store = bool(_find(components, "database") or _find(components, "storage"))
    if has_data_store and not auth_components:
        findings.append(
            _finding(
                HIGH,
                "No authentication layer guarding stored data",
                "This design stores data (database/storage) but has no dedicated authentication component in the "
                "architecture, so nothing here establishes who is allowed to access it.",
                None,
                "Add an authentication/identity component and route data access through it.",
            )
        )
    handles_sensitive = bool(_find(components, "phi-vault") or _find(components, "tokenization"))
    for c in auth_components:
        config = _lld_config(c, provider)
        if handles_sensitive and config.get("mfaRequired", "").lower().startswith("false"):
            findings.append(
                _finding(
                    MEDIUM,
                    "Multi-factor authentication is not required",
                    f'"{c.get("name", c["id"])}" does not require MFA, despite this design handling sensitive '
                    "data (PHI or payment card data).",
                    c,
                    "Require MFA for any account that can access PHI or cardholder data.",
                )
            )
        if config.get("selfSignUpEnabled", "").lower().startswith("true") and handles_sensitive:
            findings.append(
                _finding(
                    MEDIUM,
                    "Unrestricted self-service sign-up on a sensitive-data system",
                    f'"{c.get("name", c["id"])}" allows open self-service sign-up while this design handles '
                    "sensitive data, with no indication of an approval or verification step.",
                    c,
                    "Gate sign-up behind an approval step, invite-only flow, or additional verification for sensitive systems.",
                )
            )

    # 4. Missing audit logging -- industry-gated: audit-log is only ever added by industry_rules
    #    for fintech/healthtech, so its absence there (or wherever sensitive data is handled) is a
    #    real gap, not a false positive on a plain non-industry project.
    has_audit_log = bool(_find(components, "audit-log"))
    if not has_audit_log and (industry in ("fintech", "healthtech") or handles_sensitive):
        findings.append(
            _finding(
                HIGH,
                "No audit logging component",
                "This design handles regulated or sensitive data but has no audit-log component recording who "
                "accessed or changed it -- a common compliance requirement (e.g. PCI-DSS, HIPAA).",
                None,
                "Add an immutable audit-logging component covering access to sensitive data and admin actions.",
            )
        )

    # 5. Missing backup/DR -- database redundancy signal from LLD config (multiAZ / backupRetention).
    for c in _find(components, "database"):
        config = _lld_config(c, provider)
        multi_az = config.get("multiAZ", "")
        if multi_az.lower().startswith("false"):
            findings.append(
                _finding(
                    MEDIUM,
                    "Database has no automatic failover configured",
                    f'"{c.get("name", c["id"])}" is configured as a single node with no standby/failover, making '
                    "it a single point of failure.",
                    c,
                    "Enable a multi-AZ/standby configuration so a single node failure doesn't cause an outage.",
                )
            )
        backup_retention = config.get("backupRetention", "")
        if backup_retention and backup_retention.strip().startswith(("0", "None", "none")):
            findings.append(
                _finding(
                    MEDIUM,
                    "Database backup retention is effectively disabled",
                    f'"{c.get("name", c["id"])}" has a backup retention period of "{backup_retention}".',
                    c,
                    "Set a backup retention period appropriate for recovery requirements (commonly 7-30+ days).",
                )
            )

    return findings
