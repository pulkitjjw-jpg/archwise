from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import AppSetting


async def get_or_create_app_settings(db: AsyncSession) -> AppSetting:
    """The table is deliberately single-row -- if it's ever empty (a fresh DB before the seed
    migration ran, or the row was somehow deleted), create it on the fly with the model's own
    defaults rather than 500ing on a null read. Lives in services/, not routers/settings.py, so
    non-router code (usage_limits.py, admin.py) can import it without reaching into a router
    module."""
    setting = (await db.execute(select(AppSetting).limit(1))).scalar_one_or_none()
    if not setting:
        setting = AppSetting()
        db.add(setting)
        await db.commit()
    return setting
