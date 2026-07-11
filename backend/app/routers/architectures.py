import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.constants import DEFAULT_INDUSTRY_CONTEXT
from app.db import get_db
from app.models import Architecture, Project, Requirement
from app.schemas import ManualArchitectureRequest, ProposeChangesRequest
from app.serializers import serialize_architecture
from app.services.architecture_diff import calculate_total_cost, compute_architecture_diff
from app.services.cloud_mapping import get_cloud_mapping
from app.services.industry_rules import run_industry_rules
from app.services.lld_rules import run_lld_rules_engine
from app.services.llm import generate_flow_story, propose_component_changes, validate_and_generate_architecture
from app.services.rules_engine import run_rules_engine
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


def _build_cloud_mapping(provider: str, component: dict, reqs_context: dict, industry_context: dict) -> dict:
    mapping = get_cloud_mapping(provider, component["type"], component["id"], reqs_context)
    lld = run_lld_rules_engine(provider, component["type"], component["id"], reqs_context, None, industry_context)
    return {
        "serviceName": mapping["serviceName"],
        "alternatives": mapping["alternatives"],
        "costEstimate": mapping["costEstimate"],
        "lld": {"config": lld["config"], "reasoning": lld["reasoning"]},
    }


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

    # Cached per provider on this specific architecture version -- switching the provider tab
    # back and forth never re-triggers generation once each provider has been viewed once.
    if record.flow_story.get(provider):
        return {"story": record.flow_story[provider]}

    reqs = (
        await db.execute(
            select(Requirement)
            .where(Requirement.project_id == project_id)
            .order_by(Requirement.version.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    functional = reqs.functional if reqs else []

    components = record.hld.get("components", [])
    connections = record.hld.get("connections", [])

    # Synthesize from the reasoning + service names already computed for this provider -- no new
    # architectural decisions are made here, just narrated.
    provider_components = [
        {
            "id": c["id"],
            "name": c["name"],
            "type": c["type"],
            "reasoning": c.get("reasoning", ""),
            "serviceName": ((c.get("cloudMappings") or {}).get(provider) or {}).get("serviceName", c["name"]),
        }
        for c in components
    ]

    story = await generate_flow_story(provider, provider_components, connections, functional, settings.openrouter_api_key)

    # Cache-only UPDATE on an otherwise-immutable versioned row -- see Architecture.flow_story's
    # docstring in models.py. SQLAlchemy won't detect a plain in-place dict mutation on a JSONB
    # column as a change, so reassign the whole dict rather than record.flow_story[provider] = ...
    record.flow_story = {**record.flow_story, provider: story}
    await db.commit()

    return {"story": story}


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
    existing_ids = {c["id"] for c in existing_components}

    raw_proposals = await propose_component_changes(
        payload.description, existing_components, existing_connections, reqs_context, settings.openrouter_api_key
    )

    proposals: list[dict] = []
    for p in raw_proposals:
        action = p.get("action")
        component_id = p.get("id")
        if not component_id:
            continue

        if action == "add":
            if component_id in existing_ids:
                continue  # LLM picked a colliding id -- drop rather than silently overwrite an existing component
            component_type = p.get("type") or "compute"
            mapping = _build_cloud_mapping(payload.provider, {"id": component_id, "type": component_type}, reqs_context, industry_context)
            full_component = {
                "id": component_id,
                "name": p.get("name") or component_id,
                "type": component_type,
                "description": "",
                "reasoning": p.get("reasoning") or "Proposed in response to a chat-described enhancement.",
                "rulesFired": [],
                "metadata": {"isManuallyAdded": True, "overrideSource": "user"},
                "cloudMappings": {
                    provider: _build_cloud_mapping(provider, {"id": component_id, "type": component_type}, reqs_context, industry_context)
                    for provider in ("aws", "azure", "gcp", "kubernetes", "private")
                },
            }
            proposals.append(
                {
                    "action": "add",
                    "componentId": component_id,
                    "componentType": component_type,
                    "componentName": full_component["name"],
                    "reasoning": full_component["reasoning"],
                    "serviceName": mapping["serviceName"],
                    "component": full_component,
                    "newConnections": p.get("connections") or [],
                }
            )
        elif action == "modify":
            existing = next((c for c in existing_components if c["id"] == component_id), None)
            if not existing:
                continue  # LLM referenced a component id that doesn't exist -- drop it
            current_service_name = ((existing.get("cloudMappings") or {}).get(payload.provider) or {}).get(
                "serviceName", existing.get("name")
            )
            proposals.append(
                {
                    "action": "modify",
                    "componentId": component_id,
                    "componentType": existing.get("type"),
                    "componentName": existing.get("name"),
                    "reasoning": p.get("reasoning") or "Role updated in response to a chat-described enhancement.",
                    "serviceName": current_service_name,
                    "previousReasoning": existing.get("reasoning", ""),
                }
            )

    return {"proposals": proposals}


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

    # 3. Run rules engine to produce baseline HLD, then layer industry-specific compliance
    # components on top (audit log, tokenization, PHI vault, de-identification pipeline -- see
    # industry_rules.py). A generic project (industry: "none") gets nothing extra here.
    baseline = run_rules_engine(reqs_context)
    industry_result = run_industry_rules(industry_context, reqs_context["functional"])

    all_components = baseline["components"] + industry_result["components"]
    all_connections = baseline["connections"] + industry_result["connections"]
    all_rules_trace = baseline["rulesTrace"] + industry_result["rulesTrace"]

    # 4. Resolve mappings, costs, and LLD baselines for AWS, Azure, and GCP for each component
    mapped_baseline_components = [
        {
            **c,
            "cloudMappings": {
                "aws": _build_cloud_mapping("aws", c, reqs_context, industry_context),
                "azure": _build_cloud_mapping("azure", c, reqs_context, industry_context),
                "gcp": _build_cloud_mapping("gcp", c, reqs_context, industry_context),
            },
        }
        for c in all_components
    ]

    # 4b. Resolve Kubernetes + private-cloud mappings for every component too -- but keep these
    # entirely OUT of what gets sent to the LLM. They're fully deterministic (no managed-service
    # pricing nuance to "validate"), and adding two more providers' worth of reasoning to
    # validate_and_generate_architecture's job would meaningfully grow its prompt/output size,
    # which makes Gemini's occasional malformed-JSON problem worse. Computed here, merged onto
    # the LLM's response afterward (step 7b).
    extra_provider_mappings_by_id = {
        c["id"]: {
            "kubernetes": _build_cloud_mapping("kubernetes", c, reqs_context, industry_context),
            "private": _build_cloud_mapping("private", c, reqs_context, industry_context),
        }
        for c in all_components
    }

    # 5. Calculate baseline total costs
    provider_costs = {"aws": {"min": 0, "max": 0}, "azure": {"min": 0, "max": 0}, "gcp": {"min": 0, "max": 0}}
    for c in mapped_baseline_components:
        for prov in ("aws", "azure", "gcp"):
            provider_costs[prov]["min"] += c["cloudMappings"][prov]["costEstimate"]["min"]
            provider_costs[prov]["max"] += c["cloudMappings"][prov]["costEstimate"]["max"]

    # 6. Fetch the latest architecture for versioning and delta comparison
    latest_arch = await _latest_architecture(db, project_id)
    next_version = _next_version(latest_arch)

    # 7. Validate, enrich and recommend provider with LLM, passing HLD + LLD baselines & previous components
    enriched = await validate_and_generate_architecture(
        project.name,
        {**reqs_context, "industryContext": industry_context},
        {"components": mapped_baseline_components, "connections": all_connections},
        provider_costs,
        settings.openrouter_api_key,
        latest_arch.hld["components"] if latest_arch else None,
    )

    # Merge deterministic industry-rule risks (e.g. data residency, processor-scope caveats) in
    # alongside whatever risks the LLM itself surfaced from unspecified requirement fields.
    enriched["risks"] = (enriched.get("risks") or []) + industry_result["risks"]

    # 7b. Re-attach the deterministic rule-engine's "alternatives" (each carrying its own
    # costEstimate) onto the LLM's output. The LLM is intentionally not asked to reproduce cost
    # data for alternatives (keeps its output smaller/faster and avoids drift); those
    # alternatives + costs power the manual editor's cloud-service-swap feature, so every
    # component must have them regardless of what the LLM returned.
    baseline_by_id = {c["id"]: c for c in mapped_baseline_components}
    for c in enriched["components"]:
        baseline_component = baseline_by_id.get(c["id"])
        if not baseline_component or not c.get("cloudMappings"):
            continue
        for prov in ("aws", "azure", "gcp"):
            if c["cloudMappings"].get(prov) and baseline_component["cloudMappings"].get(prov):
                c["cloudMappings"][prov]["alternatives"] = baseline_component["cloudMappings"][prov]["alternatives"]

        # Attach the Kubernetes + private-cloud mappings computed in step 4b. These never went
        # to the LLM, so they're attached wholesale rather than merged field-by-field.
        extra = extra_provider_mappings_by_id.get(c["id"])
        if extra:
            c["cloudMappings"]["kubernetes"] = extra["kubernetes"]
            c["cloudMappings"]["private"] = extra["private"]

    # 8. Compute the version-to-version diff deterministically in Python (never from the LLM)
    # so costDelta is always present and before/after values always come from the actual stored
    # previous/new component records.
    diff = None
    if latest_arch:
        diff = compute_architecture_diff(
            enriched["components"],
            latest_arch.hld.get("components", []),
            {
                "defaultAddedReasoning": "Added in response to updated requirements.",
                "defaultChangeReasoning": "Updated in response to requirement changes.",
            },
        )

    # 9. Save new architecture version with all three cloud mappings, recommendations, and LLD specs
    record = Architecture(
        project_id=project_id,
        version=next_version,
        hld={"components": enriched["components"], "connections": enriched["connections"]},
        reasoning={
            "decisions": [
                {
                    "component": "system",
                    "choice": rule,
                    "rationale": "Matched deterministic rule pattern in system requirements.",
                    "tradeoffs": [],
                    "alternatives": [],
                }
                for rule in all_rules_trace
            ],
            "assumptions": enriched["assumptions"],
            "risks": enriched["risks"],
            "recommendation": enriched["recommendation"],
            "diff": diff,
        },
        cloud_provider="aws",
    )
    db.add(record)
    await db.flush()

    # 10. Update project's current version
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
                    "aws": _build_cloud_mapping("aws", c, reqs_context, industry_context),
                    "azure": _build_cloud_mapping("azure", c, reqs_context, industry_context),
                    "gcp": _build_cloud_mapping("gcp", c, reqs_context, industry_context),
                    "kubernetes": _build_cloud_mapping("kubernetes", c, reqs_context, industry_context),
                    "private": _build_cloud_mapping("private", c, reqs_context, industry_context),
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
    )
    db.add(record)
    await db.flush()

    # 8. Update project's current version
    project.current_version = next_version

    await db.commit()

    return {"architecture": serialize_architecture(record)}
