"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

// Same portal-rendered, viewport-position pattern as InfoTooltip.tsx (never clipped by an
// ancestor's overflow, including the diagram canvas's SVG foreignObject boundaries -- a plain
// CSS tooltip anchored inside a foreignObject gets clipped at that box's edges, which is exactly
// why a diagram-node hover tooltip can't just reuse InfoTooltip's own small "i"-button trigger
// directly: it needs to wrap an arbitrary existing element (the node's icon) as the hover target
// instead of rendering its own trigger button. Supports multi-line text via \n (rendered with
// whitespace-pre-line) so a node's badge explanations can be folded into one tooltip alongside
// its name.
export default function HoverTooltip({ text, children }: { text: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number; flip: boolean } | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);

  const updatePosition = () => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    const flip = rect.top < 100;
    setCoords({
      top: flip ? rect.bottom + 10 : rect.top - 10,
      left: Math.min(Math.max(rect.left + rect.width / 2, 160), window.innerWidth - 160),
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
    <div ref={anchorRef} onMouseEnter={show} onMouseLeave={hide} className="inline-flex">
      {children}
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
            className="pointer-events-none z-[999] w-max max-w-[300px] whitespace-pre-line rounded-xl bg-ink px-3.5 py-2.5 text-[11.5px] font-medium leading-relaxed text-white shadow-xl"
          >
            {text}
          </div>,
          document.body
        )}
    </div>
  );
}
