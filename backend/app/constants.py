DEFAULT_INDUSTRY_CONTEXT = {
    "industry": "none",
    "rationale": "",
    "complianceAnswers": [],
    "flags": {},
}

# "not_specified" is this app's own established convention for "genuinely unknown" (see llm.py's
# extract_requirements_from_history prompt: "If a non-functional item was NOT discussed... set it
# EXACTLY to not_specified"). Used to fill any of the 7 keys extract_requirements_from_history's
# own response is missing -- confirmed live that it can return a "nonFunctional" object missing
# some or all of these keys entirely (not just a theoretical gap), which used to be persisted
# as-is and then crashed the frontend the next time it read a missing field as a plain string
# (RequirementsPanel.tsx's renderNFRField, ArchitectureWorkspace.tsx's isScaleUnspecified et al.).
DEFAULT_NON_FUNCTIONAL = {
    "expectedScale": "not_specified",
    "readWritePattern": "not_specified",
    "dataNature": "not_specified",
    "latencySensitivity": "not_specified",
    "budget": "not_specified",
    "teamMaturity": "not_specified",
    "compliance": "not_specified",
}

# Mirrors models.py's PRODUCT_DOMAIN_DEFAULT (a raw-SQL server_default) -- that only applies when a
# column is left unspecified at INSERT time, which extract_requirements never does (it always
# passes an explicit value), so a degenerate extraction returning "productDomain": {} bypasses the
# DB-level default entirely and needs this Python-side equivalent instead.
DEFAULT_PRODUCT_DOMAIN = {"category": "other", "rationale": "", "referenceSystem": None}

# Knowledge-base RAG (architecture/software-engineering book ingestion). BAAI/bge-small-en-v1.5
# via fastembed -- a local ONNX model, not an API call, chosen specifically to avoid adding a new
# API-key dependency (this app only has an OpenRouter key configured, and OpenRouter has no
# embeddings endpoint) and to avoid the multi-GB PyTorch/CUDA footprint plain sentence-transformers
# would pull into the backend's Docker image. 384-dim output; both the pgvector column and the
# embedding model must agree on this if either ever changes.
KNOWLEDGE_EMBEDDING_MODEL = "BAAI/bge-small-en-v1.5"
KNOWLEDGE_EMBEDDING_DIM = 384
