import logging
import re
import time
import uuid

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from app.config import settings
from app.logging_config import configure_logging, request_id_var
from app.rate_limit import limiter
from app.routers import admin, architectures, auth, conversations, export, health, projects, requirements, share
# Aliased -- `settings` at module scope is already app.config's Settings singleton (line above);
# this is the unrelated /settings (app-name) router, not to be confused with it.
from app.routers import settings as settings_router

# Root logger defaults to WARNING with no handler configured, which would silently drop the
# INFO-level "served by <model>" logs app/services/llm.py emits on every successful fallback-chain
# call -- the only visibility into which model actually served a request. INFO is the right
# floor: routine per-request model selection is operationally useful, DEBUG would be noisy.
# JSON-structured (see app/logging_config.py), not plain text -- parseable by whatever log
# aggregator a real deployment ships to, and every line carries the request that produced it.
configure_logging(level=logging.INFO)

logger = logging.getLogger("app")

app = FastAPI(title="AI Cloud Architecture Generator — Backend")

app.state.limiter = limiter
app.add_middleware(SlowAPIMiddleware)

# No CORS middleware on purpose: this service is never called from a browser origin, only
# from Next.js's own server-side proxy. Adding permissive CORS here would be a second way to
# accidentally expose it even if network isolation is ever misconfigured.


# ---------------------------------------------------------------------------
# Human-readable validation errors
# ---------------------------------------------------------------------------
# Pydantic/FastAPI's raw errors (e.g. "body.email: field required") are meaningless to the
# non-technical end users this app is built for. This is a reusable mapping layer -- not
# one-off string patches -- so that new request fields degrade gracefully (via
# _humanize_field_name) instead of ever leaking a raw Pydantic error again.

# Explicit plain-language labels for known field names (the last segment of Pydantic's `loc`
# tuple). Anything not listed here falls back to _humanize_field_name below.
FIELD_LABELS: dict[str, str] = {
    "name": "name",
    "ideaText": "idea description",
    "hasExistingSystem": "existing system setting",
    "existingSystemText": "existing system description",
    "role": "message type",
    "message": "message",
    "stage": "stage",
    "functional": "functional requirements",
    "nonFunctional": "non-functional requirements",
    "industryContext": "industry context",
    "additionalContext": "additional context",
    "components": "components",
    "connections": "connections",
    "id": "ID",
    "type": "type",
    "description": "description",
    "reasoning": "reasoning",
    "service": "service",
    "serviceName": "service name",
    "from": "source connection",
    "to": "destination connection",
    "protocol": "protocol",
    "provider": "provider",
    "action": "action",
    "componentId": "component ID",
    "componentType": "component type",
    "componentName": "component name",
    "originalProposal": "original proposal",
    "discussionMessage": "discussion message",
    "priorMessages": "prior messages",
    "text": "text",
    "x": "x position",
    "y": "y position",
    "appName": "app name",
    "isAdmin": "admin setting",
    "min": "minimum cost",
    "max": "maximum cost",
    "assumptions": "cost assumptions",
    "config": "configuration",
    "alternatives": "alternatives",
    "costEstimate": "cost estimate",
    "lld": "low-level design details",
    "swapReasoning": "swap reasoning",
    "rulesFired": "rules fired",
    "metadata": "metadata",
    "cloudMappings": "cloud mappings",
    "aws": "AWS configuration",
    "azure": "Azure configuration",
    "gcp": "GCP configuration",
    "kubernetes": "Kubernetes configuration",
    "private": "private cloud configuration",
}


def _humanize_field_name(field_name: str) -> str:
    """Fallback for any field NOT in FIELD_LABELS: split camelCase/snake_case into words and
    lowercase them (e.g. "someNewField" -> "some new field"). This is what keeps newly-added
    fields from ever showing a raw Pydantic field name to a user."""
    # snake_case -> spaces
    spaced = field_name.replace("_", " ")
    # camelCase / PascalCase -> insert a space before each capital that follows a lowercase
    # letter (or precedes a lowercase letter, for runs of capitals like "ID" in "userIDValue")
    spaced = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", spaced)
    spaced = re.sub(r"(?<=[A-Z])(?=[A-Z][a-z])", " ", spaced)
    return " ".join(spaced.split()).lower()


