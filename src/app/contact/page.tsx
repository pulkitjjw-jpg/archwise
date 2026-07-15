import LegalPageShell from "@/app/components/LegalPageShell";
import { SUPPORT_EMAIL } from "@/lib/legal-pages";

export const metadata = { title: "Contact — Archwise" };

export default function ContactPage() {
  return (
    <LegalPageShell title="Contact" lastUpdated="July 2026">
      <p>
        Archwise is currently built and run by one person, so support here is more direct than
        you&apos;d get from a big company — and sometimes a little slower. Both are true, and
        we&apos;d rather say so than pretend otherwise.
      </p>

      <h2>Email</h2>
      <p>
        <a href={`mailto:${SUPPORT_EMAIL}`} className="text-lg">
          {SUPPORT_EMAIL}
        </a>
      </p>
      <p>
        For anything: bugs, billing questions, feature requests, account/data requests (see our{" "}
        <a href="/privacy">Privacy Policy</a>), or security reports (see <a href="/security">Security</a>).
        Every message is read by a real person.
      </p>

      <h2>Where we&apos;re based</h2>
      <p>
        Archwise is built to be used from anywhere — it isn&apos;t tied to serving users in one
        specific country, and we don&apos;t publish a formal business address at this stage since
        there&apos;s no registered business entity yet.
      </p>
    </LegalPageShell>
  );
}
