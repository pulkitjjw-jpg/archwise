"use client";

// A self-drawing cloud architecture diagram -- the actual product output (a request-flow graph),
// not generic decoration. Edges draw in with a staggered delay so the diagram appears to build
// itself top-down, then each edge gets a small dot looping along it forever (offset-path), reading
// as live request traffic through the design. Coordinates are plain 0-100 percentages so the same
// numbers drive both the SVG path data and the HTML node positioning without a second unit system.
const NODES = [
  { id: "client", label: "Client", emoji: "👤", left: 50, top: 7, delay: 0 },
  { id: "lb", label: "Load Balancer", emoji: "🌐", left: 50, top: 36, delay: 0.9 },
  { id: "app1", label: "App Server", emoji: "⚙️", left: 20, top: 65, delay: 1.7 },
  { id: "app2", label: "App Server", emoji: "⚙️", left: 80, top: 65, delay: 1.7 },
  { id: "db", label: "Database", emoji: "🗄️", left: 20, top: 93, delay: 2.5 },
  { id: "cache", label: "Cache", emoji: "⚡", left: 80, top: 93, delay: 2.5 },
];

const EDGES = [
  { d: "M50,7 L50,36", drawDelay: 0.3, flowDelay: 3.0 },
  { d: "M50,36 L20,65", drawDelay: 1.1, flowDelay: 3.3 },
  { d: "M50,36 L80,65", drawDelay: 1.1, flowDelay: 3.3 },
  { d: "M20,65 L20,93", drawDelay: 1.9, flowDelay: 3.6 },
  { d: "M80,65 L80,93", drawDelay: 1.9, flowDelay: 3.6 },
];

// Pop in once the diagram's own entrance sequence settles (last node lands at 2.5s + 0.5s anim =
// 3.0s), then bob gently forever -- real signals the product actually produces (a component
// count, a cost estimate), not arbitrary chrome, timed to feel like the diagram "finishing its
// thought" rather than random notifications.
const TOASTS = [
  { id: "components", label: "12 components reasoned", emoji: "✅", delay: 3.2, bobDelay: 3.7, className: "-right-3 top-10 sm:-right-8" },
  { id: "cost", label: "$340–420/mo estimate", emoji: "💰", delay: 3.6, bobDelay: 4.3, className: "-left-3 bottom-14 sm:-left-8" },
];

export function HeroDiagram() {
  return (
    <div className="relative mx-auto aspect-[10/9] w-full max-w-md select-none">
      <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full overflow-visible" aria-hidden="true">
        {EDGES.map((e, i) => (
          <path
            key={`line-${i}`}
            d={e.d}
            pathLength={1}
            fill="none"
            stroke="var(--color-accent)"
            strokeOpacity={0.4}
            strokeWidth={0.6}
            strokeLinecap="round"
            strokeDasharray="1 1"
            style={{ animation: `draw-line 0.7s ease-out ${e.drawDelay}s both` }}
          />
        ))}
        {EDGES.map((e, i) => (
          <circle
            key={`dot-${i}`}
            r={0.9}
            fill="var(--color-accent)"
            style={{ offsetPath: `path("${e.d}")`, animation: `flow-dot 2.6s linear ${e.flowDelay}s infinite` }}
          />
        ))}
      </svg>
      {NODES.map((n) => (
        <div
          key={n.id}
          className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1 rounded-2xl border border-line bg-white/95 px-3 py-2 text-center shadow-lg backdrop-blur-sm"
          style={{ left: `${n.left}%`, top: `${n.top}%`, opacity: 0, animation: `node-in 0.5s ease-out ${n.delay}s both` }}
        >
          <span className="text-lg leading-none">{n.emoji}</span>
          <span className="text-[10px] font-bold whitespace-nowrap text-ink-muted">{n.label}</span>
        </div>
      ))}
      {TOASTS.map((t) => (
        <div
          key={t.id}
          className={`absolute z-10 flex items-center gap-1.5 whitespace-nowrap rounded-xl border border-line bg-white/95 px-3 py-1.5 text-xs font-bold text-ink shadow-lg backdrop-blur-sm ${t.className}`}
          style={{ opacity: 0, animation: `toast-in 0.5s ease-out ${t.delay}s both, float-bob 4s ease-in-out ${t.bobDelay}s infinite` }}
        >
          <span>{t.emoji}</span>
          {t.label}
        </div>
      ))}
    </div>
  );
}
