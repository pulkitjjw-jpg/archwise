import hashlib
import secrets
import uuid
from collections import defaultdict
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.dependencies import get_current_user
from app.models import (
    ApiKey,
    Architecture,
    Conversation,
    Project,
    ProjectComment,
    ProjectMembership,
    Requirement,
    ShareLink,
    User,
    Webhook,
)
from app.rate_limit import limiter
from app.schemas import ApiKeyCreateRequest, DeleteAccountRequest, WebhookCreateRequest
from app.serializers import (
    serialize_api_key,
    serialize_architecture,
    serialize_conversation,
    serialize_project,
    serialize_project_comment,
    serialize_project_membership,
    serialize_requirement,
    serialize_share_link,
    serialize_user,
    serialize_webhook,
)
from app.services.audit import write_audit_log

router = APIRouter()

# The only event type this pass's webhook delivery mechanism actually fires (see
# app/worker.py's generate_architecture_task / app/services/webhooks.py) -- validated against at
# registration time so a typo'd event name doesn't silently register a webhook that can never
# fire. A plain set (not an enum) so a future event type is a one-line addition here, same
# "free-form but namespaced" precedent as AuditLog.action in app/models.py.
ALLOWED_WEBHOOK_EVENT_TYPES = {"architecture.generated"}

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


# ---------------------------------------------------------------------------
# API keys -- self-service programmatic access (see app/dependencies.py's
# get_user_from_api_key and app/routers/public_api.py, the only consumer of the keys minted
# here). Management itself stays Clerk-authenticated (get_current_user) -- a browser session is
# how a user proves "I'm allowed to mint/revoke keys for this account" in the first place.
# ---------------------------------------------------------------------------


@router.post("/auth/me/api-keys", status_code=201)
@limiter.limit("20/hour")
async def create_api_key(
    request: Request,
    payload: ApiKeyCreateRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    # secrets.token_urlsafe(32) -- a real random secret (256 bits), not a low-entropy
    # user-chosen value, same reasoning that lets get_user_from_api_key hash it with plain
    # sha256 instead of a slow password hash. Prefixed so a leaked key is recognizable at a
    # glance (same convention as a GitHub `ghp_...` / Stripe `sk_...` token).
    raw_key = f"arc_{secrets.token_urlsafe(32)}"
    key_hash = hashlib.sha256(raw_key.encode()).hexdigest()
    # First 12 chars (including the "arc_" prefix) -- enough to tell keys apart in the list view
    # without re-exposing anything secret; the rest of the key is never stored anywhere.
    key_prefix = raw_key[:12]

    api_key = ApiKey(user_id=current_user.id, name=payload.name, key_hash=key_hash, key_prefix=key_prefix)
    db.add(api_key)
    await db.flush()

    await write_audit_log(
        db,
        actor_user_id=current_user.id,
        action="api_key.created",
        target_type="api_key",
        target_id=str(api_key.id),
        extra_data={"name": payload.name, "keyPrefix": key_prefix},
    )
    await db.commit()

    return {
        "apiKey": {
            **serialize_api_key(api_key),
            # THE ONLY TIME the raw key is ever returned. Only key_hash is persisted -- this app
            # can never show it again after this response, the same "shown once" UX as GitHub,
            # Stripe, and every other real API-key issuer. Copy it now; losing it means minting a
            # new key, there is no recovery path.
            "key": raw_key,
        }
    }


@router.get("/auth/me/api-keys")
async def list_api_keys(current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)) -> dict:
    keys = (
        await db.execute(select(ApiKey).where(ApiKey.user_id == current_user.id).order_by(ApiKey.created_at.desc()))
    ).scalars().all()
    return {"apiKeys": [serialize_api_key(k) for k in keys]}


@router.delete("/auth/me/api-keys/{key_id}")
async def revoke_api_key(
    key_id: uuid.UUID, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> dict:
    api_key = (
        await db.execute(select(ApiKey).where(ApiKey.id == key_id, ApiKey.user_id == current_user.id))
    ).scalar_one_or_none()
    if not api_key:
        raise HTTPException(status_code=404, detail="API key not found")

    # Idempotent -- revoking an already-revoked key just returns its current state rather than
    # erroring or double-logging the audit trail.
    if api_key.revoked_at is None:
        api_key.revoked_at = datetime.now(UTC)
        await write_audit_log(
            db,
            actor_user_id=current_user.id,
            action="api_key.revoked",
            target_type="api_key",
            target_id=str(api_key.id),
            extra_data={"name": api_key.name},
        )
        await db.commit()

    return {"apiKey": serialize_api_key(api_key)}


# ---------------------------------------------------------------------------
# Webhooks -- self-service outbound event subscriptions. See app/services/webhooks.py (matching +
# enqueueing) and app/worker.py's deliver_webhook_task (the actual HTTP delivery, run as its own
# arq job so a slow/down receiver can never block or fail the generation job that triggered it).
# ---------------------------------------------------------------------------


@router.post("/auth/me/webhooks", status_code=201)
@limiter.limit("20/hour")
async def create_webhook(
    request: Request,
    payload: WebhookCreateRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    unknown_event_types = set(payload.eventTypes) - ALLOWED_WEBHOOK_EVENT_TYPES
    if unknown_event_types:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unknown event type(s): {', '.join(sorted(unknown_event_types))}. "
                f"Supported event types: {', '.join(sorted(ALLOWED_WEBHOOK_EVENT_TYPES))}."
            ),
        )

    raw_secret = secrets.token_urlsafe(32)
    webhook = Webhook(user_id=current_user.id, url=payload.url, secret=raw_secret, event_types=payload.eventTypes)
    db.add(webhook)
    await db.flush()

    await write_audit_log(
        db,
        actor_user_id=current_user.id,
        action="webhook.created",
        target_type="webhook",
        target_id=str(webhook.id),
        extra_data={"url": webhook.url, "eventTypes": webhook.event_types},
    )
    await db.commit()

    return {
        "webhook": {
            **serialize_webhook(webhook),
            # Shown exactly once, same "shown once" UX and reasoning as the API key's raw value
            # above -- only the plaintext secret can HMAC-verify a received payload, and only the
            # receiving end needs to keep it, so this app never needs to show it again.
            "secret": raw_secret,
        }
    }


@router.get("/auth/me/webhooks")
async def list_webhooks(current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)) -> dict:
    webhooks = (
        await db.execute(select(Webhook).where(Webhook.user_id == current_user.id).order_by(Webhook.created_at.desc()))
    ).scalars().all()
    return {"webhooks": [serialize_webhook(w) for w in webhooks]}


@router.delete("/auth/me/webhooks/{webhook_id}")
async def disable_webhook(
    webhook_id: uuid.UUID, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> dict:
    webhook = (
        await db.execute(select(Webhook).where(Webhook.id == webhook_id, Webhook.user_id == current_user.id))
    ).scalar_one_or_none()
    if not webhook:
        raise HTTPException(status_code=404, detail="Webhook not found")

    # Soft-disable, not delete -- same "revoke, don't delete" precedent as ApiKey.revoked_at
    # above and ShareLink.revoked_at, keeps the delivery history (webhook_deliveries) intact.
    if webhook.disabled_at is None:
        webhook.disabled_at = datetime.now(UTC)
        await write_audit_log(
            db,
            actor_user_id=current_user.id,
            action="webhook.disabled",
            target_type="webhook",
            target_id=str(webhook.id),
            extra_data={"url": webhook.url},
        )
        await db.commit()

    return {"webhook": serialize_webhook(webhook)}
