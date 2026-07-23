"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/admin", label: "Usage" },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/limits", label: "Limits" },
  { href: "/admin/feedback", label: "Feedback" },
  { href: "/admin/settings", label: "Settings" },
];

export default function AdminNav() {
  const pathname = usePathname();
  return (
    <nav className="flex items-center gap-1.5 rounded-2xl border border-line bg-panel p-1.5 shadow-sm">
      {TABS.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`rounded-xl px-4 py-1.5 text-xs font-bold uppercase tracking-wider transition ${
              active ? "bg-ink text-white" : "text-ink-muted hover:text-ink"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
