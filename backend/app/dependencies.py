import uuid
from typing import Annotated

from clerk_backend_api.security.types import TokenVerificationError, VerifyTokenOptions
from clerk_backend_api.security.verifytoken import verify_token
from fastapi import Depends, Header, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import get_db
from app.models import Project, User
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


async def get_owned_project(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Project:
    """FastAPI resolves `project_id` from the path the same way whether it's a route's own
    parameter or, like here, a dependency's -- so any route with a {project_id} path segment can
    just depend on this and get an ownership-checked Project back in one shot, instead of every
    router hand-rolling the same `select(...).where(Project.id == ..., Project.user_id == ...)`
    check. Not-found and not-owned are indistinguishable (both 404) so a non-owner can never learn
    a project id exists at all."""
    project = (
        await db.execute(select(Project).where(Project.id == project_id, Project.user_id == current_user.id))
    ).scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project
