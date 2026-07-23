import type { Metadata } from "next";
import PricingClient from "./PricingClient";

// See src/app/page.tsx's own comment on why this thin Server Component wrapper exists -- the
// same "use client" + generateMetadata incompatibility applies here.
export const metadata: Metadata = {
  title: "Pricing — Archwise",
  description:
    "Simple, honest pricing for Archwise's AI cloud architecture generator. Free tier included, no credit card required.",
};

export default function PricingPage() {
  return <PricingClient />;
}
