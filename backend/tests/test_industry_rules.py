"""Tests for app/services/industry_rules.py's run_industry_rules -- pure function, no DB access."""

from app.services.industry_rules import run_industry_rules


def component_ids(result: dict) -> set[str]:
    return {c["id"] for c in result["components"]}


class TestNoneIndustry:
    def test_none_industry_returns_empty_everything(self):
        result = run_industry_rules({"industry": "none", "flags": {}}, ["Users can sign up"])
        assert result == {"components": [], "connections": [], "rulesTrace": [], "risks": []}


class TestFintech:
    def test_audit_log_is_mandatory_regardless_of_flags(self):
        result = run_industry_rules({"industry": "fintech", "flags": {}}, [])
        assert "audit-log" in component_ids(result)
        assert "Rule-Fintech-AuditLog-Mandatory" in result["rulesTrace"]
        assert {"from": "compute", "to": "audit-log", "protocol": "HTTPS"} in result["connections"]

    def test_tokenization_added_only_when_handles_card_data_directly(self):
        result = run_industry_rules(
            {"industry": "fintech", "flags": {"handlesCardDataDirectly": True}}, []
        )
        assert "tokenization" in component_ids(result)
        assert "Rule-Fintech-Tokenization-DirectCardHandling" in result["rulesTrace"]
        assert {"from": "compute", "to": "tokenization", "protocol": "HTTPS"} in result["connections"]
        assert {"from": "tokenization", "to": "audit-log", "protocol": "HTTPS"} in result["connections"]

    def test_tokenization_absent_and_processor_risk_when_not_handling_card_data_directly(self):
        result = run_industry_rules(
            {"industry": "fintech", "flags": {"handlesCardDataDirectly": False}}, []
        )
        assert "tokenization" not in component_ids(result)
        assert any("third-party processor" in risk for risk in result["risks"])

    def test_processor_risk_also_fires_when_flag_missing(self):
        result = run_industry_rules({"industry": "fintech", "flags": {}}, [])
        assert "tokenization" not in component_ids(result)
        assert len(result["risks"]) == 1


class TestHealthtech:
    def test_audit_log_is_mandatory(self):
        result = run_industry_rules({"industry": "healthtech", "flags": {}}, [])
        assert "audit-log" in component_ids(result)
        assert "Rule-Healthtech-AuditLog-Mandatory" in result["rulesTrace"]

    def test_phi_vault_added_only_when_stores_phi(self):
        result = run_industry_rules({"industry": "healthtech", "flags": {"storesPHI": True}}, [])
        assert "phi-vault" in component_ids(result)
        assert "Rule-Healthtech-PHIVault-Mandatory" in result["rulesTrace"]
        assert {"from": "compute", "to": "phi-vault", "protocol": "HTTPS"} in result["connections"]
        assert {"from": "phi-vault", "to": "audit-log", "protocol": "HTTPS"} in result["connections"]

    def test_phi_vault_absent_and_risk_fires_when_not_storing_phi(self):
        result = run_industry_rules({"industry": "healthtech", "flags": {"storesPHI": False}}, [])
        assert "phi-vault" not in component_ids(result)
        assert any("PHI storage was not confirmed" in risk for risk in result["risks"])

    def test_deidentification_added_when_phi_and_analytics_functional_requirement(self):
        result = run_industry_rules(
            {"industry": "healthtech", "flags": {"storesPHI": True}},
            ["Admins can view an analytics dashboard of patient outcomes"],
        )
        assert "deidentification" in component_ids(result)
        assert "Rule-Healthtech-Deidentification-Analytics" in result["rulesTrace"]
        assert {"from": "phi-vault", "to": "deidentification", "protocol": "Batch/ETL"} in result["connections"]

    def test_deidentification_absent_without_analytics_functional_requirement(self):
        result = run_industry_rules(
            {"industry": "healthtech", "flags": {"storesPHI": True}},
            ["Patients can book an appointment"],
        )
        assert "deidentification" not in component_ids(result)

    def test_deidentification_absent_without_phi_even_with_analytics(self):
        result = run_industry_rules(
            {"industry": "healthtech", "flags": {"storesPHI": False}},
            ["Admins can view an analytics dashboard"],
        )
        assert "deidentification" not in component_ids(result)

    def test_data_residency_risk_message_when_specified(self):
        result = run_industry_rules(
            {"industry": "healthtech", "flags": {"storesPHI": True, "dataResidency": "European Union"}}, []
        )
        assert any("European Union" in risk for risk in result["risks"])
        assert "Rule-Healthtech-DataResidency-Flagged" in result["rulesTrace"]

    def test_no_data_residency_risk_when_not_specified(self):
        result = run_industry_rules(
            {"industry": "healthtech", "flags": {"storesPHI": True, "dataResidency": "not_specified"}}, []
        )
        assert not any("Data residency" in risk for risk in result["risks"])
        assert "Rule-Healthtech-DataResidency-Flagged" not in result["rulesTrace"]
