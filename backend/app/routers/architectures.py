import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.constants import DEFAULT_INDUSTRY_CONTEXT
from app.db import get_db
from app.models import Architecture, Project, Requirement
from app.schemas import (
    ComponentSuggestionsRequest,
    LayoutOverrideRequest,
    ManualArchitectureRequest,
    ProposeChangesRequest,
    RefineProposalRequest,
    WhatIfPreviewRequest,
)
from app.serializers import serialize_architecture
from app.services.architecture_diff import calculate_total_cost, compute_architecture_diff
from app.services.architecture_generation import build_cloud_mapping, generate_architecture_bundle
from app.services.knowledge_retrieval import (
    build_flow_story_query,
    build_requirements_context_query,
    chunk_to_prompt_dict,
    enrich_citations,
    retrieve_relevant_knowledge,
)
from app.services.llm import (
    generate_component_suggestions,
    generate_flow_story,
    generate_migration_roadmap,
    generate_user_journey,
    generate_whatif_suggestions,
    propose_component_changes,
    refine_component_proposal,
)
from app.services.path_verification import verify_journey_path
from app.services.security_rules import run_security_rules
from app.services.validation import validate_architecture_layout

router = APIRouter()

VALID_FLOW_STORY_PROVIDERS = ("aws", "azure", "gcp", "kubernetes", "private")
VALID_PROPOSE_CHANGES_PROVIDERS = VALID_FLOW_STORY_PROVIDERS


