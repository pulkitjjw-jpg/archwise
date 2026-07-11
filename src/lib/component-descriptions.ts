// Plain-language, one-line descriptions per component type, for the Simple view toggle.
// Frontend-only presentational data -- doesn't touch what the backend generates or stores.

const TYPE_DESCRIPTIONS: Record<string, string> = {
  cdn: "Speeds up your app by caching content in locations close to your users around the world.",
  compute: "Runs your application's core logic — the code that actually handles user requests.",
  worker: "Processes tasks in the background, like generating reports or resizing images, without making users wait.",
  database: "Stores your app's structured data — things like records, bookings, or accounts — safely and reliably.",
  storage: "Stores files and uploads (images, PDFs, documents) cheaply and durably.",
  queue: "Holds tasks that need to happen soon but don't have to happen instantly, so spikes don't slow the app down.",
  cache: "Keeps frequently-used data close at hand so repeat requests come back almost instantly.",
  auth: "Handles user sign-in, passwords, and who's allowed to access what.",
  tokenization: "Swaps sensitive data (like card numbers) for safe placeholder tokens, so the real data never touches the rest of your systems directly.",
  "audit-log": "Keeps a tamper-proof record of who did what and when — required for compliance reviews.",
  "phi-vault": "A specially secured, separate store for protected health information, locked down beyond your normal data.",
  deidentification: "Automatically strips or masks personal details from records before they're used for anything else, like analytics.",
};

export function getPlainDescription(componentType: string, componentId: string): string {
  if (componentType === "compute" && componentId === "worker") {
    return TYPE_DESCRIPTIONS.worker;
  }
  return TYPE_DESCRIPTIONS[componentType] || "Supports the system as part of the overall architecture.";
}
