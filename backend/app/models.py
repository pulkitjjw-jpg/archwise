import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import ForeignKey, Integer, Text, text
from sqlalchemy.dialects.postgresql import JSONB, TIMESTAMP, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

# Mirrors drizzle/0003_vengeful_zaran.sql's server_default exactly (verified against the live
# migration SQL, not the CLAUDE.md audit's assumption that this default was applied app-side).
INDUSTRY_CONTEXT_DEFAULT = text(
    """'{"industry":"none","rationale":"","complianceAnswers":[],"flags":{}}'::jsonb"""
)


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    owner: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), nullable=False, server_default=text("now()")
    )
    current_version: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'0.1.0'"))
    # Set once, early in the brainstorm, by get_next_brainstorm_turn's self-classification and
    # locked in thereafter (never re-classified once non-"unknown") so question depth/pacing
    # doesn't flip-flop mid-conversation. Same "mutable project-level pointer" precedent as
    # current_version, not a versioned content field.
    knowledge_level: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'unknown'"))

    conversations: Mapped[list["Conversation"]] = relationship(back_populates="project", passive_deletes=True)
    requirements: Mapped[list["Requirement"]] = relationship(back_populates="project", passive_deletes=True)
    architectures: Mapped[list["Architecture"]] = relationship(back_populates="project", passive_deletes=True)


class Conversation(Base):
    __tablename__ = "conversations"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    role: Mapped[str] = mapped_column(Text, nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    stage: Mapped[str] = mapped_column(Text, nullable=False)
    # LLM-generated quick-reply options tailored to this specific assistant question (empty for
    # user turns). Persisted rather than computed ephemerally so a page reload doesn't lose the
    # suggestions for the latest unanswered question.
    suggested_replies: Mapped[list[str]] = mapped_column(JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), nullable=False, server_default=text("now()")
    )

    project: Mapped["Project"] = relationship(back_populates="conversations")


class Requirement(Base):
    __tablename__ = "requirements"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    functional: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    non_functional: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    industry_context: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, server_default=INDUSTRY_CONTEXT_DEFAULT
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("1"))
    # Lazily generated + cached on first request (not eagerly on every requirements save) --
    # NULL until someone actually views the Conversation Summary section. This is the one field
    # on an otherwise-immutable versioned row that gets an in-place UPDATE after insert: it's a
    # derived cache of existing data (conversation + this row's own functional/nonFunctional),
    # never a change to the requirements content itself, so it doesn't violate the "insert new
    # version, never mutate" pattern the rest of this table follows.
    conversation_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), nullable=False, server_default=text("now()")
    )

    project: Mapped["Project"] = relationship(back_populates="requirements")


class Architecture(Base):
    __tablename__ = "architectures"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    version: Mapped[str] = mapped_column(Text, nullable=False)
    hld: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    reasoning: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    cloud_provider: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'aws'"))
    # Keyed by provider ("aws" | "azure" | "gcp" | "kubernetes" | "private"), each value lazily
    # generated + cached the first time that provider's flow story is viewed -- generating all 5
    # up front would mean 5 extra LLM calls on every architecture generation, on top of the one
    # that already takes ~30-45s. Same "derived cache, not content" reasoning as
    # Requirement.conversation_summary applies to updating this after insert.
    flow_story: Mapped[dict[str, str]] = mapped_column(JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    # Keyed by provider, each value a list of {userAction, systemResponse, componentIds} step
    # objects -- the "User Journey Architecture" view's step-by-step breakdown. Synthesized FROM
    # flow_story[provider] (never generated independently of it -- see get_user_journey in
    # architectures.py), so it's downstream of and lazily cached the same way flow_story is.
    journey_steps: Mapped[dict[str, list[dict[str, Any]]]] = mapped_column(
        JSONB, nullable=False, server_default=text("'{}'::jsonb")
    )
    # Keyed by component id -> {"x": float, "y": float}, a manual drag-to-reposition override on
    # top of the auto-computed ELK layout (Workstream Q). Purely cosmetic/visual, never a content
    # change, so -- same "sanctioned in-place UPDATE" exception as flow_story/journey_steps above
    # -- this is merged in directly via a lightweight PATCH endpoint rather than going through the
    # insert-new-version manual-save flow every other component edit uses.
    layout_overrides: Mapped[dict[str, dict[str, float]]] = mapped_column(
        JSONB, nullable=False, server_default=text("'{}'::jsonb")
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), nullable=False, server_default=text("now()")
    )

    project: Mapped["Project"] = relationship(back_populates="architectures")
