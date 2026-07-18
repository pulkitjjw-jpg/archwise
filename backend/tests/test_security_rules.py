"""Tests for app/services/security_rules.py's run_security_rules -- pure function, no DB access.
One test per finding category, plus a "clean" architecture producing zero findings."""

from app.services.security_rules import run_security_rules

PROVIDER = "aws"


def component(component_id: str, comp_type: str, name: str | None = None, *, lld_config: dict | None = None) -> dict:
    c: dict = {"id": component_id, "type": comp_type, "name": name or component_id}
    if lld_config is not None:
        c["cloudMappings"] = {PROVIDER: {"lld": {"config": lld_config}}}
    return c


def conn(from_: str, to: str) -> dict:
    return {"from": from_, "to": to}


NONE_INDUSTRY = {"industry": "none"}


def _titles(findings: list[dict]) -> set[str]:
    return {f["title"] for f in findings}


class TestMissingDatabaseEncryptionSignal:
    def test_fires_when_no_encryption_key_in_config(self):
        components = [component("db", "database", lld_config={"instanceClass": "db.t4g.micro"})]
        findings = run_security_rules(components, [], NONE_INDUSTRY, PROVIDER)
        assert "Database has no explicit encryption configuration recorded" in _titles(findings)

    def test_does_not_fire_when_encryption_type_present(self):
        components = [component("db", "database", lld_config={"encryptionType": "AWS KMS Managed Encryption"})]
        findings = run_security_rules(components, [], NONE_INDUSTRY, PROVIDER)
        assert "Database has no explicit encryption configuration recorded" not in _titles(findings)


class TestPublicComponentDirectToDataStore:
    def test_fires_when_cdn_connects_directly_to_database(self):
        components = [
            component("cdn", "cdn", lld_config={}),
            component("db", "database", lld_config={"encryptionType": "x", "multiAZ": "true", "backupRetention": "7 Days"}),
        ]
        findings = run_security_rules(components, [conn("cdn", "db")], NONE_INDUSTRY, PROVIDER)
        assert "Public-facing component connects directly to a data store" in _titles(findings)

    def test_does_not_fire_when_compute_sits_between_cdn_and_database(self):
        components = [
            component("cdn", "cdn", lld_config={}),
            component("compute", "compute", lld_config={}),
            component("db", "database", lld_config={"encryptionType": "x", "multiAZ": "true", "backupRetention": "7 Days"}),
        ]
        findings = run_security_rules(components, [conn("cdn", "compute"), conn("compute", "db")], NONE_INDUSTRY, PROVIDER)
        assert "Public-facing component connects directly to a data store" not in _titles(findings)

    def test_fires_when_lb_connects_directly_to_database(self):
        """"lb" is a public-facing entry type too (_PUBLIC_ENTRY_TYPES) -- a load balancer wired
        straight to a data store bypasses the application layer exactly like a CDN would."""
        components = [
            component("lb", "lb", lld_config={}),
            component("db", "database", lld_config={"encryptionType": "x", "multiAZ": "true", "backupRetention": "7 Days"}),
        ]
        findings = run_security_rules(components, [conn("lb", "db")], NONE_INDUSTRY, PROVIDER)
        assert "Public-facing component connects directly to a data store" in _titles(findings)

    def test_does_not_fire_when_compute_sits_between_lb_and_database(self):
        components = [
            component("lb", "lb", lld_config={}),
            component("compute", "compute", lld_config={}),
            component("db", "database", lld_config={"encryptionType": "x", "multiAZ": "true", "backupRetention": "7 Days"}),
        ]
        findings = run_security_rules(components, [conn("lb", "compute"), conn("compute", "db")], NONE_INDUSTRY, PROVIDER)
        assert "Public-facing component connects directly to a data store" not in _titles(findings)


class TestMissingAuthWhenDataStoresExist:
    def test_fires_when_database_exists_with_no_auth_component(self):
        components = [component("db", "database", lld_config={"encryptionType": "x", "multiAZ": "true", "backupRetention": "7 Days"})]
        findings = run_security_rules(components, [], NONE_INDUSTRY, PROVIDER)
        assert "No authentication layer guarding stored data" in _titles(findings)

    def test_does_not_fire_when_auth_component_present(self):
        components = [
            component("db", "database", lld_config={"encryptionType": "x", "multiAZ": "true", "backupRetention": "7 Days"}),
            component("auth", "auth", lld_config={"mfaRequired": "true", "selfSignUpEnabled": "false"}),
        ]
        findings = run_security_rules(components, [], NONE_INDUSTRY, PROVIDER)
        assert "No authentication layer guarding stored data" not in _titles(findings)


