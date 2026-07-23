from fastapi import APIRouter, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.dependencies import get_current_user
from app.models import Feedback, User
from app.rate_limit import limiter
from app.schemas import FeedbackCreateRequest

router = APIRouter()


@router.post("/feedback", status_code=201)
@limiter.limit("20/hour")
async def submit_feedback(
    request: Request,
    payload: FeedbackCreateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Authenticated (get_current_user, not require_admin) -- any signed-in user can submit, from
    the /help page. `email` is a snapshot at submission time (same "mirrored from Clerk at row-
    creation" precedent as User.email itself), not a live join, so it stays correct even if the
    submitting user's account is later deleted (Feedback.user_id is ON DELETE SET NULL -- see
    AuditLog.actor_user_id for the same reasoning). Rate-limited generously since it's already
    authenticated (low abuse value) -- just a backstop against a stray retry loop, not a real
    anti-spam measure."""
    fb = Feedback(user_id=current_user.id, email=current_user.email, category=payload.category, message=payload.message)
    db.add(fb)
    await db.commit()
    return {"id": str(fb.id), "createdAt": fb.created_at}
