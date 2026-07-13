import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from pgvector.sqlalchemy import Vector
from sqlalchemy import Boolean, ForeignKey, Integer, Numeric, Text, text
from sqlalchemy.dialects.postgresql import JSONB, TIMESTAMP, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.constants import KNOWLEDGE_EMBEDDING_DIM
from app.db import Base

# Mirrors drizzle/0003_vengeful_zaran.sql's server_default exactly (verified against the live
# migration SQL, not the CLAUDE.md audit's assumption that this default was applied app-side).
INDUSTRY_CONTEXT_DEFAULT = text(
    """'{"industry":"none","rationale":"","complianceAnswers":[],"flags":{}}'::jsonb"""
)

# productDomain (domain-awareness feature) -- a BROADER classification than industry_context (an
# app can be healthtech AND a marketplace at once). "other" is the honest default for a row
# created before this field existed / before extraction has run, distinct from a real "other"
# classification the LLM actually chose -- callers that care about the difference check
# created_at or whether rationale is empty, same precedent as industry_context's "none" default.
# The backslash before :null escapes SQLAlchemy text()'s bind-parameter syntax (":word" is
# normally read as a bind param placeholder) -- without it, this raises "invalid input syntax for
# type json, Token NULL is invalid" because SQLAlchemy silently mangles the literal ":null".
PRODUCT_DOMAIN_DEFAULT = text(r"""'{"category":"other","rationale":"","referenceSystem"\:null}'::jsonb""")


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
    # Set once at project creation (Workstream T5's "I have an existing system" intake toggle),
    # never re-classified mid-conversation -- same locked-pointer precedent as knowledge_level.
    # Threaded into get_next_brainstorm_turn so the brainstorm asks about the current stack/
    # deployment/pain points instead of (or alongside) the usual greenfield checklist.
    has_existing_system: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))

    conversations: Mapped[list["Conversation"]] = relationship(back_populates="project", passive_deletes=True)
    requirements: Mapped[list["Requirement"]] = relationship(back_populates="project", passive_deletes=True)
    architectures: Mapped[list["Architecture"]] = relationship(back_populates="project", passive_deletes=True)
    share_links: Mapped[list["ShareLink"]] = relationship(back_populates="project", passive_deletes=True)


