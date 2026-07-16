"""arq worker process -- runs SEPARATELY from the FastAPI backend (its own container/`command`,
see docker-compose.yml's `worker` service: `arq app.worker.WorkerSettings`), consuming jobs
enqueued via app/services/jobs.py's enqueue_architecture_job / enqueue_export_job.

Why arq: this codebase is async-native throughout (FastAPI + SQLAlchemy's async engine + httpx
AsyncClient for every LLM call) and already depends on Redis (slowapi's rate limiter, see
app/rate_limit.py). arq is a thin, Redis-backed job queue built specifically for asyncio apps --
job functions are plain `async def`s that run on the same event loop style as the rest of this
app, no separate sync worker pool / prefork model to reason about the way Celery would need.
Celery is sync-first (its workers are process/thread-pool based; async tasks are a bolted-on
`asgiref`-style adapter, not the native model) and a much heavier dependency footprint --
broker+backend abstraction, its own serialization format debates, a beat scheduler nothing here
needs -- for what amounts to two job types. Not worth it for this app's actual shape.

Each job function re-fetches whatever DB state it needs through its OWN AsyncSession
(AsyncSessionLocal from app.db) -- it never reuses the enqueuing request's session, which is long
gone (a different process) by the time this runs. Everything a job needs that ISN'T cheap to
re-query (the free-tier usage cap decision, the already-resolved requirements context) is instead
passed in as plain, JSON-serializable arguments at enqueue time -- see app/services/jobs.py's
enqueue_* functions and the docstring there on why usage-cap enforcement stays in the API layer,
never here.
"""

import json
import logging
import uuid
from datetime import UTC, datetime

import httpx
from arq.connections import RedisSettings
from sqlalchemy import select

from app.config import settings
from app.db import AsyncSessionLocal
from app.models import Architecture, Project, Webhook, WebhookDelivery
from app.serializers import serialize_architecture
from app.services import export_generation, jobs
from app.services.architecture_generation import generate_architecture_bundle
from app.services.knowledge_retrieval import (
    build_requirements_context_query,
    chunk_to_prompt_dict,
    enrich_citations,
    retrieve_domain_pattern_knowledge,
    retrieve_relevant_knowledge,
)
from app.services.webhooks import (
    RESPONSE_BODY_TRUNCATE_LENGTH,
    WEBHOOK_DELIVERY_TIMEOUT_SECONDS,
    enqueue_matching_webhook_deliveries,
    sign_payload,
)

logger = logging.getLogger("app.worker")


