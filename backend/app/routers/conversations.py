import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import get_db
from app.models import Conversation, Project
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
async def list_conversations(project_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> dict:
    history = await _load_history(db, project_id)
    return {"conversations": [serialize_conversation(c) for c in history]}


@router.post("/projects/{project_id}/conversations", status_code=201)
async def create_conversation_turn(
    project_id: uuid.UUID, payload: ConversationCreateRequest, db: AsyncSession = Depends(get_db)
) -> dict:
    if not payload.role or not payload.message or not payload.stage:
        raise HTTPException(status_code=400, detail="role, message, and stage are required")

    # 1. Insert user message
    user_turn = Conversation(project_id=project_id, role=payload.role, message=payload.message, stage=payload.stage)
    db.add(user_turn)
    await db.flush()

    # 2. Load conversation history
    history = await _load_history(db, project_id)

    # 3. Load project context
    project = (await db.execute(select(Project).where(Project.id == project_id))).scalar_one_or_none()
    project_name = (project.name if project else None) or "Cloud Project"
    known_knowledge_level = (project.knowledge_level if project else None) or "unknown"
    has_existing_system = bool(project.has_existing_system) if project else False

    # 4. Generate AI follow-up
    assistant_turn_data = {
        "message": "Thank you for the input. Could you share more about your scaling or compliance requirements?",
        "stage": "brainstorm",
        "suggestedReplies": [],
    }

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
        detected_level = next_turn.get("knowledgeLevel")
        if project is not None and known_knowledge_level == "unknown" and detected_level in ("technical", "beginner"):
            project.knowledge_level = detected_level
    except Exception as llm_err:
        logger.error("Failed to generate assistant response: %s", llm_err)

    # 5. Insert assistant message
    assistant_turn = Conversation(
        project_id=project_id,
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
    }
