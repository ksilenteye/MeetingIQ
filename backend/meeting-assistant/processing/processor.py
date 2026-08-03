from __future__ import annotations

import time
from typing import Any, Callable, Dict, List, Optional, Tuple

import numpy as np

from config import CHUNK_SIZE, OVERLAP, PENDING_FLUSH_SECONDS
from db.sqlite_reader import SQLiteTranscriptReader
from embedding.embedder import Embedder
from memory.buffer import ShortTermBuffer
from memory.summarizer import RollingSummarizer
from memory.vectordb import VectorDB
from processing.chunker import Line, chunk_meta, render_chunk, seal_chunks
from processing.cleaner import stable_indices


def group_rows_by_meeting(rows: List[Dict[str, str]]) -> List[Tuple[str, List[Dict[str, str]]]]:
    """
    Bucket a fetch batch per meeting, preserving first-seen meeting order and
    chronological row order within each meeting. Chunks are built per bucket so
    every chunk carries a real meeting_id instead of a batch-wide placeholder.
    """
    order: List[str] = []
    buckets: Dict[str, List[Dict[str, str]]] = {}
    for row in rows:
        mid = str(row.get("meeting_id") or "unknown")
        if mid not in buckets:
            buckets[mid] = []
            order.append(mid)
        buckets[mid].append(row)
    return [(mid, buckets[mid]) for mid in order]


class Processor:
    """
    Pulls new transcript rows and turns them into embedded chunks.

    Chunks accumulate across ingest cycles: captions arrive a few words at a
    time, so text is held per meeting until it reaches chunk_size rather than
    being embedded as one stub chunk per batch. A meeting that goes quiet has
    its remainder sealed after flush_seconds so short meetings still land.
    """

    def __init__(
        self,
        reader: SQLiteTranscriptReader,
        buffer: ShortTermBuffer,
        embedder: Embedder,
        vectordb: VectorDB,
        summarizer: RollingSummarizer,
        chunk_size: int = CHUNK_SIZE,
        overlap: int = OVERLAP,
        flush_seconds: float = PENDING_FLUSH_SECONDS,
        clock: Optional[Callable[[], float]] = None,
    ) -> None:
        self.reader = reader
        self.buffer = buffer
        self.embedder = embedder
        self.vectordb = vectordb
        self.summarizer = summarizer
        self.chunk_size = chunk_size
        self.overlap = overlap
        self.flush_seconds = flush_seconds
        self._clock = clock or time.monotonic

        self.last_chunks: List[str] = []
        self.last_vectors = np.empty((0, self.embedder.dim), dtype=np.float32)
        self.last_meeting_ids: List[str] = []
        self.last_chunk_metas: List[Dict[str, Any]] = []
        self.last_source_max_id: int = 0

        # carried between runs, keyed by meeting_id
        self._pending: Dict[str, List[Line]] = {}
        self._pending_since: Dict[str, float] = {}
        self._dedupe_seed: Dict[str, str] = {}

    def pending_line_count(self) -> int:
        return sum(len(v) for v in self._pending.values())

    def _reset_last(self) -> None:
        self.last_chunks = []
        self.last_vectors = np.empty((0, self.embedder.dim), dtype=np.float32)
        self.last_meeting_ids = []
        self.last_chunk_metas = []
        self.last_source_max_id = 0

    def _ingest_rows(self, rows: List[Dict[str, str]]) -> List[Tuple[str, List[Line]]]:
        """Clean, buffer and summarize new rows; return whatever chunks that sealed."""
        sealed: List[Tuple[str, List[Line]]] = []
        for meeting_id, group in group_rows_by_meeting(rows):
            texts = [f'{r["speaker"]}: {r["text"]}' for r in group]
            keep, seed = stable_indices(texts, previous=self._dedupe_seed.get(meeting_id, ""))
            self._dedupe_seed[meeting_id] = seed
            if not keep:
                continue

            lines = [
                Line(
                    text=" ".join(texts[i].split()),
                    speaker=str(group[i].get("speaker") or "Unknown"),
                    ts=str(group[i].get("timestamp") or ""),
                )
                for i in keep
            ]

            # short-term tiers stay live — they must not wait for a chunk to seal
            self.buffer.add(
                [{"timestamp": ln.ts, "speaker": "meeting", "text": ln.text} for ln in lines]
            )
            self.summarizer.update([ln.text for ln in lines])

            carried = self._pending.get(meeting_id, [])
            groups, leftover = seal_chunks(carried + lines, self.chunk_size, self.overlap)
            self._pending[meeting_id] = leftover
            self._pending_since[meeting_id] = self._clock()
            sealed.extend((meeting_id, g) for g in groups)
        return sealed

    def _seal_idle(self) -> List[Tuple[str, List[Line]]]:
        """Seal remainders for meetings that have gone quiet."""
        sealed: List[Tuple[str, List[Line]]] = []
        now = self._clock()
        for meeting_id, lines in list(self._pending.items()):
            if not lines:
                continue
            if now - self._pending_since.get(meeting_id, now) < self.flush_seconds:
                continue
            groups, _leftover = seal_chunks(lines, self.chunk_size, self.overlap, flush=True)
            self._pending[meeting_id] = []
            sealed.extend((meeting_id, g) for g in groups)
        return sealed

    def _embed_and_store(self, sealed: List[Tuple[str, List[Line]]]) -> int:
        if not sealed:
            return 0
        chunk_texts = [render_chunk(group, mid) for mid, group in sealed]
        metas = [chunk_meta(group, mid) for mid, group in sealed]
        vectors = self.embedder.embed_texts(chunk_texts)
        self.vectordb.add(chunk_texts, vectors, metas)
        self.last_chunks = chunk_texts
        self.last_vectors = vectors
        self.last_meeting_ids = [mid for mid, _group in sealed]
        self.last_chunk_metas = metas
        return len(chunk_texts)

    def run_once(self) -> Dict[str, int]:
        self._reset_last()
        rows = self.reader.fetch_new_rows()
        if rows:
            self.last_source_max_id = max(int(r.get("id", 0)) for r in rows)

        sealed = self._ingest_rows(rows) if rows else []
        sealed.extend(self._seal_idle())
        chunks = self._embed_and_store(sealed)
        return {"rows": len(rows), "chunks": chunks}

    def flush(self) -> Dict[str, int]:
        """Seal every meeting's remainder regardless of idle time."""
        self._reset_last()
        sealed: List[Tuple[str, List[Line]]] = []
        for meeting_id, lines in list(self._pending.items()):
            if not lines:
                continue
            groups, _leftover = seal_chunks(lines, self.chunk_size, self.overlap, flush=True)
            self._pending[meeting_id] = []
            sealed.extend((meeting_id, g) for g in groups)
        chunks = self._embed_and_store(sealed)
        return {"rows": 0, "chunks": chunks}
