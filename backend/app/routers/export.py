import io
import re
import uuid
import zipfile

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.models import Architecture, Project, Requirement
from app.services.k8s_manifest_generator import generate_kubernetes_manifests
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
