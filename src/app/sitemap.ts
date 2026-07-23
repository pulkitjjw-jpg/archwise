import type { MetadataRoute } from "next";

// See robots.ts's own note on this placeholder.
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://archwise.example.com";

// Next.js's built-in metadata file convention -- generates a real /sitemap.xml, no static file
// needed. Only genuinely public, indexable pages -- /dashboard, /projects/*, /admin, /profile,
// /share/* all require a login (or an unguessable token) and have no reason to be crawled/listed.
export default function sitemap(): MetadataRoute.Sitemap {
  const staticRoutes = [
    "",
    "/pricing",
    "/login",
    "/signup",
    "/about",
    "/contact",
    "/security",
    "/privacy",
    "/terms",
    "/cookie-policy",
    "/acceptable-use",
    "/refund-policy",
  ];

  return staticRoutes.map((route) => ({
    url: `${SITE_URL}${route}`,
    lastModified: new Date(),
    changeFrequency: route === "" || route === "/pricing" ? "weekly" : "monthly",
    priority: route === "" ? 1 : route === "/pricing" || route === "/signup" ? 0.8 : 0.5,
  }));
}
