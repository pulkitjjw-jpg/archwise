import { db } from "@/db";
import { conversations, projects } from "@/db/schema";
import { getNextBrainstormTurn } from "@/lib/llm";
import { NextResponse } from "next/server";

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
