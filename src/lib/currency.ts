// Workstream Z2 -- currency handling for budget/cost fields. The backend's budget-tier rules
// (backend/app/services/rules_engine.py's is_budget_tight) do crude keyword/digit-substring
// matching on the raw budget string (e.g. checking "50", "low", "tight" appear in it) -- that
// contract is unchanged here on purpose, out of scope for this workstream. Every budget value
// this app persists is still just a string; what's new is that the string is now ALWAYS built
// from a real number + currency the user picked, converted to a canonical USD figure, instead of
// arbitrary free text.

export type CurrencyCode = "USD" | "INR";

export const CURRENCIES: { code: CurrencyCode; symbol: string; label: string }[] = [
  { code: "USD", symbol: "$", label: "USD" },
  { code: "INR", symbol: "₹", label: "INR" },
];

// Fixed illustrative rate, not a live feed -- explicitly allowed ("a simple hardcoded/config-
// based rate is fine for now, doesn't need a live FX API"). Update this constant if it drifts
// too far from reality; there is no live-refresh mechanism.
const USD_PER_INR = 1 / 83;

export function toUsd(amount: number, currency: CurrencyCode): number {
  if (currency === "USD") return amount;
  return amount * USD_PER_INR;
}

export function formatCurrency(amount: number, currency: CurrencyCode): string {
  const symbol = CURRENCIES.find((c) => c.code === currency)!.symbol;
  const rounded = Math.round(amount).toLocaleString("en-US");
  return `${symbol}${rounded}`;
}

/**
 * Builds the canonical string actually persisted as nonFunctional.budget -- always USD-first (so
 * the backend's existing digit-substring budget-tier heuristic keeps working unchanged), with the
 * originally-entered currency/amount appended when it wasn't already USD, so neither side of what
 * the user actually typed is silently discarded.
 */
export function buildBudgetString(amount: number, currency: CurrencyCode): string {
  const usd = toUsd(amount, currency);
  const usdString = `${formatCurrency(usd, "USD")}/month`;
  if (currency === "USD") return usdString;
  return `${usdString} (entered as ${formatCurrency(amount, currency)}/month ${currency})`;
}

/**
 * Best-effort parse of an EXISTING budget string back into an amount + currency, so the
 * structured input has something sensible to start from -- either old free text, LLM-generated
 * prose like "~$2,000/month" from the discovery conversation, or this component's OWN previous
 * output (see buildBudgetString). That last case needs care: a non-USD string looks like
 * "$500/month (entered as ₹41,500/month INR)" -- TWO numbers, USD-converted first. A naive
 * "first number in the string" match would grab the converted 500 instead of the 41,500 the user
 * actually typed, silently corrupting the amount every time the field is re-opened for editing.
 * The number following "entered as" (this function's own round-trip marker) always wins when
 * present; only a plain, single-currency string (or free text) falls back to the first number.
 * Returns null when no number can be found at all -- callers should fall back to showing the raw
 * text and an empty input rather than guessing a number that was never there.
 */
export function parseBudgetString(raw: string): { amount: number; currency: CurrencyCode } | null {
  if (!raw) return null;
  const cleaned = raw.replace(/,/g, "");
  const isInr = /₹|inr|rs\.?\s?\d/i.test(cleaned);

  const enteredAsMatch = cleaned.match(/entered as[^\d]*(\d+(\.\d+)?)/i);
  const match = enteredAsMatch ?? cleaned.match(/(\d+(\.\d+)?)/);
  if (!match) return null;

  const amount = parseFloat(match[1]);
  if (!Number.isFinite(amount)) return null;
  return { amount, currency: isInr ? "INR" : "USD" };
}
