import LegalPageShell from "@/app/components/LegalPageShell";
import FeedbackForm from "@/app/components/FeedbackForm";

export const metadata = { title: "Help & FAQ — Archwise" };

export default function HelpPage() {
  return (
    <LegalPageShell title="Help & FAQ" lastUpdated="July 2026">
      <p>
        Archwise is new software, and we&apos;d rather hear what&apos;s confusing or missing
        directly from you than guess. The form at the bottom of this page goes straight to the
        person building it.
      </p>

      <h2>What does Archwise actually do?</h2>
      <p>
        You describe a product idea in plain language. A guided brainstorm chat asks a few
        follow-up questions — expected scale, budget, compliance needs — then generates a real,
        reasoned cloud architecture: which components to use, why, cost estimates per provider,
        a security/compliance check, and ready-to-run Terraform or Kubernetes config.
      </p>

      <h2>How do the free and paid plans work?</h2>
      <p>
        The free plan resets every 7 days, with enough brainstorm sessions, architecture
        generations, and architecture updates to try every main feature and see real value —
        not a crippled demo. The paid plan gets its own daily allowance that renews every day.
        Exact numbers are shown on the <a href="/pricing">pricing page</a>.
      </p>

      <h2>Can I have more than one project?</h2>
      <p>
        Yes — every project you create is saved to your account, with its own brainstorm history,
        requirements, and architecture versions. There&apos;s no limit on how many projects you can
        have open at once, only on how many new brainstorm sessions / generations / updates you can
        create within your plan&apos;s reset window.
      </p>

      <h2>What happens if I change my mind about something in my architecture?</h2>
      <p>
        Report the change in the same project&apos;s chat — the architecture evolves with full
        version history. Nothing is ever silently overwritten; you can always see what it looked
        like before.
      </p>

      <h2>Something looks wrong, or a feature isn&apos;t working</h2>
      <p>
        Please tell us below, or email <a href="/contact">our support address</a>. Include what you
        were trying to do and what happened instead — the more specific, the faster it gets fixed.
      </p>

      <h2>Send feedback</h2>
      <div className="mt-4 max-w-md">
        <FeedbackForm />
      </div>
    </LegalPageShell>
  );
}
