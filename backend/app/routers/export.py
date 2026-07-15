import base64
import io
import re
import zipfile

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.constants import DEFAULT_INDUSTRY_CONTEXT
from app.db import get_db
from app.dependencies import get_current_user, get_owned_project
from app.models import Architecture, Project, Requirement, User
from app.rate_limit import limiter
from app.schemas import EmailExportRequest
from app.services.architecture_diff import calculate_total_cost
from app.services.email import ExportEmailError, send_export_email
from app.services.executive_summary_pdf import build_executive_summary_pdf
from app.services.k8s_manifest_generator import generate_kubernetes_manifests
from app.services.llm import generate_executive_summary
from app.services.terraform_generator import generate_terraform_code

router = APIRouter()

VALID_PROVIDERS = ("aws", "azure", "gcp", "kubernetes", "private")

# format -> (Content-Type, human label used in the email subject/body). "docs" and "image" aren't
# here -- those are client-generated (see EmailExportAttachment's docstring) so their content type
# comes from whatever the browser already built, not a fixed server-side value.
SERVER_GENERATED_FORMATS = {
    "terraform": ("application/zip", "Terraform"),
    "kubernetes": ("application/zip", "Kubernetes manifest"),
    "executive-summary": ("application/pdf", "Executive Summary"),
}


def _require_provider(provider: str) -> None:
    if provider not in VALID_PROVIDERS:
        raise HTTPException(
            status_code=400,
            detail="That cloud provider isn't supported. Please choose AWS, Azure, GCP, Kubernetes, or Private Cloud.",
        )


async def _latest_architecture(project: Project, db: AsyncSession) -> Architecture:
    record = (
        await db.execute(
            select(Architecture)
            .where(Architecture.project_id == project.id)
            .order_by(Architecture.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if not record:
        raise HTTPException(status_code=404, detail="No architecture design found. Please generate one first.")
    return record


async def _latest_requirements(project: Project, db: AsyncSession) -> Requirement | None:
    return (
        await db.execute(
            select(Requirement)
            .where(Requirement.project_id == project.id)
            .order_by(Requirement.version.desc())
            .limit(1)
        )
    ).scalar_one_or_none()


async def _build_terraform_or_k8s_zip(provider: str, project: Project, db: AsyncSession) -> tuple[bytes, str]:
    """Shared by the direct-download route and the email-export route -- returns (zip_bytes,
    filename), identical file set either way."""
    record = await _latest_architecture(project, db)
    reqs = await _latest_requirements(project, db)

    if provider == "kubernetes":
        files_map = generate_kubernetes_manifests(
            project.name, record.hld["components"], record.hld["connections"], reqs.industry_context if reqs else None
        )
    else:
        files_map = generate_terraform_code(
            provider, project.name, record.hld["components"], record.hld["connections"], reqs.industry_context if reqs else None
        )

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zip_file:
        for filename, content in files_map.items():
            zip_file.writestr(filename, content)

    safe_name = re.sub(r"[^a-z0-9]", "-", project.name.lower())
    export_label = "k8s-manifests" if provider == "kubernetes" else "terraform"
    return buffer.getvalue(), f"{safe_name}-{export_label}-{provider}.zip"


async def _build_executive_summary_pdf_bytes(provider: str, project: Project, db: AsyncSession) -> tuple[bytes, str]:
    """Shared by the direct-download route and the email-export route -- returns (pdf_bytes,
    filename). Not cached (same tradeoff as the original route): a fresh LLM call per request,
    acceptable for a one-page, rarely-repeated synthesis, and rate-limited on both routes because
    of it."""
    record = await _latest_architecture(project, db)
    reqs = await _latest_requirements(project, db)

    cost = calculate_total_cost(record.hld.get("components", []), provider)
    functional = reqs.functional if reqs else []
    non_functional = reqs.non_functional if reqs else {}
    industry_context = reqs.industry_context if reqs else DEFAULT_INDUSTRY_CONTEXT
    assumptions = record.reasoning.get("assumptions", [])
    risks = record.reasoning.get("risks", [])

    summary = await generate_executive_summary(
        project.name, provider, cost, functional, non_functional, industry_context, assumptions, risks, settings.openrouter_api_key
    )
    pdf_bytes = build_executive_summary_pdf(project.name, provider, record.version, cost, summary)
    safe_name = re.sub(r"[^a-z0-9]", "-", project.name.lower())
    return pdf_bytes, f"{safe_name}-executive-summary.pdf"


@router.get("/projects/{project_id}/export")
async def export_architecture(
    provider: str = "aws", project: Project = Depends(get_owned_project), db: AsyncSession = Depends(get_db)
):
    _require_provider(provider)
    zip_bytes, filename = await _build_terraform_or_k8s_zip(provider, project, db)
    return Response(
        content=zip_bytes,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/projects/{project_id}/export/executive-summary")
@limiter.limit("20/hour")
async def export_executive_summary(
    request: Request,
    provider: str = "aws",
    project: Project = Depends(get_owned_project),
    db: AsyncSession = Depends(get_db),
):
    """Workstream T2 -- a one-page, plain-business-language PDF for a non-technical stakeholder.
    Deliberately a GET (like export_architecture above) so it can be triggered as a direct
    download link, not a fetch+blob round-trip."""
    _require_provider(provider)
    pdf_bytes, filename = await _build_executive_summary_pdf_bytes(provider, project, db)
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/projects/{project_id}/export/email")
@limiter.limit("10/hour")
async def email_export(
    request: Request,
    payload: EmailExportRequest,
    project: Project = Depends(get_owned_project),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """'Email to me' -- always sends to the requester's own Clerk-registered email (current_user.
    email, synced at account-sync time, see app/services/clerk_sync.py), never an
    address supplied in the request body, so this can't be turned into a way to spam an arbitrary
    inbox. Terraform/Kubernetes/Executive Summary are regenerated server-side via the exact same
    functions the direct-download routes use; Docs/Image are already-generated client-side content
    the browser attaches as base64 (see EmailExportAttachment)."""
    if payload.format in SERVER_GENERATED_FORMATS:
        _require_provider(payload.provider)
        content_type, label = SERVER_GENERATED_FORMATS[payload.format]
        if payload.format == "executive-summary":
            attachment_bytes, filename = await _build_executive_summary_pdf_bytes(payload.provider, project, db)
        else:
            attachment_bytes, filename = await _build_terraform_or_k8s_zip(payload.provider, project, db)
    elif payload.format in ("docs", "image"):
        if not payload.attachment:
            raise HTTPException(status_code=400, detail="Please try exporting again.")
        try:
            attachment_bytes = base64.b64decode(payload.attachment.contentBase64)
        except Exception:
            raise HTTPException(status_code=400, detail="Please try exporting again.")
        filename = payload.attachment.filename
        content_type = payload.attachment.mimeType
        label = "Documentation" if payload.format == "docs" else "Diagram"
    else:
        raise HTTPException(status_code=400, detail="That export type isn't supported.")

    try:
        await send_export_email(
            to_email=current_user.email,
            project_name=project.name,
            export_label=label,
            attachment_filename=filename,
            attachment_bytes=attachment_bytes,
            attachment_content_type=content_type,
        )
    except ExportEmailError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    return {"ok": True, "sentTo": current_user.email}
