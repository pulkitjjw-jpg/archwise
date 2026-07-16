FROM python:3.12-slim

WORKDIR /app

# curl is used by HEALTHCHECK below -- not in the base slim image by default. Installed instead
# of using a python -c urllib one-liner because the health check needs to send a custom header
# (x-internal-auth) and check the HTTP status code; curl -f does both in one readable line, and
# the added image size (~1-2MB with apt lists cleaned up) is a reasonable trade for that.
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY . .
RUN pip install --no-cache-dir -e .

# Run as a non-root user -- limits blast radius if the process is ever compromised via a
# dependency or request-handling bug. One real local-write need exists despite the app being
# otherwise stateless: app/services/knowledge_embeddings.py's fastembed model is downloaded and
# cached on first use (via huggingface_hub, no cache_dir configured so it uses HF_HOME/$HOME's
# default resolution) -- confirmed live as a 500 on architecture generation (Permission denied)
# the first time this ran as a --no-create-home user with no HOME set.
#
# HF_HOME is deliberately OUTSIDE /app, not just a subdirectory of it: docker-compose.yml
# bind-mounts the host's ./backend directory over /app unconditionally (`volumes: - ./backend:/app`,
# not gated to dev), which shadows anything created under /app at image-build time with the host
# directory's own contents/ownership -- a cache dir chowned to appuser here would still 403 at
# runtime under that mount. /opt/hf-cache isn't touched by any bind mount, so it survives.
ENV HF_HOME=/opt/hf-cache
RUN groupadd --system appuser && useradd --system --gid appuser --no-create-home appuser \
    && mkdir -p "$HF_HOME" \
    && chown -R appuser:appuser /app "$HF_HOME"
USER appuser

EXPOSE 8000

# Hits the same /api/health endpoint the load balancer/orchestrator would use, from inside the
# container itself. /api/health sits behind main.py's require_internal_auth middleware just like
# every other route (it is NOT exempted), so this must send the same x-internal-auth header a
# real caller would -- read from the container's own INTERNAL_AUTH_SECRET env var, never
# hardcoded. curl -f turns any non-2xx response into a failed health check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f -H "x-internal-auth: ${INTERNAL_AUTH_SECRET}" http://localhost:8000/api/health || exit 1

# --reload is a dev-only flag (file-watching, single worker) -- fine for local docker-compose,
# where ENVIRONMENT is never set to "production" (see app/config.py's default), but wrong for a
# real deployment. Branching here means the same image is safe in both: set ENVIRONMENT=production
# (and optionally UVICORN_WORKERS) to get a multi-worker, no-reload process; leave it unset/
# "development" and local `docker-compose up` behaves exactly as it always has.
CMD ["sh", "-c", "if [ \"$ENVIRONMENT\" = \"production\" ]; then exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers ${UVICORN_WORKERS:-4}; else exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload; fi"]
