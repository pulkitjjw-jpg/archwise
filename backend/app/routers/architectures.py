import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.constants import DEFAULT_INDUSTRY_CONTEXT
from app.db import get_db
from app.models import Architecture, Project, Requirement
from app.schemas import ManualArchitectureRequest
from app.serializers import serialize_architecture
from app.services.architecture_diff import calculate_total_cost, compute_architecture_diff
from app.services.cloud_mapping import get_cloud_mapping
from app.services.industry_rules import run_industry_rules
from app.services.lld_rules import run_lld_rules_engine
from app.services.llm import validate_and_generate_architecture
from app.services.rules_engine import run_rules_engine
from app.services.validation import validate_architecture_layout

router = APIRouter()


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
