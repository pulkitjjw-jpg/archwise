import Link from "next/link";
import type { ReactNode } from "react";

// Shared outer wrapper for login/signup/forgot-password/reset-password -- same background
// gradient and card treatment as the rest of the app (see page.tsx's hero, IntakeForm.tsx's
// card), so these read as part of the same product rather than a bolted-on auth flow.
export default function AuthShell({
  eyebrow,
  title,
  subtitle,
  children,
  footer,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_top_left,var(--color-accent-soft),transparent_36%)] bg-paper px-6 py-12 text-ink">
      <div className="w-full max-w-md">
        <Link href="/" className="mb-6 flex items-center justify-center gap-2 text-sm font-bold text-ink-muted transition hover:text-ink">
          ← Back to home
        </Link>
        <div className="rounded-[2rem] border border-white/70 bg-white/80 p-6 shadow-xl backdrop-blur-md sm:p-8">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/25 bg-accent-soft px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-accent-ink">
            {eyebrow}
          </span>
          <h1 className="mt-3 text-2xl font-black tracking-tight text-ink">{title}</h1>
          <p className="mt-2 text-sm leading-relaxed text-ink-muted">{subtitle}</p>
          <div className="mt-6">{children}</div>
        </div>
        {footer && <p className="mt-6 text-center text-sm text-ink-muted">{footer}</p>}
      </div>
    </main>
  );
}
