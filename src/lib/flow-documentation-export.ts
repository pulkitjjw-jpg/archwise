// Builds and downloads a Markdown "Architecture Documentation" file -- deliberately a separate
// export action from both Export TF (deployable code) and Export Image (just the picture), per
// the explicit ask to keep these three concerns from merging into one dropdown. This one is the
// only one with narrative explanation baked in.

export interface FlowDocComponent {
  name: string;
  type: string;
  serviceName: string;
  reasoning: string;
}

export interface FlowDocInput {
  projectName: string;
  providerLabel: string;
  version: string;
  conversationSummary: string | null;
  flowStory: string | null;
  components: FlowDocComponent[];
  costMin: number;
  costMax: number;
}

function escapeMd(s: string): string {
  return s.replace(/\|/g, "\\|");
}

export function buildFlowDocumentationMarkdown(input: FlowDocInput): string {
  const lines: string[] = [];
  lines.push(`# ${input.projectName} — Architecture Documentation`);
  lines.push("");
  lines.push(`**Version:** ${input.version} · **Provider:** ${input.providerLabel} · **Generated:** ${new Date().toLocaleDateString()}`);
  lines.push("");

  if (input.conversationSummary) {
    lines.push("## Project Summary");
    lines.push("");
    lines.push(input.conversationSummary);
    lines.push("");
  }

  lines.push(`## Architecture Flow (${input.providerLabel})`);
  lines.push("");
  lines.push(input.flowStory || "_Flow story not available for this provider yet — open the Architecture tab with this provider selected to generate it._");
  lines.push("");

  lines.push("## Components");
  lines.push("");
  lines.push("| Component | Type | Service | Why |");
  lines.push("|---|---|---|---|");
  for (const c of input.components) {
    lines.push(`| ${escapeMd(c.name)} | ${escapeMd(c.type)} | ${escapeMd(c.serviceName)} | ${escapeMd(c.reasoning)} |`);
  }
  lines.push("");

  lines.push("## Estimated Cost");
  lines.push("");
  lines.push(`$${input.costMin} – $${input.costMax}/mo`);
  lines.push("");

  return lines.join("\n");
}

export function downloadMarkdown(content: string, filenameBase: string) {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${filenameBase}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
