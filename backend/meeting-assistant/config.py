from __future__ import annotations

import os

CHUNK_SIZE = int(os.getenv("MA_CHUNK_SIZE", "500"))
OVERLAP = int(os.getenv("MA_OVERLAP", "50"))
BUFFER_TIME = int(os.getenv("MA_BUFFER_TIME", "90"))  # seconds
PROCESS_INTERVAL = float(os.getenv("MA_PROCESS_INTERVAL", "3"))

TRANSCRIPT_DB_PATH = os.getenv("MA_TRANSCRIPT_DB_PATH", "../transcripts.db")
TRANSCRIPT_TABLE = os.getenv("MA_TRANSCRIPT_TABLE", "transcripts")

EMBEDDING_DIM = int(os.getenv("MA_EMBEDDING_DIM", "384"))
TOP_K = int(os.getenv("MA_TOP_K", "5"))
SIMILARITY_THRESHOLD = float(os.getenv("MA_SIMILARITY_THRESHOLD", "0.6"))

SUMMARY_MAX_CHARS = int(os.getenv("MA_SUMMARY_MAX_CHARS", "4000"))
SUMMARY_TARGET_CHARS = int(os.getenv("MA_SUMMARY_TARGET_CHARS", "1200"))

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