def _field_label(loc: tuple) -> str:
    """Resolve a plain-language label for a Pydantic error's `loc` tuple. Uses the last
    string segment (the actual field name), skipping numeric list indices and the leading
    "body"/"query"/etc. location markers."""
    field_name = None
    for segment in reversed(loc):
        if isinstance(segment, str) and segment not in ("body", "query", "path", "header"):
            field_name = segment
            break
    if not field_name:
        return "information"
    return FIELD_LABELS.get(field_name, _humanize_field_name(field_name))


def _error_message(error: dict) -> str:
    """Turn a single Pydantic error dict (from exc.errors()) into a plain-language sentence."""
    label = _field_label(error.get("loc", ()))
    error_type = error.get("type", "")

    if error_type == "missing" or "required" in error_type:
        return f"Please fill in your {label}."

    if "too_short" in error_type or "min_length" in error_type:
        min_length = (error.get("ctx") or {}).get("min_length")
        if min_length is not None:
            return f"Your {label} needs to be at least {min_length} characters."
        return f"Your {label} needs to be longer."

    if "type" in error_type:
        return f"Please check your {label} — it doesn't look right."

    return f"Please check your {label} and try again."


def _validation_error_response_message(errors: list[dict]) -> str:
    """Builds the primary user-facing message from a list of Pydantic errors. Only the first
    error is used today (matching prior behavior), but this is kept as its own function -- and
    takes the full list -- so returning all messages later is a one-line change rather than a
    rewrite."""
    if not errors:
        return "Please check the information you entered and try again."
    return _error_message(errors[0])


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
    # handling in every component that reads err.error from a failed fetch. The message text
    # itself is built by the human-readable mapping layer above, not FastAPI/Pydantic's raw
    # loc/msg -- see FIELD_LABELS, _humanize_field_name, and _error_message.
    message = _validation_error_response_message(exc.errors())
    return JSONResponse(status_code=status.HTTP_400_BAD_REQUEST, content={"error": message})


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    logger.exception("Unhandled exception on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={
            "error": "Something went wrong on our end. Please try again in a moment — if it keeps happening, let us know."
        },
    )


@app.exception_handler(RateLimitExceeded)
async def rate_limit_exceeded_handler(request: Request, exc: RateLimitExceeded):
    # Same { error: string } shape as every other error response -- not slowapi's default body.
    return JSONResponse(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        content={"error": "Too many requests -- please slow down and try again shortly."},
    )


@app.middleware("http")
async def request_context(request: Request, call_next):
    """The LAST-registered middleware, which Starlette makes the OUTERMOST -- wraps every other
    middleware (including require_internal_auth) so even a rejected/unauthenticated request gets
    a correlation id and a completion log line, not just successfully-routed ones. Every log call
    anywhere during this request (any module, any call depth) picks up requestId automatically
    via request_id_var -- see app/logging_config.py. Also echoed back as X-Request-Id so a
    specific request can be correlated with a support report or a frontend-side error."""
    request_id = str(uuid.uuid4())
    token = request_id_var.set(request_id)
    start = time.monotonic()
    try:
        response = await call_next(request)
    except Exception:
        # The unhandled-exception path already logs its own traceback (see
        # unhandled_exception_handler) -- this just ensures a completion line still exists even
        # when call_next raises past FastAPI's own exception handling.
        duration_ms = int((time.monotonic() - start) * 1000)
        logger.error(
            "request failed",
            extra={"method": request.method, "path": request.url.path, "durationMs": duration_ms},
        )
        request_id_var.reset(token)
        raise

    duration_ms = int((time.monotonic() - start) * 1000)
    response.headers["X-Request-Id"] = request_id
    # /health is polled every few seconds by any real load balancer/orchestrator -- logging every
    # hit at INFO would drown out everything else in the stream for zero operational value.
    if request.url.path != "/api/health":
        logger.info(
            "request completed",
            extra={
                "method": request.method,
                "path": request.url.path,
                "status": response.status_code,
                "durationMs": duration_ms,
            },
        )
    request_id_var.reset(token)
    return response


app.include_router(health.router, prefix="/api")
app.include_router(settings_router.router, prefix="/api")
app.include_router(auth.router, prefix="/api")
app.include_router(projects.router, prefix="/api")
app.include_router(conversations.router, prefix="/api")
app.include_router(requirements.router, prefix="/api")
app.include_router(architectures.router, prefix="/api")
app.include_router(export.router, prefix="/api")
app.include_router(share.router, prefix="/api")
app.include_router(admin.router, prefix="/api")
