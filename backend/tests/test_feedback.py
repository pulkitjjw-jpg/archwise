"""HTTP-level tests for app/routers/feedback.py's user-facing submission endpoint."""

import pytest
from sqlalchemy import select

from app.models import Feedback

pytestmark = pytest.mark.asyncio


async def test_submit_feedback_persists_with_user_and_email_snapshot(as_user, make_user, db_session):
    user = await make_user()
    client = as_user(user)

    resp = await client.post("/api/v1/feedback", json={"message": "Please add dark mode", "category": "feature"})

    assert resp.status_code == 201
    body = resp.json()
    assert "id" in body

    row = (await db_session.execute(select(Feedback).where(Feedback.id == body["id"]))).scalar_one()
    assert row.user_id == user.id
    assert row.email == user.email
    assert row.message == "Please add dark mode"
    assert row.category == "feature"


async def test_submit_feedback_category_is_optional(as_user, make_user):
    user = await make_user()
    client = as_user(user)

    resp = await client.post("/api/v1/feedback", json={"message": "Just a note"})

    assert resp.status_code == 201


async def test_submit_feedback_rejects_empty_message(as_user, make_user):
    user = await make_user()
    client = as_user(user)

    resp = await client.post("/api/v1/feedback", json={"message": ""})

    assert resp.status_code == 400


async def test_submit_feedback_requires_auth(client):
    resp = await client.post("/api/v1/feedback", json={"message": "hi"})

    assert resp.status_code == 401
