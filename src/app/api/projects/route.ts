import { db } from "@/db";
import { conversations, projects } from "@/db/schema";
import { getNextBrainstormTurn } from "@/lib/llm";
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

export type ProjectStatus =
  | "just_started"
  | "brainstorm_in_progress"
  | "requirements_complete"
  | "architecture_ready";

function deriveStatus(row: { conversationCount: number; requirementCount: number; architectureCount: number }): ProjectStatus {
  if (row.architectureCount > 0) return "architecture_ready";
  if (row.requirementCount > 0) return "requirements_complete";
  if (row.conversationCount > 0) return "brainstorm_in_progress";
  return "just_started";
}

export async function GET() {
  try {
    // Single aggregated query (no N+1): each child table is pre-aggregated per project_id in
    // its own subquery before joining, so the join itself never fans out across tables.
    const result = await db.execute(sql`
      SELECT
        p.id,
        p.name,
        p.owner,
        p.created_at AS "createdAt",
        p.current_version AS "currentVersion",
        COALESCE(conv.cnt, 0) AS "conversationCount",
        COALESCE(req.cnt, 0) AS "requirementCount",
        COALESCE(arch.cnt, 0) AS "architectureCount",
        GREATEST(p.created_at, conv.last, req.last, arch.last) AS "lastUpdated"
      FROM projects p
      LEFT JOIN (
        SELECT project_id, COUNT(*) AS cnt, MAX(created_at) AS last
        FROM conversations GROUP BY project_id
      ) conv ON conv.project_id = p.id
      LEFT JOIN (
        SELECT project_id, COUNT(*) AS cnt, MAX(created_at) AS last
        FROM requirements GROUP BY project_id
      ) req ON req.project_id = p.id
      LEFT JOIN (
        SELECT project_id, COUNT(*) AS cnt, MAX(created_at) AS last
        FROM architectures GROUP BY project_id
      ) arch ON arch.project_id = p.id
      ORDER BY "lastUpdated" DESC NULLS LAST
    `);

    const projectsWithStatus = (result.rows as any[]).map((row) => {
      const normalized = {
        conversationCount: Number(row.conversationCount),
        requirementCount: Number(row.requirementCount),
        architectureCount: Number(row.architectureCount),
      };
      return {
        id: row.id,
        name: row.name,
        owner: row.owner,
        createdAt: row.createdAt,
        currentVersion: row.currentVersion,
        lastUpdated: row.lastUpdated,
        ...normalized,
        status: deriveStatus(normalized),
      };
    });

    return NextResponse.json({ projects: projectsWithStatus });
  } catch (error: any) {
    console.error("Error listing projects:", error);
    return NextResponse.json({ error: error.message || "Failed to list projects" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { name, ideaText } = await request.json();

    if (!name || !ideaText) {
      return NextResponse.json({ error: "name and ideaText are required" }, { status: 400 });
    }

    // Insert the project
    const [project] = await db
      .insert(projects)
      .values({
        name,
        currentVersion: "0.1.0",
      })
      .returning();

    // Log the initial idea as the first user conversation turn
    await db.insert(conversations).values({
      projectId: project.id,
      role: "user",
      message: ideaText,
      stage: "intake",
    });

    // Call LLM to get the first brainstorm question
    let firstQuestion = "Thank you. Let's start the brainstorm. Can you tell me what target traffic size or request volume you expect?";
    try {
      const turn = await getNextBrainstormTurn(
        [{ role: "user", message: ideaText, stage: "intake" }],
        name
      );
      firstQuestion = turn.message;
    } catch (llmErr) {
      console.error("Failed to generate first brainstorm question:", llmErr);
    }

    // Log the first AI follow-up question
    await db.insert(conversations).values({
      projectId: project.id,
      role: "assistant",
      message: firstQuestion,
      stage: "brainstorm",
    });

    return NextResponse.json({ projectId: project.id }, { status: 201 });
  } catch (error: any) {
    console.error("Error creating project:", error);
    return NextResponse.json({ error: error.message || "Failed to create project" }, { status: 500 });
  }
}
