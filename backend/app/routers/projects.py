import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import get_db
from app.dependencies import get_accessible_project, get_current_user, get_owned_project
from app.models import Conversation, Project, User
from app.rate_limit import limiter
from app.schemas import ProjectCreateRequest
from app.serializers import serialize_project
from app.services.audit import write_audit_log
from app.services.llm import get_next_brainstorm_turn
from app.services.usage_limits import check_and_increment

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


async def _list_projects_for_user(db: AsyncSession, user_id: uuid.UUID) -> dict:
    """Shared body behind GET /projects (Clerk session, app/routers/auth.py's get_current_user)
    and GET /public/projects (API key, app/routers/public_api.py's get_user_from_api_key) -- both
    surfaces list exactly "this caller's own projects" and should never drift into two different
    queries/serializations of the same data."""
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
            WHERE p.user_id = :user_id
            ORDER BY "lastUpdated" DESC NULLS LAST
            """
        ),
        {"user_id": user_id},
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


@router.get("/projects")
async def list_projects(db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)) -> dict:
    return await _list_projects_for_user(db, current_user.id)


@router.post("/projects", status_code=201)
@limiter.limit("60/hour")
async def create_project(
    request: Request,
    payload: ProjectCreateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    if not payload.name or not payload.ideaText:
        raise HTTPException(
            status_code=400, detail="Please give your project a name and describe your idea before continuing."
        )

    # Free-tier cap check BEFORE any real work (no project row, no LLM call) so a request that
    # would exceed the cap never touches either. A new project is what actually starts a new
    # brainstorm session in this app's data model -- conversations.py's POST endpoint only ever
    # continues an EXISTING project's ongoing back-and-forth, it never starts a new one. Not
    # committed here -- this call's own increment rides in the same transaction as the rest of
    # this route's work, committed together below.
    await check_and_increment(db, current_user.id, "brainstorm_sessions")

    project = Project(
        name=payload.name,
        current_version="0.1.0",
        has_existing_system=payload.hasExistingSystem,
        user_id=current_user.id,
    )
    db.add(project)
    await db.flush()

    # Log the initial idea as the first user conversation turn
    db.add(Conversation(project_id=project.id, role="user", message=payload.ideaText, stage="intake"))

    intake_history = [{"role": "user", "message": payload.ideaText, "stage": "intake"}]

    # Workstream T5 -- if the user described an existing system, log it as its own intake turn
    # (clearly labeled, not silently merged into the idea text) so it's a distinct, extractable
    # part of the conversation history rather than buried prose.
    if payload.hasExistingSystem and payload.existingSystemText and payload.existingSystemText.strip():
        existing_system_message = f"Existing system: {payload.existingSystemText.strip()}"
        db.add(Conversation(project_id=project.id, role="user", message=existing_system_message, stage="intake"))
        intake_history.append({"role": "user", "message": existing_system_message, "stage": "intake"})

    # Call LLM to get the first brainstorm question
    first_question = "Thank you. Let's start the brainstorm. Can you tell me what target traffic size or request volume you expect?"
    first_suggested_replies: list[str] = []
    try:
        turn = await get_next_brainstorm_turn(
            intake_history,
            payload.name,
            settings.openrouter_api_key,
            has_existing_system=payload.hasExistingSystem,
        )
        first_question = turn["message"]
        first_suggested_replies = turn.get("suggestedReplies") or []
        detected_level = turn.get("knowledgeLevel")
        if detected_level in ("technical", "beginner"):
            project.knowledge_level = detected_level
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
async def get_project(project: Project = Depends(get_accessible_project)) -> dict:
    # Broad access (owner OR any member) -- a collaborator's very first request when opening a
    # project is this one (see src/app/projects/[id]/page.tsx), so it has to allow the same
    # audience as everything else on the page.
    return {"project": serialize_project(project)}


@router.delete("/projects/{project_id}")
@limiter.limit("30/hour")
async def delete_project(
    request: Request, project: Project = Depends(get_owned_project), db: AsyncSession = Depends(get_db)
) -> dict:
    """Permanently deletes a project and everything nested under it (conversations, requirements,
    architectures, share links, comments, memberships) via the same ON DELETE CASCADE foreign keys
    DELETE /auth/me already relies on for a full account deletion -- this is that same cascade,
    just scoped to one project instead of an entire account. Real, irreversible data loss, by
    design.

    Owner-only (get_owned_project, not get_accessible_project) -- a collaborator/member can view
    or edit a shared project, but deleting it outright is the owner's call alone.

    Deliberately no "type the project name to confirm" friction like DeleteAccountRequest has for
    the whole account -- losing one project among possibly several is a meaningfully smaller
    consequence than losing every project at once, so a plain confirm-dialog click (enforced
    client-side by the dashboard) is a reasonable amount of friction here."""
    project_name = project.name
    await write_audit_log(
        db,
        actor_user_id=project.user_id,
        action="project.deleted",
        target_type="project",
        target_id=str(project.id),
        extra_data={"name": project_name},
    )
    await db.delete(project)
    await db.commit()
    return {"ok": True}
