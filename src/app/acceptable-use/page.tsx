import LegalPageShell from "@/app/components/LegalPageShell";
import { SUPPORT_EMAIL } from "@/lib/legal-pages";

export const metadata = { title: "Acceptable Use Policy — Archwise" };

export default function AcceptableUsePage() {
  return (
    <LegalPageShell title="Acceptable Use Policy" lastUpdated="July 2026">
      <p>
        This policy covers what you can&apos;t do with Archwise. It exists to keep the Service
        usable and fairly priced for everyone, including on the free tier.
      </p>

      <h2>Don&apos;t</h2>
      <ul>
        <li>Use Archwise for anything illegal, or to design systems intended to facilitate illegal activity.</li>
        <li>
          Try to bypass, automate around, or abuse usage limits or rate limits — including scripting
          repeated free-tier signups to get around the free plan&apos;s caps.
        </li>
        <li>Attempt to probe, scan, or attack the Service&apos;s infrastructure, or interfere with other users&apos; access to it.</li>
        <li>Scrape, resell, or redistribute the Service or its output as your own competing product.</li>
        <li>Share your account credentials or let someone else use your account.</li>
        <li>Use the brainstorm chat or any generation feature to produce harmful, abusive, or illegal content unrelated to designing a real system.</li>
        <li>Attempt to reverse-engineer or extract the underlying AI models or rule engine.</li>
      </ul>

      <h2>What happens if this is violated</h2>
      <p>
        We may suspend or terminate access for violations of this policy. For anything ambiguous,
        we&apos;d rather talk it through than jump straight to enforcement — reach out at{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> if you&apos;re not sure whether
        something&apos;s okay.
      </p>
    </LegalPageShell>
  );
}