class ShareLink(Base):
    """Workstream T7 -- an unguessable token granting read-only, no-login access to a project's
    latest architecture. Deliberately its own table (not a column on Project) so a project can
    have several links with independent lifetimes, and revoking one never affects another. The
    app has no per-user auth anywhere (see main.py's single shared internal-auth secret, which
    only gates Next's server talking to FastAPI, never an end user) -- this token is the first and
    only thing in the app that gates access to a specific project's data at all."""

    __tablename__ = "share_links"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    token: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), nullable=False, server_default=text("now()")
    )
    # NULL while active; set to revoke. A row is never deleted on revoke (unlike everything else
    # in this app, which is either append-only-versioned or a plain mutable pointer) so "this link
    # used to exist and was revoked" stays visible in the creator's link-management list, distinct
    # from a token that never existed.
    revoked_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)

    project: Mapped["Project"] = relationship(back_populates="share_links")


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
    # Extracted alongside functional/nonFunctional/industryContext (Workstream T5) when
    # Project.has_existing_system is set -- {techStack, deployment, painPoints} or NULL for a
    # plain greenfield project. NULL (not an empty dict) is the "not applicable" signal the
    # Migration Roadmap feature gates on, distinct from "asked about it, nothing was said."
    existing_system: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    # Domain-awareness feature -- {category, rationale, referenceSystem}, extracted the same way
    # and at the same time as industryContext (see extract_requirements_from_history), but a
    # broader/orthogonal classification: product CATEGORY (e-commerce, SaaS, marketplace...) not
    # regulated-industry compliance regime. Consumed by HLD generation, Migration Roadmap, and
    # growth-trigger reasoning to ground domain-typical-pattern suggestions.
    product_domain: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default=PRODUCT_DOMAIN_DEFAULT)
    version: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("1"))
    # Lazily generated + cached on first request (not eagerly on every requirements save) --
    # NULL until someone actually views the Conversation Summary section. This is the one field
    # on an otherwise-immutable versioned row that gets an in-place UPDATE after insert: it's a
    # derived cache of existing data (conversation + this row's own functional/nonFunctional),
    # never a change to the requirements content itself, so it doesn't violate the "insert new
    # version, never mutate" pattern the rest of this table follows.
    conversation_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Knowledge-base RAG citations for conversation_summary, set together with it (same lazy-
    # generate-once-then-cache lifecycle) -- a SEPARATE sidecar column rather than folding into
    # conversation_summary itself, since that's a plain Text column already read as a bare string
    # everywhere on the frontend; adding this alongside avoids reshaping every existing reader.
    # NULL until conversation_summary is generated; [] (not NULL) once generated with no genuine
    # citations found, so the UI can distinguish "not generated yet" from "generated, nothing to cite".
    conversation_summary_sources: Mapped[list[dict[str, Any]] | None] = mapped_column(JSONB, nullable=True)
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
    # Knowledge-base RAG citations for flow_story, keyed by the same provider key -- a SEPARATE
    # sidecar column (not folded into flow_story[provider] itself) since flow_story's value is a
    # plain string read directly as narrative text everywhere on the frontend today; changing that
    # to an object would mean updating every existing reader. A provider key with no entry here
    # means "not generated yet or nothing to cite", same semantics as flow_story itself.
    flow_story_sources: Mapped[dict[str, list[dict[str, Any]]]] = mapped_column(
        JSONB, nullable=False, server_default=text("'{}'::jsonb")
    )
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
    # Keyed by provider, each value a list of finding dicts from the deterministic security-rules
    # audit (Workstream T4, app/services/security_rules.py). Unlike flow_story/journey_steps
    # above, this is NOT a lazy cache -- it's cheap, deterministic, no LLM call -- so all 5
    # providers are computed and stored up front at generation/manual-save time, the same moment
    # hld/reasoning are set, rather than lazily per-provider on first view.
    security_findings: Mapped[dict[str, list[dict]]] = mapped_column(
        JSONB, nullable=False, server_default=text("'{}'::jsonb")
    )
    # Keyed by provider, each value a list of phase dicts (Workstream T5) -- lazily generated +
    # cached on first request, same pattern as flow_story/journey_steps, since it's an LLM call
    # and most architectures never came from an "existing system" intake at all. Only meaningful
    # when the project's latest Requirement has existing_system set; the endpoint 400s otherwise.
    migration_roadmap: Mapped[dict[str, list[dict]]] = mapped_column(
        JSONB, nullable=False, server_default=text("'{}'::jsonb")
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), nullable=False, server_default=text("now()")
    )

    project: Mapped["Project"] = relationship(back_populates="architectures")


class KnowledgeChunk(Base):
    """A chunk of text from one of the ingested architecture/software-engineering reference books
    (see app/services/knowledge_ingestion.py), plus its embedding for similarity search. Not tied
    to any project -- this is a single shared, global corpus every project's reasoning can draw
    from. Populated by the offline ingestion script (backend/scripts/ingest_knowledge_base.py),
    never written to from a request handler."""

    __tablename__ = "knowledge_chunks"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    book_title: Mapped[str] = mapped_column(Text, nullable=False)
    author: Mapped[str] = mapped_column(Text, nullable=False)
    # Best-effort, regex-heuristic section-heading detection at ingestion time -- "Unknown
    # section" when no heading could be confidently detected above this chunk, never a guess.
    chapter_title: Mapped[str | None] = mapped_column(Text, nullable=True)
    # NULLable (not NOT NULL) since only PDF sources have a real page concept -- a web-sourced
    # reference-architecture chunk (source_type="reference-architecture") has no page number at
    # all, and forcing a placeholder value here would be a fabricated citation detail. PDF sources
    # (source_type="principle", plus any PDF-based reference-architecture doc like an AWS
    # whitepaper) always set both.
    page_start: Mapped[int | None] = mapped_column(Integer, nullable=True)
    page_end: Mapped[int | None] = mapped_column(Integer, nullable=True)
    chunk_text: Mapped[str] = mapped_column(Text, nullable=False)
    embedding: Mapped[list[float]] = mapped_column(Vector(KNOWLEDGE_EMBEDDING_DIM), nullable=False)
    # LLM-generated during ingestion (one pass per chunk) -- short topic slugs like
    # "monolith-vs-microservices", used only for human-readable inspection/debugging right now;
    # retrieval itself is purely embedding-similarity-based, not a tag filter.
    topic_tags: Mapped[list[str]] = mapped_column(JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    # Domain-awareness (Part 2 of the knowledge-base RAG rollout) -- "principle" (the original 5
    # architecture/software-engineering books, general timeless principles) vs "reference-
    # architecture" (AWS/Azure/GCP's own published reference architecture guides for a specific
    # product domain -- e-commerce, SaaS multi-tenant, media/content, real-time messaging). Citation
    # display and retrieval-time framing both key off this: a reference-architecture citation reads
    # as "Pattern Source: ..." (an established, provider-endorsed pattern for that domain), a
    # principle citation reads as "Principle Source: ..." (general architectural theory) -- these
    # are different KINDS of grounding, not interchangeable.
    source_type: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'principle'"))
    # Which product domain(s) a reference-architecture chunk applies to (e.g. ["e-commerce"]) --
    # always empty for source_type="principle" (general principles aren't domain-scoped). Informs
    # which reference-architecture chunks get pulled into a retrieval query for a project already
    # classified into a domain (see knowledge_retrieval.py), though retrieval itself still ranks by
    # embedding similarity first -- this is descriptive metadata, not a hard filter.
    domain_tags: Mapped[list[str]] = mapped_column(JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    # The public URL a reference-architecture chunk was sourced from, for HTML/Markdown sources
    # with no page concept (NULL for PDF-based sources, which cite by page instead).
    source_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), nullable=False, server_default=text("now()")
    )


