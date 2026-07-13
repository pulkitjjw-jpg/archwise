import logging

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from app.config import settings
from app.rate_limit import limiter
from app.routers import admin, architectures, auth, conversations, export, health, projects, requirements, share

# Root logger defaults to WARNING with no handler configured, which would silently drop the
# INFO-level "served by <model>" logs app/services/llm.py emits on every successful fallback-chain
# call -- the only visibility into which model actually served a request. INFO is the right
# floor: routine per-request model selection is operationally useful, DEBUG would be noisy.
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

logger = logging.getLogger("app")

app = FastAPI(title="AI Cloud Architecture Generator — Backend")

app.state.limiter = limiter
app.add_middleware(SlowAPIMiddleware)

# No CORS middleware on purpose: this service is never called from a browser origin, only
# from Next.js's own server-side proxy. Adding permissive CORS here would be a second way to
# accidentally expose it even if network isolation is ever misconfigured.


@app.middleware("http")
async def require_internal_auth(request: Request, call_next):
    """Defense-in-depth on top of network isolation: reject anything that doesn't carry the
    shared secret only Next.js's server-side proxy knows. This is a backstop, not the primary
    control -- the primary control is that this service has no public network path at all."""
    if request.headers.get("x-internal-auth") != settings.internal_auth_secret:
        return JSONResponse(status_code=status.HTTP_401_UNAUTHORIZED, content={"error": "Unauthorized"})
    return await call_next(request)


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    # Normalize to the { error: string } shape the Next.js frontend already expects --
    # FastAPI's default {"detail": [...]} would otherwise silently break existing error
    # handling in every component that reads err.error from a failed fetch.
    first = exc.errors()[0] if exc.errors() else None
    message = f"{'.'.join(str(p) for p in first['loc'])}: {first['msg']}" if first else "Invalid request"
    return JSONResponse(status_code=status.HTTP_400_BAD_REQUEST, content={"error": message})


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    logger.exception("Unhandled exception on %s %s", request.method, request.url.path)
    return JSONResponse(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, content={"error": "Internal server error"})


@app.exception_handler(RateLimitExceeded)
async def rate_limit_exceeded_handler(request: Request, exc: RateLimitExceeded):
    # Same { error: string } shape as every other error response -- not slowapi's default body.
    return JSONResponse(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        content={"error": "Too many requests -- please slow down and try again shortly."},
    )


app.include_router(health.router, prefix="/api")
app.include_router(auth.router, prefix="/api")
app.include_router(projects.router, prefix="/api")
app.include_router(conversations.router, prefix="/api")
app.include_router(requirements.router, prefix="/api")
app.include_router(architectures.router, prefix="/api")
app.include_router(export.router, prefix="/api")
app.include_router(share.router, prefix="/api")
app.include_router(admin.router, prefix="/api")
