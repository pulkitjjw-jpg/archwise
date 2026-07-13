import secrets
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.dependencies import get_owned_project
from app.models import Architecture, Project, ShareLink
from app.serializers import serialize_architecture

router = APIRouter()


def _serialize_share_link(link: ShareLink) -> dict:
    return {
        "id": str(link.id),
        "projectId": str(link.project_id),
        "token": link.token,
        "createdAt": link.created_at,
        "revokedAt": link.revoked_at,
        "isActive": link.revoked_at is None,
    }


@router.post("/projects/{project_id}/share-links", status_code=201)
async def create_share_link(project: Project = Depends(get_owned_project), db: AsyncSession = Depends(get_db)) -> dict:
    """Workstream T7 -- generates a new unguessable, no-login read-only link for this project.
    A project can have several active links at once; each has an independent lifetime."""
    # token_urlsafe(32) -- 256 bits of entropy, not derived from or embedding the project's own
    # UUID, so a leaked/guessed token never reveals or relates to the real project id.
    link = ShareLink(project_id=project.id, token=secrets.token_urlsafe(32))
    db.add(link)
    await db.commit()

    return {"shareLink": _serialize_share_link(link)}


@router.get("/projects/{project_id}/share-links")
async def list_share_links(project: Project = Depends(get_owned_project), db: AsyncSession = Depends(get_db)) -> dict:
    """For the creator's own link-management UI -- lists every link ever created for this
    project, active or revoked, newest first."""
    links = (
        (
            await db.execute(
                select(ShareLink).where(ShareLink.project_id == project.id).order_by(ShareLink.created_at.desc())
            )
        )
        .scalars()
        .all()
    )
    return {"shareLinks": [_serialize_share_link(link) for link in links]}


@router.delete("/projects/{project_id}/share-links/{share_link_id}")
async def revoke_share_link(
    share_link_id: uuid.UUID, project: Project = Depends(get_owned_project), db: AsyncSession = Depends(get_db)
) -> dict:
    """Revokes one link -- the row is kept (revoked_at set), not deleted, so it stays visible in
    the management list as "this used to work." Immediately makes the public /share/{token}
    lookup 404 for anyone still holding the link."""
    link = (
        await db.execute(
            select(ShareLink).where(ShareLink.id == share_link_id, ShareLink.project_id == project.id)
        )
    ).scalar_one_or_none()
    if not link:
        raise HTTPException(status_code=404, detail="Share link not found")

    if link.revoked_at is None:
        link.revoked_at = datetime.now(timezone.utc)
        await db.commit()

    return {"shareLink": _serialize_share_link(link)}


@router.get("/share/{token}")
async def get_shared_architecture(token: str, db: AsyncSession = Depends(get_db)) -> dict:
    """The PUBLIC, no-login read endpoint the shared page itself calls. Only ever reads the
    latest architecture already generated/cached for this project -- never triggers flow-story/
    journey/migration-roadmap generation (those are POSTs on the authenticated-workspace routes
    only), since an unauthenticated link must never be able to trigger paid LLM calls."""
    link = (await db.execute(select(ShareLink).where(ShareLink.token == token))).scalar_one_or_none()
    if not link or link.revoked_at is not None:
        raise HTTPException(status_code=404, detail="This share link doesn't exist or has been revoked.")

    project = (await db.execute(select(Project).where(Project.id == link.project_id))).scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    architecture = (
        await db.execute(
            select(Architecture)
            .where(Architecture.project_id == link.project_id)
            .order_by(Architecture.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if not architecture:
        raise HTTPException(status_code=404, detail="No architecture has been generated for this project yet.")

    return {
        "projectName": project.name,
        "architecture": serialize_architecture(architecture),
    }
