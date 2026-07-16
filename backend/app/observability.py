"""Sentry error tracking -- inert scaffolding until a real SENTRY_DSN is configured.

The app has no Sentry account/DSN yet (see settings.sentry_dsn's default of ""), so
init_sentry() is a deliberate no-op whenever it's unset: sentry_sdk.init() is simply never
called, which means the SDK never patches anything, never opens a connection, and never sends
data anywhere. Nothing else in this module (or main.py, which calls capture_exception from the
unhandled-exception handler) does anything unsafe if that's the case -- sentry_sdk's own
capture_* functions are themselves no-ops when the SDK was never initialized.
"""

import logging

import sentry_sdk
from sentry_sdk.integrations.fastapi import FastApiIntegration
from sentry_sdk.integrations.starlette import StarletteIntegration

from app.config import settings
from app.logging_config import request_id_var

logger = logging.getLogger("app")


def _tag_request_id(event: dict, hint: dict) -> dict:
    """Attach the current request's correlation id (the same one every structured JSON log line
    for this request carries -- see app/logging_config.py) to the outgoing Sentry event, so a
    Sentry issue can be cross-referenced against the structured logs for the exact request that
    triggered it."""
    request_id = request_id_var.get()
    if request_id:
        event.setdefault("tags", {})["request_id"] = request_id
    return event


def init_sentry() -> None:
    """Initialize the Sentry SDK if (and only if) a DSN is configured. Called once at startup
    from main.py, before the app object's middleware/routes are set up. Safe to call
    unconditionally -- does nothing when settings.sentry_dsn is empty."""
    if not settings.sentry_enabled:
        logger.info("Sentry DSN not configured -- error tracking is inert")
        return

    sentry_sdk.init(
        dsn=settings.sentry_dsn,
        environment=settings.environment,
        integrations=[StarletteIntegration(), FastApiIntegration()],
        before_send=_tag_request_id,
        # Conservative default -- this app has no real Sentry account/quota provisioned yet, so
        # tracing is off until someone deliberately opts in from a real Sentry project's settings.
        traces_sample_rate=0.0,
        send_default_pii=False,
    )
    logger.info("Sentry error tracking initialized", extra={"environment": settings.environment})
