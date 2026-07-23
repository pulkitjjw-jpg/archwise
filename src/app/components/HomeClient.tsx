"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import SiteFooter from "@/app/components/SiteFooter";
import { LogoMark } from "@/app/components/LogoMark";
import { HeroDiagram } from "@/app/components/HeroDiagram";

// Ordered so the 3 features most people actually care about first (what it generates, that it's
// multi-cloud, that costs are real) render as the larger "hero" cards; the remaining, still-real
// but more supporting capabilities render smaller in the row below -- every feature is still
// listed, just with real visual hierarchy instead of six identical-weight boxes.
const HERO_FEATURES = [
  {
    emoji: "🧠",
    title: "AI Brainstorm Chat",
    body: "Describe your idea in plain language. A guided conversation asks the right questions — scale, budget, team size, compliance — before any design work starts.",
  },
  {
    emoji: "🌐",
    title: "Multi-Cloud Architecture",
    body: "One design, matched sensibly across AWS, Azure, Google Cloud, Kubernetes, and your own servers — every component choice explained, not just generated.",
  },
  {
    emoji: "💰",
    title: "Real Cost Estimates",
    body: "A price range for each provider for every component, computed from your actual scale and requirements — not a generic price list.",
  },
];

const SUPPORTING_FEATURES = [
  {
    emoji: "🛡️",
    title: "Security Findings",
    body: "A rule-based security and compliance check on every design — encryption, access control, industry-specific rules like PCI-DSS or HIPAA.",
  },
  {
    emoji: "📦",
    title: "Terraform & Kubernetes Export",
    body: "Ready-to-run infrastructure code for your chosen provider — the actual files that build it, not a picture of it.",
  },
  {
    emoji: "🔄",
    title: "Living Architecture",
    body: "Report a change in chat and the architecture evolves with full version history — nothing is ever silently overwritten.",
  },
  {
    emoji: "🔍",
    title: "Search, Analytics & ML Components",
    body: "Real component types for search indexes, data warehouses, and ML inference endpoints — not just compute, database, and cache.",
  },
  {
    emoji: "🌍",
    title: "Multi-Region & Multi-Account",
    body: "Disaster-recovery strategies and per-environment account separation, modeled the way a real enterprise architecture actually needs them.",
  },
  {
    emoji: "📊",
    title: "Health Score & Flow Story",
    body: "A plain-language walkthrough of how a request flows through your design, plus a scored breakdown of cost, security, and vendor lock-in.",
  },
];

// Cycled in the headline ("Get a real ___ architecture.") to make the multi-cloud pitch
// concrete instead of just asserting it in prose -- "cloud" first (matches a reader landing
// mid-sentence), then the actual providers/targets the app really supports.
const ROTATING_TARGETS = ["cloud", "AWS", "Azure", "GCP", "Kubernetes"];

const STEPS = [
  { n: "1", title: "Describe your idea", body: "A few sentences about what you're building is enough to start." },
  { n: "2", title: "Brainstorm the details", body: "A short guided conversation fills in scale, budget, and constraints." },
  { n: "3", title: "Get your architecture", body: "A reasoned, multi-cloud design with costs, security findings, and ready-to-deploy infrastructure code." },
  { n: "4", title: "Iterate as things change", body: "Report a change in chat — the architecture updates, versioned, never lost." },
];

