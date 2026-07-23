import LegalPageShell from "@/app/components/LegalPageShell";

export const metadata = { title: "How to Use — Archwise" };

export default function HowToUsePage() {
  return (
    <LegalPageShell title="How to Use Archwise" lastUpdated="July 2026">
      <p>
        A full walkthrough of the actual flow, step by step — from a blank idea to deployable
        Terraform or Kubernetes config.
      </p>

      <h2>1. Start a project</h2>
      <p>
        From your dashboard, click <strong>+ New Project</strong>. Give it a name, then describe
        your idea in the <strong>Product Idea &amp; Context</strong> box — a few sentences is
        enough (&quot;a marketplace app connecting local tutors with students, expecting a few
        thousand users in year one&quot;). If you&apos;re modernizing an existing system rather
        than starting from scratch, check <strong>I have an existing system</strong> to describe
        it or upload a short .txt/.md brief. Click <strong>Launch Brainstorm Workspace</strong> to
        begin.
      </p>

      <h2>2. Brainstorm the details</h2>
      <p>
        You&apos;ll land in the <strong>Interactive Discovery Chat</strong>. A guided conversation
        asks the questions that actually shape the architecture — expected scale, budget, team
        size, compliance needs — often with clickable suggested replies so you don&apos;t have to
        type everything out. Answer at your own pace; when enough detail has been gathered, a
        banner reading <strong>&quot;Discovery complete&quot;</strong> appears and your answers are
        automatically turned into structured requirements.
      </p>

      <h2>3. Review your requirements</h2>
      <p>
        The <strong>Your Project Details</strong> tab shows what was extracted: what the product
        does, plus how it should perform — expected traffic, read/write pattern, data types,
        latency, budget range, team maturity, and security/compliance needs. Anything you want to
        correct or fill in is editable directly — click <strong>Edit</strong>, adjust a field (AI
        suggestions are offered per field), and <strong>Save Requirements</strong>. When it looks
        right, click <strong>Go to Architecture Diagram</strong>.
      </p>

      <h2>4. Generate and explore the architecture</h2>
      <p>
        Click <strong>Generate Architecture Design</strong> and Archwise reasons through a real
        design — not a generic template. The <strong>Multi-Cloud Design Board</strong> that
        follows lets you switch between AWS, Azure, GCP, Kubernetes, and a private/on-prem view of
        the same design, and between several ways of looking at it:
      </p>
      <ul>
        <li><strong>Diagram</strong> — the interactive topology, with a cost breakdown and an overall Architecture Health Score.</li>
        <li><strong>Compare Clouds</strong> — the same design side by side across providers.</li>
        <li><strong>User Journey</strong> — a plain-language walkthrough of how a real request flows through your design.</li>
        <li><strong>Migration Roadmap</strong> — shown only if you flagged an existing system, a step-by-step path to get there.</li>
      </ul>
      <p>
        The <strong>Security Findings</strong> panel lists a deterministic security/compliance
        audit of the design. Curious what a design decision would change? The
        <strong> What-If Simulator</strong> lets you try alternatives without committing to them.
      </p>

      <h2>5. Fix security findings in one click</h2>
      <p>
        Many findings in the Security Findings panel show a <strong>Fix this</strong> button.
        Click it, confirm with <strong>Yes, fix it</strong>, and Archwise applies the fix directly
        to your architecture — no manual editing — and shows you exactly what changed as a
        before/after diff, scoped to just the affected component.
      </p>

      <h2>6. Export what you need</h2>
      <p>
        When you&apos;re ready to build it for real, export options are on the same screen:
      </p>
      <ul>
        <li><strong>Export Terraform</strong> / <strong>Export Kubernetes Config</strong> — real, deployable <code>.tf</code> files or Kubernetes YAML manifests, zipped, matching whichever provider tab is active.</li>
        <li><strong>Export Image</strong> — a PNG/SVG of just the diagram.</li>
        <li><strong>Executive Summary</strong> — a non-technical PDF (no diagrams or code) for sharing with stakeholders who just need the cost/security picture.</li>
      </ul>
      <p>Every export can also be emailed to yourself instead of downloaded directly.</p>

      <h2>7. Report a change later</h2>
      <p>
        Your architecture isn&apos;t frozen once it&apos;s generated. Go back to the same chat and
        describe what changed — &quot;scale increased to 50k users,&quot; a new feature, a bigger
        budget — using the <strong>Report a change</strong> input. Archwise analyzes the impact and
        proposes specific updates in a <strong>Chat-Proposed Changes</strong> panel, where you can
        accept or reject each one individually (or all at once) before anything is applied. Every
        change is versioned, so nothing is ever silently overwritten.
      </p>

      <h2>Free vs. paid usage</h2>
      <p>
        The free plan renews every 7 days with enough brainstorm sessions, architecture
        generations, and updates to try the whole flow above. The paid plan gets its own daily
        allowance instead. See <a href="/pricing">pricing</a> for exact numbers, or the{" "}
        <a href="/help">Help &amp; FAQ page</a> if something doesn&apos;t match what you&apos;re
        seeing.
      </p>
    </LegalPageShell>
  );
}
