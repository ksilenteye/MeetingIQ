from __future__ import annotations

from typing import Dict, List

import numpy as np

from config import CHUNK_SIZE, OVERLAP
from db.sqlite_reader import SQLiteTranscriptReader
from embedding.embedder import Embedder
from memory.buffer import ShortTermBuffer
from memory.summarizer import RollingSummarizer
from memory.vectordb import VectorDB
from processing.chunker import chunk_text
from processing.cleaner import clean_stable_sentences


class Processor:
    def __init__(
        self,
        reader: SQLiteTranscriptReader,
        buffer: ShortTermBuffer,
        embedder: Embedder,
        vectordb: VectorDB,
        summarizer: RollingSummarizer,
    ) -> None:
        self.reader = reader
        self.buffer = buffer
        self.embedder = embedder
        self.vectordb = vectordb
        self.summarizer = summarizer
        self.last_chunks: List[str] = []
        self.last_vectors = np.empty((0, self.embedder.dim), dtype=np.float32)
        self.last_meeting_ids: List[str] = []
        self.last_source_max_id: int = 0

    def run_once(self) -> Dict[str, int]:
        self.last_chunks = []
        self.last_vectors = np.empty((0, self.embedder.dim), dtype=np.float32)
        self.last_meeting_ids = []
        self.last_source_max_id = 0
        rows = self.reader.fetch_new_rows()
        if not rows:
            return {"rows": 0, "chunks": 0}
        self.last_source_max_id = max(int(r.get("id", 0)) for r in rows)

        lines: List[str] = [f'{r["speaker"]}: {r["text"]}' for r in rows]
        cleaned = clean_stable_sentences(lines)
        if not cleaned:
            return {"rows": len(rows), "chunks": 0}

        buffered = [
            {"timestamp": rows[min(i, len(rows) - 1)]["timestamp"], "speaker": "meeting", "text": t}
            for i, t in enumerate(cleaned)
        ]
        self.buffer.add(buffered)

        joined = "\n".join(cleaned)
        chunks = chunk_text(joined, CHUNK_SIZE, OVERLAP)
        vecs = self.embedder.embed_texts(chunks)
        self.vectordb.add(chunks, vecs)
        meeting_ids = {str(r.get("meeting_id") or "") for r in rows if r.get("meeting_id")}
        meeting_id = next(iter(meeting_ids)) if len(meeting_ids) == 1 else "mixed"
        self.last_chunks = chunks
        self.last_vectors = vecs
        self.last_meeting_ids = [meeting_id for _ in chunks]
        self.summarizer.update(cleaned)
        return {"rows": len(rows), "chunks": len(chunks)}
