"""
Test database / environment strategy
=====================================
These tests run against a REAL Postgres database, not SQLite or a mocked engine -- this app uses
Postgres-specific features (JSONB columns, pgvector's `Vector` column type on KnowledgeChunk)
that an in-memory substitute can't faithfully emulate, and the whole point of DB-touching tests
is to catch real query/constraint bugs, not just Python-level logic bugs.

Tests use a DEDICATED, separate database (`app_test_db`) on the SAME Postgres server the dev
stack already runs via `docker compose up -d postgres redis` (published at 127.0.0.1:5433) --
never the dev `app_db` database, which has real data from live manual verification testing and
must never be touched by a test run.

One-time setup for a fresh checkout/environment (already done for this one -- documented here so
a future session can reproduce it without guessing):

    cd "<repo root>"
    docker compose up -d postgres redis
    PGPASSWORD=postgres psql -h 127.0.0.1 -p 5433 -U postgres -d app_db \
        -c "CREATE DATABASE app_test_db;"
    PGPASSWORD=postgres psql -h 127.0.0.1 -p 5433 -U postgres -d app_test_db \
        -c "CREATE EXTENSION IF NOT EXISTS vector;"

Schema is created directly from the SQLAlchemy models via `Base.metadata.create_all` (see
`_create_schema` below), NOT replayed through the Alembic migration chain. This is a deliberate
choice scoped to THIS throwaway test database only: it keeps the schema always in exact sync with
`app/models.py` (the real source of truth the app runs against today) without needing to keep
Alembic's own env.py settings-loading in sync with the env-var overrides below, and without
depending on the full migration history being cleanly replayable end to end. It is not a
statement that the Alembic chain itself is untrustworthy.

DATABASE_URL / REDIS_URL are overridden to point at the test database / a scratch Redis logical
DB (index 15, distinct from the dev app's index 0 so rate-limiter counters never collide with a
real dev session) BEFORE any `app.*` module is imported anywhere -- app/config.py's `settings`
singleton and app/db.py's async engine are both constructed at import time from whatever
DATABASE_URL is in the environment at that moment, so this override must happen at the very top
of this file, ahead of every other import in this test suite (conftest.py is always imported
first by pytest).

Run with:  cd backend && .venv/bin/python -m pytest -q
"""

import os

os.environ["DATABASE_URL"] = "postgresql://postgres:postgres@127.0.0.1:5433/app_test_db"
os.environ["REDIS_URL"] = "redis://127.0.0.1:6379/15"

import uuid
from collections.abc import AsyncIterator, Callable

import pytest
import pytest_asyncio
from fastapi import Depends, Request
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import AsyncSessionLocal, Base, engine, get_db
from app.dependencies import get_current_user
from app.main import app
from app.models import Project, User

pytestmark = pytest.mark.asyncio


@pytest_asyncio.fixture(scope="session", autouse=True)
async def _flush_rate_limit_redis() -> None:
    """app/rate_limit.py's Limiter persists its counters in Redis (storage_uri=settings.redis_url,
    logical DB 15 here -- see the env override at the top of this file), which otherwise
    accumulates across separate test RUNS (not just within one run) since nothing else ever
    clears it. Flushed once at the start of the session so a rate-limited route (e.g. create_
    project's 60/hour, export_my_data's 5/hour) starts from a clean slate every time the suite
    runs, instead of eventually tripping from leftover counts built up across many local re-runs
    during development."""
    import redis.asyncio as redis_asyncio

    r = redis_asyncio.from_url(settings.redis_url)
    await r.flushdb()
    await r.aclose()


@pytest_asyncio.fixture(scope="session", autouse=True)
async def _create_schema() -> AsyncIterator[None]:
    """Creates every table once for the whole test session against app_test_db, and disposes the
    engine's connection pool at the very end. Deliberately does NOT drop tables afterward -- a
    dedicated, already-empty-of-app-data test database is fine to leave with the schema in place
    between runs (create_all is idempotent), and dropping would slow down/complicate re-runs for
    no real benefit."""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield
    await engine.dispose()


