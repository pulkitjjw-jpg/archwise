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
        One cookie: <strong>session_token</strong>. It&apos;s what keeps you signed in between page
        loads. It&apos;s <strong>essential</strong> — the Service can&apos;t recognize that
        you&apos;re logged in without it. It&apos;s set as <strong>httpOnly</strong> (JavaScript on
        the page can&apos;t read it) and is cleared when you log out.
      </p>

      <h2>What we don&apos;t use</h2>
      <p>
        No advertising cookies, no third-party tracking or analytics cookies, and no cross-site
        tracking of any kind. If that ever changes as Archwise grows, this page will be updated to
        say so honestly and in advance, not silently.
      </p>

      <h2>Questions</h2>
      <p>
        Reach us at <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
      </p>
    </LegalPageShell>
  );
}
