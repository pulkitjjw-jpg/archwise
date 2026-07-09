import { db } from "@/db";
import { conversations, DEFAULT_INDUSTRY_CONTEXT, requirements } from "@/db/schema";
import { extractRequirementsFromHistory } from "@/lib/llm";
import { asc, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    // Fetch the latest version of requirements
    const [record] = await db
      .select()
      .from(requirements)
      .where(eq(requirements.projectId, id))
      .orderBy(desc(requirements.version))
      .limit(1);

    // No requirements extracted yet is an expected, common state (e.g. brainstorm still in
    // progress) — respond 200 with a null payload rather than 404, so routine polling from the
    // client doesn't surface as a failed-request error in the browser console.
    if (!record) {
      return NextResponse.json({ requirements: null });
    }

    return NextResponse.json({ requirements: record });
  } catch (error: any) {
    console.error("Error fetching requirements:", error);
    return NextResponse.json({ error: error.message || "Failed to fetch requirements" }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;

    // Load conversation history
    const history = await db
      .select()
      .from(conversations)
      .where(eq(conversations.projectId, id))
      .orderBy(asc(conversations.createdAt));

    // Extract requirements using LLM
    const extracted = await extractRequirementsFromHistory(
      history.map((h) => ({
        role: h.role,
        message: h.message,
      }))
    );

    // Get current latest version to increment
    const [latest] = await db
      .select()
      .from(requirements)
      .where(eq(requirements.projectId, id))
      .orderBy(desc(requirements.version))
      .limit(1);

    const nextVersion = latest ? latest.version + 1 : 1;

    // Always insert a new record for version history
    const [record] = await db
      .insert(requirements)
      .values({
        projectId: id,
        functional: extracted.functional,
        nonFunctional: extracted.nonFunctional,
        industryContext: extracted.industryContext,
        version: nextVersion,
      })
      .returning();

    return NextResponse.json({ requirements: record }, { status: 201 });
  } catch (error: any) {
    console.error("Error extracting requirements:", error);
    return NextResponse.json({ error: error.message || "Failed to extract requirements" }, { status: 500 });
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { functional, nonFunctional } = await request.json();

    if (!functional || !nonFunctional) {
      return NextResponse.json({ error: "functional and nonFunctional are required" }, { status: 400 });
    }

    // Get current latest version to increment
    const [latest] = await db
      .select()
      .from(requirements)
      .where(eq(requirements.projectId, id))
      .orderBy(desc(requirements.version))
      .limit(1);

    const nextVersion = latest ? latest.version + 1 : 1;

    // Manual edits via the requirements panel don't touch industry context — carry the
    // latest detected value forward rather than letting the column default silently wipe it.
    const industryContext = latest?.industryContext ?? DEFAULT_INDUSTRY_CONTEXT;

    // Always insert a new record for version history
    const [record] = await db
      .insert(requirements)
      .values({
        projectId: id,
        functional,
        nonFunctional,
        industryContext,
        version: nextVersion,
      })
      .returning();

    return NextResponse.json({ requirements: record });
  } catch (error: any) {
    console.error("Error saving requirements:", error);
    return NextResponse.json({ error: error.message || "Failed to save requirements" }, { status: 500 });
  }
}
