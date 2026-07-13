from slowapi import Limiter
from slowapi.util import get_remote_address
from starlette.requests import Request

from app.config import settings


def _rate_limit_key(request: Request) -> str:
    # Prefer the authenticated user's id (stashed on request.state by get_current_user) so limits
    # are per-user, not per-connection -- every request arrives from the same Next.js proxy, so a
    # plain remote-address key would lump every user together. Falls back to the real client IP
    # (forwarded by the proxy via x-real-ip/x-forwarded-for -- see src/app/api/[...path]/route.ts)
    # for the couple of routes with no auth yet: register/login themselves, where IP-based
    # throttling is exactly the right anti-abuse signal (brute force, signup spam).
    user_id = getattr(request.state, "user_id", None)
    if user_id:
        return f"user:{user_id}"
    forwarded = request.headers.get("x-real-ip") or request.headers.get("x-forwarded-for")
    return forwarded.split(",")[0].strip() if forwarded else get_remote_address(request)


# Shared storage_uri means limits are correct across multiple backend instances/workers, not just
# within one process -- the same requirement that motivated using Redis for sessions.
limiter = Limiter(key_func=_rate_limit_key, storage_uri=settings.redis_url)
