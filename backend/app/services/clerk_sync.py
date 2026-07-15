from clerk_backend_api import Clerk
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models import User

# Lazy row-creation, not a Clerk webhook: the internal `users` row for a given clerk_user_id is
# created the first time that user makes an authenticated request, not proactively when they sign
# up in Clerk. Simpler than standing up a webhook endpoint (with svix signature verification, a
# public route, retry handling) for a v1 migration, at the cost of `email` being a point-in-time
# copy that can drift if the user later changes their email in Clerk -- acceptable today since
# nothing in this app treats email as a security-sensitive identifier post-Clerk (Clerk owns
# login/verification entirely; our `email` column is display-only, e.g. the admin user list).
# Revisit with a `user.updated` webhook if that drift ever actually matters.


def _primary_email(clerk_user) -> str:
    """Clerk's User object holds a list of email addresses plus a pointer to which one is
    primary -- there's no single "email" field to read directly."""
    for addr in clerk_user.email_addresses or []:
        if addr.id == clerk_user.primary_email_address_id:
            return addr.email_address
    # Defensive fallback -- every real Clerk user has at least one email address by the time
    # they can complete sign-up, so this only matters if primary_email_address_id is somehow
    # unset/stale; still better than a hard 500 on an edge case that costs nothing to handle.
    if clerk_user.email_addresses:
        return clerk_user.email_addresses[0].email_address
    raise ValueError(f"Clerk user {clerk_user.id} has no email address on file")


async def get_or_create_user_by_clerk_id(db: AsyncSession, clerk_user_id: str) -> User:
    """The one place Clerk identity becomes an internal User row. Called from
    app/dependencies.py's get_current_user on every authenticated request -- the common-case path
    is just the first SELECT (no Clerk API call), so this stays cheap on every request after a
    given user's first one."""
    user = (await db.execute(select(User).where(User.clerk_user_id == clerk_user_id))).scalar_one_or_none()
    if user:
        return user

    async with Clerk(bearer_auth=settings.clerk_secret_key) as clerk:
        clerk_user = await clerk.users.get_async(user_id=clerk_user_id)
    email = _primary_email(clerk_user)

    user = User(clerk_user_id=clerk_user_id, email=email)
    db.add(user)
    try:
        # commit(), not flush() -- get_db()'s session has no auto-commit-on-clean-exit (see
        # app/db.py), so a bare flush() here is only visible within THIS request's own
        # transaction and gets silently rolled back the moment the request ends, unless the
        # route handler itself happens to commit something else later. That's true for a
        # write endpoint like POST /projects, but not for a plain read like GET /projects/{id}
        # -- confirmed live: a user whose first authenticated request was read-only got a
        # working response for that one request (the flushed row was visible to the SAME
        # transaction's queries) but never actually persisted, silently re-created and
        # re-discarded on every subsequent request, invisible to GET /admin/users forever.
        # This must commit unconditionally, independent of whatever the calling route does.
        await db.commit()
    except IntegrityError:
        # Two concurrent first-requests from the same brand-new user (e.g. a double-fired
        # effect, or two tabs) can both reach here before either commits -- the unique
        # constraint on clerk_user_id is the real guard, this just avoids surfacing that as a
        # 500 to whichever request lost the race. Re-fetch the row the other request created.
        await db.rollback()
        user = (await db.execute(select(User).where(User.clerk_user_id == clerk_user_id))).scalar_one_or_none()
        if not user:
            raise
    return user
