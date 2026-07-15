import LegalPageShell from "@/app/components/LegalPageShell";
import { SUPPORT_EMAIL } from "@/lib/legal-pages";

export const metadata = { title: "Refund Policy — Archwise" };

export default function RefundPolicyPage() {
  return (
    <LegalPageShell title="Refund Policy" lastUpdated="July 2026">
      <p>
        Archwise&apos;s paid plan is a pay-as-you-go monthly subscription. Here&apos;s exactly how
        billing and cancellation work — written in plain language, not legal jargon.
      </p>

      <h2>No refunds for the current billing period</h2>
      <p>
        Once you&apos;re charged for a billing period, that charge is final — we don&apos;t offer
        refunds for the current or any past billing period. This is the standard approach most
        subscription software uses (Slack and Freshworks, for example, work the same way): you&apos;re
        paying for access during that period, not for a specific amount of usage within it.
      </p>

      <h2>Cancelling stops the next renewal</h2>
      <p>
        If you cancel, your subscription won&apos;t renew — but you keep paid access for the rest of
        the period you&apos;ve already paid for. There&apos;s no partial or prorated refund for the
        unused portion of a current cycle; cancelling simply means you won&apos;t be charged again
        going forward.
      </p>

      <h2>Something went wrong on our end?</h2>
      <p>
        If you were charged due to a billing error or a Service outage that genuinely prevented you
        from using Archwise, email us at{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>{" "}
        and we&apos;ll look into it and make it right on a case-by-case basis. This policy describes
        our standard terms, not a promise that we won&apos;t ever help — just that refunds aren&apos;t
        automatic.
      </p>

      <h2>Free tier</h2>
      <p>
        The free tier has no payment involved, so there&apos;s nothing to refund there — see our{" "}
        <a href="/pricing">Pricing</a>{" "}
        page for what&apos;s included.
      </p>
    </LegalPageShell>
  );
}
