"""Retrieval layer for the architecture/software-engineering book knowledge base (RAG). Reads
knowledge_chunks (populated offline by backend/scripts/ingest_knowledge_base.py) -- this module
has no write access to that table, mirroring the read-only relationship every other retrieval-style
service in this codebase has to its data source."""

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import KnowledgeChunk
from app.services.knowledge_embeddings import embed_query

# Cosine SIMILARITY (1 - cosine distance) below this is treated as "nothing genuinely relevant
# found" -- retrieval returns fewer than top_k results (possibly zero) rather than padding with
# weak matches. Never attach a citation from a chunk that didn't clear this bar (see Step 3's
# "never force a fake citation" requirement).
#
# Re-validated against the FULL 5-book corpus (1,629 chunks) with 8 relevant queries + 4
# deliberately irrelevant control queries ("how do I train for a marathon", "recommend a good
# science fiction novel", etc). This raised the bar from an earlier single-book estimate of 0.55:
# a bigger, more varied corpus means more chances for a topically-unrelated chunk to be the *least*
# dissimilar match by coincidence -- e.g. at 0.55, "how do I train for a marathon" was matching a
# career-development passage about "carving out personal time for hobbies" at 0.58, which reads
# like a real citation but isn't one. With the full corpus: every relevant query's weakest top-5
# result still scored >=0.72, while every irrelevant control query's best result stayed <=0.58.
# 0.65 sits well inside that gap. Re-check again if the corpus size/composition changes materially
# (e.g. more books added) -- this number is empirical, not principled.
MIN_SIMILARITY = 0.65


@dataclass
class RetrievedChunk:
    chunk_id: str
    book_title: str
    author: str
    chapter_title: str | None
    page_start: int
    page_end: int
    chunk_text: str
    topic_tags: list[str]
    similarity: float


async def retrieve_relevant_knowledge(
    db: AsyncSession, query: str, top_k: int = 5, min_similarity: float = MIN_SIMILARITY
) -> list[RetrievedChunk]:
    """Embeds `query` and returns up to `top_k` chunks from the knowledge base ordered by
    relevance, each above `min_similarity`. Returns an empty list when nothing clears the bar --
    callers must treat that as "no grounding available" (see architecture_generation.py's Step 3
    wiring), never fall back to forcing in the closest-but-irrelevant chunk."""
    query_vector = embed_query(query)
    distance_expr = KnowledgeChunk.embedding.cosine_distance(query_vector)
    rows = (
        await db.execute(
            select(KnowledgeChunk, distance_expr.label("distance"))
            .order_by(distance_expr)
            .limit(top_k)
        )
    ).all()

    results: list[RetrievedChunk] = []
    for chunk, distance in rows:
        similarity = 1 - float(distance)
        if similarity < min_similarity:
            continue
        results.append(
            RetrievedChunk(
                chunk_id=str(chunk.id),
                book_title=chunk.book_title,
                author=chunk.author,
                chapter_title=chunk.chapter_title,
                page_start=chunk.page_start,
                page_end=chunk.page_end,
                chunk_text=chunk.chunk_text,
                topic_tags=chunk.topic_tags,
                similarity=round(similarity, 4),
            )
        )
    return results


def build_requirements_context_query(reqs_context: dict, industry_context: dict) -> str:
    """Builds a retrieval query from a product's requirements -- a plain-language description of
    the decision context, phrased the way a book's table of contents or index would describe
    topics, not a JSON dump of the raw requirements. Shared by every touchpoint whose grounding
    question is fundamentally "what does the corpus say about a product like this one": HLD
    generation (monolith vs. microservices, layering, component boundaries), NFR suggestion
    reasoning, and the Conversation Summary. Deliberately built ONLY from requirements/industry
    context (never rule-engine or architecture output) so callers can retrieve before running
    anything else. Kept as a pure function (no DB) so it's trivially unit-testable."""
    functional = ", ".join(reqs_context.get("functional", [])[:8]) or "not specified"
    nfr = reqs_context.get("nonFunctional", {})
    parts = [
        f"Architectural design decisions for a product with these capabilities: {functional}.",
        f"Expected scale: {nfr.get('expectedScale', 'not specified')}.",
        f"Read/write pattern: {nfr.get('readWritePattern', 'not specified')}.",
        f"Data nature: {nfr.get('dataNature', 'not specified')}.",
    ]
    industry = industry_context.get("industry", "none")
    if industry and industry != "none":
        parts.append(f"Industry/compliance context: {industry}.")
    return " ".join(parts)


def build_flow_story_query(components: list[dict], functional: list[str]) -> str:
    """Builds the retrieval query for the Flow Story touchpoint -- grounded in the actual
    component types/names present and what the product does, since Flow Story is about how a
    request moves through THIS architecture, not the raw requirements that produced it."""
    names = ", ".join(sorted({c.get("name", c.get("type", "")) for c in components})[:10]) or "not specified"
    caps = ", ".join(functional[:6]) or "not specified"
    return (
        f"How a request or data flows through a system composed of: {names}. "
        f"The product's key capabilities: {caps}."
    )


def chunk_to_prompt_dict(chunk: RetrievedChunk) -> dict:
    """Shapes a RetrievedChunk into what validate_and_generate_architecture's knowledge_context
    parameter expects -- kept here (not duplicated at each call site) since both the real-generate
    and What-If-preview call sites need the exact same shape."""
    return {
        "bookTitle": chunk.book_title,
        "author": chunk.author,
        "chapterTitle": chunk.chapter_title,
        "pageStart": chunk.page_start,
        "pageEnd": chunk.page_end,
        "text": chunk.chunk_text,
    }


def enrich_citations(sources: list[dict] | None, knowledge_context: list[dict]) -> list[dict]:
    """Attaches the real stored excerpt text to each LLM-cited source, by matching back against
    the chunks actually retrieved for this call -- never trusts the LLM to echo the excerpt
    verbatim (risk of paraphrase/drift), and never fabricates an excerpt for a citation that
    doesn't match anything retrieved (that citation is dropped rather than shown with no text, to
    avoid displaying attribution-only citation the UI can't back up with real content).

    Matches on book title + page number falling in the chunk's page range -- not chapter/section
    title, since the LLM sometimes cites a more specific internal sub-heading found within a
    chunk's text (verified accurate in practice, e.g. "A.1.1 Web Applications" nested inside a
    chunk titled "A. A Design Concepts Catalog") that won't string-match the chunk's own
    chapter_title metadata."""
    if not sources:
        return []
    enriched = []
    for s in sources:
        try:
            page = int(str(s.get("page", "")).split("-")[0].strip())
        except (ValueError, TypeError):
            page = None
        match = next(
            (
                c
                for c in knowledge_context
                if c["bookTitle"] == s.get("book") and (page is None or c["pageStart"] <= page <= c["pageEnd"])
            ),
            None,
        )
        if not match:
            continue
        enriched.append(
            {
                "book": s.get("book"),
                "author": match["author"],
                "chapterOrSection": s.get("chapterOrSection"),
                "page": s.get("page"),
                "excerpt": match["text"],
            }
        )
    return enriched
