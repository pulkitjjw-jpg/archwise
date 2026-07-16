"""app/dependencies.py -- the most security-critical code in this app (ownership/access-control
gating on every project-scoped route, plus both auth paths' identity resolution). Tests call the
dependency functions directly with a real db session and real rows, rather than going through
HTTP, so a regression here fails fast and precisely instead of being buried under an HTTP status
code assertion. See conftest.py's module docstring for the test-database strategy.
"""

import hashlib
import uuid
from types import SimpleNamespace

import pytest
from clerk_backend_api.security.types import TokenVerificationError, TokenVerificationErrorReason
from fastapi import HTTPException

from app.dependencies import (
    get_accessible_project,
    get_current_user,
    get_editable_project,
    get_owned_project,
    get_owned_project_by_api_key,
    get_user_from_api_key,
)
from app.models import ApiKey, ProjectMembership

pytestmark = pytest.mark.asyncio


def _fake_request() -> SimpleNamespace:
    """A minimal stand-in for Starlette's Request -- every function under test here only ever
    touches `request.state.user_id`, never routing/headers/etc, so a real Request is unnecessary
    ceremony."""
    return SimpleNamespace(state=SimpleNamespace())


# ---------------------------------------------------------------------------
# get_owned_project / get_owned_project_by_api_key -- strict ownership. 404, not 403, for both
# "doesn't exist" and "exists but isn't yours" -- never reveal a project id exists to a non-owner.
# ---------------------------------------------------------------------------


async def test_get_owned_project_returns_project_for_real_owner(db_session, make_user, make_project):
    owner = await make_user()
    project = await make_project(user=owner)

    result = await get_owned_project(project_id=project.id, db=db_session, current_user=owner)

    assert result.id == project.id


async def test_get_owned_project_404s_for_nonexistent_project(db_session, make_user):
    user = await make_user()

    with pytest.raises(HTTPException) as exc_info:
        await get_owned_project(project_id=uuid.uuid4(), db=db_session, current_user=user)

    assert exc_info.value.status_code == 404


async def test_get_owned_project_404s_not_403_for_someone_elses_project(db_session, make_user, make_project):
    """The precise regression this test guards against: a non-owner must get the exact same 404
    a truly-nonexistent project id would produce, never a 403 (which would leak "this id exists,
    you just can't touch it") and never the project itself."""
    owner = await make_user()
    project = await make_project(user=owner)
    intruder = await make_user()

    with pytest.raises(HTTPException) as exc_info:
        await get_owned_project(project_id=project.id, db=db_session, current_user=intruder)

    assert exc_info.value.status_code == 404


async def test_get_owned_project_404s_for_a_member_who_is_not_the_owner(db_session, make_user, make_project):
    """A ProjectMembership (editor/viewer) is NOT ownership -- get_owned_project is the strict
    check used by owner-only actions (invite/revoke members, etc.), so a mere collaborator must
    still be rejected here even though get_accessible_project would let them in."""
    owner = await make_user()
    project = await make_project(user=owner)
    editor = await make_user()
    db_session.add(ProjectMembership(project_id=project.id, user_id=editor.id, role="editor"))
    await db_session.commit()

    with pytest.raises(HTTPException) as exc_info:
        await get_owned_project(project_id=project.id, db=db_session, current_user=editor)

    assert exc_info.value.status_code == 404


async def test_get_owned_project_by_api_key_mirrors_ownership_check(db_session, make_user, make_project):
    owner = await make_user()
    project = await make_project(user=owner)
    intruder = await make_user()

    result = await get_owned_project_by_api_key(project_id=project.id, db=db_session, current_user=owner)
    assert result.id == project.id

    with pytest.raises(HTTPException) as exc_info:
        await get_owned_project_by_api_key(project_id=project.id, db=db_session, current_user=intruder)
    assert exc_info.value.status_code == 404


# ---------------------------------------------------------------------------
# get_accessible_project -- owner OR any member (viewer or editor), broad "can view" check.
# ---------------------------------------------------------------------------


async def test_get_accessible_project_allows_owner(db_session, make_user, make_project):
    owner = await make_user()
    project = await make_project(user=owner)

    result = await get_accessible_project(project_id=project.id, db=db_session, current_user=owner)
    assert result.id == project.id


@pytest.mark.parametrize("role", ["viewer", "editor"])
async def test_get_accessible_project_allows_any_member_role(db_session, make_user, make_project, role):
    owner = await make_user()
    project = await make_project(user=owner)
    member = await make_user()
    db_session.add(ProjectMembership(project_id=project.id, user_id=member.id, role=role))
    await db_session.commit()

    result = await get_accessible_project(project_id=project.id, db=db_session, current_user=member)
    assert result.id == project.id


async def test_get_accessible_project_404s_for_a_stranger(db_session, make_user, make_project):
    owner = await make_user()
    project = await make_project(user=owner)
    stranger = await make_user()

    with pytest.raises(HTTPException) as exc_info:
        await get_accessible_project(project_id=project.id, db=db_session, current_user=stranger)

    assert exc_info.value.status_code == 404


# ---------------------------------------------------------------------------
# get_editable_project -- owner OR editor, NOT viewer (403 for a viewer, not 404 -- they CAN see
# the project, just can't mutate it, so revealing that distinction is intentional here).
# ---------------------------------------------------------------------------


async def test_get_editable_project_allows_owner_and_editor(db_session, make_user, make_project):
    owner = await make_user()
    project = await make_project(user=owner)
    editor = await make_user()
    db_session.add(ProjectMembership(project_id=project.id, user_id=editor.id, role="editor"))
    await db_session.commit()

    owner_result = await get_editable_project(project_id=project.id, db=db_session, current_user=owner)
    assert owner_result.id == project.id

    editor_result = await get_editable_project(project_id=project.id, db=db_session, current_user=editor)
    assert editor_result.id == project.id


