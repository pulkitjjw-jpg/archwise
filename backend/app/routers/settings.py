from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.models import AppSetting

router = APIRouter()


async def _get_or_create_settings(db: AsyncSession) -> AppSetting:
    """The table is deliberately single-row -- if it's ever empty (a fresh DB before the seed
    migration ran, or the row was somehow deleted), create it on the fly with the model's own
    default rather than 500ing on a null read."""
    setting = (await db.execute(select(AppSetting).limit(1))).scalar_one_or_none()
    if not setting:
        setting = AppSetting()
        db.add(setting)
        await db.commit()
    return setting


@router.get("/settings")
async def get_settings(db: AsyncSession = Depends(get_db)) -> dict:
    """PUBLIC -- no auth beyond the existing global internal-auth-secret middleware. The landing
    page and the page <title> both need the app's name before anyone has logged in."""
    setting = await _get_or_create_settings(db)
    return {"appName": setting.app_name}
