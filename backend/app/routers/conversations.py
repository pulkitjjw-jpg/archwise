import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import get_db
from app.dependencies import get_accessible_project, get_editable_project
from app.models import Conversation, Project
from app.rate_limit import limiter
from app.schemas import ConversationCreateRequest
from app.serializers import serialize_conversation
from app.services.llm import get_next_brainstorm_turn

logger = logging.getLogger("app.routers.conversations")

router = APIRouter()


async def _load_history(db: AsyncSession, project_id: uuid.UUID) -> list[Conversation]:
    result = await db.execute(
        select(Conversation).where(Conversation.project_id == project_id).order_by(Conversation.created_at.asc())
    )
    return list(result.scalars().all())


@router.get("/projects/{project_id}/conversations")
async def list_conversations(
    project: Project = Depends(get_accessible_project), db: AsyncSession = Depends(get_db)
) -> dict:
    # Broad access -- any collaborator (viewer or editor) can read the brainstorm transcript.
    history = await _load_history(db, project.id)
    return {"conversations": [serialize_conversation(c) for c in history]}


@router.post("/projects/{project_id}/conversations", status_code=201)
@limiter.limit("60/hour")
async def create_conversation_turn(
    request: Request,
    payload: ConversationCreateRequest,
    project: Project = Depends(get_editable_project),
    db: AsyncSession = Depends(get_db),
) -> dict:
    # Editor-or-owner only -- continuing the brainstorm creates new conversation content, which a
    # read-only "viewer" role shouldn't be able to do (see get_editable_project's docstring).
    if not payload.role or not payload.message or not payload.stage:
        raise HTTPException(status_code=400, detail="We couldn't send your message. Please try again.")

    # 1. Insert user message
    user_turn = Conversation(project_id=project.id, role=payload.role, message=payload.message, stage=payload.stage)
    db.add(user_turn)
    await db.flush()

    # 2. Load conversation history
    history = await _load_history(db, project.id)

    # 3. Project context (already loaded and access-checked by get_editable_project)
    project_name = project.name or "Cloud Project"
    known_knowledge_level = project.knowledge_level or "unknown"
    has_existing_system = bool(project.has_existing_system)

    # 4. Generate AI follow-up. This default is a last-resort safety net only -- under normal
    # operation get_next_brainstorm_turn never raises (it has its own internal fallback that
    # computes a sensible stage/isComplete from the conversation length), so reaching this except
    # block below means something genuinely unexpected happened outside the LLM call itself.
    # "degraded" is never persisted to the Conversation row -- it's a real-time-only signal in
    # THIS response so the frontend can show a clear "I had trouble with that" state on this turn
    # instead of presenting a generic filler as an ordinary question (see ChatArea.tsx).
    assistant_turn_data = {
        "message": "I had some trouble processing that last message clearly -- could you tell me a bit more, or try rephrasing it?",
        "stage": "growth_trigger" if any(h.stage == "growth_trigger" for h in history) else "brainstorm",
        "suggestedReplies": [],
    }
    degraded = False

    try:
        next_turn = await get_next_brainstorm_turn(
            [{"role": h.role, "message": h.message, "stage": h.stage} for h in history],
            project_name,
            settings.openrouter_api_key,
            known_knowledge_level,
            has_existing_system=has_existing_system,
        )
        assistant_turn_data = {
            "message": next_turn["message"],
            "stage": next_turn["stage"],
            "suggestedReplies": next_turn.get("suggestedReplies") or [],
        }
        degraded = bool(next_turn.get("degraded"))
        detected_level = next_turn.get("knowledgeLevel")
        if known_knowledge_level == "unknown" and detected_level in ("technical", "beginner"):
            project.knowledge_level = detected_level
    except Exception as llm_err:
        logger.error("Failed to generate assistant response: %s", llm_err)
        degraded = True

    # 5. Insert assistant message
    assistant_turn = Conversation(
        project_id=project.id,
        role="assistant",
        message=assistant_turn_data["message"],
        stage=assistant_turn_data["stage"],
        suggested_replies=assistant_turn_data["suggestedReplies"],
    )
    db.add(assistant_turn)
    await db.flush()

    await db.commit()

    return {
        "userConversation": serialize_conversation(user_turn),
        "assistantConversation": serialize_conversation(assistant_turn),
        "degraded": degraded,
    }
