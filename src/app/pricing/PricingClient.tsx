"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import SiteFooter from "@/app/components/SiteFooter";
import { LogoMark } from "@/app/components/LogoMark";

// Numbers here must match backend/app/services/usage_limits.py's FREE_TIER_LIMITS -- kept as
// plain text, not fetched, since this is marketing copy that changes rarely and in lockstep with
// a deliberate pricing decision, not live data.
const FREE_FEATURES = [
  "6 planning conversations (brainstorming + requirements)",
  "2 architecture generations",
  "2 architecture updates as your app needs to scale up",
  "Cost estimates & security findings",
  "Terraform / Kubernetes export",
];

const PAID_FEATURES = [
  "Unlimited planning conversations",
  "Unlimited architecture generations",
  "Unlimited architecture updates as your app grows",
  "Cost estimates & security findings",
  "Terraform / Kubernetes export",
  "Executive summary PDF & shareable links",
  "Priority AI access — never wait behind free-plan users",
];

function Check() {
  return (
    <span className="mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded-full bg-success-soft text-[10px] font-bold text-success">
      ✓
    </span>
  );
}

export default function PricingClient() {
  const [appName, setAppName] = useState("Archwise");

  useEffect(() => {
    fetch("/api/settings")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => data?.appName && setAppName(data.appName))
      .catch(() => {});
  }, []);

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,var(--color-accent-soft),transparent_36%)] bg-paper px-6 py-10 text-ink sm:py-14">
      <div className="mx-auto max-w-4xl">
        <div className="flex items-center justify-between">
          <Link href="/" className="inline-flex items-center gap-2 text-lg font-black tracking-tight text-ink">
            <LogoMark className="h-7 w-7" />
            {appName}
          </Link>
          <Link href="/login" className="text-sm font-semibold text-ink-muted transition hover:text-ink">
            Log In
          </Link>
        </div>

        <div className="mt-12 text-center">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/25 bg-accent-soft px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-accent-ink">
            💳 Pricing
          </span>
          <h1 className="mt-4 text-3xl font-black tracking-tight text-ink sm:text-4xl">
            Try it free. Upgrade when you&apos;re ready.
          </h1>
          <p className="mx-auto mt-4 max-w-lg text-sm leading-relaxed text-ink-muted">
            One plan, priced simply. The free tier is enough to fully experience what {appName} can
            do — not a crippled demo.
          </p>
        </div>

        <div className="mt-10 grid gap-6 sm:grid-cols-2">
          {/* Free */}
          <div className="flex flex-col rounded-[2rem] border border-line bg-white/80 p-7 shadow-sm">
            <h2 className="text-sm font-bold uppercase tracking-wider text-ink-muted">Free</h2>
            <p className="mt-2 text-4xl font-black tracking-tight text-ink">$0</p>
            <p className="mt-1 text-xs text-ink-faint">no credit card required</p>
            <ul className="mt-6 flex-1 space-y-3">
              {FREE_FEATURES.map((f) => (
                <li key={f} className="flex items-start gap-2.5 text-sm text-ink-muted">
                  <Check />
                  {f}
                </li>
              ))}
            </ul>
            <Link
              href="/signup"
              className="mt-7 flex items-center justify-center rounded-2xl border border-line bg-white px-5 py-3 text-sm font-semibold text-ink shadow-sm transition hover:border-line-strong active:scale-[0.98]"
            >
              Get Started Free
            </Link>
          </div>

          {/* Paid */}
          <div className="flex flex-col rounded-[2rem] border-2 border-accent bg-accent-soft/50 p-7 shadow-md">
            <h2 className="text-sm font-bold uppercase tracking-wider text-accent-ink">Paid</h2>
            <p className="mt-2 text-4xl font-black tracking-tight text-ink">
              $20<span className="text-base font-semibold text-ink-muted">/month</span>
            </p>
            <p className="mt-1 text-xs text-ink-faint">cancel anytime</p>
            <ul className="mt-6 flex-1 space-y-3">
              {PAID_FEATURES.map((f) => (
                <li key={f} className="flex items-start gap-2.5 text-sm text-ink">
                  <Check />
                  {f}
                </li>
              ))}
            </ul>
            <Link
              href="/signup"
              className="mt-7 flex items-center justify-center rounded-2xl bg-accent px-5 py-3 text-sm font-semibold text-white shadow-md transition-all hover:bg-accent-ink active:scale-[0.98]"
            >
              Get Started
            </Link>
            <p className="mt-2 text-center text-[11px] text-ink-faint">Billing setup coming soon — sign up free for now.</p>
          </div>
        </div>

        <p className="mt-10 text-center text-xs text-ink-faint">
          Have questions?{" "}
          <Link href="/contact" className="font-semibold text-accent-ink hover:underline">
            Get in touch
          </Link>{" "}
          — we read every message.
        </p>

        <SiteFooter appName={appName} />
      </div>
    </main>
  );
}
