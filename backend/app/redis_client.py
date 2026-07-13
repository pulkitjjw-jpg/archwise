import redis.asyncio as redis

from app.config import settings

# Same singleton-at-import-time shape as db.py's engine -- one shared connection pool for the
# whole process, not created per-request. decode_responses=True so callers get str back instead
# of bytes (every value this app stores in Redis -- session tokens, reset tokens, rate-limit
# counters -- is text, never binary).
redis_client = redis.from_url(settings.redis_url, decode_responses=True)
