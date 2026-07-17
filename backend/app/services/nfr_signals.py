"""Shared NFR (non-functional requirement) signal parsing, used by rules_engine.py,
cloud_mapping.py, and lld_rules.py so the "is this budget tight?" / "is this high scale?"
decisions are computed identically everywhere -- a single source of truth, matching the existing
precedent of rules_engine.py's is_relational_data_nature.

This module replaces a previously-duplicated (and buggy) inline check in all three files:

    is_budget_tight = "low" in budget_lower or "50" in budget_lower or "10" in budget_lower or "tight" in budget_lower

Bare digit-substring matching like `"50" in budget_lower` means a well-funded budget such as
"$50,000/month" or "$10,000/month" gets misclassified as tight purely because the digits "50" or
"10" happen to appear somewhere in the string -- steering the architecture toward
serverless/minimal-instance recommendations that are wrong for a well-funded client. The fix:
actually parse the numeric figure out of the string and judge tightness by the number, falling
back to keyword matching only when nothing numeric can be parsed.
"""

import re


def parse_budget_amount(budget_str: str) -> float | None:
    """Extracts the actual monthly dollar figure from a free-text budget string.

    Handles:
      - "$500/month", "$50,000 per month" -> the single figure.
      - "k"/"K" shorthand for thousands: "$10-50k" -> 50000 (upper bound of the range * 1000).
      - Ranges ("$500-2,000/month", "$10-50k"): the UPPER bound is used, since that's the more
        conservative signal for "is this actually tight" -- a range's ceiling is what the project
        might really spend.
      - "under $100": a single figure, no range separator, used directly.
      - "not_specified", "", or text with no digits at all: returns None.

    Returns None if no numeric figure can be extracted at all.
    """
    if not budget_str:
        return None

    text = budget_str.strip().lower()
    if text in ("", "not_specified", "not specified", "unspecified", "n/a", "none"):
        return None

    # Find every "<number><optional k suffix>" token in the string, e.g. "500", "2,000", "50k".
    # Commas inside the number are stripped before parsing; a trailing k/K multiplies by 1000.
    matches = re.findall(r"(\d[\d,]*(?:\.\d+)?)\s*(k)?", text)
    amounts: list[float] = []
    for number_part, k_suffix in matches:
        cleaned = number_part.replace(",", "")
        if not cleaned:
            continue
        try:
            amount = float(cleaned)
        except ValueError:
            continue
        if k_suffix:
            amount *= 1000
        amounts.append(amount)

    if not amounts:
        return None

    # Upper bound of any range (or the only figure found, if there's just one) -- the more
    # conservative reading of "how much could this actually cost."
    return max(amounts)


# Thresholds are monthly USD cloud spend. Under ~$300/month is genuinely tight for a real
# production cloud deployment (barely covers a small managed DB + a couple of always-on compute
# instances once you add a load balancer); $300-500/month is a defensible fuzzy boundary for
# solo/hobby-scale projects. Anything at or above that -- and certainly anything in the
# thousands/tens-of-thousands, like "$10,000/month" or "$50,000/month" -- is NOT a tight budget,
# regardless of what digits happen to appear in the string.
_TIGHT_BUDGET_THRESHOLD_USD = 300.0

# Fallback keywords used ONLY when no numeric figure could be parsed at all (e.g. "low budget",
# "shoestring", "not_specified"). Deliberately excludes bare digit substrings like "50"/"10"/"30"
# -- that substring-matching is exactly the bug this module fixes.
_TIGHT_BUDGET_KEYWORDS = ("low", "tight", "minimal", "shoestring", "not_specified")


def is_budget_tight(budget_str: str) -> bool:
    """Primary path: if a numeric dollar figure can be parsed out of the string, judge tightness
    by that number against _TIGHT_BUDGET_THRESHOLD_USD. This is what correctly distinguishes
    "$50,000/month" (not tight) from "$50/month" (tight) even though both contain the digits "50".

    Fallback path: if nothing numeric parses (e.g. "low budget", "tight", "not_specified", or
    other non-numeric free text), fall back to keyword matching -- but never on bare digit
    substrings.
    """
    amount = parse_budget_amount(budget_str)
    if amount is not None:
        return amount < _TIGHT_BUDGET_THRESHOLD_USD

    budget_lower = (budget_str or "").strip().lower()
    return any(keyword in budget_lower for keyword in _TIGHT_BUDGET_KEYWORDS)


def is_high_scale(scale_str: str) -> bool:
    """Consolidates the scale-detection logic previously duplicated across rules_engine.py,
    cloud_mapping.py, and lld_rules.py. Behavior is intentionally unchanged from the original
    inline checks -- this is a pure dedup, not a fix (no equally clear bug was spotted here; see
    the accompanying report for a note on its remaining crudeness)."""
    scale_lower = (scale_str or "").lower()
    return (
        "high" in scale_lower
        or "million" in scale_lower
        or "100,000" in scale_lower
        or "10k" in scale_lower
        or "50k" in scale_lower
    )
