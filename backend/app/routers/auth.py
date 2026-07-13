import logging
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.dependencies import get_current_user
from app.models import User
from app.rate_limit import limiter
from app.schemas import ForgotPasswordRequest, LoginRequest, RegisterRequest, ResetPasswordRequest
from app.security import (
    consume_reset_token,
    create_reset_token,
    create_session,
    delete_session,
    hash_password,
    verify_password,
)
from app.serializers import serialize_user

router = APIRouter()
logger = logging.getLogger("app.routers.auth")


# IP-keyed (no user is authenticated yet at this point -- see app/rate_limit.py's key function,
# which falls back to the real forwarded client IP when request.state.user_id isn't set). Tight
# limits: this is exactly where brute-forcing a password or spamming signups would happen.
@router.post("/auth/register", status_code=201)
@limiter.limit("10/hour")
async def register(request: Request, payload: RegisterRequest, db: AsyncSession = Depends(get_db)) -> dict:
    existing = (await db.execute(select(User).where(User.email == payload.email))).scalar_one_or_none()
    if existing:
        # Deliberately vague, matching login's phrasing -- doesn't confirm the email specifically
        # belongs to an existing account any more precisely than necessary.
        raise HTTPException(status_code=409, detail="An account with this email already exists")

    user = User(email=payload.email, password_hash=hash_password(payload.password))
    db.add(user)
    await db.flush()
    session_token = await create_session(user.id)
    await db.commit()

    return {"user": serialize_user(user), "sessionToken": session_token}


@router.post("/auth/login")
@limiter.limit("20/hour")
async def login(request: Request, payload: LoginRequest, db: AsyncSession = Depends(get_db)) -> dict:
    user = (await db.execute(select(User).where(User.email == payload.email))).scalar_one_or_none()
    # Same generic message whether the email doesn't exist or the password is wrong -- never
    # reveal which one it was (that's a user-enumeration vector).
    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid email or password")

    session_token = await create_session(user.id)
    return {"user": serialize_user(user), "sessionToken": session_token}


@router.post("/auth/logout")
async def logout(x_session_token: Annotated[str | None, Header()] = None) -> dict:
    if x_session_token:
        await delete_session(x_session_token)
    return {"ok": True}


@router.get("/auth/me")
async def me(current_user: User = Depends(get_current_user)) -> dict:
    return {"user": serialize_user(current_user)}


@router.post("/auth/forgot-password")
@limiter.limit("10/hour")
async def forgot_password(request: Request, payload: ForgotPasswordRequest, db: AsyncSession = Depends(get_db)) -> dict:
    user = (await db.execute(select(User).where(User.email == payload.email))).scalar_one_or_none()
    if user:
        token = await create_reset_token(user.id)
        # Real email delivery is a deferred follow-up (no provider configured in this project
        # yet) -- logging the link server-side is the interim path so the reset flow is fully
        # usable end-to-end during development/support without one.
        logger.info("Password reset requested for %s: token=%s (email delivery not yet configured)", payload.email, token)
    # Same generic response whether or not the email exists -- never confirm/deny an account.
    return {"message": "If an account exists for that email, a reset link has been generated."}


@router.post("/auth/reset-password")
async def reset_password(payload: ResetPasswordRequest, db: AsyncSession = Depends(get_db)) -> dict:
    user_id = await consume_reset_token(payload.token)
    if not user_id:
        raise HTTPException(status_code=400, detail="This reset link is invalid or has expired")

    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=400, detail="This reset link is invalid or has expired")

    user.password_hash = hash_password(payload.newPassword)
    await db.commit()
    return {"ok": True}
