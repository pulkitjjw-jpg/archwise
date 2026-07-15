import Link from "next/link";

const COLUMNS = [
  {
    heading: "Product",
    links: [
      { href: "/pricing", label: "Pricing" },
      { href: "/security", label: "Security" },
    ],
  },
  {
    heading: "Company",
    links: [
      { href: "/about", label: "About" },
      { href: "/contact", label: "Contact" },
    ],
  },
  {
    heading: "Legal",
    links: [
      { href: "/terms", label: "Terms of Service" },
      { href: "/privacy", label: "Privacy Policy" },
      { href: "/refund-policy", label: "Refund Policy" },
      { href: "/cookie-policy", label: "Cookie Policy" },
      { href: "/acceptable-use", label: "Acceptable Use" },
    ],
  },
];

// Shared marketing-site footer -- used on the landing page and pricing page (and any other public
// page that wants it), NOT on the logged-in app screens (dashboard/admin/project workspace),
// which have their own functional chrome rather than marketing-site navigation.
export default function SiteFooter({ appName = "Archwise" }: { appName?: string }) {
  return (
    <footer className="mt-24 border-t border-line pt-10 pb-6 text-xs text-ink-faint">
      <div className="grid gap-8 sm:grid-cols-[1.3fr_repeat(3,1fr)]">
        <div>
          <span className="text-sm font-black tracking-tight text-ink">{appName}</span>
          <p className="mt-2 max-w-[220px] leading-relaxed">
            AI-reasoned multi-cloud architecture, from a plain-language idea.
          </p>
        </div>
        {COLUMNS.map((col) => (
          <div key={col.heading}>
            <p className="text-[10px] font-bold uppercase tracking-wider text-ink-faint">{col.heading}</p>
            <ul className="mt-3 space-y-2">
              {col.links.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="hover:text-ink-muted">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="mt-10 flex flex-col gap-3 border-t border-line pt-6 sm:flex-row sm:items-center sm:justify-between">
        <span>© {new Date().getFullYear()} {appName}. Built and run independently.</span>
        <div className="flex items-center gap-4">
          <Link href="/login" className="hover:text-ink-muted">Log In</Link>
          <Link href="/signup" className="hover:text-ink-muted">Sign Up</Link>
        </div>
      </div>
    </footer>
  );
}
