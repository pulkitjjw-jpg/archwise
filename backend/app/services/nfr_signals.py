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


# Free-text phrases that, if present anywhere in the NFR data, are treated as an explicit
# business-continuity signal regardless of scale/compliance -- the same lowercased-substring
# convention rules_engine.py already uses for needs_auth/needs_notification/etc. on free-text
# requirements.
_EXPLICIT_DR_PHRASES = (
    "cannot afford downtime",
    "can't afford downtime",
    "business continuity",
    "disaster recovery",
    "99.99%",
    "always available",
)


def determine_dr_strategy(nfr: dict, industry_context: dict | None) -> str:
    """Real judgment call, not a hardcoded default: decides whether this architecture's disaster-
    recovery posture should be "none", "pilot-light", or "warm-standby" (Phase 5 -- deliberately
    NOT Backup & Restore, too passive to be architecturally interesting and already partially
    covered by backup-retention LLD config, and NOT Active-Active, disproportionate multi-master
    complexity for this app's scope -- see the task's own scope note).

    The two inputs that matter:
      - is_high_scale (via the shared nfr_signals.is_high_scale signal): a high-traffic system has
        more to lose (in absolute terms) from an extended regional outage.
      - is_regulated: high-security/compliance NFR text (gdpr/hipaa/pci/secure/audit/encrypt --
        the identical substring check cloud_mapping.py/lld_rules.py already each recompute
        locally as "_is_high_security"/"is_high_security") OR a fintech/healthtech
        industry_context -- the same "industry is close to a baseline expectation, not just scale"
        reasoning lld_rules.py's own _waf_lld_config already applies to WAF enablement.

    Decision:
      - "warm-standby": is_high_scale AND is_regulated (a regulated system that's also high-scale
        genuinely cannot afford extended downtime -- the two signals compounding is what justifies
        paying for standing secondary-region capacity), OR the NFR data explicitly says so via
        _EXPLICIT_DR_PHRASES (a stated business-continuity requirement overrides the scale/
        compliance heuristic entirely, the same way explicit functional-text signals override
        heuristics elsewhere in this codebase).
      - "pilot-light": is_high_scale OR is_regulated alone (one signal, not both) -- worth a
        minimal-cost warm-able secondary footprint, not worth standing capacity.
      - "none": otherwise -- a generic project's architecture is completely unaffected, matching
        every prior phase's "additive, never changes generic-project behavior" precedent.

    `nfr` is the `nonFunctional` sub-dict (same shape every other function in this module takes),
    not the full requirements dict -- explicit-phrase matching scans every string value in `nfr`
    (budget/teamMaturity/compliance/dataNature/latencySensitivity/expectedScale/readWritePattern),
    since a business-continuity requirement could plausibly be phrased under any of those free-text
    fields, not just "compliance"."""
    high_scale = is_high_scale(nfr.get("expectedScale", ""))

    compliance_lower = (nfr.get("compliance") or "").lower()
    is_high_security = (
        "gdpr" in compliance_lower
        or "hipaa" in compliance_lower
        or "pci" in compliance_lower
        or "secure" in compliance_lower
        or "audit" in compliance_lower
        or "encrypt" in compliance_lower
    )
    industry = (industry_context or {}).get("industry", "none")
    is_regulated = is_high_security or industry in ("fintech", "healthtech")

    nfr_text = " ".join(str(v) for v in nfr.values() if isinstance(v, str)).lower()
    explicit_signal = any(phrase in nfr_text for phrase in _EXPLICIT_DR_PHRASES)

    if (high_scale and is_regulated) or explicit_signal:
        return "warm-standby"
    if high_scale or is_regulated:
        return "pilot-light"
    return "none"


# Free-text phrases that, if present anywhere in the NFR data, are treated as an explicit request
# for per-environment cloud-account isolation -- the same lowercased-substring convention
# _EXPLICIT_DR_PHRASES already uses. Deliberately excludes a bare "account" (far too common a word
# in unrelated contexts, e.g. "user account", "admin account") -- every phrase here is specific
# enough to actually mean "separate cloud accounts/subscriptions/projects per environment," not
# just "this product has user accounts."
_EXPLICIT_ACCOUNT_PHRASES = (
    "separate accounts",
    "separate aws accounts",
    "multi-account",
    "multiple aws accounts",
    "multiple accounts",
    "account isolation",
    "aws organizations",
    "separate environments",
)

