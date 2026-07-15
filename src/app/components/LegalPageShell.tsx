import Link from "next/link";
import type { ReactNode } from "react";
import { LEGAL_PAGES } from "@/lib/legal-pages";

// Deliberately a plainer, denser layout than the marketing pages (no gradient hero, no rounded-
// [2rem] cards) -- long-form legal text reads better as simple prose than as decorated panels,
// and a Terms page that looks like a sales pitch reads as less trustworthy, not more. Still uses
// the same design tokens (colors, type scale) as the rest of the app, just applied more plainly.
export default function LegalPageShell({
  title,
  lastUpdated,
  children,
}: {
  title: string;
  lastUpdated: string;
  children: ReactNode;
}) {
  return (
    <main className="min-h-screen bg-paper px-6 py-10 text-ink sm:py-14">
      <div className="mx-auto max-w-2xl">
        <Link href="/" className="text-sm font-black tracking-tight text-ink">
          Archwise
        </Link>

        <h1 className="mt-6 text-3xl font-black tracking-tight text-ink">{title}</h1>
        <p className="mt-1.5 text-xs font-semibold uppercase tracking-wider text-ink-faint">
          Last updated {lastUpdated}
        </p>

        <article className="prose-legal mt-8 space-y-5 text-sm leading-relaxed text-ink-muted [&_h2]:mt-8 [&_h2]:text-base [&_h2]:font-bold [&_h2]:tracking-tight [&_h2]:text-ink [&_h3]:mt-5 [&_h3]:text-sm [&_h3]:font-bold [&_h3]:text-ink [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5 [&_a]:font-semibold [&_a]:text-accent-ink [&_a]:underline [&_a]:underline-offset-2 [&_strong]:font-semibold [&_strong]:text-ink">
          {children}
        </article>

        <nav className="mt-14 border-t border-line pt-6">
          <p className="text-xs font-semibold uppercase tracking-wider text-ink-faint">More</p>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
            {LEGAL_PAGES.map((p) => (
              <Link key={p.href} href={p.href} className="text-xs font-semibold text-ink-muted hover:text-accent-ink">
                {p.label}
              </Link>
            ))}
          </div>
        </nav>
      </div>
    </main>
  );
}
