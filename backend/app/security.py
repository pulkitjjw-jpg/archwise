import secrets
import uuid

import bcrypt

from app.redis_client import redis_client

SESSION_TTL_SECONDS = 60 * 60 * 24 * 30  # 30 days
RESET_TOKEN_TTL_SECONDS = 60 * 60  # 1 hour -- short-lived and single-use, unlike a session


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))


async def create_session(user_id: uuid.UUID) -> str:
    # secrets.token_urlsafe(32) -- the same proven pattern as ShareLink.token (256 bits of
    # entropy, cryptographically secure). The token itself IS the credential; Redis just maps it
    # to a user_id so a session can be revoked instantly (logout) by deleting the key.
    token = secrets.token_urlsafe(32)
    await redis_client.setex(f"session:{token}", SESSION_TTL_SECONDS, str(user_id))
    return token


async def get_user_id_from_session(token: str) -> uuid.UUID | None:
    raw = await redis_client.get(f"session:{token}")
    return uuid.UUID(raw) if raw else None


async def delete_session(token: str) -> None:
    await redis_client.delete(f"session:{token}")


async def create_reset_token(user_id: uuid.UUID) -> str:
    token = secrets.token_urlsafe(32)
    await redis_client.setex(f"reset:{token}", RESET_TOKEN_TTL_SECONDS, str(user_id))
    return token


async def consume_reset_token(token: str) -> uuid.UUID | None:
    """Single-use: looks up AND deletes atomically-enough for this app's needs (a reset token
    being raced by two concurrent requests is not a realistic threat model here)."""
    raw = await redis_client.get(f"reset:{token}")
    if not raw:
        return None
    await redis_client.delete(f"reset:{token}")
    return uuid.UUID(raw)