async def _latest_architecture(db: AsyncSession, project_id: uuid.UUID) -> Architecture | None:
    result = await db.execute(
        select(Architecture)
        .where(Architecture.project_id == project_id)
        .order_by(Architecture.created_at.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


def _next_version(latest_arch: Architecture | None) -> str:
    if not latest_arch:
        return "0.1.0"
    parts = latest_arch.version.split(".")
    if len(parts) == 3:
        patch = int(parts[2]) + 1
        return f"{parts[0]}.{parts[1]}.{patch}"
    return "0.1.0"


@router.get("/projects/{project_id}/architectures")
async def list_architectures(project_id: uuid.UUID, all: str | None = None, db: AsyncSession = Depends(get_db)) -> dict:
    if all == "true":
        result = await db.execute(
            select(Architecture).where(Architecture.project_id == project_id).order_by(Architecture.created_at.desc())
        )
        return {"architectures": [serialize_architecture(a) for a in result.scalars().all()]}

    record = await _latest_architecture(db, project_id)

    # No architecture generated yet is an expected, common state (e.g. still gathering
    # requirements) -- respond 200 with a null payload rather than 404, so routine polling from
    # the client doesn't surface as a failed-request error in the browser console.
    if not record:
        return {"architecture": None}

    return {"architecture": serialize_architecture(record)}


async def _latest_functional(db: AsyncSession, project_id: uuid.UUID) -> list:
    reqs = (
        await db.execute(
            select(Requirement)
            .where(Requirement.project_id == project_id)
            .order_by(Requirement.version.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    return reqs.functional if reqs else []


def _provider_components(components: list[dict], provider: str) -> list[dict]:
    # Synthesize from the reasoning + service names already computed for this provider -- no new
    # architectural decisions are made here, just narrated.
    return [
        {
            "id": c["id"],
            "name": c["name"],
            "type": c["type"],
            "reasoning": c.get("reasoning", ""),
            "serviceName": ((c.get("cloudMappings") or {}).get(provider) or {}).get("serviceName", c["name"]),
        }
        for c in components
    ]


def _enrich_proposal_item(
    p: dict, provider: str, existing_components: list[dict], reqs_context: dict, industry_context: dict
) -> dict | None:
    """Turns one type-level proposal (action/id/type/name/reasoning from the LLM -- never a
    specific cloud service, see propose_component_changes' docstring) into the fully-enriched,
    frontend-ready shape: real per-provider service names/costs/LLD resolved deterministically
    via _build_cloud_mapping, exactly like a manually-added component. Shared by both the
    propose-changes endpoint and refine-proposal below so a refined proposal goes through the
    identical enrichment a freshly-proposed one does. Returns None for anything invalid (missing
    id, colliding id on "add", unknown id on "modify") so the caller can filter it out."""
    action = p.get("action")
    component_id = p.get("id")
    if not component_id:
        return None
    existing_ids = {c["id"] for c in existing_components}

    if action == "add":
        if component_id in existing_ids:
            return None  # LLM picked a colliding id -- drop rather than silently overwrite an existing component
        component_type = p.get("type") or "compute"
        mapping = build_cloud_mapping(provider, {"id": component_id, "type": component_type}, reqs_context, industry_context)
        full_component = {
            "id": component_id,
            "name": p.get("name") or component_id,
            "type": component_type,
            "description": "",
            "reasoning": p.get("reasoning") or "Proposed in response to a chat-described enhancement.",
            "rulesFired": [],
            "metadata": {"isManuallyAdded": True, "overrideSource": "user"},
            "cloudMappings": {
                prov: build_cloud_mapping(prov, {"id": component_id, "type": component_type}, reqs_context, industry_context)
                for prov in ("aws", "azure", "gcp", "kubernetes", "private")
            },
        }
        result = {
            "action": "add",
            "componentId": component_id,
            "componentType": component_type,
            "componentName": full_component["name"],
            "reasoning": full_component["reasoning"],
            "serviceName": mapping["serviceName"],
            "component": full_component,
            "newConnections": p.get("connections") or [],
        }
        if p.get("domainPattern"):
            result["domainPattern"] = p["domainPattern"]
        return result

    if action == "modify":
        existing = next((c for c in existing_components if c["id"] == component_id), None)
        if not existing:
            return None  # LLM referenced a component id that doesn't exist -- drop it
        current_service_name = ((existing.get("cloudMappings") or {}).get(provider) or {}).get(
            "serviceName", existing.get("name")
        )
        result = {
            "action": "modify",
            "componentId": component_id,
            "componentType": existing.get("type"),
            "componentName": existing.get("name"),
            "reasoning": p.get("reasoning") or "Role updated in response to a chat-described enhancement.",
            "serviceName": current_service_name,
            "previousReasoning": existing.get("reasoning", ""),
        }
        if p.get("domainPattern"):
            result["domainPattern"] = p["domainPattern"]
        return result

    return None


async def _get_or_generate_flow_story(db: AsyncSession, record: Architecture, project_id: uuid.UUID, provider: str) -> str:
    # Cached per provider on this specific architecture version -- switching the provider tab
    # back and forth never re-triggers generation once each provider has been viewed once.
    if record.flow_story.get(provider):
        return record.flow_story[provider]

    functional = await _latest_functional(db, project_id)
    provider_components = _provider_components(record.hld.get("components", []), provider)
    connections = record.hld.get("connections", [])

    # Knowledge-base RAG (Step 4 priority 2). Grounded in the actual component makeup of this
    # architecture, not the raw requirements -- see build_flow_story_query's docstring.
    knowledge_chunks = await retrieve_relevant_knowledge(db, build_flow_story_query(provider_components, functional))
    knowledge_context = [chunk_to_prompt_dict(c) for c in knowledge_chunks]

    result = await generate_flow_story(
        provider, provider_components, connections, functional, settings.openrouter_api_key, knowledge_context
    )
    sources = enrich_citations(result["sources"], knowledge_context)

    # Cache-only UPDATE on an otherwise-immutable versioned row -- see Architecture.flow_story's
    # docstring in models.py. SQLAlchemy won't detect a plain in-place dict mutation on a JSONB
    # column as a change, so reassign the whole dict rather than record.flow_story[provider] = ...
    record.flow_story = {**record.flow_story, provider: result["story"]}
    record.flow_story_sources = {**record.flow_story_sources, provider: sources}
    await db.commit()
    return result["story"]


@router.post("/projects/{project_id}/architectures/{architecture_id}/flow-story")
async def get_flow_story(
    project_id: uuid.UUID, architecture_id: uuid.UUID, provider: str, db: AsyncSession = Depends(get_db)
) -> dict:
    if provider not in VALID_FLOW_STORY_PROVIDERS:
        raise HTTPException(status_code=400, detail="Invalid provider specified")

    record = (
        await db.execute(
            select(Architecture).where(Architecture.id == architecture_id, Architecture.project_id == project_id)
        )
    ).scalar_one_or_none()
    if not record:
        raise HTTPException(status_code=404, detail="Architecture version not found")

    story = await _get_or_generate_flow_story(db, record, project_id, provider)
    return {"story": story, "sources": record.flow_story_sources.get(provider, [])}


@router.post("/projects/{project_id}/architectures/{architecture_id}/journey")
async def get_user_journey(
    project_id: uuid.UUID, architecture_id: uuid.UUID, provider: str, db: AsyncSession = Depends(get_db)
) -> dict:
    """The "User Journey Architecture" view -- restructures the (already-generated-or-generated-
    here-first) flow story into discrete end-user-facing steps. Deliberately downstream of
    flow-story, never an independent regeneration of request flow."""
    if provider not in VALID_FLOW_STORY_PROVIDERS:
        raise HTTPException(status_code=400, detail="Invalid provider specified")

    record = (
        await db.execute(
            select(Architecture).where(Architecture.id == architecture_id, Architecture.project_id == project_id)
        )
    ).scalar_one_or_none()
    if not record:
        raise HTTPException(status_code=404, detail="Architecture version not found")

    provider_components = _provider_components(record.hld.get("components", []), provider)
    connections = record.hld.get("connections", [])

    if record.journey_steps.get(provider):
        steps = record.journey_steps[provider]
        return {"journeySteps": steps, "verification": verify_journey_path(steps, provider_components, connections)}

    flow_story = await _get_or_generate_flow_story(db, record, project_id, provider)
    functional = await _latest_functional(db, project_id)

    steps = await generate_user_journey(
        provider, flow_story, provider_components, connections, functional, settings.openrouter_api_key
    )

    # Same cache-only UPDATE pattern as flow_story -- reassign the whole dict, JSONB in-place
    # mutation isn't detected by SQLAlchemy's change tracking.
    record.journey_steps = {**record.journey_steps, provider: steps}
    await db.commit()

    # Verification is recomputed fresh every fetch, not cached alongside the steps -- it's cheap
    # (pure in-memory graph check) and a stale "verified" verdict would defeat the point.
    return {"journeySteps": steps, "verification": verify_journey_path(steps, provider_components, connections)}


@router.post("/projects/{project_id}/architectures/{architecture_id}/migration-roadmap")
async def get_migration_roadmap(
    project_id: uuid.UUID, architecture_id: uuid.UUID, provider: str, db: AsyncSession = Depends(get_db)
) -> dict:
    """Migration Roadmap (Workstream T5) -- a phased plan from the user's stated existing system to
    this target architecture. Only meaningful for a project whose latest Requirement has
    existing_system set (i.e. the "I have an existing system" intake toggle was used and the
    brainstorm actually captured something) -- 400s otherwise rather than fabricating a legacy
    system to migrate from. Lazily generated and cached per provider, same pattern as flow-story."""
    if provider not in VALID_FLOW_STORY_PROVIDERS:
        raise HTTPException(status_code=400, detail="Invalid provider specified")

    record = (
        await db.execute(
            select(Architecture).where(Architecture.id == architecture_id, Architecture.project_id == project_id)
        )
    ).scalar_one_or_none()
    if not record:
        raise HTTPException(status_code=404, detail="Architecture version not found")

    if record.migration_roadmap.get(provider):
        return {"phases": record.migration_roadmap[provider]}

    reqs = (
        await db.execute(
            select(Requirement)
            .where(Requirement.project_id == project_id)
            .order_by(Requirement.version.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if not reqs or not reqs.existing_system:
        raise HTTPException(
            status_code=400,
            detail="No existing system was captured for this project -- the Migration Roadmap only applies when starting from an existing system.",
        )

    provider_components = _provider_components(record.hld.get("components", []), provider)
    connections = record.hld.get("connections", [])

    phases = await generate_migration_roadmap(
        provider,
        reqs.existing_system,
        provider_components,
        connections,
        reqs.functional,
        settings.openrouter_api_key,
        reqs.product_domain or None,
    )

    record.migration_roadmap = {**record.migration_roadmap, provider: phases}
    await db.commit()

    return {"phases": phases}


@router.patch("/projects/{project_id}/architectures/{architecture_id}/layout")
async def update_layout_override(
    project_id: uuid.UUID, architecture_id: uuid.UUID, payload: LayoutOverrideRequest, db: AsyncSession = Depends(get_db)
) -> dict:
    """Persists one node's manually-dragged position (Workstream Q) -- purely cosmetic, so this
    merges into the CURRENT architecture version's layout_overrides in place rather than
    creating a new version, exactly like flow_story/journey_steps above. Scoped per architecture
    version, so an older version a user browses back to keeps whatever layout it had when it was
    last positioned, and doesn't inherit later versions' repositioning."""
    record = (
        await db.execute(
            select(Architecture).where(Architecture.id == architecture_id, Architecture.project_id == project_id)
        )
    ).scalar_one_or_none()
    if not record:
        raise HTTPException(status_code=404, detail="Architecture version not found")

    record.layout_overrides = {**record.layout_overrides, payload.componentId: {"x": payload.x, "y": payload.y}}
    await db.commit()

    return {"layoutOverrides": record.layout_overrides}


@router.post("/projects/{project_id}/architectures/{architecture_id}/propose-changes")
async def propose_architecture_changes(
    project_id: uuid.UUID, architecture_id: uuid.UUID, payload: ProposeChangesRequest, db: AsyncSession = Depends(get_db)
) -> dict:
    """Preview-only: identifies which components a freeform chat-described enhancement would add
    or change, scoped to one cloud provider, and returns them as reviewable cards. Nothing is
    persisted here -- the frontend applies only the user-approved subset via the existing
    /architectures/manual endpoint, reusing its versioning/diff/validation exactly as-is."""
    if payload.provider not in VALID_PROPOSE_CHANGES_PROVIDERS:
        raise HTTPException(status_code=400, detail="Invalid provider specified")

    record = (
        await db.execute(
            select(Architecture).where(Architecture.id == architecture_id, Architecture.project_id == project_id)
        )
    ).scalar_one_or_none()
    if not record:
        raise HTTPException(status_code=404, detail="Architecture version not found")

    reqs = (
        await db.execute(
            select(Requirement)
            .where(Requirement.project_id == project_id)
            .order_by(Requirement.version.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if not reqs:
        raise HTTPException(status_code=400, detail="Requirements must exist before proposing changes")

    reqs_context = {"functional": reqs.functional, "nonFunctional": reqs.non_functional}
    industry_context = reqs.industry_context or DEFAULT_INDUSTRY_CONTEXT

    existing_components = record.hld.get("components", [])
    existing_connections = record.hld.get("connections", [])

    raw_proposals = await propose_component_changes(
        payload.description,
        existing_components,
        existing_connections,
        reqs_context,
        settings.openrouter_api_key,
        reqs.product_domain or None,
    )

    proposals = [
        enriched
        for p in raw_proposals
        if (enriched := _enrich_proposal_item(p, payload.provider, existing_components, reqs_context, industry_context))
    ]

    return {"proposals": proposals}


@router.post("/projects/{project_id}/architectures/whatif-suggestions")
async def get_whatif_suggestions(project_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> dict:
    """What-If Simulator (Workstream V) -- AI-suggested HYPOTHETICAL variations per field, fetched
    fresh whenever the panel opens. Deliberately reads the project's CURRENT saved requirements
    itself (not client-supplied) so suggestions are always grounded in real, fresh state -- the
    frontend never pre-fills fields with these current values, it only shows them as a "current: "
    caption alongside the suggestion chips."""
    reqs = (
        await db.execute(
            select(Requirement)
            .where(Requirement.project_id == project_id)
            .order_by(Requirement.version.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if not reqs:
        raise HTTPException(status_code=400, detail="Requirements must exist before exploring what-if scenarios")

    suggestions = await generate_whatif_suggestions(
        reqs.functional,
        reqs.non_functional,
        reqs.industry_context or DEFAULT_INDUSTRY_CONTEXT,
        settings.openrouter_api_key,
    )
    return {
        "suggestions": suggestions,
        "current": {
            "functional": reqs.functional,
            "nonFunctional": reqs.non_functional,
            "industryContext": reqs.industry_context or DEFAULT_INDUSTRY_CONTEXT,
        },
    }


@router.post("/projects/{project_id}/architectures/component-suggestions")
async def get_component_suggestions(
    project_id: uuid.UUID, payload: ComponentSuggestionsRequest, db: AsyncSession = Depends(get_db)
) -> dict:
    """Manual Editor Controls (Workstream W) -- AI-suggested component types/names worth adding
    next, given the CLIENT'S current draft diagram (which may include unsaved manual edits) and
    the project's real saved requirements. Stateless, not persisted -- meant to be re-fetched when
    entering edit mode or after a meaningful draft change, not on every keystroke."""
    reqs = (
        await db.execute(
            select(Requirement)
            .where(Requirement.project_id == project_id)
            .order_by(Requirement.version.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if not reqs:
        raise HTTPException(status_code=400, detail="Requirements must exist before suggesting components")

    suggestions = await generate_component_suggestions(
        [c.model_dump() for c in payload.components],
        [c.model_dump(by_alias=True) for c in payload.connections],
        {
            "functional": reqs.functional,
            "nonFunctional": reqs.non_functional,
            "industryContext": reqs.industry_context or DEFAULT_INDUSTRY_CONTEXT,
        },
        settings.openrouter_api_key,
    )
    return {"suggestions": suggestions.get("suggestions", [])}


@router.post("/projects/{project_id}/architectures/whatif-preview")
async def preview_whatif_architecture(
    project_id: uuid.UUID, payload: WhatIfPreviewRequest, db: AsyncSession = Depends(get_db)
) -> dict:
    """What-If Simulator (Workstream T1, extended): runs the FULL real-generation pipeline
    (generate_architecture_bundle -- same rules engine + LLM validation generate_architecture
    itself uses) against hypothetical requirement values instead of the project's saved ones, and
    never writes to the database. A structured "what if every requirement field changed together"
    preview, not just a scale/budget slider -- because the real generation pipeline already
    considers all of these fields together, simulating a subset would misrepresent how the actual
    architecture would come out."""
    project = (await db.execute(select(Project).where(Project.id == project_id))).scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    latest_arch = await _latest_architecture(db, project_id)

    functional = list(payload.functional)
    if payload.additionalContext and payload.additionalContext.strip():
        # Folded into the SAME functional-requirements channel the rules engine and LLM already
        # read capability descriptions from -- not a new, unproven LLM input field.
        functional.append(f"[What-if scenario] {payload.additionalContext.strip()}")

    reqs_context = {"functional": functional, "nonFunctional": payload.nonFunctional}
    industry_context = payload.industryContext or DEFAULT_INDUSTRY_CONTEXT

    bundle = await generate_architecture_bundle(
        project.name,
        reqs_context,
        industry_context,
        settings.openrouter_api_key,
        latest_arch.hld["components"] if latest_arch else None,
    )

    return {
        "components": bundle["components"],
        "connections": bundle["connections"],
        "assumptions": bundle["assumptions"],
        "risks": bundle["risks"],
        "recommendation": bundle["recommendation"],
        "diff": bundle["diff"],
        "securityFindings": bundle["securityFindings"],
    }


@router.post("/projects/{project_id}/architectures/{architecture_id}/refine-proposal")
async def refine_proposal(
    project_id: uuid.UUID, architecture_id: uuid.UUID, payload: RefineProposalRequest, db: AsyncSession = Depends(get_db)
) -> dict:
    """Inline discuss/refine for a single pending proposal (Workstream O) -- the user pushes
    back on one card ("use a cheaper alternative") without affecting any other proposal in the
    same batch. Preview-only like propose-changes: returns an updated, fully-enriched proposal
    plus a conversational reply for the mini chat thread; nothing is persisted until the user
    accepts and the batch is applied via the existing manual-save endpoint."""
    if payload.provider not in VALID_PROPOSE_CHANGES_PROVIDERS:
        raise HTTPException(status_code=400, detail="Invalid provider specified")

    record = (
        await db.execute(
            select(Architecture).where(Architecture.id == architecture_id, Architecture.project_id == project_id)
        )
    ).scalar_one_or_none()
    if not record:
        raise HTTPException(status_code=404, detail="Architecture version not found")

    reqs = (
        await db.execute(
            select(Requirement)
            .where(Requirement.project_id == project_id)
            .order_by(Requirement.version.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if not reqs:
        raise HTTPException(status_code=400, detail="Requirements must exist before refining a proposal")

    reqs_context = {"functional": reqs.functional, "nonFunctional": reqs.non_functional}
    industry_context = reqs.industry_context or DEFAULT_INDUSTRY_CONTEXT
    existing_components = record.hld.get("components", [])

    result = await refine_component_proposal(
        payload.originalProposal.model_dump(),
        [m.model_dump() for m in payload.priorMessages],
        payload.discussionMessage,
        existing_components,
        reqs_context,
        settings.openrouter_api_key,
    )

    enriched = _enrich_proposal_item(
        result["proposal"], payload.provider, existing_components, reqs_context, industry_context
    )
    if not enriched:
        raise HTTPException(status_code=422, detail="Could not resolve the refined proposal to a valid component")

    return {"proposal": enriched, "assistantReply": result["assistantReply"]}


@router.post("/projects/{project_id}/architectures", status_code=201)
async def generate_architecture(project_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> dict:
    # 1. Fetch project details
    project = (await db.execute(select(Project).where(Project.id == project_id))).scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    # 2. Fetch the latest requirements
    reqs = (
        await db.execute(
            select(Requirement)
            .where(Requirement.project_id == project_id)
            .order_by(Requirement.version.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if not reqs:
        raise HTTPException(status_code=400, detail="Requirements must be generated before architecture")

    reqs_context = {"functional": reqs.functional, "nonFunctional": reqs.non_functional}
    industry_context = reqs.industry_context or DEFAULT_INDUSTRY_CONTEXT
    product_domain = reqs.product_domain or None

    # 3. Fetch the latest architecture for versioning and delta comparison
    latest_arch = await _latest_architecture(db, project_id)
    next_version = _next_version(latest_arch)

    # 3b. Knowledge-base RAG (highest-value touchpoint per the rollout plan: monolith-vs-
    # microservices, layering, component-boundary reasoning). Retrieval happens HERE, not inside
    # generate_architecture_bundle, since that module deliberately has no database access -- this
    # is the one place in the whole pipeline with both a DB session and the requirements context
    # available before the LLM call. An empty list (nothing cleared the similarity threshold) is
    # passed through unchanged; validate_and_generate_architecture treats that as "no grounding
    # available" and never fabricates a citation.
    knowledge_chunks = await retrieve_relevant_knowledge(db, build_requirements_context_query(reqs_context, industry_context))
    knowledge_context = [chunk_to_prompt_dict(c) for c in knowledge_chunks]

    # 4. The shared rules-engine + LLM-validation + cloud-mapping pipeline (architecture_
    # generation.py) -- identical to what the What-If preview endpoint below calls, just against
    # this project's real saved requirements instead of hypothetical ones.
    bundle = await generate_architecture_bundle(
        project.name,
        reqs_context,
        industry_context,
        settings.openrouter_api_key,
        latest_arch.hld["components"] if latest_arch else None,
        knowledge_context,
        product_domain,
    )

    # Attach the real stored excerpt text to whichever citations the LLM actually cited -- see
    # enrich_citations' docstring. A citation with no matching retrieved chunk is dropped rather
    # than shown without backing content.
    for c in bundle["components"]:
        if c.get("sources"):
            c["sources"] = enrich_citations(c["sources"], knowledge_context)
            if not c["sources"]:
                del c["sources"]
    if bundle.get("recommendation", {}).get("sources"):
        bundle["recommendation"]["sources"] = enrich_citations(bundle["recommendation"]["sources"], knowledge_context)
        if not bundle["recommendation"]["sources"]:
            del bundle["recommendation"]["sources"]

    # 5. Save new architecture version with all five cloud mappings, recommendations, LLD specs,
    # and security findings.
    record = Architecture(
        project_id=project_id,
        version=next_version,
        hld={"components": bundle["components"], "connections": bundle["connections"]},
        reasoning={
            "decisions": [
                {
                    "component": "system",
                    "choice": rule,
                    "rationale": "Matched deterministic rule pattern in system requirements.",
                    "tradeoffs": [],
                    "alternatives": [],
                }
                for rule in bundle["rulesTrace"]
            ],
            "assumptions": bundle["assumptions"],
            "risks": bundle["risks"],
            "recommendation": bundle["recommendation"],
            "diff": bundle["diff"],
        },
        cloud_provider="aws",
        security_findings=bundle["securityFindings"],
    )
    db.add(record)
    await db.flush()

    # 6. Update project's current version
    project.current_version = next_version

    await db.commit()

    return {"architecture": serialize_architecture(record)}


@router.post("/projects/{project_id}/architectures/manual", status_code=201)
async def save_manual_architecture(
    project_id: uuid.UUID, payload: ManualArchitectureRequest, db: AsyncSession = Depends(get_db)
) -> dict:
    # 1. Fetch project details
    project = (await db.execute(select(Project).where(Project.id == project_id))).scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    # 2. Fetch latest requirements
    reqs = (
        await db.execute(
            select(Requirement)
            .where(Requirement.project_id == project_id)
            .order_by(Requirement.version.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if not reqs:
        raise HTTPException(
            status_code=400, detail="Requirements must exist before saving manual architecture modifications"
        )

    reqs_context = {"functional": reqs.functional, "nonFunctional": reqs.non_functional}
    industry_context = reqs.industry_context

    connections = [conn.model_dump(by_alias=True) for conn in payload.connections]

    # 3. Compile manual components (resolve missing cloud mappings and LLD baselines)
    compiled_components = []
    for component in payload.components:
        c = component.model_dump()

        # Check if mappings already exist
        if c.get("cloudMappings"):
            compiled_components.append(c)
            continue

        # Automatically generate mappings & LLD defaults for a new node. Passing
        # industry_context keeps a manually-added component (e.g. a second database) subject to
        # the same compliance-mandated config (encryption in transit, etc.) as the
        # auto-generated baseline.
        compiled_components.append(
            {
                **c,
                "reasoning": c.get("reasoning") or "Manually added by user.",
                "metadata": {
                    **(c.get("metadata") or {}),
                    "isManuallyAdded": True,
                    "overrideSource": "user",
                },
                "cloudMappings": {
                    "aws": build_cloud_mapping("aws", c, reqs_context, industry_context),
                    "azure": build_cloud_mapping("azure", c, reqs_context, industry_context),
                    "gcp": build_cloud_mapping("gcp", c, reqs_context, industry_context),
                    "kubernetes": build_cloud_mapping("kubernetes", c, reqs_context, industry_context),
                    "private": build_cloud_mapping("private", c, reqs_context, industry_context),
                },
            }
        )

    # 4. Run Layout Validation
    aws_costs = calculate_total_cost(compiled_components, "aws")
    validation = validate_architecture_layout(compiled_components, connections, reqs_context, aws_costs)

    if not validation["isValid"]:
        raise HTTPException(status_code=400, detail=f"Validation blocked save: {'; '.join(validation['errors'])}")

    # 5. Fetch previous version to compute diff and calculate next version
    latest_arch = await _latest_architecture(db, project_id)
    next_version = _next_version(latest_arch)

    # 6. Compute diff against previous architecture version
    prev_components = latest_arch.hld.get("components", []) if latest_arch else []
    diff = compute_architecture_diff(
        compiled_components,
        prev_components,
        {"defaultAddedReasoning": "Manually added by user.", "defaultChangeReasoning": "Manually changed by user."},
    )

    # 6b. Same deterministic security-posture audit as auto-generate -- must be recomputed here
    # too since manual edits (add/remove/rewire components) can change findings just as much as
    # a fresh generation can.
    security_findings = {
        prov: run_security_rules(compiled_components, connections, industry_context, prov)
        for prov in ("aws", "azure", "gcp", "kubernetes", "private")
    }

    # 7. Save manual architecture version
    record = Architecture(
        project_id=project_id,
        version=next_version,
        hld={"components": compiled_components, "connections": connections},
        reasoning={
            "decisions": [
                {
                    "component": "system",
                    "choice": "manual_override",
                    "rationale": "Layout manually adjusted by project maintainer.",
                    "tradeoffs": [],
                    "alternatives": [],
                }
            ],
            "assumptions": latest_arch.reasoning.get("assumptions", []) if latest_arch else [],
            "risks": latest_arch.reasoning.get("risks", []) if latest_arch else [],
            "recommendation": latest_arch.reasoning.get("recommendation") if latest_arch else None,
            "diff": diff,
        },
        cloud_provider=(latest_arch.cloud_provider if latest_arch else "aws"),
        security_findings=security_findings,
    )
    db.add(record)
    await db.flush()

    # 8. Update project's current version
    project.current_version = next_version

    await db.commit()

    return {"architecture": serialize_architecture(record)}
