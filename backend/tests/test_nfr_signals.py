"""Pure-function tests for app/services/nfr_signals.py -- no DB access needed, these are plain
Python functions. See conftest.py's autouse session fixtures for why postgres/redis still need to
be reachable when the suite runs (they're set up once for the whole session regardless of which
test files are collected)."""

import pytest

from app.services.nfr_signals import is_budget_tight, is_high_scale, parse_budget_amount


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
