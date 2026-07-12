"""Offline ingestion CLI for the architecture/software-engineering knowledge base (RAG). Parses a
PDF, chunks it, tags each chunk's topics via one LLM pass, embeds it locally, and inserts into
knowledge_chunks. Never run as part of request handling -- this is a one-time (or occasional,
when a book is added) manual job.

Usage (from backend/, inside the container or a venv with the package installed):
    python scripts/ingest_knowledge_base.py --only "software-architecture-for-developers"
    python scripts/ingest_knowledge_base.py            # ingests every book in BOOKS below
    python scripts/ingest_knowledge_base.py --dry-run --only "software-architecture-for-developers"
        # parses + chunks + tags + embeds but never writes to the database -- for inspecting
        # chunk/tag quality before committing to a real ingestion run.

IMPORTANT -- run ONE book per process invocation for anything but the shortest book, i.e. prefer
    python scripts/ingest_knowledge_base.py --only book-a
    python scripts/ingest_knowledge_base.py --only book-b
over
    python scripts/ingest_knowledge_base.py --only book-a --only book-b
This isn't just a style preference: looping over multiple large books within one long-lived
process OOM-killed the container during real ingestion (Docker Desktop's VM here has a shared,
finite ~8GB budget across postgres/redis/backend, no per-container limit to hit first -- the Linux
OOM killer picks a victim once the whole VM is under pressure). A separate process per book gets a
full OS-level memory reclaim on exit; batching books in one process does not, and memory grows
with page/chunk/tag data that never gets released mid-run.
"""

import argparse
import asyncio
import sys
from pathlib import Path

# Concurrency cap for the per-chunk LLM tagging calls -- one pass per chunk (per the ingestion
# spec) but sequential would be painfully slow for a ~300-page book (hundreds of chunks); this
# keeps a bounded number of OpenRouter requests in flight rather than hammering it unbounded.
TAG_CONCURRENCY = 5

BOOKS_DIR = Path(__file__).resolve().parent.parent / "knowledge_base" / "source_books"

# key -> (filename, book_title, author). Keys are what --only matches against, deliberately
# short/typeable rather than the full messy downloaded filename.
BOOKS: dict[str, tuple[str, str, str]] = {
    "software-architecture-for-developers": (
        "sddconf2014-software-architecture-for-developers-extract.pdf",
        "Software Architecture for Developers",
        "Simon Brown",
    ),
    "fundamentals-of-software-architecture": (
        "OReilly.Fundamentals.of.Software.Architecture.2020.1.pdf",
        "Fundamentals of Software Architecture",
        "Mark Richards and Neal Ford",
    ),
    "software-architecture-the-hard-parts": (
        "Software.Architecture.The.Hard.Parts.Neal.Ford.OReilly.9781492086895.EBooksWorld.ir.pdf",
        "Software Architecture: The Hard Parts",
        "Neal Ford, Mark Richards, Pramod Sadalage, and Zhamak Dehghani",
    ),
    "designing-software-architectures": (
        "Designing Software Architectures_ A Practical Approach ( PDFDrive ).pdf",
        "Designing Software Architectures: A Practical Approach",
        "Humberto Cervantes and Rick Kazman",
    ),
    "software-engineering-sommerville": (
        "Software-Engineering-9th-Edition-by-Ian-Sommerville.pdf",
        "Software Engineering, 9th Edition",
        "Ian Sommerville",
    ),
}


async def ingest_book(key: str, dry_run: bool) -> None:
    from app.config import settings
    from app.services.knowledge_embeddings import embed_passages
    from app.services.knowledge_ingestion import chunk_book, extract_pages
    from app.services.llm import tag_knowledge_chunk_topics

    filename, book_title, author = BOOKS[key]
    pdf_path = BOOKS_DIR / filename
    if not pdf_path.exists():
        print(f"  SKIP {key}: file not found at {pdf_path}")
        return

    print(f"[{key}] Parsing {filename} ...")
    pages = extract_pages(str(pdf_path))
    print(f"[{key}] Extracted {len(pages)} pages")

    chunks = chunk_book(pages)
    print(f"[{key}] Produced {len(chunks)} chunks")

    print(f"[{key}] Tagging topics ({TAG_CONCURRENCY} concurrent LLM calls, one per chunk)...")
    sem = asyncio.Semaphore(TAG_CONCURRENCY)
    tags_by_index: dict[int, list[str]] = {}

    async def tag_one(idx: int, text: str) -> None:
        async with sem:
            try:
                tags_by_index[idx] = await tag_knowledge_chunk_topics(text, book_title, settings.openrouter_api_key)
            except Exception as err:  # noqa: BLE001 -- one failed tag call shouldn't abort the whole book
                print(f"  [warn] tagging failed for chunk {idx}: {err}")
                tags_by_index[idx] = []

    await asyncio.gather(*(tag_one(i, c.text) for i, c in enumerate(chunks)))
    tagged_count = sum(1 for i in range(len(chunks)) if tags_by_index.get(i))
    print(f"[{key}] Tagged {tagged_count}/{len(chunks)} chunks with at least one topic")

    print(f"[{key}] Embedding {len(chunks)} chunks locally...")
    embeddings = embed_passages([c.text for c in chunks])

    if dry_run:
        print(f"[{key}] --dry-run: skipping database insert")
        return

    from app.db import AsyncSessionLocal
    from app.models import KnowledgeChunk

    async with AsyncSessionLocal() as session:
        for i, chunk in enumerate(chunks):
            session.add(
                KnowledgeChunk(
                    book_title=book_title,
                    author=author,
                    chapter_title=chunk.chapter_title,
                    page_start=chunk.page_start,
                    page_end=chunk.page_end,
                    chunk_text=chunk.text,
                    embedding=embeddings[i],
                    topic_tags=tags_by_index.get(i, []),
                )
            )
        await session.commit()
    print(f"[{key}] Inserted {len(chunks)} chunks into knowledge_chunks")


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", action="append", choices=list(BOOKS.keys()), help="Ingest only this book (repeatable)")
    parser.add_argument("--dry-run", action="store_true", help="Parse/chunk/tag/embed but never write to the database")
    args = parser.parse_args()

    keys = args.only or list(BOOKS.keys())
    for key in keys:
        await ingest_book(key, dry_run=args.dry_run)


if __name__ == "__main__":
    sys.exit(asyncio.run(main()) or 0)
