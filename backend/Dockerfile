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

# Run as a non-root user. The app never needs to write outside its own process (no local file
# writes at runtime), so there's no reason to run as root -- this limits blast radius if the
# process is ever compromised via a dependency or request-handling bug.
RUN groupadd --system appuser && useradd --system --gid appuser --no-create-home appuser \
    && chown -R appuser:appuser /app
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
