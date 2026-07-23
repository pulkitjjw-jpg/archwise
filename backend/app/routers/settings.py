from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.services.app_settings import get_or_create_app_settings as _get_or_create_settings
from app.services.cache import SETTINGS_CACHE_KEY, SETTINGS_CACHE_TTL_SECONDS, get_cached_json, set_cached_json

router = APIRouter()


@router.get("/settings")
async def get_settings(db: AsyncSession = Depends(get_db)) -> dict:
    """PUBLIC -- no auth beyond the existing global internal-auth-secret middleware. The landing
    page and the page <title> both need the app's name before anyone has logged in, and this is
    hit on nearly every page load -- worth a short cache. Actively invalidated (not just left to
    expire) by PUT /admin/settings, the only thing that changes the cached value."""
    cached = await get_cached_json(SETTINGS_CACHE_KEY)
    if cached is not None:
        return cached
    setting = await _get_or_create_settings(db)
    result = {"appName": setting.app_name}
    await set_cached_json(SETTINGS_CACHE_KEY, result, SETTINGS_CACHE_TTL_SECONDS)
    return result
