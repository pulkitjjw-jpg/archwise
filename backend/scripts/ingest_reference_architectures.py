"""Offline ingestion CLI for the reference-architecture corpus (Part 2 of the domain-awareness
rollout) -- AWS/Azure/GCP's own published reference-architecture guides for specific product
domains (e-commerce, SaaS multi-tenant, media/content, real-time messaging), stored alongside the
5 general-principles books but tagged source_type="reference-architecture" + domain_tags so
retrieval and citation display can distinguish "an established provider-endorsed pattern for this
domain" from "a general architecture principle" (see knowledge_retrieval.py).

Sibling script to ingest_knowledge_base.py, kept separate rather than merged into it: the source
formats here are genuinely mixed (PDF whitepaper, HTML blog/docs page, raw Markdown from a public
GitHub docs repo) and each entry carries different metadata (domain_tags, source_url) than a book
does (author, no domain scope) -- forcing both into one manifest shape would be more contorted than
two focused scripts sharing the underlying chunking/embedding/tagging functions.

Usage (from backend/, inside the container or a venv with the package installed):
    python scripts/ingest_reference_architectures.py --only aws-ecommerce
    python scripts/ingest_reference_architectures.py            # ingests every doc below
    python scripts/ingest_reference_architectures.py --dry-run --only aws-ecommerce

These source documents are much shorter than the 5 books (blog posts / docs pages / one
whitepaper, not several-hundred-page books), so unlike ingest_knowledge_base.py there's no strong
need to run one-per-process -- but nothing stops you from doing so if memory is tight.
"""

import argparse
import asyncio
import sys
from pathlib import Path
from typing import Literal, TypedDict

TAG_CONCURRENCY = 5

REF_ARCH_DIR = Path(__file__).resolve().parent.parent / "knowledge_base" / "reference_architectures"


class RefArchEntry(TypedDict):
    filename: str
    format: Literal["pdf", "html", "markdown"]
    title: str
    author: str
    source_url: str
    domain_tags: list[str]


# key -> metadata. Keys are what --only matches against. domain_tags are free-text (not a rigid
# enum, matching productDomain.category's own free-text design) but deliberately phrased close to
# how a product's category would be classified, so a retrieval query built from productDomain
# lines up well with these tags at the embedding-similarity level (domain_tags aren't a hard
# filter -- see knowledge_retrieval.py -- but keeping the vocabulary close helps relevance anyway).
REFERENCE_ARCHITECTURES: dict[str, RefArchEntry] = {
    "aws-ecommerce": {
        "filename": "aws_ecommerce_architecture.html",
        "format": "html",
        "title": "Architecting a Highly Available Serverless, Microservices-Based Ecommerce Site",
        "author": "AWS Architecture Blog",
        "source_url": "https://aws.amazon.com/blogs/architecture/architecting-a-highly-available-serverless-microservices-based-ecommerce-site/",
        "domain_tags": ["e-commerce"],
    },
    "azure-saas-multitenant-overview": {
        "filename": "azure_saas_multitenant_overview.md",
        "format": "markdown",
        "title": "SaaS and Multitenant Solution Architecture",
        "author": "Azure Architecture Center",
        "source_url": "https://learn.microsoft.com/en-us/azure/architecture/guide/saas-multitenant-solution-architecture/",
        "domain_tags": ["saas", "multi-tenant saas", "b2b saas"],
    },
    "azure-multitenant-architecture": {
        "filename": "azure_multitenant_architecture.md",
        "format": "markdown",
        "title": "Architect Multitenant Solutions on Azure",
        "author": "Azure Architecture Center",
        "source_url": "https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/overview",
        "domain_tags": ["saas", "multi-tenant saas", "b2b saas"],
    },
    "gcp-media-live-streaming": {
        "filename": "gcp_media_live_streaming_architecture.html",
        "format": "html",
        "title": "Live Streaming with Media CDN and Google Cloud Load Balancer",
        "author": "Google Cloud Blog",
        "source_url": "https://cloud.google.com/blog/products/networking/live-streaming-with-media-cdn-and-google-cloud-load-balancer/",
        "domain_tags": ["media/content platform", "real-time messaging", "streaming"],
    },
    "aws-real-time-communication": {
        "filename": "aws_real_time_communication_whitepaper.pdf",
        "format": "pdf",
        "title": "Real-Time Communication on AWS",
        "author": "AWS Whitepaper",
        "source_url": "https://docs.aws.amazon.com/whitepapers/latest/real-time-communication-on-aws/introduction.html",
        "domain_tags": ["real-time messaging", "real-time communication"],
    },
}


async def ingest_reference_doc(key: str, dry_run: bool) -> None:
    from app.config import settings
    from app.services.knowledge_embeddings import embed_passages
    from app.services.knowledge_ingestion import (
        RawChunk,
        chunk_book,
        chunk_plain_document,
        extract_html_text,
        extract_markdown_text,
        extract_pages,
    )
    from app.services.llm import tag_knowledge_chunk_topics

    entry = REFERENCE_ARCHITECTURES[key]
    doc_path = REF_ARCH_DIR / entry["filename"]
    if not doc_path.exists():
        print(f"  SKIP {key}: file not found at {doc_path}")
        return

    print(f"[{key}] Parsing {entry['filename']} ({entry['format']}) ...")
    chunks: list[RawChunk]
    if entry["format"] == "pdf":
        pages = extract_pages(str(doc_path))
        print(f"[{key}] Extracted {len(pages)} pages")
        chunks = chunk_book(pages)
    else:
        raw = doc_path.read_text(encoding="utf-8")
        text = extract_html_text(raw) if entry["format"] == "html" else extract_markdown_text(raw)
        chunks = chunk_plain_document(text)
    print(f"[{key}] Produced {len(chunks)} chunks")

    print(f"[{key}] Tagging topics ({TAG_CONCURRENCY} concurrent LLM calls, one per chunk)...")
    sem = asyncio.Semaphore(TAG_CONCURRENCY)
    tags_by_index: dict[int, list[str]] = {}

    async def tag_one(idx: int, chunk_text: str) -> None:
        async with sem:
            try:
                tags_by_index[idx] = await tag_knowledge_chunk_topics(chunk_text, entry["title"], settings.openrouter_api_key)
            except Exception as err:  # noqa: BLE001 -- one failed tag call shouldn't abort the whole doc
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
                    book_title=entry["title"],
                    author=entry["author"],
                    chapter_title=chunk.chapter_title,
                    page_start=chunk.page_start,
                    page_end=chunk.page_end,
                    chunk_text=chunk.text,
                    embedding=embeddings[i],
                    topic_tags=tags_by_index.get(i, []),
                    source_type="reference-architecture",
                    domain_tags=entry["domain_tags"],
                    source_url=entry["source_url"],
                )
            )
        await session.commit()
    print(f"[{key}] Inserted {len(chunks)} chunks into knowledge_chunks (source_type=reference-architecture)")


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--only", action="append", choices=list(REFERENCE_ARCHITECTURES.keys()), help="Ingest only this doc (repeatable)"
    )
    parser.add_argument("--dry-run", action="store_true", help="Parse/chunk/tag/embed but never write to the database")
    args = parser.parse_args()

    keys = args.only or list(REFERENCE_ARCHITECTURES.keys())
    for key in keys:
        await ingest_reference_doc(key, dry_run=args.dry_run)


if __name__ == "__main__":
    sys.exit(asyncio.run(main()) or 0)
