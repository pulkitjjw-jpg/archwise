import type { Metadata } from "next";
import HomeClient from "@/app/components/HomeClient";

// A Server Component wrapper purely so this route can export its own metadata -- the actual
// homepage content (HomeClient) has to stay a Client Component (it fetches the live app name
// client-side), and a "use client" file cannot export `metadata`/`generateMetadata` in the App
// Router. Without this split, every page in the app inherited the exact same title/description
// from the root layout (confirmed live: pricing, signup, dashboard all showed identical <title>
// and meta description as the homepage) -- a real SEO gap, not a hypothetical one.
export const metadata: Metadata = {
  title: "Archwise — AI Cloud Architecture Generator",
  description:
    "Describe your product idea in plain language and get a genuinely-reasoned multi-cloud architecture — AWS, Azure, GCP, and Kubernetes — with real cost estimates, a deterministic security/compliance audit, and ready-to-run Terraform or Kubernetes config.",
};

export default function HomePage() {
  return <HomeClient />;
}
