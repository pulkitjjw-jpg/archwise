import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import get_db
from app.models import Conversation, Project
from app.schemas import ProjectCreateRequest
from app.serializers import serialize_project
from app.services.llm import get_next_brainstorm_turn

logger = logging.getLogger("app.routers.projects")

router = APIRouter()


def _derive_status(conversation_count: int, requirement_count: int, architecture_count: int) -> str:
    if architecture_count > 0:
        return "architecture_ready"
    if requirement_count > 0:
        return "requirements_complete"
    if conversation_count > 0:
        return "brainstorm_in_progress"
    return "just_started"


@router.get("/projects")
async def list_projects(db: AsyncSession = Depends(get_db)) -> dict:
    # Single aggregated query (no N+1): each child table is pre-aggregated per project_id in
    # its own subquery before joining, so the join itself never fans out across tables.
    result = await db.execute(
        text(
            """
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
            """
        )
    )

    projects_with_status = []
    for row in result.mappings():
        conversation_count = int(row["conversationCount"])
        requirement_count = int(row["requirementCount"])
        architecture_count = int(row["architectureCount"])
        projects_with_status.append(
            {
                "id": str(row["id"]),
                "name": row["name"],
                "owner": row["owner"],
                "createdAt": row["createdAt"],
                "currentVersion": row["currentVersion"],
                "lastUpdated": row["lastUpdated"],
                "conversationCount": conversation_count,
                "requirementCount": requirement_count,
                "architectureCount": architecture_count,
                "status": _derive_status(conversation_count, requirement_count, architecture_count),
            }
        )

    return {"projects": projects_with_status}


@router.post("/projects", status_code=201)
async def create_project(payload: ProjectCreateRequest, db: AsyncSession = Depends(get_db)) -> dict:
    if not payload.name or not payload.ideaText:
        raise HTTPException(status_code=400, detail="name and ideaText are required")

    project = Project(name=payload.name, current_version="0.1.0")
    db.add(project)
    await db.flush()

    # Log the initial idea as the first user conversation turn
    db.add(Conversation(project_id=project.id, role="user", message=payload.ideaText, stage="intake"))

    # Call LLM to get the first brainstorm question
    first_question = "Thank you. Let's start the brainstorm. Can you tell me what target traffic size or request volume you expect?"
    first_suggested_replies: list[str] = []
    try:
        turn = await get_next_brainstorm_turn(
            [{"role": "user", "message": payload.ideaText, "stage": "intake"}],
            payload.name,
            settings.openrouter_api_key,
        )
        first_question = turn["message"]
        first_suggested_replies = turn.get("suggestedReplies") or []
    except Exception as llm_err:
        logger.error("Failed to generate first brainstorm question: %s", llm_err)

    # Log the first AI follow-up question
    db.add(
        Conversation(
            project_id=project.id,
            role="assistant",
            message=first_question,
            stage="brainstorm",
            suggested_replies=first_suggested_replies,
        )
    )

    await db.commit()

    return {"projectId": str(project.id)}


@router.get("/projects/{project_id}")
async def get_project(project_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> dict:
    project = (await db.execute(select(Project).where(Project.id == project_id))).scalar_one_or_none()

    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    return {"project": serialize_project(project)}
