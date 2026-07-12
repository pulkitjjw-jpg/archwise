"""Shared local embedding model for the knowledge-base RAG feature -- used by both the offline
ingestion script (embedding passages) and the retrieval layer (embedding queries). A single
module so both sides load the exact same model/singleton rather than each managing their own
instance, and so the model only ever loads once per process even though both ingestion and
runtime retrieval import from here.

BAAI/bge-small-en-v1.5 via fastembed (ONNX runtime), not an OpenAI API call and not plain
sentence-transformers -- see app.constants.KNOWLEDGE_EMBEDDING_MODEL for the full tradeoff
rationale (no new API-key dependency, avoids the multi-GB PyTorch footprint). BGE models are
trained with asymmetric query/passage encoding, so passages (ingestion) and queries (retrieval)
use different embed calls below -- mixing them up would quietly degrade retrieval quality, not
error out.
"""

from functools import lru_cache

from fastembed import TextEmbedding

from app.constants import KNOWLEDGE_EMBEDDING_MODEL


@lru_cache(maxsize=1)
def _get_model() -> TextEmbedding:
    return TextEmbedding(model_name=KNOWLEDGE_EMBEDDING_MODEL)


# Caps peak memory during ingestion, independent of how many chunks a book produces. Ingestion
# runs inside a Docker Desktop VM with a hard, shared memory ceiling (~8GB total across postgres +
# redis + this container) -- embedding a large book's full chunk list in one fastembed call (which
# processes it directly by its own internal batch_size) was enough to OOM-kill the process on the
# largest book here (Sommerville, 752 chunks), while smaller books succeeded. Processing in
# smaller Python-level batches keeps peak resident memory roughly constant regardless of book size.
_EMBED_BATCH_SIZE = 32


def embed_passages(texts: list[str]) -> list[list[float]]:
    """Embeds book chunks for storage. Use for ingestion, never for a search query."""
    vectors: list[list[float]] = []
    for start in range(0, len(texts), _EMBED_BATCH_SIZE):
        batch = texts[start : start + _EMBED_BATCH_SIZE]
        vectors.extend(vec.tolist() for vec in _get_model().embed(batch, batch_size=_EMBED_BATCH_SIZE))
    return vectors


def embed_query(text: str) -> list[float]:
    """Embeds a single search query, using BGE's query-side instruction prefix under the hood
    (fastembed's query_embed handles this per-model). Use for retrieval, never for ingestion."""
    return next(iter(_get_model().query_embed([text]))).tolist()