@pytest_asyncio.fixture(autouse=True)
async def _clean_tables() -> AsyncIterator[None]:
    """Function-scoped, runs AFTER every test and truncates every table (in metadata's
    dependency-sorted order, reversed, so children are cleared before parents) -- guarantees no
    test ever sees another test's leftover rows, without paying for a full CREATE/DROP schema
    cycle per test."""
    yield
    async with engine.begin() as conn:
        for table in reversed(Base.metadata.sorted_tables):
            await conn.execute(table.delete())


@pytest_asyncio.fixture
async def db_session() -> AsyncIterator[AsyncSession]:
    """A plain session for tests to set up fixture rows directly, or to unit-test a
    dependencies.py function without going through HTTP at all."""
    async with AsyncSessionLocal() as session:
        yield session


@pytest_asyncio.fixture
async def make_user(db_session: AsyncSession) -> Callable:
    async def _make(*, is_admin: bool = False, email: str | None = None) -> User:
        user = User(
            clerk_user_id=f"user_{uuid.uuid4().hex}",
            email=email or f"{uuid.uuid4().hex}@example.com",
            is_admin=is_admin,
        )
        db_session.add(user)
        await db_session.commit()
        await db_session.refresh(user)
        return user

    return _make


@pytest_asyncio.fixture
async def make_project(db_session: AsyncSession) -> Callable:
    async def _make(*, user: User, name: str = "Test Project", **kwargs) -> Project:
        project = Project(name=name, user_id=user.id, **kwargs)
        db_session.add(project)
        await db_session.commit()
        await db_session.refresh(project)
        return project

    return _make


@pytest_asyncio.fixture
async def client() -> AsyncIterator[AsyncClient]:
    """A real httpx.AsyncClient driving the real FastAPI `app` object in-process (ASGITransport --
    no actual network socket), with the shared internal-auth header every route requires (see
    app/main.py's require_internal_auth middleware) attached by default. dependency_overrides is
    cleared after every test so one test's auth override can never leak into the next."""
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"x-internal-auth": settings.internal_auth_secret},
    ) as ac:
        yield ac
    app.dependency_overrides.clear()


@pytest.fixture
def as_user(client: AsyncClient) -> Callable[[User], AsyncClient]:
    """Returns a helper that makes `client` authenticate every subsequent request as the given
    User, by overriding get_current_user via FastAPI's own dependency_overrides mechanism -- the
    standard pattern for testing FastAPI auth without a real Clerk JWT on every call (see
    app/dependencies.py's get_current_user docstring). require_admin and every ownership/role
    dependency downstream still run their OWN real logic on top of this -- only identity
    resolution itself is stubbed, never the authorization checks that consume it.

    Also stashes request.state.user_id, mirroring the real get_current_user's own side effect --
    app/rate_limit.py's key function reads that to rate-limit per-user rather than per-connection.
    Without this, every overridden test request would fall back to the same IP-based key (every
    ASGITransport request looks like it comes from the same address), and unrelated tests hitting
    a rate-limited route would silently share one rate-limit bucket.

    Re-fetches the User row by id from the ROUTE's own `get_db`-provided session (not the fixture
    session the caller's `user` object came from) on every call, the same way the real
    get_current_user resolves a fresh row per request -- returning the fixture's own ORM instance
    directly would attach it to whatever session created it, and a route that later does
    `db.delete(current_user)`/mutates it on ITS OWN (different) session raises SQLAlchemy's
    "already attached to session" error. This mirrors production request-scoping instead of
    fighting it."""

    def _as(user: User) -> AsyncClient:
        async def _override(request: Request, db: AsyncSession = Depends(get_db)) -> User:
            request.state.user_id = user.id
            fresh = await db.get(User, user.id)
            return fresh if fresh is not None else user

        app.dependency_overrides[get_current_user] = _override
        return client

    return _as
