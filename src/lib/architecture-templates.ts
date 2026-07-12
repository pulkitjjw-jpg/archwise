// Architecture Templates / Starter Library (Workstream T6) -- pre-filled STARTING CONTEXT for the
// intake form, not a pre-built architecture. Picking one only fills in the "Product Idea &
// Context" textarea with a realistic starting paragraph for that kind of product; the user still
// goes through the exact same multi-turn brainstorm afterward (scale, budget, compliance, team
// maturity are deliberately left for the conversation to surface, not pre-answered here) --
// this only accelerates describing WHAT the product is, never skips gathering HOW it needs to run.

export type ArchitectureTemplate = {
  id: string;
  label: string;
  emoji: string;
  tagline: string;
  namePlaceholder: string;
  ideaText: string;
};

export const ARCHITECTURE_TEMPLATES: ArchitectureTemplate[] = [
  {
    id: "saas-multi-tenant",
    label: "SaaS Multi-Tenant",
    emoji: "🏢",
    tagline: "B2B software serving many separate customer accounts",
    namePlaceholder: "e.g. TeamOps Workspace",
    ideaText:
      "A B2B SaaS product where each customer (a company) gets its own isolated workspace -- their own users, data, and settings, with no visibility into other customers' data. Includes team/role management (admin vs. member permissions), a core workflow feature specific to the product's purpose, and usage-based or seat-based billing. Customers sign up, invite their team, and configure their workspace independently of one another.",
  },
  {
    id: "ecommerce",
    label: "E-Commerce",
    emoji: "🛒",
    tagline: "Online storefront with catalog, cart, and checkout",
    namePlaceholder: "e.g. Northgate Marketplace",
    ideaText:
      "An online store where customers browse a product catalog, add items to a cart, and check out with a card payment. Needs product search/filtering, inventory tracking so items can't be oversold, order history for customers, and an admin view for merchants to manage listings and fulfill orders. Product images and descriptions are a core part of the browsing experience.",
  },
  {
    id: "content-media",
    label: "Content / Media Platform",
    emoji: "🎬",
    tagline: "Video, article, or podcast platform with a content library",
    namePlaceholder: "e.g. Waypoint Streaming",
    ideaText:
      "A platform where creators upload content (video, articles, or audio) and an audience browses/streams it. Needs content upload and processing (e.g. video transcoding for different qualities), a browsing/discovery feed, and playback that starts quickly even for large media files. Some content may be free and some subscriber-only, so there's a distinction between public and gated content.",
  },
  {
    id: "fintech",
    label: "Fintech",
    emoji: "💳",
    tagline: "Payments, lending, or banking-adjacent product",
    namePlaceholder: "e.g. Ledgerly Payments",
    ideaText:
      "A financial product that moves or tracks customers' money -- e.g. processing payments, tracking balances, or facilitating transfers between accounts. Needs strong transaction integrity (every movement of money must be accurately recorded and auditable), user identity verification before money moves, and integration with an external payment processor or banking partner rather than handling raw card/bank details directly wherever possible.",
  },
  {
    id: "healthtech",
    label: "Healthtech",
    emoji: "🏥",
    tagline: "Patient data, clinical workflows, or healthcare providers",
    namePlaceholder: "e.g. Meridian Patient Portal",
    ideaText:
      "A healthcare product used by patients and/or clinical staff that involves patient health information -- e.g. appointment scheduling, medical records access, or care coordination between providers. Needs strict access controls around who can see which patient's data, an audit trail of who accessed or changed records, and secure messaging or data-sharing between patients and providers.",
  },
];