export default function HomeClient() {
  const [appName, setAppName] = useState("Archwise");
  const [targetIndex, setTargetIndex] = useState(0);
  // Crossfade via a single persistent node (toggling opacity/transform through a CSS transition),
  // not a keyed remount + keyframe animation -- the remount approach measurably raced with paint
  // in testing (the word occasionally rendered as fully blank for a frame, reproduced via repeated
  // screenshots at the same wait time even though computed opacity/color were correct throughout).
  // Swapping the text at transitionend, while opacity is already at 0, removes that race: the DOM
  // node never unmounts, so there's no window where nothing has been painted yet.
  const [wordVisible, setWordVisible] = useState(true);

  useEffect(() => {
    fetch("/api/settings")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => data?.appName && setAppName(data.appName))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const id = setInterval(() => setWordVisible(false), 2200);
    return () => clearInterval(id);
  }, []);

  return (
    <main className="min-h-screen overflow-x-clip bg-paper text-ink">
      {/* Ambient gradient blobs -- a relatively-positioned wrapper around nav+hero only (not the
          whole page) so the slow drift animation and blur don't paint behind content further down,
          which would just cost GPU with nothing visible under it. */}
      <div className="relative">
        <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
          <div
            className="absolute -left-24 -top-32 h-[28rem] w-[28rem] rounded-full bg-accent-soft blur-3xl"
            style={{ animation: "blob-drift 14s ease-in-out infinite" }}
          />
          <div
            className="absolute -right-32 top-10 h-[24rem] w-[24rem] rounded-full bg-accent/10 blur-3xl"
            style={{ animation: "blob-drift 18s ease-in-out infinite reverse" }}
          />
        </div>

        <div className="mx-auto max-w-6xl px-6 pt-6">
          {/* Nav */}
          <nav className="sticky top-4 z-20 flex items-center justify-between rounded-2xl border border-white/70 bg-white/70 px-4 py-3 shadow-sm backdrop-blur-xl">
            <span className="inline-flex items-center gap-2 text-lg font-black tracking-tight text-ink">
              <LogoMark className="h-7 w-7" />
              {appName}
            </span>
            <div className="flex items-center gap-1.5 sm:gap-3">
              <Link
                href="/login"
                className="whitespace-nowrap rounded-2xl px-2.5 py-2 text-sm font-semibold text-ink-muted transition hover:text-ink sm:px-4"
              >
                Log In
              </Link>
              <Link
                href="/signup"
                className="shimmer-cta relative whitespace-nowrap rounded-2xl bg-accent px-4 py-2 text-sm font-semibold text-white shadow-md transition-all hover:bg-accent-ink hover:shadow-lg active:scale-[0.98] sm:px-5 sm:py-2.5 overflow-hidden"
              >
                <span className="sm:hidden">Get Started</span>
                <span className="hidden sm:inline">Get Started Free</span>
              </Link>
            </div>
          </nav>

          {/* Hero -- copy + CTAs on the left, the diagram building itself on the right. On mobile
              the diagram stacks below the copy instead of competing for the same space. */}
          <div className="mt-14 grid items-center gap-12 sm:mt-20 lg:grid-cols-[1.05fr_1fr] lg:gap-8">
            <div style={{ animation: "fade-in-up 0.6s ease-out both" }}>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/25 bg-accent-soft px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-accent-ink">
                🧭 AI-Powered Architecture
              </span>
              <h1 className="mt-5 text-4xl font-black tracking-tight text-ink sm:text-5xl lg:text-[3.25rem] lg:leading-[1.05]">
                Describe your idea.
                <br />
                Get a real{" "}
                <span className="relative inline-block h-[1.05em] overflow-hidden align-bottom">
                  <span
                    className="inline-block text-accent transition-all duration-300 ease-out"
                    style={{ opacity: wordVisible ? 1 : 0, transform: wordVisible ? "translateY(0)" : "translateY(-40%)" }}
                    onTransitionEnd={(e) => {
                      // transition-all fires this once per transitioned property (opacity AND
                      // transform) -- without this guard the index silently incremented twice per
                      // cycle, which is what produced the earlier "AWS" being skipped entirely.
                      if (e.propertyName !== "opacity" || wordVisible) return;
                      setTargetIndex((i) => (i + 1) % ROTATING_TARGETS.length);
                      setWordVisible(true);
                    }}
                  >
                    {ROTATING_TARGETS[targetIndex]}
                  </span>
                </span>{" "}
                architecture.
              </h1>
              <p className="mt-5 max-w-xl text-base leading-7 text-ink-muted sm:text-lg">
                {appName} turns a plain-language product idea into a genuinely-reasoned multi-cloud
                architecture — with cost estimates, security findings, and ready-to-run Terraform, in
                minutes, not weeks.
              </p>
              <div className="mt-8 flex flex-col items-start gap-3 sm:flex-row">
                <Link
                  href="/signup"
                  className="shimmer-cta relative w-full overflow-hidden rounded-2xl bg-accent px-7 py-3.5 text-center text-sm font-semibold text-white shadow-md transition-all hover:bg-accent-ink hover:shadow-lg active:scale-[0.98] sm:w-auto"
                >
                  Get Started Free
                </Link>
                <a
                  href="#pricing"
                  className="w-full rounded-2xl border border-line bg-white/70 px-7 py-3.5 text-center text-sm font-semibold text-ink transition hover:border-line-strong hover:bg-white sm:w-auto"
                >
                  See pricing
                </a>
              </div>
            </div>

            <HeroDiagram />
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-6xl px-6">
        {/* Feature grid -- hero features (larger, prominent) first, then every other real
            capability still shown, just in a smaller supporting row. Nothing is hidden, only
            visually weighted by how central it is to the core pitch. */}
        <div className="mt-24 sm:mt-32">
          <h2 className="text-center text-2xl font-black tracking-tight text-ink sm:text-3xl">
            What it actually does
          </h2>
          <div className="mt-8 grid gap-5 sm:grid-cols-3">
            {HERO_FEATURES.map((f) => (
              <div
                key={f.title}
                className="group rounded-[2rem] border border-white/70 bg-white/80 p-7 shadow-xl backdrop-blur-md transition-all duration-300 hover:-translate-y-1.5 hover:shadow-2xl"
              >
                <span className="inline-block text-4xl transition-transform duration-300 group-hover:scale-110">
                  {f.emoji}
                </span>
                <h3 className="mt-3 text-xl font-bold tracking-tight text-ink">{f.title}</h3>
                <p className="mt-2.5 text-sm leading-relaxed text-ink-muted">{f.body}</p>
              </div>
            ))}
          </div>
          <div className="mt-5 grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
            {SUPPORTING_FEATURES.map((f) => (
              <div
                key={f.title}
                className="rounded-2xl border border-line bg-white/60 p-4 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-line-strong hover:bg-white/90 hover:shadow-md"
              >
                <span className="text-xl">{f.emoji}</span>
                <h3 className="mt-2 text-sm font-bold tracking-tight text-ink">{f.title}</h3>
                <p className="mt-1 text-xs leading-relaxed text-ink-muted">{f.body}</p>
              </div>
            ))}
          </div>
        </div>

        {/* How it works */}
        <div className="mt-24 sm:mt-32">
          <h2 className="text-center text-2xl font-black tracking-tight text-ink sm:text-3xl">How it works</h2>
          <div className="relative mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {/* Connecting rail -- desktop only, sits behind the step cards to suggest one
                continuous pipeline rather than 4 unrelated boxes. */}
            <div className="absolute inset-x-8 top-[1.15rem] hidden h-px bg-line lg:block" aria-hidden="true" />
            {STEPS.map((s) => (
              <div
                key={s.n}
                className="relative rounded-2xl border border-line bg-white/70 p-5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
              >
                <span className="relative z-10 flex h-7 w-7 items-center justify-center rounded-full bg-ink text-xs font-bold text-white">
                  {s.n}
                </span>
                <h3 className="mt-3 text-sm font-bold tracking-tight text-ink">{s.title}</h3>
                <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">{s.body}</p>
              </div>
            ))}
          </div>
          <div className="mt-6 text-center">
            <Link href="/how-to-use" className="text-sm font-semibold text-accent-ink hover:underline">
              See the full walkthrough →
            </Link>
          </div>
        </div>

        {/* Pricing teaser */}
        <div id="pricing" className="mt-24 scroll-mt-8 sm:mt-32">
          <h2 className="text-center text-2xl font-black tracking-tight text-ink sm:text-3xl">
            Simple, honest pricing
          </h2>
          <p className="mx-auto mt-3 max-w-md text-center text-sm text-ink-muted">
            Try the full product once, free. Upgrade when you&apos;re ready to build for real.
          </p>
          <div className="mx-auto mt-8 grid max-w-2xl gap-5 sm:grid-cols-2">
            <div className="rounded-[2rem] border border-line bg-white/80 p-6 shadow-sm transition-all duration-200 hover:-translate-y-1 hover:shadow-md">
              <h3 className="text-sm font-bold uppercase tracking-wider text-ink-muted">Free</h3>
              <p className="mt-2 text-3xl font-black tracking-tight text-ink">$0</p>
              <p className="mt-3 text-xs leading-relaxed text-ink-muted">
                Enough to fully experience the product: several brainstorm sessions, a couple of
                architecture generations and enhancements.
              </p>
            </div>
            <div className="rounded-[2rem] border-2 border-accent bg-accent-soft/60 p-6 shadow-md transition-all duration-200 hover:-translate-y-1 hover:shadow-lg">
              <h3 className="text-sm font-bold uppercase tracking-wider text-accent-ink">Paid</h3>
              <p className="mt-2 text-3xl font-black tracking-tight text-ink">
                $20<span className="text-sm font-semibold text-ink-muted">/mo</span>
              </p>
              <p className="mt-3 text-xs leading-relaxed text-ink-muted">
                Everything, unlimited — brainstorming, architectures, enhancements, exports.
              </p>
            </div>
          </div>
          <div className="mt-6 text-center">
            <Link href="/pricing" className="text-sm font-semibold text-accent-ink hover:underline">
              See full pricing breakdown →
            </Link>
          </div>
        </div>

        {/* Closing CTA band */}
        <div className="relative mt-24 overflow-hidden rounded-[2.5rem] border border-line bg-white px-8 py-14 text-center shadow-xl sm:mt-32 sm:px-16">
          <div
            className="pointer-events-none absolute -right-16 -top-16 h-64 w-64 rounded-full bg-accent/15 blur-3xl"
            style={{ animation: "blob-drift 16s ease-in-out infinite" }}
          />
          <h2 className="text-3xl font-black tracking-tight text-ink sm:text-4xl">
            Ready to see your architecture?
          </h2>
          <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-ink-muted">
            No credit card required. Describe your idea and get a real, reasoned design in minutes.
          </p>
          <Link
            href="/signup"
            className="shimmer-cta relative mt-8 inline-flex overflow-hidden rounded-2xl bg-accent px-8 py-3.5 text-sm font-semibold text-white shadow-md transition-all hover:bg-accent-ink hover:shadow-lg active:scale-[0.98]"
          >
            Get Started Free
          </Link>
        </div>

        <SiteFooter appName={appName} />
      </div>
    </main>
  );
}
