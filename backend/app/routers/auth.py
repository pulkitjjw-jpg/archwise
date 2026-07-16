from collections import defaultdict
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.dependencies import get_current_user
from app.models import (
    Architecture,
    Conversation,
    Project,
    ProjectComment,
    ProjectMembership,
    Requirement,
    ShareLink,
    User,
)
from app.rate_limit import limiter
from app.schemas import DeleteAccountRequest
from app.serializers import (
    serialize_architecture,
    serialize_conversation,
    serialize_project,
    serialize_project_comment,
    serialize_project_membership,
    serialize_requirement,
    serialize_share_link,
    serialize_user,
)
from app.services.audit import write_audit_log

router = APIRouter()

# Register/login/logout/forgot-password/reset-password/change-password all removed -- Clerk owns
# credentials, sessions, and email verification entirely now (see app/dependencies.py's
# get_current_user and app/services/clerk_sync.py). The one route kept was this: the frontend
# still needs to know app-specific state Clerk has no concept of (our internal user id, isAdmin)
# alongside whatever it already gets straight from Clerk's own hooks client-side. Two more were
# added below for GDPR self-service: export-my-data and delete-my-account.


@router.get("/auth/me")
async def me(current_user: User = Depends(get_current_user)) -> dict:
    return {"user": serialize_user(current_user)}


@router.get("/auth/me/export")
@limiter.limit("5/hour")
async def export_my_data(
    request: Request, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> dict:
    """GDPR data export -- a single JSON dump of everything this app has ABOUT the current user,
    for their own self-service download (no admin required, and only ever the caller's own data --
    there is no user_id parameter here to accidentally widen). Rate-limited tighter than the
    read-only routes elsewhere in this app (5/hour, vs. e.g. 60/hour for GET /projects) since a
    power user with many projects makes this a real, if infrequent, multi-table query -- not
    something a legitimate user needs to hit repeatedly.

    Deliberately raw per-table `select()` queries keyed by project id (the same shape
    `_latest_architecture`/`_latest_requirements` already use in export.py), not ORM relationship
    traversal -- this app's models don't use eager (selectin/joined) loading, so touching a lazy
    relationship attribute from an async session raises MissingGreenlet instead of quietly
    N+1-querying like it would under sync SQLAlchemy.
    """
    projects = (await db.execute(select(Project).where(Project.user_id == current_user.id))).scalars().all()
    project_ids = [p.id for p in projects]

    conversations_by_project: dict = defaultdict(list)
    requirements_by_project: dict = defaultdict(list)
    architectures_by_project: dict = defaultdict(list)
    share_links_by_project: dict = defaultdict(list)

    if project_ids:
        conversations = (
            (await db.execute(select(Conversation).where(Conversation.project_id.in_(project_ids))))
            .scalars()
            .all()
        )
        for c in conversations:
            conversations_by_project[c.project_id].append(serialize_conversation(c))

        requirements = (
            (await db.execute(select(Requirement).where(Requirement.project_id.in_(project_ids))))
            .scalars()
            .all()
        )
        for r in requirements:
            requirements_by_project[r.project_id].append(serialize_requirement(r))

        architectures = (
            (await db.execute(select(Architecture).where(Architecture.project_id.in_(project_ids))))
            .scalars()
            .all()
        )
        for a in architectures:
            architectures_by_project[a.project_id].append(serialize_architecture(a))

        share_links = (
            (await db.execute(select(ShareLink).where(ShareLink.project_id.in_(project_ids)))).scalars().all()
        )
        for s in share_links:
            share_links_by_project[s.project_id].append(serialize_share_link(s))

    # project_memberships / project_comments are queried by the USER's own id (member of / author
    # of), not scoped to their own projects -- collaboration (ProjectMembership) means a row here
    # can reference a project this user doesn't own, and that row is still genuinely "data about
    # this user" (which projects they were granted access to). Both tables are new and likely
    # empty for every real user right now (see app/models.py) -- queried unconditionally anyway
    # rather than skipped, per the GDPR export's own point: don't guess what's empty, ask the DB.
    memberships = (
        (await db.execute(select(ProjectMembership).where(ProjectMembership.user_id == current_user.id)))
        .scalars()
        .all()
    )
    comments = (
        (await db.execute(select(ProjectComment).where(ProjectComment.author_user_id == current_user.id)))
        .scalars()
        .all()
    )

    return {
        "exportedAt": datetime.now(UTC).isoformat(),
        "user": {
            "id": str(current_user.id),
            "clerkUserId": current_user.clerk_user_id,
            "email": current_user.email,
            "isAdmin": current_user.is_admin,
            "createdAt": current_user.created_at,
        },
        "projects": [
            {
                **serialize_project(p),
                "conversations": conversations_by_project.get(p.id, []),
                "requirements": requirements_by_project.get(p.id, []),
                "architectures": architectures_by_project.get(p.id, []),
                "shareLinks": share_links_by_project.get(p.id, []),
            }
            for p in projects
        ],
        "projectMemberships": [serialize_project_membership(m) for m in memberships],
        "projectComments": [serialize_project_comment(c) for c in comments],
    }


@router.delete("/auth/me")
@limiter.limit("5/hour")
async def delete_my_account(
    request: Request,
    payload: DeleteAccountRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Self-service account deletion. Requires the caller's own email as confirmation (see
    DeleteAccountRequest) -- a cheap guard against a stray/scripted DELETE silently nuking an
    account, since there's no other "are you sure" precedent anywhere else in this codebase to
    follow.

    Deletes this app's own data about the user ONLY. This does NOT delete the user's actual Clerk
    account/credentials -- Clerk owns identity, login, and sessions entirely (see
    app/dependencies.py's get_current_user); a user who deletes their account here can still sign
    back in via Clerk, at which point get_or_create_user_by_clerk_id (app/services/clerk_sync.py)
    would simply create a fresh, empty User row for them. Deleting the actual Clerk account is out
    of scope for this endpoint -- that's a separate, Clerk-side action this app doesn't manage.

    `Project.user_id` has `ON DELETE CASCADE` (see app/models.py) -- deleting the User row cascades
    to delete every project they own and everything nested under it (conversations, requirements,
    architectures, share_links). This is real, permanent, irreversible data loss, by design -- that
    IS what "delete my account" means.
    """
    if payload.confirmEmail != current_user.email:
        raise HTTPException(
            status_code=400,
            detail="Please type your account email exactly to confirm account deletion.",
        )

    projects = (await db.execute(select(Project).where(Project.user_id == current_user.id))).scalars().all()
    projects_deleted = len(projects)

    # Audit log written FIRST, before the User row (and thus this session's own FK anchor for the
    # log's actor_user_id) is gone -- though actor_user_id is ON DELETE SET NULL, so the row would
    # survive either ordering; this is just the cleaner order to read.
    await write_audit_log(
        db,
        actor_user_id=current_user.id,
        action="user.deleted_own_account",
        target_type="user",
        target_id=str(current_user.id),
        extra_data={"email": current_user.email, "projectsDeleted": projects_deleted},
    )

    await db.delete(current_user)
    await db.commit()

    return {
        "deleted": True,
        "projectsDeleted": projects_deleted,
        "message": (
            "Your account data has been permanently deleted from this app. This does not delete "
            "your sign-in account -- that's managed separately by Clerk."
        ),
    }