async def generate_architecture_task(
    ctx: dict,
    *,
    job_id: str,
    project_id: str,
    project_name: str,
    reqs_context: dict,
    industry_context: dict,
    product_domain: dict | None,
    prev_components: list[dict] | None,
    next_version: str,
) -> None:
    """Background twin of the old synchronous body of POST /projects/{project_id}/architectures
    (steps 3b-6 -- knowledge retrieval, the rules+LLM pipeline, persisting the new Architecture
    row, bumping Project.current_version). Everything before this (requirements lookup, version
    numbering, the free-tier cap check-and-increment) already happened in the enqueuing request --
    see app/routers/architectures.py's generate_architecture -- and is passed in above as already-
    resolved plain data."""
    redis = ctx["redis"]
    await jobs.set_job_status(redis, "architecture", job_id, project_id=project_id, status="running")

    try:
        async with AsyncSessionLocal() as db:
            knowledge_chunks = await retrieve_relevant_knowledge(
                db, build_requirements_context_query(reqs_context, industry_context)
            )
            domain_pattern_chunks = await retrieve_domain_pattern_knowledge(db, product_domain)
            knowledge_context = [chunk_to_prompt_dict(c) for c in knowledge_chunks + domain_pattern_chunks]

            bundle = await generate_architecture_bundle(
                project_name,
                reqs_context,
                industry_context,
                settings.openrouter_api_key,
                prev_components,
                knowledge_context,
                product_domain,
            )

            for c in bundle["components"]:
                if c.get("sources"):
                    c["sources"] = enrich_citations(c["sources"], knowledge_context)
                    if not c["sources"]:
                        del c["sources"]
            if bundle.get("recommendation", {}).get("sources"):
                bundle["recommendation"]["sources"] = enrich_citations(
                    bundle["recommendation"]["sources"], knowledge_context
                )
                if not bundle["recommendation"]["sources"]:
                    del bundle["recommendation"]["sources"]

            record = Architecture(
                project_id=uuid.UUID(project_id),
                version=next_version,
                hld={"components": bundle["components"], "connections": bundle["connections"]},
                reasoning={
                    "decisions": [
                        {
                            "component": "system",
                            "choice": rule,
                            "rationale": "Matched deterministic rule pattern in system requirements.",
                            "tradeoffs": [],
                            "alternatives": [],
                        }
                        for rule in bundle["rulesTrace"]
                    ],
                    "assumptions": bundle["assumptions"],
                    "risks": bundle["risks"],
                    "recommendation": bundle["recommendation"],
                    "diff": bundle["diff"],
                },
                cloud_provider="aws",
                security_findings=bundle["securityFindings"],
            )
            db.add(record)
            await db.flush()

            project = (
                await db.execute(select(Project).where(Project.id == uuid.UUID(project_id)))
            ).scalar_one_or_none()
            if project:
                project.current_version = next_version

            await db.commit()
            serialized = serialize_architecture(record)

            # Webhook fan-out AFTER the architecture row is durably committed -- a delivery
            # attempt describing this event should never be enqueued for a generation that could
            # still roll back. Deliberately a separate arq job per matching webhook (see
            # app/services/webhooks.py's own docstring) rather than an inline httpx call here: a
            # slow/down webhook receiver must never block or fail architecture generation itself.
            if project:
                await enqueue_matching_webhook_deliveries(
                    db,
                    redis,
                    project.user_id,
                    "architecture.generated",
                    {
                        "event": "architecture.generated",
                        "projectId": project_id,
                        "projectName": project_name,
                        "architectureId": str(record.id),
                        "version": next_version,
                        "createdAt": record.created_at,
                    },
                )

        await jobs.set_job_status(
            redis, "architecture", job_id, project_id=project_id, status="complete", result={"architecture": serialized}
        )
    except Exception as exc:
        # str(exc) is what actually reaches the frontend's error banner (see
        # app/routers/architectures.py's GET .../jobs/{job_id}) -- _call_llm_with_fallback_chain
        # (app/services/llm.py) already raises a clean, human-readable message when every model in
        # the chain fails ("... failed across the entire model fallback chain: <reason>. Please
        # try again."), so this deliberately does NOT rewrap or genericize it the way
        # app/main.py's global exception handler would for an in-request failure.
        logger.exception("[job %s] architecture generation failed", job_id)
        await jobs.set_job_status(redis, "architecture", job_id, project_id=project_id, status="failed", error=str(exc))


async def generate_export_task(ctx: dict, *, job_id: str, project_id: str, format: str, provider: str) -> None:
    """Background twin of export.py's old direct-download GET routes. `format` is one of
    SERVER_GENERATED_FORMATS' keys (terraform/kubernetes/executive-summary) -- see
    app/routers/export.py's create_export_job, which validates this before enqueuing."""
    redis = ctx["redis"]
    await jobs.set_job_status(redis, "export", job_id, project_id=project_id, status="running")

    try:
        async with AsyncSessionLocal() as db:
            project = (
                await db.execute(select(Project).where(Project.id == uuid.UUID(project_id)))
            ).scalar_one_or_none()
            if not project:
                raise export_generation.ExportGenerationError("This project no longer exists.")

            if format == "executive-summary":
                content, filename = await export_generation.build_executive_summary_pdf_bytes(provider, project, db)
                content_type = "application/pdf"
            else:
                content, filename = await export_generation.build_terraform_or_k8s_zip(provider, project, db)
                content_type = "application/zip"

        await jobs.store_export_file(redis, job_id, content)
        await jobs.set_job_status(
            redis,
            "export",
            job_id,
            project_id=project_id,
            status="complete",
            result={"filename": filename, "contentType": content_type},
        )
    except Exception as exc:
        logger.exception("[job %s] export generation failed", job_id)
        await jobs.set_job_status(redis, "export", job_id, project_id=project_id, status="failed", error=str(exc))


