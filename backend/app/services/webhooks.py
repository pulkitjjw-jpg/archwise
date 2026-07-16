"""Outbound webhook delivery -- matching + enqueueing (this module) and the actual HTTP POST
(app/worker.py's deliver_webhook_task, the arq job this enqueues). Deliberately split into its
own background job rather than an inline httpx call inside whatever triggered the event (today,
only generate_architecture_task): a webhook receiver being slow or down must never block or fail
the real work that produced the event it's describing.

Known limitation, by design for this pass: deliver_webhook_task makes exactly ONE delivery
attempt, no retry-with-backoff. A real retry system (exponential backoff, a dead-letter view,
manual re-delivery) is meaningfully more scope than "webhook delivery exists and works end to
end" needed for this first pass -- noted here rather than silently built partially.
"""

import hashlib
import hmac
import uuid
from typing import Any

from arq.connections import ArqRedis
from fastapi.encoders import jsonable_encoder
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Webhook

# Generous relative to a normal API call, but this is a fire-and-forget background job with no
# user waiting on it synchronously -- there's no reason to cut a genuinely slow-but-working
# receiver off early the way e.g. the LLM per-model timeout does for a request a user IS waiting on.
WEBHOOK_DELIVERY_TIMEOUT_SECONDS = 10.0

# WebhookDelivery.response_body exists to help a user debug "why didn't my webhook fire," not to
# store an arbitrary receiver's full response body -- same truncation reasoning as any other
# debug-only captured payload in this codebase.
RESPONSE_BODY_TRUNCATE_LENGTH = 1000


def sign_payload(secret: str, body: bytes) -> str:
    """HMAC-SHA256 over the exact bytes sent on the wire (hex digest) -- the receiving end
    verifies by signing the raw request body it received the same way. Deliberately takes
    already-serialized bytes, not the payload dict: two "equivalent" JSON encodings of the same
    dict aren't guaranteed byte-identical (key order, whitespace), so signing anything other than
    the literal bytes sent would make receiver-side verification fragile/impossible."""
    return hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


async def enqueue_matching_webhook_deliveries(
    db: AsyncSession,
    redis: ArqRedis,
    user_id: uuid.UUID,
    event_type: str,
    payload: dict[str, Any],
) -> None:
    """Called from inside a background job once its own work is durably committed (see
    app/worker.py's generate_architecture_task) -- looks up the event owner's ENABLED webhooks
    subscribed to this event_type and enqueues one deliver_webhook_task arq job per match.
    Filtering event_types (a short JSON array, at most a handful of webhooks per user) in Python
    rather than a JSONB `@>` containment query -- not worth the less-portable SQL for this volume.
    """
    webhooks = (
        await db.execute(select(Webhook).where(Webhook.user_id == user_id, Webhook.disabled_at.is_(None)))
    ).scalars().all()

    for webhook in webhooks:
        if event_type not in (webhook.event_types or []):
            continue
        job_id = str(uuid.uuid4())
        await redis.enqueue_job(
            "deliver_webhook_task",
            _job_id=job_id,
            webhook_id=str(webhook.id),
            event_type=event_type,
            payload=jsonable_encoder(payload),
        )