# Free-text phrases in `teamMaturity` that indicate a team large/mature enough to actually operate
# multiple cloud accounts/subscriptions/projects well -- running N accounts multiplies IAM,
# billing, and CI/CD-identity surface area in a way a solo/small team has neither the headcount nor
# the process maturity to manage. Word-based substring checks on free text, deliberately not the
# kind of bare-digit-substring check nfr_signals.py's own module docstring already fixed elsewhere
# (is_budget_tight) -- there's no numeric field here to misparse, so a substring check is fine as
# long as the phrases themselves are specific words/phrases, not digits.
_MULTI_ACCOUNT_TEAM_PHRASES = (
    "enterprise",
    "platform team",
    "multiple teams",
    "large organization",
    "large org",
    "mature",
)


def determine_account_strategy(nfr: dict, industry_context: dict | None) -> str:
    """Real judgment call, not a hardcoded default: decides whether this architecture should be
    modeled as deployed into a SINGLE shared cloud account, or deployed independently N times (once
    per environment -- dev/staging/prod) into SEPARATE cloud accounts/subscriptions/projects
    (Phase 7 -- deliberately the narrower "environment separation" pattern only, NOT a full AWS-
    Organizations/Landing-Zone governance model with a management account, security/log-archive
    account, and SCPs -- see this phase's own scope note for why that heavier pattern was
    explicitly not chosen here).

    The two inputs that matter:
      - explicit_signal: the NFR data explicitly says so via _EXPLICIT_ACCOUNT_PHRASES -- a stated
        requirement overrides the heuristic entirely, the same way determine_dr_strategy's own
        _EXPLICIT_DR_PHRASES check does.
      - team_signal AND is_high_scale (via the shared nfr_signals.is_high_scale signal), compounding
        together: a team assessed as large/mature enough to operate multiple accounts (see
        _MULTI_ACCOUNT_TEAM_PHRASES) is a necessary but not sufficient signal on its own -- a small
        team loosely described as "mature" running a genuinely low-scale project doesn't need the
        real operational overhead of managing N accounts, and a high-scale project with no team-
        maturity signal at all doesn't have the demonstrated headcount/process to operate them
        well either. Both signals compounding is what justifies paying that overhead, mirroring
        determine_dr_strategy's own "two moderate signals compounding" shape.

    Decision:
      - "multi-account": explicit_signal alone, OR (team_signal AND is_high_scale) together.
      - "single-account": otherwise -- a generic project's architecture is completely unaffected,
        matching every prior phase's "additive, never changes generic-project behavior" precedent.

    `nfr` is the `nonFunctional` sub-dict (same shape every other function in this module takes),
    not the full requirements dict -- explicit-phrase matching scans every string value in `nfr`,
    since a multi-account requirement could plausibly be phrased under any free-text field, not
    just `teamMaturity`.

    `industry_context` is accepted (and required by this function's signature) purely for
    parameter symmetry with determine_dr_strategy and this module's other NFR-signal functions --
    it is NOT used in the decision itself. Unlike DR posture, account separation is an
    organizational/operational-maturity question, not a compliance one: a regulated industry alone
    doesn't imply a team is staffed and ready to actually operate multiple cloud accounts, so
    folding fintech/healthtech into this heuristic the way determine_dr_strategy folds it into
    is_regulated would be a false signal here."""
    nfr_text = " ".join(str(v) for v in nfr.values() if isinstance(v, str)).lower()
    explicit_signal = any(phrase in nfr_text for phrase in _EXPLICIT_ACCOUNT_PHRASES)

    team_lower = (nfr.get("teamMaturity") or "").lower()
    team_signal = any(phrase in team_lower for phrase in _MULTI_ACCOUNT_TEAM_PHRASES)

    high_scale = is_high_scale(nfr.get("expectedScale", ""))

    if explicit_signal or (team_signal and high_scale):
        return "multi-account"
    return "single-account"
