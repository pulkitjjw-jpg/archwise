import LegalPageShell from "@/app/components/LegalPageShell";
import { SUPPORT_EMAIL } from "@/lib/legal-pages";

export const metadata = { title: "About — Archwise" };

export default function AboutPage() {
  return (
    <LegalPageShell title="About Archwise" lastUpdated="July 2026">
      <p>
        Most AI architecture tools generate a picture. Archwise generates a{" "}
        <strong>reasoned</strong> design: every component comes with why it was chosen, cost
        estimates grounded in your actual scale and budget, a deterministic security and compliance
        audit, and ready-to-run Terraform or Kubernetes config — not just a diagram to redraw
        yourself later.
      </p>

      <h2>Why it exists</h2>
      <p>
        Going from &quot;I have a product idea&quot; to &quot;here&apos;s a defensible cloud
        architecture for it&quot; usually means either hours of manual design work or a generic
        diagram tool that can&apos;t explain its own choices. Archwise runs a real discovery
        conversation first — scale, budget, team size, compliance needs — then generates a design
        that&apos;s reasoned against that specific context, across AWS, Azure, Google Cloud,
        Kubernetes, or your own servers.
      </p>

      <h2>Who&apos;s behind it</h2>
      <p>
        Archwise is currently built and operated by one person, not a company — an early-stage,
        independently-run product. That&apos;s reflected honestly across the site (our{" "}
        <a href="/terms">Terms</a> and <a href="/privacy">Privacy Policy</a>{" "}
        say so directly) rather than dressed up to look bigger than it is.
      </p>

      <h2>Get in touch</h2>
      <p>
        Questions, feedback, or just want to say what you built with it? We&apos;d genuinely like to
        hear from you at <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
      </p>
    </LegalPageShell>
  );
}
