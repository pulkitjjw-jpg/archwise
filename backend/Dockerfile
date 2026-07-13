FROM python:3.12-slim

WORKDIR /app

COPY . .
RUN pip install --no-cache-dir -e .

EXPOSE 8000

# --reload is a dev-only flag (file-watching, single worker) -- fine for local docker-compose,
# where ENVIRONMENT is never set to "production" (see app/config.py's default), but wrong for a
# real deployment. Branching here means the same image is safe in both: set ENVIRONMENT=production
# (and optionally UVICORN_WORKERS) to get a multi-worker, no-reload process; leave it unset/
# "development" and local `docker-compose up` behaves exactly as it always has.
CMD ["sh", "-c", "if [ \"$ENVIRONMENT\" = \"production\" ]; then exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers ${UVICORN_WORKERS:-4}; else exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload; fi"]
