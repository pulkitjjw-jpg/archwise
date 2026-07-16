"""The app's first genuinely-external-facing API surface -- authenticated with an API key
(app/dependencies.py's get_user_from_api_key) instead of a Clerk browser session, for callers
that will never have one: a CI pipeline, a script, someone's own integration against this app's
data. Deliberately small -- this establishes the pattern (API-key auth working end-to-end against
real data, scoped correctly to the key's owner) rather than mirroring every existing endpoint.

Reachability, given this app's network topology (see docker-compose.yml: the FastAPI backend
publishes its port to 127.0.0.1 only in dev, and not at all in a real deployment -- it is NEVER
reachable directly from the public internet, only from Next.js's own server-side proxy): a
caller reaches these routes the exact same way the browser reaches every other backend route
today, through src/app/api/[...path]/route.ts's catch-all proxy (e.g. a plain
`curl -H "Authorization: Bearer <api-key>" https://<app-domain>/api/public/projects`, no Clerk
session/cookie at all). That proxy already forwards the Authorization header verbatim when there
is no Clerk session to mint one from (see route.ts: it only overwrites the header when
`getToken()` returns a real session token), and app/main.py's require_internal_auth middleware
is satisfied because the PROXY is what's calling this backend -- the proxy always attaches
X-Internal-Auth to every request it forwards, regardless of how the original caller authenticated
to IT. So this router is mounted under the exact same prefix/middleware stack as every other
router (no exemption from require_internal_auth needed or added); the API key is what
authenticates the CALLER to the app, the internal-auth header is what authenticates the PROXY to
this backend -- two different hops, two different concerns, neither one replaces the other.

"Public API" in this pass therefore means "authenticate with an API key instead of a Clerk
session, still routed through the existing Next.js proxy" -- not "the FastAPI port is directly
exposed to the internet." Actually publishing backend:8000 beyond the proxy is a real
infra/deployment decision (a load balancer, a public ingress, its own rate limiting/WAF
posture) that's out of scope here and unchanged by this pass.
"""

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.dependencies import get_owned_project_by_api_key, get_user_from_api_key
from app.models import Project, User
from app.routers.projects import _list_projects_for_user
from app.serializers import serialize_project

router = APIRouter()


@router.get("/public/projects")
async def list_my_projects(
    current_user: User = Depends(get_user_from_api_key), db: AsyncSession = Depends(get_db)
) -> dict:
    """Same shape/data as GET /projects (the Clerk-session version in app/routers/projects.py) --
    reuses its exact query + serialization via _list_projects_for_user rather than a parallel
    implementation that could silently drift from it."""
    return await _list_projects_for_user(db, current_user.id)


@router.get("/public/projects/{project_id}")
async def get_my_project(project: Project = Depends(get_owned_project_by_api_key)) -> dict:
    """Same shape as GET /projects/{project_id} -- get_owned_project_by_api_key gives the same
    404-for-both-not-found-and-not-owned ownership check as the Clerk-session
    get_owned_project, just resolved from the API key's owning user instead."""
    return {"project": serialize_project(project)}
