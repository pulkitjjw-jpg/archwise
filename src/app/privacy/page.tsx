import LegalPageShell from "@/app/components/LegalPageShell";
import { SUPPORT_EMAIL } from "@/lib/legal-pages";

export const metadata = { title: "Privacy Policy — Archwise" };

export default function PrivacyPage() {
  return (
    <LegalPageShell title="Privacy Policy" lastUpdated="July 2026">
      <p>
        This Privacy Policy explains what data Archwise collects, why, and how it&apos;s handled.
        Archwise is currently operated by an individual, not a registered company — we&apos;re
        writing this policy to be accurate about a small, early-stage service, not to imply
        formal structures that don&apos;t exist yet.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li>
          <strong>Account information:</strong> your email address and a securely hashed password
          (we never store your actual password — see <a href="/security">Security</a>).
        </li>
        <li>
          <strong>Project content:</strong> the product ideas, brainstorm conversations,
          requirements, and architectures you create — this is the core data the Service exists to
          work with.
        </li>
        <li>
          <strong>Usage data:</strong> basic operational logs (e.g. which features were used, request
          timing) that help us keep the Service reliable and debug problems.
        </li>
      </ul>

      <h2>How we use it</h2>
      <p>
        To operate the Service: authenticating you, generating your architectures, saving your
        project history and versions, and enforcing the usage limits described on our{" "}
        <a href="/pricing">Pricing</a>{" "}
        page. We don&apos;t sell your data, and we don&apos;t use it for advertising.
      </p>

      <h2>Third-party services we rely on</h2>
      <p>
        Generating a brainstorm reply or an architecture means sending the relevant parts of your
        conversation and requirements to third-party AI model providers (via OpenRouter) so they can
        generate a response — that&apos;s how the core feature works. We also use third-party cloud
        infrastructure providers to host the Service (application servers, database, and caching).
        Server locations are managed by those providers and may vary — Archwise doesn&apos;t
        currently pin your data to a single country or region.
      </p>

      <h2>Cookies</h2>
      <p>
        We use a small set of essential cookies to keep you signed in. See our{" "}
        <a href="/cookie-policy">Cookie Policy</a>{" "}
        for the full picture — it&apos;s short, because that&apos;s genuinely all we use today.
      </p>

      <h2>Data retention</h2>
      <p>
        We keep your account and project data for as long as your account is active. If you want
        your account and associated data deleted, email us at{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> — Archwise doesn&apos;t yet have a
        fully self-service data export/deletion tool, so this is handled manually for now.
      </p>

      <h2>Your rights</h2>
      <p>
        You can ask us what data we hold about you, ask us to correct it, or ask us to delete it, by
        emailing <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. We&apos;ll respond as
        promptly as we can.
      </p>

      <h2>Children&apos;s privacy</h2>
      <p>Archwise is not directed at children under 16, and we don&apos;t knowingly collect their data.</p>

      <h2>Changes to this policy</h2>
      <p>
        We&apos;ll update the date at the top of this page whenever this policy changes materially.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about this policy? Reach us at{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
      </p>
    </LegalPageShell>
  );
}
