from fastapi import APIRouter, Depends

from app.dependencies import get_current_user
from app.models import User
from app.serializers import serialize_user

router = APIRouter()

# Register/login/logout/forgot-password/reset-password/change-password all removed -- Clerk owns
# credentials, sessions, and email verification entirely now (see app/dependencies.py's
# get_current_user and app/services/clerk_sync.py). The one route kept is this: the frontend
# still needs to know app-specific state Clerk has no concept of (our internal user id, isAdmin)
# alongside whatever it already gets straight from Clerk's own hooks client-side.


@router.get("/auth/me")
async def me(current_user: User = Depends(get_current_user)) -> dict:
    return {"user": serialize_user(current_user)}
