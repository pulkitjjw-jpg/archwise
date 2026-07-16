"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface InfoTooltipProps {
  text: string;
  /** "dark" for icons that sit on a dark/colored surface (e.g. the chat header) -- swaps to a
   * light-on-dark palette instead of appending classes, since Tailwind utility class *order* in
   * the compiled stylesheet (not the order in a className string) decides which color wins when
   * two color utilities for the same property collide, so naive appending isn't reliable. */
  variant?: "default" | "dark";
}

const VARIANT_CLASSES: Record<"default" | "dark", string> = {
  default: "border-ink-faint/60 text-ink-faint hover:border-accent hover:text-accent hover:bg-accent-soft",
  dark: "border-white/40 text-white/70 hover:border-white hover:text-white hover:bg-white/10",
};

// Portal-rendered so it's never clipped by an ancestor's overflow-hidden (the diagram canvas,
// the workspace tabs, several card containers all have one) -- position is computed from the
// anchor button's real viewport coordinates instead of relying on CSS containment.
export default function InfoTooltip({ text, variant = "default" }: InfoTooltipProps) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number; flip: boolean } | null>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);

  const updatePosition = () => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Flip below the icon if there isn't room above (near the top of the viewport).
    const flip = rect.top < 60;
    setCoords({
      top: flip ? rect.bottom + 8 : rect.top - 8,
      left: Math.min(Math.max(rect.left + rect.width / 2, 140), window.innerWidth - 140),
      flip,
    });
  };

  const show = () => {
    updatePosition();
    setOpen(true);
  };
  const hide = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    const onReposition = () => updatePosition();
    window.addEventListener("scroll", onReposition, true);
    window.addEventListener("resize", onReposition);
    return () => {
      window.removeEventListener("scroll", onReposition, true);
      window.removeEventListener("resize", onReposition);
    };
  }, [open]);

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          if (open) hide();
          else show();
        }}
        aria-label="More info"
        className={`inline-flex h-3.5 w-3.5 flex-none items-center justify-center rounded-full border text-[9px] font-bold leading-none transition ${VARIANT_CLASSES[variant]}`}
      >
        i
      </button>
      {open &&
        coords &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            role="tooltip"
            style={{
              position: "fixed",
              top: coords.top,
              left: coords.left,
              transform: coords.flip ? "translate(-50%, 0)" : "translate(-50%, -100%)",
            }}
            className="pointer-events-none z-[999] w-max max-w-[280px] rounded-xl bg-ink px-3 py-2 text-[11px] font-medium leading-relaxed text-white shadow-xl"
          >
            {text}
          </div>,
          document.body
        )}
    </>
  );
}
