import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Cloud Architecture Generator",
  description:
    "An AI-powered SaaS that generates HLD, LLD, cloud mappings, cost estimates, IaC, and living architecture versions from a plain-language product idea.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-slate-100 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
