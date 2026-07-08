import { db } from "@/db";
import { conversations, projects } from "@/db/schema";
import { getNextBrainstormTurn } from "@/lib/llm";
import { asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const history = await db
      .select()
      .from(conversations)
      .where(eq(conversations.projectId, id))
      .orderBy(asc(conversations.createdAt));

    return NextResponse.json({ conversations: history });
  } catch (error: any) {
    console.error("Error fetching conversations:", error);
    return NextResponse.json({ error: error.message || "Failed to fetch conversations" }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { role, message, stage } = await request.json();

    if (!role || !message || !stage) {
      return NextResponse.json({ error: "role, message, and stage are required" }, { status: 400 });
    }

    // 1. Insert user message
    const [userTurn] = await db
      .insert(conversations)
      .values({
        projectId: id,
        role,
        message,
        stage,
      })
      .returning();

    // 2. Load conversation history
    const history = await db
      .select()
      .from(conversations)
      .where(eq(conversations.projectId, id))
      .orderBy(asc(conversations.createdAt));

    // 3. Load project context
    const [project] = await db.select().from(projects).where(eq(projects.id, id));
    const projectName = project?.name || "Cloud Project";

    // 4. Generate AI follow-up
    let assistantTurnData = {
      message: "Thank you for the input. Could you share more about your scaling or compliance requirements?",
      stage: "brainstorm",
    };

    try {
      const nextTurn = await getNextBrainstormTurn(
        history.map((h) => ({
          role: h.role,
          message: h.message,
          stage: h.stage,
        })),
        projectName
      );
      assistantTurnData = {
        message: nextTurn.message,
        stage: nextTurn.stage,
      };
    } catch (llmErr) {
      console.error("Failed to generate assistant response:", llmErr);
    }

    // 5. Insert assistant message
    const [assistantTurn] = await db
      .insert(conversations)
      .values({
        projectId: id,
        role: "assistant",
        message: assistantTurnData.message,
        stage: assistantTurnData.stage,
      })
      .returning();

    return NextResponse.json({
      userConversation: userTurn,
      assistantConversation: assistantTurn,
    }, { status: 201 });
  } catch (error: any) {
    console.error("Error creating conversation turn:", error);
    return NextResponse.json({ error: error.message || "Failed to create conversation turn" }, { status: 500 });
  }
}
