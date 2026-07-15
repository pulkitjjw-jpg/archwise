import LegalPageShell from "@/app/components/LegalPageShell";
import { SUPPORT_EMAIL } from "@/lib/legal-pages";

export const metadata = { title: "Security — Archwise" };

export default function SecurityPage() {
  return (
    <LegalPageShell title="Security" lastUpdated="July 2026">
      <p>
        Archwise is an early-stage, independently-run product — we don&apos;t hold formal
        certifications like SOC 2, and we&apos;re not going to claim otherwise. What follows is an
        honest, specific list of what&apos;s actually in place today.
      </p>

      <h2>Passwords and sessions</h2>
      <p>
        Passwords are hashed with bcrypt — we never store or can see your actual password. Signing
        in issues a random, high-entropy session token stored server-side, not a token that encodes
        your identity in a way that could be forged or decoded.
      </p>

      <h2>Your data stays yours</h2>
      <p>
        Every project, conversation, and architecture is scoped to your account. Access is checked
        on every request — another user cannot view or modify your projects by guessing a URL or
        an ID.
      </p>

      <h2>Rate limiting</h2>
      <p>
        Endpoints that trigger AI generation are rate-limited per account, both to keep the Service
        stable under load and to prevent abuse.
      </p>

      <h2>Browser-level protections</h2>
      <p>
        Archwise sets a Content Security Policy and standard security headers in production to
        reduce the impact of common web vulnerabilities like clickjacking and script injection.
      </p>

      <h2>Infrastructure</h2>
      <p>
        The Service runs on established third-party cloud infrastructure providers rather than
        self-hosted hardware, and traffic is encrypted in transit. See our{" "}
        <a href="/privacy">Privacy Policy</a> for more on how and where data is hosted.
      </p>

      <h2>Found a security issue?</h2>
      <p>
        We take reports seriously and will respond promptly. Please email{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> with details rather than disclosing
        it publicly first — we&apos;re a small, independently-run team and a direct heads-up gives
        us the best chance to fix it quickly.
      </p>
    </LegalPageShell>
  );
}
