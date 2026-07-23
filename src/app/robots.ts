import type { MetadataRoute } from "next";

// NEXT_PUBLIC_SITE_URL should be set to the real production domain once one exists -- this
// placeholder keeps the file syntactically complete and locally testable (visit /robots.txt)
// without a real domain configured yet.
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://archwise.example.com";

// Next.js's built-in metadata file convention -- this file alone generates a real /robots.txt at
// build/request time, no static file in public/ needed (and none existed before this).
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // Authenticated/private surfaces -- nothing a crawler should index or spend budget on.
      disallow: ["/dashboard", "/projects/", "/admin", "/profile", "/share/", "/api/"],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
