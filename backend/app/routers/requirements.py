import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.constants import DEFAULT_INDUSTRY_CONTEXT
from app.db import get_db
from app.models import Conversation, Requirement
from app.schemas import RequirementsPutRequest
from app.serializers import serialize_requirement
from app.services.llm import (
    extract_requirements_from_history,
    generate_conversation_summary,
    generate_requirement_suggestions,
)

router = APIRouter()


async def _latest_requirement(db: AsyncSession, project_id: uuid.UUID) -> Requirement | None:
    result = await db.execute(
        select(Requirement)
        .where(Requirement.project_id == project_id)
        .order_by(Requirement.version.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


@router.get("/projects/{project_id}/requirements")
async def get_requirements(project_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> dict:
    record = await _latest_requirement(db, project_id)

    # No requirements extracted yet is an expected, common state (e.g. brainstorm still in
    # progress) -- respond 200 with a null payload rather than 404, so routine polling from the
    # client doesn't surface as a failed-request error in the browser console.
    if not record:
        return {"requirements": None}

    return {"requirements": serialize_requirement(record)}


@router.post("/projects/{project_id}/requirements", status_code=201)
async def extract_requirements(project_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> dict:
    # Load conversation history
    history = (
        (
            await db.execute(
                select(Conversation)
                .where(Conversation.project_id == project_id)
                .order_by(Conversation.created_at.asc())
            )
        )
        .scalars()
        .all()
    )

    # Extract requirements using LLM
    extracted = await extract_requirements_from_history(
        [{"role": h.role, "message": h.message} for h in history], settings.openrouter_api_key
    )

    # Get current latest version to increment
    latest = await _latest_requirement(db, project_id)
    next_version = latest.version + 1 if latest else 1

    # Always insert a new record for version history
    record = Requirement(
        project_id=project_id,
        functional=extracted["functional"],
        non_functional=extracted["nonFunctional"],
        industry_context=extracted["industryContext"],
        existing_system=extracted.get("existingSystem"),
        version=next_version,
    )
    db.add(record)
    await db.commit()

    return {"requirements": serialize_requirement(record)}


@router.post("/projects/{project_id}/requirements/suggestions")
async def get_requirement_suggestions(
    project_id: uuid.UUID, payload: RequirementsPutRequest, db: AsyncSession = Depends(get_db)
) -> dict:
    # Stateless and not persisted -- recomputed on demand from whatever the client currently has
    # (saved values, or the user's in-progress edit-mode draft), so suggestions stay relevant as
    # the user types/selects rather than freezing at whatever was last saved.
    suggestions = await generate_requirement_suggestions(
        payload.functional if isinstance(payload.functional, list) else [],
        payload.nonFunctional,
        settings.openrouter_api_key,
    )
    return {"suggestions": suggestions}


@router.post("/projects/{project_id}/requirements/summary")
async def get_conversation_summary(project_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> dict:
    latest = await _latest_requirement(db, project_id)
    if not latest:
        raise HTTPException(status_code=400, detail="No requirements yet -- complete the discovery conversation first")

    # Cached on the requirements row it describes -- regenerating only happens when a NEW
    # requirements version is created (a fresh row with conversation_summary NULL), never on
    # repeat views of the same version.
    if latest.conversation_summary:
        return {"summary": latest.conversation_summary}

    history = (
        (
            await db.execute(
                select(Conversation)
                .where(Conversation.project_id == project_id)
                .order_by(Conversation.created_at.asc())
            )
        )
        .scalars()
        .all()
    )

    summary = await generate_conversation_summary(
        [{"role": h.role, "message": h.message} for h in history],
        {"functional": latest.functional, "nonFunctional": latest.non_functional},
        settings.openrouter_api_key,
    )

    latest.conversation_summary = summary
    await db.commit()

    return {"summary": summary}


@router.put("/projects/{project_id}/requirements")
async def save_requirements(
    project_id: uuid.UUID, payload: RequirementsPutRequest, db: AsyncSession = Depends(get_db)
) -> dict:
    if not payload.functional or not payload.nonFunctional:
        raise HTTPException(status_code=400, detail="functional and nonFunctional are required")

    # Get current latest version to increment
    latest = await _latest_requirement(db, project_id)
    next_version = latest.version + 1 if latest else 1

    # Manual edits via the Requirements tab never send industryContext -- carry the latest
    # detected value forward rather than letting the column default silently wipe it. The What-If
    # Simulator's "Make this real" is the one caller that DOES send an explicit industryContext
    # (a changed compliance/industry selection), which takes precedence when present.
    industry_context = payload.industryContext or (latest.industry_context if latest else DEFAULT_INDUSTRY_CONTEXT)

    # Always insert a new record for version history
    record = Requirement(
        project_id=project_id,
        functional=payload.functional,
        non_functional=payload.nonFunctional,
        industry_context=industry_context,
        version=next_version,
    )
    db.add(record)
    await db.commit()

    return {"requirements": serialize_requirement(record)}
