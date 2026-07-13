"use client";

import { useState } from "react";

interface NumericInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  maxLength?: number;
  id?: string;
  allowDecimal?: boolean;
}

const REJECT_MESSAGE_MS = 1800;

/**
 * A numeric-only text input (digits + at most one decimal point) -- rejects any other character
 * at keystroke time (it never lands in the field, matching "numeric fields should reject
 * non-numeric characters") AND surfaces a visible red-border + inline message when a rejection
 * just happened, rather than silently doing nothing (a bare keystroke that produces no visible
 * change reads as a bug, not a validation rule). Workstream Z2.
 */
export default function NumericInput({
  value,
  onChange,
  placeholder,
  className = "",
  maxLength = 15,
  id,
  allowDecimal = true,
}: NumericInputProps) {
  const [rejected, setRejected] = useState(false);

  const handleChange = (raw: string) => {
    const pattern = allowDecimal ? /[^0-9.]/g : /[^0-9]/g;
    let cleaned = raw.replace(pattern, "");
    // Collapse anything past the first decimal point -- "1.2.3" is not a valid number.
    if (allowDecimal) {
      const firstDot = cleaned.indexOf(".");
      if (firstDot !== -1) {
        cleaned = cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, "");
      }
    }
    if (cleaned !== raw) {
      setRejected(true);
      setTimeout(() => setRejected(false), REJECT_MESSAGE_MS);
    }
    onChange(cleaned);
  };

  return (
    <div>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        onChange={(e) => handleChange(e.target.value)}
        className={`${className} ${rejected ? "border-danger focus:border-danger focus:ring-danger" : ""}`}
      />
      {rejected && <p className="mt-1 text-xs text-danger">Numbers only.</p>}
    </div>
  );
}
