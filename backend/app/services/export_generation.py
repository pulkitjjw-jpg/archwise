"""Shared Terraform/Kubernetes zip + Executive Summary PDF generation. Extracted out of
app/routers/export.py (same "pull the pipeline out of the router" precedent as
app/services/architecture_generation.py) so this logic has exactly one implementation reachable
from two different callers with two very different execution contexts:

  - app/worker.py's generate_export_task, a background arq job with no FastAPI/Request in scope
    at all.
  - app/routers/export.py's email_export route, which still runs synchronously in the request/
    response cycle (see that route's docstring for why "email to me" wasn't moved to the job
    queue -- it has no large file to stream back to the browser, so the request-worker-exhaustion
    risk this whole job-queue effort targets doesn't really apply to it the same way).

Raises ExportGenerationError (a plain exception, not an HTTPException) for the same user-facing
conditions the router used to turn into a 404 directly -- neither caller above can meaningfully
raise a Starlette HTTPException: the worker isn't running inside a request at all, and turning a
job failure's error message into "404: ..." via HTTPException.__str__ would leak an HTTP status
code into what's supposed to be a plain-language job-status message. Each caller converts this
into whatever error surface fits it (email_export re-raises as HTTPException(404, str(exc));
the worker stores str(exc) directly as the job's error field)."""

import io
import re
import zipfile

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.constants import DEFAULT_INDUSTRY_CONTEXT
from app.models import Architecture, Project, Requirement
from app.services.architecture_diff import calculate_total_cost
from app.services.executive_summary_pdf import build_executive_summary_pdf
from app.services.k8s_manifest_generator import generate_kubernetes_manifests
from app.services.llm import generate_executive_summary
from app.services.terraform_generator import generate_terraform_code

VALID_PROVIDERS = ("aws", "azure", "gcp", "kubernetes", "private")


class ExportGenerationError(Exception):
    """A user-facing, plain-language error -- str(exc) is safe to show directly, same convention
    as every HTTPException.detail elsewhere in this app."""


async def latest_architecture(project: Project, db: AsyncSession) -> Architecture:
    record = (
        await db.execute(
            select(Architecture)
            .where(Architecture.project_id == project.id)
            .order_by(Architecture.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if not record:
        raise ExportGenerationError("No architecture design found. Please generate one first.")
    return record


async def latest_requirements(project: Project, db: AsyncSession) -> Requirement | None:
    return (
        await db.execute(
            select(Requirement)
            .where(Requirement.project_id == project.id)
            .order_by(Requirement.version.desc())
            .limit(1)
        )
    ).scalar_one_or_none()


async def build_terraform_or_k8s_zip(provider: str, project: Project, db: AsyncSession) -> tuple[bytes, str]:
    """Shared by the export-job worker and the email-export route -- returns (zip_bytes,
    filename), identical file set either way."""
    record = await latest_architecture(project, db)
    reqs = await latest_requirements(project, db)

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


async def build_executive_summary_pdf_bytes(provider: str, project: Project, db: AsyncSession) -> tuple[bytes, str]:
    """Shared by the export-job worker and the email-export route -- returns (pdf_bytes,
    filename). Not cached (same tradeoff as the original synchronous route): a fresh LLM call per
    request/job, acceptable for a one-page, rarely-repeated synthesis."""
    record = await latest_architecture(project, db)
    reqs = await latest_requirements(project, db)

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
