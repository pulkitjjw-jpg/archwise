"""Redis-backed background-job coordination for architecture generation and export jobs (see
app/worker.py for the arq job functions that execute the actual work and write status/results
here, and app/routers/architectures.py / app/routers/export.py for the endpoints that enqueue
jobs and poll this status).

Job status intentionally lives ONLY in Redis, with a TTL -- NOT a new Postgres table. A job's
entire useful life is the handful of seconds up to ~35s the LLM chain can take to run, plus a
short polling/download grace window after that (the frontend gives up polling after ~90s -- see
ArchitectureWorkspace.tsx's poll helper). Nothing about a job's status is ever queried
historically, filtered, joined against another table, or shown in any list/audit view the way a
real `architectures` row is (contrast with Architecture's own docstring in models.py) -- it's pure
ephemeral coordination state between the API process and the worker process, exactly what Redis
(already a hard dependency here, for slowapi's rate limiter -- see app/rate_limit.py) is for. A
job that's expired and one that never existed look identical to callers (404) -- there's no
scenario where losing this state after the TTL is a real problem, since the frontend's own
polling timeout already treats "never completes" as a user-facing error.

Export jobs additionally stash the generated file's raw bytes in Redis (a separate key, same TTL)
-- NOT as arq's own per-job result value. arq's result mechanism round-trips through its own
serialization on every job.result() call and isn't meant for large binary payloads (see
app/routers/export.py's download route, which reads straight from the key below instead of going
through arq at all). Terraform/Kubernetes zips and one-page executive-summary PDFs for a single
project are comfortably small, well within what Redis handles as a plain value -- if this app ever
generates exports large enough for that to stop being true, this is the seam to swap for real
object storage (S3/GCS) without changing the job-status contract above it.
"""

import json
import uuid
from typing import Any, Literal

from arq import create_pool
from arq.connections import ArqRedis, RedisSettings
from fastapi.encoders import jsonable_encoder

from app.config import settings

# 1 hour: comfortably past the frontend's ~90s poll timeout, plus a grace window for a user who
# steps away right as an export finishes and comes back a bit later to click "download".
JOB_STATUS_TTL_SECONDS = 60 * 60

JobStatus = Literal["pending", "running", "complete", "failed"]
JobKind = Literal["architecture", "export"]

_pool: ArqRedis | None = None


async def get_redis_pool() -> ArqRedis:
    """Lazily creates and caches ONE arq redis pool for this process (the FastAPI backend -- the
    worker process gets its own pool from arq itself, passed into every job function via
    ctx["redis"], see app/worker.py). No startup/shutdown lifecycle wiring needed in app/main.py
    for this: arq's pool is a thin wrapper over a redis-py connection pool, safe to create on
    first use and hold for the life of the process -- the same lazy-singleton shape as
    app/db.py's module-level `engine`."""
    global _pool
    if _pool is None:
        _pool = await create_pool(RedisSettings.from_dsn(settings.redis_url))
    return _pool


def _status_key(kind: JobKind, job_id: str) -> str:
    return f"job:{kind}:{job_id}:status"


def _file_key(job_id: str) -> str:
    return f"job:export:{job_id}:file"


async def set_job_status(
    redis: ArqRedis,
    kind: JobKind,
    job_id: str,
    *,
    project_id: str,
    status: JobStatus,
    error: str | None = None,
    result: dict[str, Any] | None = None,
) -> None:
    """Writes (or overwrites) a job's status doc. Called both at enqueue time (status="pending",
    from the API process's own pool) and from inside the worker as a job progresses (via
    ctx["redis"]) -- either caller can pass any ArqRedis connection since they all point at the
    same Redis instance. `result` carries whatever a completed job needs the poller to see next:
    {"architecture": {...}} for architecture-generation jobs, {"filename", "contentType"} for
    export jobs (the actual file bytes live under a separate key, see store_export_file below)."""
    payload = {"jobId": job_id, "projectId": project_id, "status": status, "error": error, "result": result}
    await redis.set(_status_key(kind, job_id), json.dumps(jsonable_encoder(payload)), ex=JOB_STATUS_TTL_SECONDS)


async def get_job_status(kind: JobKind, job_id: str) -> dict[str, Any] | None:
    """Used by the polling GET endpoints. Returns None for both "never existed" and "expired" --
    callers turn either into the same 404, see this module's docstring."""
    redis = await get_redis_pool()
    raw = await redis.get(_status_key(kind, job_id))
    if raw is None:
        return None
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8")
    return json.loads(raw)


async def store_export_file(redis: ArqRedis, job_id: str, content: bytes) -> None:
    await redis.set(_file_key(job_id), content, ex=JOB_STATUS_TTL_SECONDS)


async def get_export_file(job_id: str) -> bytes | None:
    """Used by the download endpoint. Distinct from get_job_status's "not found" case: a job can
    be status="complete" (status doc still alive) while its file key has separately expired if a
    caller waits right up against the TTL edge -- the download route treats that as its own
    "please regenerate" error rather than conflating it with a plain missing/expired job."""
    redis = await get_redis_pool()
    content = await redis.get(_file_key(job_id))
    return content


async def enqueue_architecture_job(
    *,
    project_id: str,
    project_name: str,
    reqs_context: dict,
    industry_context: dict,
    product_domain: dict | None,
    prev_components: list[dict] | None,
    next_version: str,
) -> str:
    """Called by POST /projects/{project_id}/architectures AFTER the free-tier usage cap has
    already been checked-and-incremented (and committed) in that same request -- see
    architectures.py's generate_architecture. Everything passed here is plain, already-resolved
    data (no ORM instances, no DB session) since it has to survive an arq serialization round-trip
    to a completely separate worker process."""
    job_id = str(uuid.uuid4())
    redis = await get_redis_pool()
    await set_job_status(redis, "architecture", job_id, project_id=project_id, status="pending")
    await redis.enqueue_job(
        "generate_architecture_task",
        _job_id=job_id,
        job_id=job_id,
        project_id=project_id,
        project_name=project_name,
        reqs_context=reqs_context,
        industry_context=industry_context,
        product_domain=product_domain,
        prev_components=prev_components,
        next_version=next_version,
    )
    return job_id


async def enqueue_export_job(*, project_id: str, format: str, provider: str) -> str:
    job_id = str(uuid.uuid4())
    redis = await get_redis_pool()
    await set_job_status(redis, "export", job_id, project_id=project_id, status="pending")
    await redis.enqueue_job(
        "generate_export_task",
        _job_id=job_id,
        job_id=job_id,
        project_id=project_id,
        format=format,
        provider=provider,
    )
    return job_id
