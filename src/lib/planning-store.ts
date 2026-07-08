import { db } from "@/db";
import { planningArtifacts as planningArtifactsTable } from "@/db/schema";
import { planningArtifacts } from "@/lib/planning-data";
import { asc, sql } from "drizzle-orm";

export async function seedPlanningArtifacts() {
  for (const artifact of planningArtifacts) {
    await db
      .insert(planningArtifactsTable)
      .values({
        slug: artifact.slug,
        title: artifact.title,
        priority: artifact.priority,
        summary: artifact.summary,
        content: artifact.content,
        displayOrder: artifact.displayOrder,
      })
      .onConflictDoUpdate({
        target: planningArtifactsTable.slug,
        set: {
          title: artifact.title,
          priority: artifact.priority,
          summary: artifact.summary,
          content: artifact.content,
          displayOrder: artifact.displayOrder,
          updatedAt: sql`now()`,
        },
      });
  }
}

export async function getPlanningArtifacts() {
  return db
    .select()
    .from(planningArtifactsTable)
    .orderBy(asc(planningArtifactsTable.displayOrder));
}
