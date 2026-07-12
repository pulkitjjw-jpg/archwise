"""Scratch script for manually sanity-checking retrieval quality -- not part of the app, just a
convenience runner. Re-run for Process requirement #1 (single-book test) and again here to
re-validate the similarity threshold against the full 5-book corpus, per explicit user request.
"""

import asyncio

from app.db import AsyncSessionLocal
from app.services.knowledge_retrieval import MIN_SIMILARITY, retrieve_relevant_knowledge

RELEVANT_QUERIES = [
    "when should I choose microservices over a monolith",
    "how do I visualize or document a software architecture for stakeholders",
    "what makes a good non-functional requirement",
    "how much upfront design should I do before coding in an agile team",
    "what is the difference between software architecture and software design",
    "how do I decompose a monolith into services without breaking data consistency",
    "what's the difference between coupling and cohesion",
    "how should I structure requirements elicitation with stakeholders",
]

# Deliberately unrelated to software architecture/engineering entirely -- the threshold should
# reject every one of these against the real 5-book corpus, not just the single-book test corpus.
IRRELEVANT_QUERIES = [
    "best pizza toppings for a team lunch",
    "how do I train for a marathon",
    "what's the weather like in Tokyo today",
    "recommend a good science fiction novel",
]


async def main() -> None:
    async with AsyncSessionLocal() as db:
        print(f"Current MIN_SIMILARITY threshold: {MIN_SIMILARITY}\n")
        for label, queries in [("RELEVANT", RELEVANT_QUERIES), ("IRRELEVANT (control)", IRRELEVANT_QUERIES)]:
            for q in queries:
                print(f"\n{'=' * 100}\n[{label}] QUERY: {q}\n{'=' * 100}")
                results = await retrieve_relevant_knowledge(db, q, top_k=5, min_similarity=0.0)
                if not results:
                    print("  (no chunks in corpus)")
                for r in results:
                    above = "PASS" if r.similarity >= MIN_SIMILARITY else "below threshold"
                    print(f"  [{r.similarity:.4f} {above}] {r.book_title} -- {r.chapter_title!r} (p{r.page_start}-{r.page_end})")
                    print(f"    tags: {r.topic_tags}")
                    print(f"    text: {r.chunk_text[:200].replace(chr(10), ' ')}...")


if __name__ == "__main__":
    asyncio.run(main())