class TestMissingMfaWhenHandlingSensitiveData:
    def test_fires_when_mfa_not_required_and_phi_vault_present(self):
        components = [
            component("phi", "phi-vault", lld_config={"encryptionAtRest": "x"}),
            component("auth", "auth", lld_config={"mfaRequired": "false", "selfSignUpEnabled": "false"}),
        ]
        findings = run_security_rules(components, [], NONE_INDUSTRY, PROVIDER)
        assert "Multi-factor authentication is not required" in _titles(findings)

    def test_does_not_fire_when_mfa_required(self):
        components = [
            component("phi", "phi-vault", lld_config={"encryptionAtRest": "x"}),
            component("auth", "auth", lld_config={"mfaRequired": "true", "selfSignUpEnabled": "false"}),
        ]
        findings = run_security_rules(components, [], NONE_INDUSTRY, PROVIDER)
        assert "Multi-factor authentication is not required" not in _titles(findings)

    def test_does_not_fire_when_no_sensitive_data_component(self):
        components = [component("auth", "auth", lld_config={"mfaRequired": "false", "selfSignUpEnabled": "false"})]
        findings = run_security_rules(components, [], NONE_INDUSTRY, PROVIDER)
        assert "Multi-factor authentication is not required" not in _titles(findings)


class TestMissingAuditLogForFintechHealthtech:
    def test_fires_for_fintech_with_no_audit_log_component(self):
        components = [component("compute", "compute", lld_config={})]
        findings = run_security_rules(components, [], {"industry": "fintech"}, PROVIDER)
        assert "No audit logging component" in _titles(findings)

    def test_fires_for_healthtech_with_no_audit_log_component(self):
        components = [component("compute", "compute", lld_config={})]
        findings = run_security_rules(components, [], {"industry": "healthtech"}, PROVIDER)
        assert "No audit logging component" in _titles(findings)

    def test_does_not_fire_when_audit_log_component_present(self):
        components = [component("audit-log", "audit-log", lld_config={})]
        findings = run_security_rules(components, [], {"industry": "fintech"}, PROVIDER)
        assert "No audit logging component" not in _titles(findings)

    def test_does_not_fire_for_none_industry_without_sensitive_data(self):
        components = [component("compute", "compute", lld_config={})]
        findings = run_security_rules(components, [], NONE_INDUSTRY, PROVIDER)
        assert "No audit logging component" not in _titles(findings)


class TestMissingMultiAzOrBackupRetention:
    def test_fires_when_multi_az_is_false(self):
        components = [component("db", "database", lld_config={"encryptionType": "x", "multiAZ": "false (Single Node)", "backupRetention": "7 Days"})]
        findings = run_security_rules(components, [], NONE_INDUSTRY, PROVIDER)
        assert "Database has no automatic failover configured" in _titles(findings)

    def test_fires_when_backup_retention_is_zero(self):
        components = [component("db", "database", lld_config={"encryptionType": "x", "multiAZ": "true", "backupRetention": "0 Days"})]
        findings = run_security_rules(components, [], NONE_INDUSTRY, PROVIDER)
        assert "Database backup retention is effectively disabled" in _titles(findings)

    def test_neither_fires_when_multi_az_true_and_backup_retention_set(self):
        components = [component("db", "database", lld_config={"encryptionType": "x", "multiAZ": "true (Primary/Standby)", "backupRetention": "7 Days"})]
        findings = run_security_rules(components, [], NONE_INDUSTRY, PROVIDER)
        assert "Database has no automatic failover configured" not in _titles(findings)
        assert "Database backup retention is effectively disabled" not in _titles(findings)


class TestCleanArchitectureProducesZeroFindings:
    def test_well_configured_none_industry_architecture_has_no_findings(self):
        components = [
            component("compute", "compute", lld_config={}),
            component(
                "db",
                "database",
                lld_config={"encryptionType": "AWS KMS Managed Encryption", "multiAZ": "true (Primary/Standby)", "backupRetention": "7 Days"},
            ),
            component("cache", "cache", lld_config={"encryptionInTransit": "TLS 1.2+"}),
            component("auth", "auth", lld_config={"mfaRequired": "true", "selfSignUpEnabled": "false"}),
        ]
        connections = [conn("compute", "db"), conn("compute", "cache"), conn("compute", "auth")]

        findings = run_security_rules(components, connections, NONE_INDUSTRY, PROVIDER)

        assert findings == []
