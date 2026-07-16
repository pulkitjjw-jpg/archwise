import base64

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.dependencies import get_current_user, get_owned_project
from app.models import Project, User
from app.rate_limit import limiter
from app.schemas import EmailExportRequest, ExportJobRequest
from app.services import export_generation
from app.services.email import ExportEmailError, send_export_email
from app.services.export_generation import VALID_PROVIDERS, ExportGenerationError
from app.services.jobs import enqueue_export_job, get_export_file, get_job_status

router = APIRouter()

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


@router.post("/projects/{project_id}/export/jobs", status_code=202)
@limiter.limit("20/hour")
async def create_export_job(
    request: Request,
    payload: ExportJobRequest,
    project: Project = Depends(get_owned_project),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Replaces the old direct-download GET /projects/{project_id}/export and
    GET /projects/{project_id}/export/executive-summary routes -- both used to build the zip/PDF
    fully inline and stream it back in the same request. Terraform/Kubernetes generation itself is
    pure, fast, in-process computation (no LLM call, see app/services/terraform_generator.py /
    k8s_manifest_generator.py), but Executive Summary generation makes the same LLM fallback-chain
    call architecture generation does (up to ~35s under load) -- moving all three formats behind
    one job-queue endpoint keeps the contract uniform rather than having the frontend special-case
    "this export type is instant, that one polls". The 20/hour cap (previously only applied to
    executive-summary, the one with a real LLM cost) is now applied uniformly for the same reason;
    terraform/kubernetes exports were effectively unlimited before, a minor, deliberate
    tightening, not a functional regression for any real usage pattern.

    Returns 202 + a job id immediately; poll GET .../export/jobs/{job_id} below, then download
    from GET .../export/jobs/{job_id}/download once status is "complete"."""
    if payload.format not in SERVER_GENERATED_FORMATS:
        raise HTTPException(status_code=400, detail="That export type isn't supported.")
    _require_provider(payload.provider)

    # Fail fast on "no architecture yet" before a job is even queued -- same reasoning as the
    # free-tier cap check in architectures.py's generate_architecture, just for a different
    # precondition (export has no usage cap of its own).
    try:
        await export_generation.latest_architecture(project, db)
    except ExportGenerationError as exc:
        raise HTTPException(status_code=404, detail=str(exc))

    job_id = await enqueue_export_job(project_id=str(project.id), format=payload.format, provider=payload.provider)
    return {"jobId": job_id, "status": "pending"}


@router.get("/projects/{project_id}/export/jobs/{job_id}")
async def get_export_job(job_id: str, project: Project = Depends(get_owned_project)) -> dict:
    """Polling endpoint for the job enqueued above. See ArchitectureWorkspace.tsx's handleExport /
    handleExportExecutiveSummary for the frontend poll loop."""
    status_doc = await get_job_status("export", job_id)
    if not status_doc or status_doc.get("projectId") != str(project.id):
        raise HTTPException(
            status_code=404, detail="We couldn't find that export job. It may have expired -- please try again."
        )

    response: dict = {"jobId": job_id, "status": status_doc["status"]}
    if status_doc["status"] == "failed":
        response["error"] = status_doc.get("error") or "Export failed. Please try again."
    elif status_doc["status"] == "complete":
        result = status_doc.get("result") or {}
        response["filename"] = result.get("filename")
    return response


@router.get("/projects/{project_id}/export/jobs/{job_id}/download")
async def download_export_job(job_id: str, project: Project = Depends(get_owned_project)) -> Response:
    """Streams the actual file once the job is complete. Deliberately a SEPARATE route from the
    status-polling GET above, not folded into it -- arq/Redis job results aren't meant to carry a
    multi-MB binary payload through JSON, so the file bytes live under their own Redis key (see
    app/services/jobs.py's store_export_file/get_export_file) and this route is the only thing
    that reads them."""
    status_doc = await get_job_status("export", job_id)
    if not status_doc or status_doc.get("projectId") != str(project.id):
        raise HTTPException(
            status_code=404, detail="We couldn't find that export job. It may have expired -- please try again."
        )
    if status_doc["status"] != "complete":
        raise HTTPException(status_code=409, detail="This export isn't ready yet.")

    result = status_doc.get("result") or {}
    content = await get_export_file(job_id)
    if content is None:
        raise HTTPException(status_code=404, detail="This export has expired. Please generate it again.")

    return Response(
        content=content,
        media_type=result.get("contentType", "application/octet-stream"),
        headers={"Content-Disposition": f'attachment; filename="{result.get("filename", "export")}"'},
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
    app/services/export_generation.py functions the export-job worker uses; Docs/Image are
    already-generated client-side content the browser attaches as base64 (see
    EmailExportAttachment).

    Deliberately still synchronous (unlike the direct-download export routes above, now job-
    based) -- this route's response is a small JSON ack, never a multi-MB body streamed back to
    the browser, so it doesn't carry the same request-worker-exhaustion risk under load that
    motivated moving architecture generation and file exports to the background queue. It CAN
    still take up to ~35s for the executive-summary format (same LLM call), which is an accepted
    tradeoff for this one route given its lower call volume (10/hour, and only reachable after a
    real architecture already exists) -- worth revisiting if usage patterns prove otherwise."""
    if payload.format in SERVER_GENERATED_FORMATS:
        _require_provider(payload.provider)
        content_type, label = SERVER_GENERATED_FORMATS[payload.format]
        try:
            if payload.format == "executive-summary":
                attachment_bytes, filename = await export_generation.build_executive_summary_pdf_bytes(
                    payload.provider, project, db
                )
            else:
                attachment_bytes, filename = await export_generation.build_terraform_or_k8s_zip(
                    payload.provider, project, db
                )
        except ExportGenerationError as exc:
            raise HTTPException(status_code=404, detail=str(exc))
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