class LlmUsageLog(Base):
    """One row per individual model ATTEMPT within a _call_llm_with_fallback_chain invocation
    (Workstream Z1 admin panel) -- a single cascaded call produces several rows (one per tier
    tried, plus one more if the Gemma validation tier's auto-fix pass ran), all sharing the same
    call_group_id. This granularity (rather than one row per logical call) is what makes genuine
    per-model stats possible: "average latency for Nemotron" or "Qwen's success rate" need to see
    every attempt Qwen was actually part of, not just the rows where it happened to win.

    Written from a SEPARATE, independent DB session opened inside the chain function itself (see
    app/services/llm.py) rather than threaded through every LLM function's signature and the
    caller's own request-scoped session -- usage logging is a pure audit side-effect that must
    never fail or roll back the actual LLM call it's describing, so it commits on its own."""

    __tablename__ = "llm_usage_logs"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    # Shared by every attempt row belonging to the same logical fallback-chain call -- generated
    # once per _call_llm_with_fallback_chain invocation, not per-attempt. Lets the "recent calls"
    # table and time-series view group attempts back into the single user-facing request they
    # were part of, instead of showing 3 confusing rows for what was really one brainstorm turn.
    call_group_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    # The `label` already passed to _call_llm_with_fallback_chain at every call site (e.g.
    # "Architecture generation", "Brainstorm turn generation") -- reused as-is rather than
    # inventing a second taxonomy, since it already uniquely names the feature/endpoint.
    endpoint: Mapped[str] = mapped_column(Text, nullable=False)
    # The model THIS specific attempt targeted (not necessarily the one that ultimately served
    # the call -- see is_served).
    model: Mapped[str] = mapped_column(Text, nullable=False)
    # True only for the Gemma-validation-tier auto-fix repair call (app/services/llm.py's
    # _attempt_fix) -- a real, separate API call worth its own cost/latency row, but not a "real"
    # chain tier in its own right, so per-model dashboard stats exclude these rows by default
    # (they'd otherwise inflate the fix model's own call count with repair work that was never a
    # first-class attempt at serving the request).
    is_fix_pass: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    # Did THIS attempt produce output the app could actually use -- "success" for a validated
    # tier means it passed validation (or was rescued by the fix pass), not just that the HTTP
    # call itself returned 200.
    status: Mapped[str] = mapped_column(Text, nullable=False)  # "success" | "failure"
    # True for the exactly-one row per call_group_id whose content was actually returned to the
    # caller (false for every other row in the group; no row is true if the whole call failed).
    # For a validated tier rescued by the fix pass, this marks the ORIGINAL tier's row, not the
    # fix-pass row -- the content is fundamentally that model's output, just repaired.
    is_served: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    # This attempt's own duration -- NOT the whole call_group's total wall-clock time, which is
    # SUM(latency_ms) across the group (attempts are sequential, never parallel).
    latency_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    # From the OpenRouter response's "usage" field when present -- not every provider/model
    # reports this, hence nullable rather than defaulting to 0 (0 would misrepresent "unknown" as
    # "used no tokens").
    prompt_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    completion_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Numeric (not float) for exact cents/fractions-of-a-cent arithmetic when summed across many
    # rows for the dashboard's total-cost stat. NULL when token counts are unknown, not 0 --
    # distinct from a genuinely free-tier call, which is a real, known $0.
    estimated_cost_usd: Mapped[Decimal | None] = mapped_column(Numeric(12, 8), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), nullable=False, server_default=text("now()")
    )
