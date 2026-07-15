"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import SiteFooter from "@/app/components/SiteFooter";

const FEATURES = [
  {
    emoji: "🧠",
    title: "AI Brainstorm Chat",
    body: "Describe your idea in plain language. A guided conversation asks the right questions — scale, budget, team size, compliance — before any design work starts.",
  },
  {
    emoji: "🌐",
    title: "Multi-Cloud Architecture",
    body: "One design, reasoned mappings across AWS, Azure, GCP, Kubernetes, and on-prem — every component choice explained, not just generated.",
  },
  {
    emoji: "💰",
    title: "Real Cost Estimates",
    body: "Per-provider cost bands for every component, computed from your actual scale and requirements — not a generic price list.",
  },
  {
    emoji: "🛡️",
    title: "Security Findings",
    body: "A deterministic security and compliance audit runs on every design — encryption, access control, and industry-specific rules like PCI-DSS or HIPAA.",
  },
  {
    emoji: "📦",
    title: "Terraform & Kubernetes Export",
    body: "Ready-to-run infrastructure code for your chosen provider — the actual deployable config, not a picture of it.",
  },
  {
    emoji: "🔄",
    title: "Living Architecture",
    body: "Requirements change. Report an update in chat and the architecture evolves with full version history — nothing is ever silently overwritten.",
  },
];

const STEPS = [
  { n: "1", title: "Describe your idea", body: "A few sentences about what you're building is enough to start." },
  { n: "2", title: "Brainstorm the details", body: "A short guided conversation fills in scale, budget, and constraints." },
  { n: "3", title: "Get your architecture", body: "A reasoned, multi-cloud design with costs, security findings, and IaC." },
  { n: "4", title: "Iterate as things change", body: "Report a change in chat — the architecture updates, versioned, never lost." },
];

export default function LandingPage() {
  const [appName, setAppName] = useState("Archwise");

  useEffect(() => {
    fetch("/api/settings")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => data?.appName && setAppName(data.appName))
      .catch(() => {});
  }, []);

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,var(--color-accent-soft),transparent_36%)] bg-paper text-ink">
      <div className="mx-auto max-w-6xl px-6 py-8 sm:py-10">
        {/* Nav */}
        <nav className="flex items-center justify-between">
          <span className="text-lg font-black tracking-tight text-ink">{appName}</span>
          <div className="flex items-center gap-3">
            <Link
              href="/login"
              className="rounded-2xl px-4 py-2 text-sm font-semibold text-ink-muted transition hover:text-ink"
            >
              Log In
            </Link>
            <Link
              href="/signup"
              className="rounded-2xl bg-accent px-5 py-2.5 text-sm font-semibold text-white shadow-md transition-all hover:bg-accent-ink active:scale-[0.98]"
            >
              Get Started Free
            </Link>
          </div>
        </nav>

        {/* Hero */}
        <div className="mt-16 sm:mt-24 sm:text-center">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/25 bg-accent-soft px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-accent-ink">
            🧭 AI-Powered Architecture
          </span>
          <h1 className="mx-auto mt-5 max-w-3xl text-4xl font-black tracking-tight text-ink sm:text-5xl">
            Describe your idea. Get a real cloud architecture.
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-base leading-7 text-ink-muted sm:text-lg">
            {appName} turns a plain-language product idea into a genuinely-reasoned multi-cloud
            architecture — with cost estimates, security findings, and ready-to-run Terraform, in
            minutes, not weeks.
          </p>
          <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
            <Link
              href="/signup"
              className="w-full rounded-2xl bg-accent px-7 py-3.5 text-center text-sm font-semibold text-white shadow-md transition-all hover:bg-accent-ink active:scale-[0.98] sm:w-auto"
            >
              Get Started Free
            </Link>
            <a
              href="#pricing"
              className="w-full rounded-2xl border border-line bg-white/70 px-7 py-3.5 text-center text-sm font-semibold text-ink transition hover:border-line-strong sm:w-auto"
            >
              See pricing
            </a>
          </div>
        </div>

        {/* Feature grid */}
        <div className="mt-20 sm:mt-28">
          <h2 className="text-center text-2xl font-black tracking-tight text-ink sm:text-3xl">
            What it actually does
          </h2>
          <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <div
                key={f.title}
                className="rounded-[2rem] border border-white/70 bg-white/80 p-6 shadow-xl backdrop-blur-md"
              >
                <span className="text-3xl">{f.emoji}</span>
                <h3 className="mt-3 text-lg font-bold tracking-tight text-ink">{f.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-muted">{f.body}</p>
              </div>
            ))}
          </div>
        </div>

        {/* How it works */}
        <div className="mt-20 sm:mt-28">
          <h2 className="text-center text-2xl font-black tracking-tight text-ink sm:text-3xl">How it works</h2>
          <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((s) => (
              <div key={s.n} className="rounded-2xl border border-line bg-white/70 p-5">
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-ink text-xs font-bold text-white">
                  {s.n}
                </span>
                <h3 className="mt-3 text-sm font-bold tracking-tight text-ink">{s.title}</h3>
                <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">{s.body}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Pricing teaser */}
        <div id="pricing" className="mt-20 scroll-mt-8 sm:mt-28">
          <h2 className="text-center text-2xl font-black tracking-tight text-ink sm:text-3xl">
            Simple, honest pricing
          </h2>
          <p className="mx-auto mt-3 max-w-md text-center text-sm text-ink-muted">
            Try the full product once, free. Upgrade when you&apos;re ready to build for real.
          </p>
          <div className="mx-auto mt-8 grid max-w-2xl gap-5 sm:grid-cols-2">
            <div className="rounded-[2rem] border border-line bg-white/80 p-6 shadow-sm">
              <h3 className="text-sm font-bold uppercase tracking-wider text-ink-muted">Free</h3>
              <p className="mt-2 text-3xl font-black tracking-tight text-ink">$0</p>
              <p className="mt-3 text-xs leading-relaxed text-ink-muted">
                Enough to fully experience the product: a few brainstorm sessions, one architecture
                generation, one enhancement.
              </p>
            </div>
            <div className="rounded-[2rem] border-2 border-accent bg-accent-soft/60 p-6 shadow-md">
              <h3 className="text-sm font-bold uppercase tracking-wider text-accent-ink">Paid</h3>
              <p className="mt-2 text-3xl font-black tracking-tight text-ink">
                $10<span className="text-sm font-semibold text-ink-muted">/mo</span>
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

        <SiteFooter appName={appName} />
      </div>
    </main>
  );
}
