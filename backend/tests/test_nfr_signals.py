"""Pure-function tests for app/services/nfr_signals.py -- no DB access needed, these are plain
Python functions. See conftest.py's autouse session fixtures for why postgres/redis still need to
be reachable when the suite runs (they're set up once for the whole session regardless of which
test files are collected)."""

import pytest

from app.services.nfr_signals import determine_dr_strategy, is_budget_tight, is_high_scale, parse_budget_amount


def make_nfr(
    *,
    expectedScale: str = "1,000 users",
    budget: str = "$2,000/month",
    teamMaturity: str = "senior engineers",
    compliance: str = "none",
    dataNature: str = "structured business records",
    readWritePattern: str = "balanced",
    latencySensitivity: str = "medium",
) -> dict:
    return {
        "expectedScale": expectedScale,
        "budget": budget,
        "teamMaturity": teamMaturity,
        "compliance": compliance,
        "dataNature": dataNature,
        "readWritePattern": readWritePattern,
        "latencySensitivity": latencySensitivity,
    }


NONE_INDUSTRY = {"industry": "none"}
FINTECH_INDUSTRY = {"industry": "fintech"}
HEALTHTECH_INDUSTRY = {"industry": "healthtech"}


class TestParseBudgetAmount:
    @pytest.mark.parametrize(
        "budget_str,expected",
        [
            ("$500/month", 500.0),
            ("$50,000 per month", 50000.0),
            ("under $100", 100.0),
            ("$10-50k", 50000.0),  # range -> upper bound, k-suffix -> thousands
            ("not_specified", None),
            ("", None),
            ("tight budget, maybe $50 or so", 50.0),
        ],
    )
    def test_parses_realistic_formats(self, budget_str, expected):
        assert parse_budget_amount(budget_str) == expected

    def test_returns_none_for_pure_text_with_no_digits(self):
        assert parse_budget_amount("low budget") is None
        assert parse_budget_amount("shoestring") is None

    def test_upper_bound_of_a_simple_dollar_range(self):
        assert parse_budget_amount("$500-2,000/month") == 2000.0

    def test_strips_commas_correctly(self):
        assert parse_budget_amount("$1,234,567/month") == 1234567.0


class TestIsBudgetTight:
    # Regression tests: this is the exact bug being fixed. Under the old crude substring check
    # (`"50" in budget_lower or "10" in budget_lower`), both of these large, well-funded budgets
    # were misclassified as "tight" purely because the digits "50"/"10" appear in the string. This
    # test fails against the old logic and must pass against the new one.
    def test_50000_per_month_is_not_tight(self):
        assert is_budget_tight("$50,000/month") is False

    def test_10000_per_month_is_not_tight(self):
        assert is_budget_tight("$10,000/month") is False

    @pytest.mark.parametrize(
        "budget_str",
        [
            "$30/month",
            "not_specified",
            "shoestring budget",
            "low budget",
            "tight",
        ],
    )
    def test_genuinely_tight_budgets_are_tight(self, budget_str):
        assert is_budget_tight(budget_str) is True

    @pytest.mark.parametrize(
        "budget_str",
        [
            "$500/month",
            "$2,000/month",
            "$100,000/month",
            "$50,000/month",
            "$10,000/month",
        ],
    )
    def test_well_funded_budgets_are_not_tight(self, budget_str):
        assert is_budget_tight(budget_str) is False

    def test_empty_string_falls_back_to_keyword_path_and_is_not_tight(self):
        # No digits, no tight-sounding keyword either -- should not be misclassified as tight.
        assert is_budget_tight("") is False


class TestIsHighScale:
    @pytest.mark.parametrize(
        "scale_str",
        [
            "high traffic expected",
            "1 million users",
            "100,000 daily active users",
            "10k requests/sec",
            "50k monthly active users",
        ],
    )
    def test_high_scale_signals(self, scale_str):
        assert is_high_scale(scale_str) is True

    @pytest.mark.parametrize(
        "scale_str",
        [
            "500 users",
            "not_specified",
            "small internal tool",
            "",
        ],
    )
    def test_low_scale_signals(self, scale_str):
        assert is_high_scale(scale_str) is False


class TestDetermineDrStrategy:
    """Phase 5: the exact decision boundary described in determine_dr_strategy's own docstring --
    "warm-standby" needs BOTH is_high_scale AND is_regulated (or an explicit phrase), "pilot-light"
    needs exactly one of the two signals, "none" needs neither."""

    def test_generic_low_scale_unregulated_project_gets_none(self):
        nfr = make_nfr()
        assert determine_dr_strategy(nfr, NONE_INDUSTRY) == "none"

    def test_high_scale_alone_gets_pilot_light(self):
        nfr = make_nfr(expectedScale="high scale, 1 million users")
        assert determine_dr_strategy(nfr, NONE_INDUSTRY) == "pilot-light"

    def test_high_security_compliance_alone_gets_pilot_light(self):
        nfr = make_nfr(compliance="HIPAA required")
        assert determine_dr_strategy(nfr, NONE_INDUSTRY) == "pilot-light"

    def test_fintech_industry_alone_gets_pilot_light(self):
        nfr = make_nfr()
        assert determine_dr_strategy(nfr, FINTECH_INDUSTRY) == "pilot-light"

    def test_healthtech_industry_alone_gets_pilot_light(self):
        nfr = make_nfr()
        assert determine_dr_strategy(nfr, HEALTHTECH_INDUSTRY) == "pilot-light"

    def test_high_scale_and_high_security_together_get_warm_standby(self):
        nfr = make_nfr(expectedScale="high scale, 1 million users", compliance="PCI-DSS required")
        assert determine_dr_strategy(nfr, NONE_INDUSTRY) == "warm-standby"

    def test_high_scale_and_fintech_industry_together_get_warm_standby(self):
        nfr = make_nfr(expectedScale="high scale, 1 million users")
        assert determine_dr_strategy(nfr, FINTECH_INDUSTRY) == "warm-standby"

    @pytest.mark.parametrize(
        "phrase",
        [
            "cannot afford downtime",
            "can't afford downtime",
            "business continuity is critical",
            "needs a disaster recovery plan",
            "must maintain 99.99% uptime",
            "system must be always available, no exceptions",
        ],
    )
    def test_explicit_dr_phrase_forces_warm_standby_even_at_low_scale(self, phrase):
        nfr = make_nfr(expectedScale="500 users", compliance=phrase)
        assert determine_dr_strategy(nfr, NONE_INDUSTRY) == "warm-standby"

    def test_explicit_phrase_can_appear_in_any_nfr_field_not_just_compliance(self):
        nfr = make_nfr(expectedScale="500 users", dataNature="records that cannot afford downtime")
        assert determine_dr_strategy(nfr, NONE_INDUSTRY) == "warm-standby"

    def test_industry_context_none_object_treated_same_as_missing(self):
        nfr = make_nfr()
        assert determine_dr_strategy(nfr, None) == "none"

    def test_none_industry_dict_without_high_scale_or_security_stays_none(self):
        nfr = make_nfr(expectedScale="500 users", compliance="none")
        assert determine_dr_strategy(nfr, {"industry": "none"}) == "none"