async def test_get_editable_project_403s_for_a_viewer(db_session, make_user, make_project):
    owner = await make_user()
    project = await make_project(user=owner)
    viewer = await make_user()
    db_session.add(ProjectMembership(project_id=project.id, user_id=viewer.id, role="viewer"))
    await db_session.commit()

    with pytest.raises(HTTPException) as exc_info:
        await get_editable_project(project_id=project.id, db=db_session, current_user=viewer)

    assert exc_info.value.status_code == 403


async def test_get_editable_project_404s_for_a_stranger(db_session, make_user, make_project):
    """A non-member gets 404 (existence hidden), not 403 -- 403 is reserved for someone who CAN
    see the project (a viewer) but can't mutate it."""
    owner = await make_user()
    project = await make_project(user=owner)
    stranger = await make_user()

    with pytest.raises(HTTPException) as exc_info:
        await get_editable_project(project_id=project.id, db=db_session, current_user=stranger)

    assert exc_info.value.status_code == 404


# ---------------------------------------------------------------------------
# get_user_from_api_key -- hash lookup + revoked-key rejection.
# ---------------------------------------------------------------------------


async def test_get_user_from_api_key_accepts_a_valid_key_and_updates_last_used(db_session, make_user):
    user = await make_user()
    raw_key = "arc_test_valid_key"
    api_key = ApiKey(
        user_id=user.id,
        name="CI key",
        key_hash=hashlib.sha256(raw_key.encode()).hexdigest(),
        key_prefix=raw_key[:12],
    )
    db_session.add(api_key)
    await db_session.commit()
    assert api_key.last_used_at is None

    request = _fake_request()
    result = await get_user_from_api_key(request=request, authorization=f"Bearer {raw_key}", db=db_session)

    assert result.id == user.id
    assert request.state.user_id == user.id
    await db_session.refresh(api_key)
    assert api_key.last_used_at is not None


async def test_get_user_from_api_key_rejects_missing_header(db_session):
    with pytest.raises(HTTPException) as exc_info:
        await get_user_from_api_key(request=_fake_request(), authorization=None, db=db_session)
    assert exc_info.value.status_code == 401


async def test_get_user_from_api_key_rejects_unknown_key(db_session):
    with pytest.raises(HTTPException) as exc_info:
        await get_user_from_api_key(
            request=_fake_request(), authorization="Bearer arc_totally_made_up", db=db_session
        )
    assert exc_info.value.status_code == 401


async def test_get_user_from_api_key_rejects_a_revoked_key(db_session, make_user):
    """The precise regression this guards against: a revoked key must be rejected even though its
    hash still matches a real row -- get_user_from_api_key's query filters on
    ApiKey.revoked_at.is_(None), not just key_hash equality."""
    from datetime import UTC, datetime

    user = await make_user()
    raw_key = "arc_test_revoked_key"
    api_key = ApiKey(
        user_id=user.id,
        name="Revoked key",
        key_hash=hashlib.sha256(raw_key.encode()).hexdigest(),
        key_prefix=raw_key[:12],
        revoked_at=datetime.now(UTC),
    )
    db_session.add(api_key)
    await db_session.commit()

    with pytest.raises(HTTPException) as exc_info:
        await get_user_from_api_key(request=_fake_request(), authorization=f"Bearer {raw_key}", db=db_session)

    assert exc_info.value.status_code == 401


# ---------------------------------------------------------------------------
# get_current_user -- Clerk JWT verification boundary. `verify_token` itself (the actual
# cryptographic signature check) is Clerk's library code, not app logic -- monkeypatched at the
# app.dependencies module boundary the same way test_llm.py mocks the OpenRouter HTTP boundary
# with respx, so what's under test is app.dependencies' OWN handling of that boundary's outcome
# (missing header, verification failure, successful resolution), not Clerk's crypto.
# ---------------------------------------------------------------------------


async def test_get_current_user_rejects_missing_authorization_header(db_session):
    with pytest.raises(HTTPException) as exc_info:
        await get_current_user(request=_fake_request(), authorization=None, db=db_session)
    assert exc_info.value.status_code == 401


async def test_get_current_user_rejects_non_bearer_header(db_session):
    with pytest.raises(HTTPException) as exc_info:
        await get_current_user(request=_fake_request(), authorization="Basic abc123", db=db_session)
    assert exc_info.value.status_code == 401


async def test_get_current_user_rejects_invalid_token(db_session, monkeypatch):
    def _raise(*args, **kwargs):
        raise TokenVerificationError(TokenVerificationErrorReason.TOKEN_INVALID_SIGNATURE)

    monkeypatch.setattr("app.dependencies.verify_token", _raise)

    with pytest.raises(HTTPException) as exc_info:
        await get_current_user(request=_fake_request(), authorization="Bearer bad.jwt.token", db=db_session)

    assert exc_info.value.status_code == 401


async def test_get_current_user_resolves_an_existing_user_for_a_valid_token(db_session, make_user, monkeypatch):
    """Covers the common-case path (a user who already has a synced row) without needing to mock
    Clerk's own Backend API client -- that first-request-ever creation path lives entirely in
    app/services/clerk_sync.py, a separate module from what's under test here."""
    user = await make_user()
    monkeypatch.setattr("app.dependencies.verify_token", lambda token, options: {"sub": user.clerk_user_id})

    request = _fake_request()
    result = await get_current_user(request=request, authorization="Bearer some.valid.jwt", db=db_session)

    assert result.id == user.id
    assert request.state.user_id == user.id
