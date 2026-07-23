// Single source of truth for the legal/trust page set -- used by both LegalPageShell's cross-page
// nav and SiteFooter's link columns, so adding a ninth page later means updating this list once,
// not every place it's linked from.
export const LEGAL_PAGES = [
  { href: "/about", label: "About" },
  { href: "/security", label: "Security" },
  { href: "/contact", label: "Contact" },
  { href: "/how-to-use", label: "How to Use" },
  { href: "/help", label: "Help & FAQ" },
  { href: "/terms", label: "Terms of Service" },
  { href: "/privacy", label: "Privacy Policy" },
  { href: "/refund-policy", label: "Refund Policy" },
  { href: "/cookie-policy", label: "Cookie Policy" },
  { href: "/acceptable-use", label: "Acceptable Use Policy" },
] as const;

// Placeholder support address -- the domain (archwise.app) has not actually been purchased yet.
// Replace with a real, monitored inbox once it has. Intentionally not flagged as a placeholder in
// the visible page text (an obvious "PLACEHOLDER" tag next to a support email would undermine
// trust on a Terms/Privacy/Contact page more than the eventual domain swap ever would); this
// comment is the actual tracking mechanism for it.
export const SUPPORT_EMAIL = "support@archwise.app";
