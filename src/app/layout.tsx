import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";

const DEFAULT_APP_NAME = "Archwise";

// Calls the backend directly (same pattern as projects/[id]/page.tsx's backendFetch) rather than
// the relative /api/settings proxy path -- a Server Component's generateMetadata runs with no
// request context to resolve a relative URL against, unlike a page/middleware that gets a real
// NextRequest. Falls back to the hardcoded default on any failure (missing env, backend down at
// build time, etc.) so a page title is never blank.
//
// revalidate: 60, not cache: "no-store" -- this is a rarely-changed admin setting, not live data,
// and generateMetadata's cache mode propagates to every page under this layout: no-store would
// force the ENTIRE app (including pages with no dynamic data of their own, like /login) into
// server-rendered-on-demand instead of static, for a value that changes maybe once a year. A
// name change takes up to a minute to show up in the <title>; the app's own visible header/hero
// (fetched client-side on those pages) reflects it immediately regardless.
async function getAppName(): Promise<string> {
  const backendUrl = process.env.BACKEND_URL;
  const internalAuthSecret = process.env.INTERNAL_AUTH_SECRET;
  if (!backendUrl || !internalAuthSecret) return DEFAULT_APP_NAME;
  try {
    // /api/v1, not /api -- this bypasses the Next.js catch-all proxy (see backendFetch's comment
    // in src/app/projects/[id]/page.tsx for why a Server Component does that), so it has to know
    // the backend's real, versioned mount point itself instead of getting the translation for free.
    const res = await fetch(`${backendUrl}/api/v1/settings`, {
      headers: { "x-internal-auth": internalAuthSecret },
      next: { revalidate: 60 },
    });
    if (!res.ok) return DEFAULT_APP_NAME;
    const data = await res.json();
    return data.appName || DEFAULT_APP_NAME;
  } catch {
    return DEFAULT_APP_NAME;
  }
}

export async function generateMetadata(): Promise<Metadata> {
  const appName = await getAppName();
  return {
    title: appName,
    description:
      "Archwise turns a plain-language product idea into a complete cloud architecture — with diagrams, cost estimates, security checks, and ready-to-deploy infrastructure code — for AWS, Azure, Google Cloud, and Kubernetes.",
  };
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body className="bg-paper text-ink antialiased">{children}</body>
      </html>
    </ClerkProvider>
  );
}