async def deliver_webhook_task(ctx: dict, *, webhook_id: str, event_type: str, payload: dict) -> None:
    """Enqueued by app/services/webhooks.py's enqueue_matching_webhook_deliveries, one job per
    matching webhook per event. Makes exactly ONE HTTP attempt -- no retry-with-backoff, a known,
    deliberate limitation for this pass (see webhooks.py's module docstring). Never raises past
    itself for a delivery-side failure (bad URL, timeout, non-2xx, connection refused): the
    outcome is recorded as a WebhookDelivery row either way, since arq has no business logic of
    its own for "should this be retried" and a raised exception here would just show up as a
    generic failed-job log line with none of that context."""
    async with AsyncSessionLocal() as db:
        webhook = (
            await db.execute(select(Webhook).where(Webhook.id == uuid.UUID(webhook_id)))
        ).scalar_one_or_none()
        # Disabled or deleted between enqueue time and now (e.g. the user revoked it seconds
        # after the triggering event) -- nothing to send, nothing worth recording.
        if not webhook or webhook.disabled_at is not None:
            return

        # payload arrived here already jsonable_encoder()-normalized (see
        # enqueue_matching_webhook_deliveries) and round-tripped through arq's own msgpack
        # serialization -- plain str/int/float/bool/None/list/dict only, safe for json.dumps
        # directly. Signed over these EXACT bytes, the same ones sent as the request body below.
        body = json.dumps(payload).encode()
        signature = sign_payload(webhook.secret, body)

        status_code: int | None = None
        response_text: str | None = None
        delivered_at: datetime | None = None
        try:
            async with httpx.AsyncClient(timeout=WEBHOOK_DELIVERY_TIMEOUT_SECONDS) as client:
                response = await client.post(
                    webhook.url,
                    content=body,
                    headers={
                        "Content-Type": "application/json",
                        # "sha256=<hex>" -- the algorithm-prefixed format most webhook receivers
                        # (Stripe, GitHub) already expect, so verification code a user copies from
                        # elsewhere is likely to just work against this unchanged.
                        "X-Webhook-Signature": f"sha256={signature}",
                        "X-Webhook-Event": event_type,
                    },
                )
            status_code = response.status_code
            response_text = response.text[:RESPONSE_BODY_TRUNCATE_LENGTH]
            delivered_at = datetime.now(UTC)
        except httpx.HTTPError as exc:
            # Network error, timeout, DNS failure, connection refused, etc. -- status_code stays
            # None (distinct from a real non-2xx HTTP response) and delivered_at stays None, so a
            # delivery-history view can tell "we never reached it" apart from "it reached but
            # errored."
            response_text = str(exc)[:RESPONSE_BODY_TRUNCATE_LENGTH]

        db.add(
            WebhookDelivery(
                webhook_id=webhook.id,
                event_type=event_type,
                payload=payload,
                status_code=status_code,
                response_body=response_text,
                delivered_at=delivered_at,
            )
        )
        await db.commit()


class WorkerSettings:
    """arq's entry point (see docker-compose.yml: `arq app.worker.WorkerSettings`)."""

    functions = [generate_architecture_task, generate_export_task, deliver_webhook_task]
    # Resolved once at import time from the same REDIS_URL the backend service already uses for
    # slowapi -- both processes share ONE Redis instance, no separate broker.
    redis_settings = RedisSettings.from_dsn(settings.redis_url)
    # Generous job timeout: the LLM fallback chain gives each of up to 5 models one attempt at up
    # to llm_per_model_timeout_seconds (15s default) each, plus a validation/auto-fix pass on the
    # validated tier -- src/app/api/[...path]/route.ts's own proxy timeout comment computes a
    # worst case of ~160s for the heaviest call (architecture generation). 300s leaves headroom
    # above that instead of arq killing a job that would have legitimately succeeded.
    job_timeout = 300
