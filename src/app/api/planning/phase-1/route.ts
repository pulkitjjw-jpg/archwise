import { productContext } from "@/lib/planning-data";
import { getPlanningArtifacts } from "@/lib/planning-store";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const artifacts = await getPlanningArtifacts();

  return NextResponse.json({
    productContext,
    recommendedPriority: "Phase 1 technical specification, API contracts, and data model",
    artifacts,
  });
}
