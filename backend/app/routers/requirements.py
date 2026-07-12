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
from app.services.knowledge_retrieval import (
    build_requirements_context_query,
    chunk_to_prompt_dict,
    enrich_citations,
    retrieve_relevant_knowledge,
)
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
    functional = payload.functional if isinstance(payload.functional, list) else []
    industry_context = payload.industryContext or DEFAULT_INDUSTRY_CONTEXT

    # Knowledge-base RAG (Step 4 priority 3: NFR reasoning, Sommerville's requirements-engineering
    # chapters in particular). Same pattern as HLD generation -- retrieve here (router has the DB
    # session), pass plain dicts into the LLM layer.
    knowledge_chunks = await retrieve_relevant_knowledge(
        db, build_requirements_context_query({"functional": functional, "nonFunctional": payload.nonFunctional}, industry_context)
    )
    knowledge_context = [chunk_to_prompt_dict(c) for c in knowledge_chunks]

    suggestions = await generate_requirement_suggestions(
        functional,
        payload.nonFunctional,
        settings.openrouter_api_key,
        knowledge_context,
    )
    # Attach real stored excerpt text to whichever suggestions the LLM actually cited -- most
    # suggestions have no "sources" key at all, which is expected (see enrich_citations).
    for field_suggestions in suggestions.values():
        if not isinstance(field_suggestions, list):
            continue
        for s in field_suggestions:
            if isinstance(s, dict) and s.get("sources"):
                s["sources"] = enrich_citations(s["sources"], knowledge_context)
                if not s["sources"]:
                    del s["sources"]
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
        return {"summary": latest.conversation_summary, "sources": latest.conversation_summary_sources or []}

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

    industry_context = latest.industry_context or DEFAULT_INDUSTRY_CONTEXT
    knowledge_chunks = await retrieve_relevant_knowledge(
        db,
        build_requirements_context_query(
            {"functional": latest.functional, "nonFunctional": latest.non_functional}, industry_context
        ),
    )
    knowledge_context = [chunk_to_prompt_dict(c) for c in knowledge_chunks]

    result = await generate_conversation_summary(
        [{"role": h.role, "message": h.message} for h in history],
        {"functional": latest.functional, "nonFunctional": latest.non_functional},
        settings.openrouter_api_key,
        knowledge_context,
    )
    sources = enrich_citations(result["sources"], knowledge_context)

    latest.conversation_summary = result["summary"]
    latest.conversation_summary_sources = sources
    await db.commit()

    return {"summary": result["summary"], "sources": sources}


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
