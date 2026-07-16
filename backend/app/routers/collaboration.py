import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.dependencies import get_accessible_project, get_current_user, get_owned_project
from app.models import Project, ProjectComment, ProjectMembership, User
from app.rate_limit import limiter
from app.schemas import CommentCreateRequest, MemberInviteRequest
from app.serializers import serialize_project_comment, serialize_project_membership
from app.services.audit import write_audit_log

router = APIRouter()

VALID_MEMBER_ROLES = ("editor", "viewer")


def _serialize_membership(m: ProjectMembership, user: User) -> dict:
    return {**serialize_project_membership(m), "userEmail": user.email}


def _serialize_comment(c: ProjectComment, author: User | None) -> dict:
    return {**serialize_project_comment(c), "authorEmail": author.email if author else None}


# ---------------------------------------------------------------------------
# Membership -- real, invite-by-email collaboration on a project, beyond the existing read-only,
# unauthenticated ShareLink (see app/routers/share.py, this router's closest stylistic
# precedent). Management (invite/revoke) is owner-only (get_owned_project, the STRICT check);
# listing is open to the owner AND any current member (get_accessible_project, the BROADER
# check) so a collaborator can see who else has access.
# ---------------------------------------------------------------------------


@router.post("/projects/{project_id}/members", status_code=201)
@limiter.limit("20/hour")
async def invite_member(
    request: Request,
    payload: MemberInviteRequest,
    project: Project = Depends(get_owned_project),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Invites an EXISTING user (by email) to collaborate on this project. There's no
    invite-a-nonexistent-user flow -- if no Clerk-synced User row matches the email yet (they've
    never signed in to this app), this 404s with a clear message rather than silently creating a
    placeholder, same reasoning CLAUDE.md's scoping already called out."""
    role = payload.role.strip().lower()
    if role not in VALID_MEMBER_ROLES:
        raise HTTPException(status_code=400, detail="Role must be either 'editor' or 'viewer'.")

    email = payload.email.strip()
    if not email:
        raise HTTPException(status_code=400, detail="Please enter an email address to invite.")

    # Case-insensitive -- email casing isn't security-sensitive here (see clerk_sync.py's own
    # docstring: `email` is a display-only, point-in-time copy of what Clerk reports), and a
    # project owner typing an invite by hand shouldn't have to match stored casing exactly.
    target_user = (
        await db.execute(select(User).where(func.lower(User.email) == func.lower(email)))
    ).scalar_one_or_none()
    if not target_user:
        raise HTTPException(
            status_code=404,
            detail="No account found for that email. They need to sign in to this app at least once before you can invite them.",
        )
    if target_user.id == project.user_id:
        raise HTTPException(status_code=400, detail="This user already owns the project.")

    membership = ProjectMembership(
        project_id=project.id, user_id=target_user.id, role=role, invited_by_user_id=current_user.id
    )
    db.add(membership)
    try:
        await db.flush()
    except IntegrityError:
        # The (project_id, user_id) unique constraint -- turn the raw DB error into a clean 409
        # rather than letting it bubble up as a 500.
        await db.rollback()
        raise HTTPException(status_code=409, detail="This user already has access to this project.")

    await write_audit_log(
        db,
        actor_user_id=current_user.id,
        action="project_membership.created",
        target_type="project_membership",
        target_id=str(membership.id),
        extra_data={"projectId": str(project.id), "invitedUserId": str(target_user.id), "role": role},
    )
    await db.commit()

    return {"member": _serialize_membership(membership, target_user)}


@router.get("/projects/{project_id}/members")
async def list_members(
    project: Project = Depends(get_accessible_project), db: AsyncSession = Depends(get_db)
) -> dict:
    """Open to the owner AND any current member -- so a collaborator can see who else has
    access, not just the owner."""
    rows = (
        await db.execute(
            select(ProjectMembership, User)
            .join(User, ProjectMembership.user_id == User.id)
            .where(ProjectMembership.project_id == project.id)
            .order_by(ProjectMembership.created_at.asc())
        )
    ).all()
    return {"members": [_serialize_membership(m, u) for m, u in rows]}


@router.delete("/projects/{project_id}/members/{membership_id}")
async def revoke_member(
    membership_id: uuid.UUID,
    project: Project = Depends(get_owned_project),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Owner-only, same as invite -- managing WHO has access is never delegated to a collaborator,
    even an editor. Unlike ShareLink.revoked_at, the row is actually deleted (not soft-revoked):
    a membership has no independent "history" value the way a share link's revoked-but-visible
    state does -- once revoked, there's nothing left worth remembering about it."""
    membership = (
        await db.execute(
            select(ProjectMembership).where(
                ProjectMembership.id == membership_id, ProjectMembership.project_id == project.id
            )
        )
    ).scalar_one_or_none()
    if not membership:
        raise HTTPException(status_code=404, detail="Membership not found")

    await write_audit_log(
        db,
        actor_user_id=current_user.id,
        action="project_membership.revoked",
        target_type="project_membership",
        target_id=str(membership.id),
        extra_data={"projectId": str(project.id), "revokedUserId": str(membership.user_id), "role": membership.role},
    )
    await db.delete(membership)
    await db.commit()

    return {"revoked": True}


# ---------------------------------------------------------------------------
# Comments -- lightweight in-app discussion thread on a project. Open to the owner AND any
# member REGARDLESS of role (viewer or editor) for both posting and reading -- unlike
# brainstorm/requirements/architecture content, commenting isn't a "content mutation" a viewer
# should be locked out of, it's the collaboration surface itself.
# ---------------------------------------------------------------------------


@router.post("/projects/{project_id}/comments", status_code=201)
@limiter.limit("60/hour")
async def create_comment(
    request: Request,
    payload: CommentCreateRequest,
    project: Project = Depends(get_accessible_project),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    comment = ProjectComment(project_id=project.id, author_user_id=current_user.id, body=payload.body.strip())
    db.add(comment)
    await db.commit()
    return {"comment": _serialize_comment(comment, current_user)}


@router.get("/projects/{project_id}/comments")
async def list_comments(
    project: Project = Depends(get_accessible_project), db: AsyncSession = Depends(get_db)
) -> dict:
    # Oldest-first -- same ordering precedent as conversations.py's brainstorm history, so a
    # comment thread reads top-to-bottom like the rest of this app's chronological views.
    rows = (
        await db.execute(
            select(ProjectComment, User)
            .join(User, ProjectComment.author_user_id == User.id, isouter=True)
            .where(ProjectComment.project_id == project.id)
            .order_by(ProjectComment.created_at.asc())
        )
    ).all()
    return {"comments": [_serialize_comment(c, u) for c, u in rows]}


@router.delete("/projects/{project_id}/comments/{comment_id}")
async def delete_comment(
    comment_id: uuid.UUID,
    project: Project = Depends(get_accessible_project),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """The comment's own author OR the project owner (moderation) can delete it. 403, not 404,
    for "not yours" -- unlike an API key or webhook (private to their owner), a comment is
    already visible to every project member via GET above, so hiding its existence here would
    accomplish nothing and would just be confusing."""
    comment = (
        await db.execute(
            select(ProjectComment).where(ProjectComment.id == comment_id, ProjectComment.project_id == project.id)
        )
    ).scalar_one_or_none()
    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found")

    is_author = comment.author_user_id == current_user.id
    is_owner = project.user_id == current_user.id
    if not is_author and not is_owner:
        raise HTTPException(status_code=403, detail="You can only delete your own comments.")

    await db.delete(comment)
    await db.commit()

    return {"deleted": True}
