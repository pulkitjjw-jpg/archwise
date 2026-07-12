import io
import re
import uuid
import zipfile

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.constants import DEFAULT_INDUSTRY_CONTEXT
from app.db import get_db
from app.models import Architecture, Project, Requirement
from app.services.architecture_diff import calculate_total_cost
from app.services.executive_summary_pdf import build_executive_summary_pdf
from app.services.k8s_manifest_generator import generate_kubernetes_manifests
from app.services.llm import generate_executive_summary
from app.services.terraform_generator import generate_terraform_code

router = APIRouter()

VALID_PROVIDERS = ("aws", "azure", "gcp", "kubernetes", "private")


@router.get("/projects/{project_id}/export")
async def export_architecture(project_id: uuid.UUID, provider: str = "aws", db: AsyncSession = Depends(get_db)):
    if provider not in VALID_PROVIDERS:
        raise HTTPException(status_code=400, detail="Invalid provider specified")

    # 1. Fetch project details
    project = (await db.execute(select(Project).where(Project.id == project_id))).scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    # 2. Fetch the latest generated architecture
    record = (
        await db.execute(
            select(Architecture)
            .where(Architecture.project_id == project_id)
            .order_by(Architecture.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if not record:
        raise HTTPException(status_code=404, detail="No architecture design found. Please generate one first.")

    # 3. Fetch the latest requirements to know if industry-specific compliance framing
    # (PCI-DSS / HIPAA) belongs in the generated README.
    reqs = (
        await db.execute(
            select(Requirement)
            .where(Requirement.project_id == project_id)
            .order_by(Requirement.version.desc())
            .limit(1)
        )
    ).scalar_one_or_none()

    # 4. Generate the export file set -- Kubernetes gets manifests instead of Terraform,
    # everything else (including "private") gets Terraform.
    if provider == "kubernetes":
        files_map = generate_kubernetes_manifests(
            project.name,
            record.hld["components"],
            record.hld["connections"],
            reqs.industry_context if reqs else None,
        )
    else:
        files_map = generate_terraform_code(
            provider,
            project.name,
            record.hld["components"],
            record.hld["connections"],
            reqs.industry_context if reqs else None,
        )

    # Create ZIP archive
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zip_file:
        for filename, content in files_map.items():
            zip_file.writestr(filename, content)

    safe_name = re.sub(r"[^a-z0-9]", "-", project.name.lower())
    export_label = "k8s-manifests" if provider == "kubernetes" else "terraform"

    # 5. Stream back the ZIP file
    return Response(
        content=buffer.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{safe_name}-{export_label}-{provider}.zip"'},
    )


@router.get("/projects/{project_id}/export/executive-summary")
async def export_executive_summary(project_id: uuid.UUID, provider: str = "aws", db: AsyncSession = Depends(get_db)):
    """Workstream T2 -- a one-page, plain-business-language PDF for a non-technical stakeholder.
    Deliberately a GET (like export_architecture above) so it can be triggered as a direct
    download link, not a fetch+blob round-trip. Not cached: this is a light, rarely-repeated
    one-page synthesis, so a fresh LLM call each download is an acceptable trade for not needing
    a new persisted column."""
    if provider not in VALID_PROVIDERS:
        raise HTTPException(status_code=400, detail="Invalid provider specified")

    project = (await db.execute(select(Project).where(Project.id == project_id))).scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    record = (
        await db.execute(
            select(Architecture)
            .where(Architecture.project_id == project_id)
            .order_by(Architecture.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if not record:
        raise HTTPException(status_code=404, detail="No architecture design found. Please generate one first.")

    reqs = (
        await db.execute(
            select(Requirement)
            .where(Requirement.project_id == project_id)
            .order_by(Requirement.version.desc())
            .limit(1)
        )
    ).scalar_one_or_none()

    cost = calculate_total_cost(record.hld.get("components", []), provider)
    functional = reqs.functional if reqs else []
    non_functional = reqs.non_functional if reqs else {}
    industry_context = reqs.industry_context if reqs else DEFAULT_INDUSTRY_CONTEXT
    assumptions = record.reasoning.get("assumptions", [])
    risks = record.reasoning.get("risks", [])

    summary = await generate_executive_summary(
        project.name,
        provider,
        cost,
        functional,
        non_functional,
        industry_context,
        assumptions,
        risks,
        settings.openrouter_api_key,
    )

    pdf_bytes = build_executive_summary_pdf(project.name, provider, record.version, cost, summary)
    safe_name = re.sub(r"[^a-z0-9]", "-", project.name.lower())

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{safe_name}-executive-summary.pdf"'},
    )
