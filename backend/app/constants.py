DEFAULT_INDUSTRY_CONTEXT = {
    "industry": "none",
    "rationale": "",
    "complianceAnswers": [],
    "flags": {},
}

# Knowledge-base RAG (architecture/software-engineering book ingestion). BAAI/bge-small-en-v1.5
# via fastembed -- a local ONNX model, not an API call, chosen specifically to avoid adding a new
# API-key dependency (this app only has an OpenRouter key configured, and OpenRouter has no
# embeddings endpoint) and to avoid the multi-GB PyTorch/CUDA footprint plain sentence-transformers
# would pull into the backend's Docker image. 384-dim output; both the pgvector column and the
# embedding model must agree on this if either ever changes.
KNOWLEDGE_EMBEDDING_MODEL = "BAAI/bge-small-en-v1.5"
KNOWLEDGE_EMBEDDING_DIM = 384
