from __future__ import annotations

import os

CHUNK_SIZE = int(os.getenv("MA_CHUNK_SIZE", "500"))
OVERLAP = int(os.getenv("MA_OVERLAP", "50"))
BUFFER_TIME = int(os.getenv("MA_BUFFER_TIME", "90"))  # seconds
PROCESS_INTERVAL = float(os.getenv("MA_PROCESS_INTERVAL", "3"))
# Seal a meeting's partial chunk once it has been quiet this long, so short
# meetings are not held below CHUNK_SIZE forever.
PENDING_FLUSH_SECONDS = float(os.getenv("MA_PENDING_FLUSH_SECONDS", "30"))

TRANSCRIPT_DB_PATH = os.getenv("MA_TRANSCRIPT_DB_PATH", "../transcripts.db")
TRANSCRIPT_TABLE = os.getenv("MA_TRANSCRIPT_TABLE", "transcripts")

EMBEDDING_DIM = int(os.getenv("MA_EMBEDDING_DIM", "384"))
TOP_K = int(os.getenv("MA_TOP_K", "5"))
# Minimum cosine similarity for a retrieved chunk. Only meaningful against real
# embeddings, so resolve_min_score() disables it when Embedder falls back to
# hashing — unless the value was set explicitly, which is taken as "I mean it".
#
# The default used to be documented as 0.6, but the value was never read by any
# code. Measured over 1095 real chunks with all-MiniLM-L6-v2, 0.6 drops 47% of
# genuinely relevant hits; 0.25 keeps 98% of them while cutting ~89% of the
# unrelated ones.
SIMILARITY_THRESHOLD = float(os.getenv("MA_SIMILARITY_THRESHOLD", "0.25"))
SIMILARITY_THRESHOLD_EXPLICIT = "MA_SIMILARITY_THRESHOLD" in os.environ


def resolve_min_score(is_semantic: bool) -> float:
    """
    Decide whether SIMILARITY_THRESHOLD applies to a given embedder.

    Cosine scores from the SHA256 fallback embedder cluster near 0 for anything
    but a verbatim match, so applying the default 0.6 to it would silently make
    retrieval return nothing at all. Setting the env var explicitly overrides
    that protection.
    """
    if is_semantic or SIMILARITY_THRESHOLD_EXPLICIT:
        return SIMILARITY_THRESHOLD
    return 0.0

SUMMARY_MAX_CHARS = int(os.getenv("MA_SUMMARY_MAX_CHARS", "4000"))
SUMMARY_TARGET_CHARS = int(os.getenv("MA_SUMMARY_TARGET_CHARS", "1200"))

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
