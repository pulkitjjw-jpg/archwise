import uuid
from typing import Annotated

from fastapi import Depends, Header, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.models import Project, User
from app.security import get_user_id_from_session


async def get_current_user(
    request: Request,
    x_session_token: Annotated[str | None, Header()] = None,
    db: AsyncSession = Depends(get_db),
) -> User:
    if not x_session_token:
        raise HTTPException(status_code=401, detail="You need to be logged in to do that. Please sign in and try again.")
    user_id = await get_user_id_from_session(x_session_token)
    if not user_id:
        raise HTTPException(status_code=401, detail="Your session has expired. Please sign in again.")
    user = await db.get(User, user_id)
    if not user:
        # The session outlived the user (e.g. deleted between login and this request) -- treat
        # exactly like any other invalid session rather than a distinct error, nothing useful to
        # tell the caller differently.
        raise HTTPException(status_code=401, detail="You need to be logged in to do that. Please sign in and try again.")
    # Stashed so app/rate_limit.py's key function can rate-limit by user instead of by
    # connection -- every request arrives from the same Next.js proxy IP otherwise.
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
