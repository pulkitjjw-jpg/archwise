"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

// The first generic confirm-modal in this codebase -- every destructive action before this
// either had no "are you sure" step at all, or (DELETE /auth/me) used a heavier
// type-your-email-to-confirm pattern appropriate for whole-account deletion specifically, not a
// precedent worth generalizing here. Portal-rendered to document.body, same reasoning as
// InfoTooltip/HoverTooltip: never clipped by an ancestor's overflow.
export default function ConfirmDialog({
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel, busy]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-ink/50 px-4 backdrop-blur-sm"
      onClick={() => !busy && onCancel()}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ animation: "fade-in-up 0.2s ease-out" }}
        className="w-full max-w-sm rounded-[1.75rem] border border-line bg-white p-6 shadow-2xl"
      >
        <h2 id="confirm-dialog-title" className="text-lg font-black tracking-tight text-ink">
          {title}
        </h2>
        <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-ink-muted">{message}</p>
        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-2xl border border-line bg-white px-4 py-2.5 text-sm font-semibold text-ink transition hover:border-line-strong disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`rounded-2xl px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition active:scale-[0.98] disabled:opacity-50 ${
              danger ? "bg-danger hover:opacity-90" : "bg-accent hover:bg-accent-ink"
            }`}
          >
            {busy ? "Working..." : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
