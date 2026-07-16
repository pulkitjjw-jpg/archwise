import hashlib
import uuid
from datetime import UTC, datetime
from typing import Annotated

from clerk_backend_api.security.types import TokenVerificationError, VerifyTokenOptions
from clerk_backend_api.security.verifytoken import verify_token
from fastapi import Depends, Header, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import get_db
from app.models import ApiKey, Project, User
from app.services.clerk_sync import get_or_create_user_by_clerk_id


async def get_current_user(
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
    db: AsyncSession = Depends(get_db),
) -> User:
    """Replaces the old Redis-session lookup with Clerk JWT verification. `jwt_key` (a PEM public
    key from the Clerk dashboard) makes this networkless -- a local signature check, same cost
    profile as the old Redis GET, not a round-trip to Clerk's API on every request. The Bearer
    token itself is forwarded by the Next.js catch-all proxy (src/app/api/[...path]/route.ts),
    which reads it via auth().getToken() -- this backend still never talks to a browser directly."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="You need to be logged in to do that. Please sign in and try again.")
    token = authorization.removeprefix("Bearer ")
    try:
        payload = verify_token(token, VerifyTokenOptions(jwt_key=settings.clerk_jwt_key))
    except TokenVerificationError:
        raise HTTPException(status_code=401, detail="Your session has expired. Please sign in again.")
    clerk_user_id = payload["sub"]
    user = await get_or_create_user_by_clerk_id(db, clerk_user_id)
    # Stashed so app/rate_limit.py's key function can rate-limit by user instead of by
    # connection -- every request arrives from the same Next.js proxy IP otherwise. Unchanged
    # from the pre-Clerk implementation -- rate_limit.py doesn't know or care where user_id
    # came from.
    request.state.user_id = user.id
    return user


async def require_admin(user: User = Depends(get_current_user)) -> User:
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="You don't have permission to access this.")
    return user


async def get_user_from_api_key(
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
    db: AsyncSession = Depends(get_db),
) -> User:
    """Second auth path, alongside get_current_user's Clerk-JWT verification -- for genuinely
    external callers (a CI pipeline, a script) that will never hold a browser Clerk session. See
    app/routers/public_api.py, the only router that depends on this today.

    Reads the same `Authorization: Bearer <token>` header get_current_user does (the more
    standard convention, matching how most real APIs do it), but the token here is a long-lived
    API key minted by POST /auth/me/api-keys, not a short-lived Clerk JWT -- so this hashes it and
    looks up a matching, non-revoked ApiKey row instead of verifying a signature. Same
    `request.state.user_id` stash as get_current_user, for the same reason: app/rate_limit.py's
    key function needs it to rate-limit by user rather than by connection, and it doesn't care
    which auth path set it.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=401, detail="Missing API key. Send it as an 'Authorization: Bearer <key>' header."
        )
    raw_key = authorization.removeprefix("Bearer ")
    # sha256, not a slow password hash (bcrypt/argon2) -- this is a high-entropy, randomly
    # generated 32-byte token (secrets.token_urlsafe(32), see POST /auth/me/api-keys), not a
    # low-entropy user-chosen password. A slow hash defends against offline brute-forcing a small
    # search space; that concern doesn't apply here, and it would make every authenticated
    # request noticeably slower for no real security benefit -- same reasoning CLAUDE.md/the
    # audit that scoped this work already called out.
    key_hash = hashlib.sha256(raw_key.encode()).hexdigest()
    api_key = (
        await db.execute(select(ApiKey).where(ApiKey.key_hash == key_hash, ApiKey.revoked_at.is_(None)))
    ).scalar_one_or_none()
    if not api_key:
        raise HTTPException(status_code=401, detail="That API key is invalid or has been revoked.")

    user = (await db.execute(select(User).where(User.id == api_key.user_id))).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=401, detail="That API key is invalid or has been revoked.")

    api_key.last_used_at = datetime.now(UTC)
    await db.commit()

    request.state.user_id = user.id
    return user


async def _load_owned_project(project_id: uuid.UUID, db: AsyncSession, user_id: uuid.UUID) -> Project:
    """Shared ownership check behind both get_owned_project (Clerk-session callers) and
    get_owned_project_by_api_key (API-key callers) below -- the check itself (does a project with
    this id belong to this user) doesn't care which auth path resolved the user, only the two
    dependency wrappers differ. Not-found and not-owned are indistinguishable (both 404) so a
    non-owner/wrong-key caller can never learn a project id exists at all."""
    project = (
        await db.execute(select(Project).where(Project.id == project_id, Project.user_id == user_id))
    ).scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


async def get_owned_project(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Project:
    """FastAPI resolves `project_id` from the path the same way whether it's a route's own
    parameter or, like here, a dependency's -- so any route with a {project_id} path segment can
    just depend on this and get an ownership-checked Project back in one shot, instead of every
    router hand-rolling the same `select(...).where(Project.id == ..., Project.user_id == ...)`
    check."""
    return await _load_owned_project(project_id, db, current_user.id)


async def get_owned_project_by_api_key(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_user_from_api_key),
) -> Project:
    """Same ownership check as get_owned_project, but resolves the caller via API-key auth
    (get_user_from_api_key) instead of a Clerk session -- used by app/routers/public_api.py's
    GET /public/projects/{project_id} so it can share get_owned_project's exact 404-for-both
    not-found/not-owned semantics without depending on get_current_user."""
    return await _load_owned_project(project_id, db, current_user.id)
