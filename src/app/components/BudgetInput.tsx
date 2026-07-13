"use client";

import { useState } from "react";
import NumericInput from "./NumericInput";
import { CURRENCIES, buildBudgetString, parseBudgetString, toUsd, formatCurrency, type CurrencyCode } from "@/lib/currency";

interface BudgetInputProps {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  className?: string;
}

/**
 * Amount + currency picker for any budget/cost field (Workstream Z2) -- replaces a plain free-text
 * input with a real number (validated via NumericInput) and a currency selector (USD/INR today).
 * Converts to a canonical USD-denominated string on every change (see buildBudgetString) so the
 * backend's existing budget-tier heuristic, which does crude digit/keyword matching on this string,
 * keeps working unchanged; the originally-entered currency and amount are preserved in that same
 * string rather than silently discarded, and the USD equivalent is always shown inline so a
 * converted number is never displayed without saying so.
 */
export default function BudgetInput({ value, onChange, id, className = "" }: BudgetInputProps) {
  // Seeded ONLY from the initial value at mount -- amount/currency are then the sole source of
  // truth for what's displayed, never re-derived from the `value` prop again. This component is
  // only ever rendered while its parent's edit mode is active, which naturally unmounts/remounts
  // it (fresh useState seed) whenever the user re-enters editing, so there's no separate "resync
  // on external change" case to handle. A live resync WOULD be actively wrong here: `value`
  // itself changes on every keystroke (each edit calls onChange -> parent state -> new value
  // prop), and parseBudgetString(buildBudgetString(...)) doesn't round-trip byte-for-byte (it
  // returns the USD-converted figure, not the original entered amount) -- re-deriving from it on
  // every render would fight the user's own typing.
  const parsed = parseBudgetString(value);
  const [amount, setAmount] = useState(parsed ? String(parsed.amount) : "");
  const [currency, setCurrency] = useState<CurrencyCode>(parsed?.currency ?? "USD");
  const [unparsedOriginal] = useState(parsed ? null : value || null);

  const emit = (nextAmount: string, nextCurrency: CurrencyCode) => {
    const numeric = parseFloat(nextAmount);
    if (nextAmount.trim() === "" || !Number.isFinite(numeric)) {
      onChange("");
      return;
    }
    onChange(buildBudgetString(numeric, nextCurrency));
  };

  const numericAmount = parseFloat(amount);
  const showUsdHint = currency !== "USD" && Number.isFinite(numericAmount) && amount.trim() !== "";

  return (
    <div className={className}>
      {unparsedOriginal && amount === "" && (
        <p className="mb-1.5 text-[11px] italic text-ink-faint">
          Current value: &ldquo;{unparsedOriginal}&rdquo; — enter an amount below to replace it.
        </p>
      )}
      <div className="flex gap-2">
        <NumericInput
          id={id}
          value={amount}
          onChange={(next) => {
            setAmount(next);
            emit(next, currency);
          }}
          placeholder="Amount"
          maxLength={12}
          className="w-full rounded-xl border border-line bg-white px-3 py-2 text-xs text-ink shadow-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent transition-all duration-200"
        />
        <select
          value={currency}
          onChange={(e) => {
            const next = e.target.value as CurrencyCode;
            setCurrency(next);
            emit(amount, next);
          }}
          className="shrink-0 rounded-xl border border-line bg-white px-2 py-2 text-xs text-ink shadow-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        >
          {CURRENCIES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
      {showUsdHint && (
        <p className="mt-1 text-[11px] text-ink-faint">
          ≈ {formatCurrency(toUsd(numericAmount, currency), "USD")}/month USD — all cost estimates use this figure.
        </p>
      )}
    </div>
  );
}
