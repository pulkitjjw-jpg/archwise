import LegalPageShell from "@/app/components/LegalPageShell";
import { SUPPORT_EMAIL } from "@/lib/legal-pages";

export const metadata = { title: "Cookie Policy — Archwise" };

export default function CookiePolicyPage() {
  return (
    <LegalPageShell title="Cookie Policy" lastUpdated="July 2026">
      <p>
        This is a short policy because Archwise genuinely doesn&apos;t use many cookies — we&apos;d
        rather tell you exactly what&apos;s true than pad this out to look more comprehensive.
      </p>

      <h2>What we use</h2>
      <p>
        A small set of cookies set by <strong>Clerk</strong>, the service that handles signing in,
        signing up, and staying signed in for us. They&apos;re <strong>essential</strong> — the
        Service can&apos;t recognize that you&apos;re logged in without them — and they exist only
        to keep your session working, not to track you across other sites. They&apos;re cleared
        when you log out.
      </p>

      <h2>What we don&apos;t use</h2>
      <p>
        No advertising cookies, no analytics cookies, and no cross-site tracking of any kind. If
        that ever changes as Archwise grows, this page will be updated to say so honestly and in
        advance, not silently.
      </p>

      <h2>Questions</h2>
      <p>
        Reach us at <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
      </p>
    </LegalPageShell>
  );
}
