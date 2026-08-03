from __future__ import annotations

from typing import Dict, List

import numpy as np
import pytest

from memory.buffer import ShortTermBuffer
from memory.summarizer import RollingSummarizer
from memory.vectordb import VectorDB
from processing.processor import Processor, group_rows_by_meeting
from utils.time_utils import utc_now

# ShortTermBuffer prunes by wall clock, so rows must be stamped "now" to survive it.
TS = utc_now().isoformat().replace("+00:00", "Z")


class FakeReader:
    """Stands in for SQLiteTranscriptReader; serves each batch once."""

    def __init__(self, *batches: List[Dict[str, str]]) -> None:
        self.batches = list(batches)
        self.last_id = 0

    def fetch_new_rows(self, limit: int = 1000) -> List[Dict[str, str]]:
        if not self.batches:
            return []
        rows = self.batches.pop(0)
        if rows:
            self.last_id = int(rows[-1]["id"])
        return rows


class StubEmbedder:
    """Deterministic and instant — the real one downloads a model."""

    def __init__(self, dim: int = 8) -> None:
        self.dim = dim
        self.calls: List[List[str]] = []

    def embed_texts(self, texts: List[str]) -> np.ndarray:
        self.calls.append(list(texts))
        out = np.zeros((len(texts), self.dim), dtype=np.float32)
        for i, text in enumerate(texts):
            out[i][hash(text) % self.dim] = 1.0
        return out


class FakeClock:
    def __init__(self, start: float = 1000.0) -> None:
        self.t = start

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds


def row(rid: int, meeting: str, speaker: str, text: str, ts: str = TS) -> Dict[str, str]:
    return {"id": rid, "meeting_id": meeting, "timestamp": ts, "speaker": speaker, "text": text}


def build(*batches, embedder=None, chunk_size=500, overlap=50, flush_seconds=30.0, clock=None):
    embedder = embedder or StubEmbedder()
    return Processor(
        FakeReader(*batches),
        ShortTermBuffer(90),
        embedder,
        VectorDB(embedder.dim),
        RollingSummarizer(4000, 1200),
        chunk_size=chunk_size,
        overlap=overlap,
        flush_seconds=flush_seconds,
        clock=clock,
    )


LONG = "we discussed the migration plan in detail and agreed on the rollout order"  # ~72 chars

# Pairwise dissimilar on purpose: near-duplicate lines are dropped by the
# cleaner, so reusing one sentence would leave nothing to accumulate.
SENTENCES = [
    "we discussed the migration plan and agreed on the rollout order",
    "marketing needs the launch assets by the end of next week",
    "the staging cluster keeps dropping connections under load",
    "legal signed off on the updated data processing agreement",
    "we should postpone the pricing change until after the audit",
    "hiring for the platform team is paused until Q4 budgeting",
    "customer escalations dropped by half after the caching fix",
    "the mobile build is blocked on an expired signing certificate",
    "documentation for the public API is seventy percent complete",
    "a decision is needed on whether to keep the legacy sdk alive",
]


class TestGroupRowsByMeeting:
    def test_single_meeting(self):
        rows = [row(1, "m1", "A", "one"), row(2, "m1", "B", "two")]
        assert group_rows_by_meeting(rows) == [("m1", rows)]

    def test_interleaved_meetings_are_bucketed_preserving_order(self):
        rows = [row(1, "m1", "A", "one"), row(2, "m2", "B", "two"), row(3, "m1", "C", "three")]
        grouped = group_rows_by_meeting(rows)
        assert [mid for mid, _ in grouped] == ["m1", "m2"]
        assert [r["id"] for r in grouped[0][1]] == [1, 3]
        assert [r["id"] for r in grouped[1][1]] == [2]

    def test_missing_meeting_id_becomes_unknown(self):
        grouped = group_rows_by_meeting([{"id": 1, "timestamp": TS, "speaker": "A", "text": "x"}])
        assert grouped[0][0] == "unknown"

    def test_empty(self):
        assert group_rows_by_meeting([]) == []


class TestRunOnce:
    def test_no_rows_is_a_noop(self):
        assert build([]).run_once() == {"rows": 0, "chunks": 0}

    def test_chunks_are_tagged_with_their_own_meeting(self):
        # regression: a batch spanning two meetings collapsed to meeting_id "mixed",
        # which made those chunks unreachable by the meeting-filtered RAG lookup
        proc = build([
            row(1, "abc-defg-hij", "Alice", "Budget approved for Q3 hiring."),
            row(2, "xyz-1234-klm", "Dave", "The migration script is ready to review."),
            row(3, "abc-defg-hij", "Bob", "We revisit headcount in August."),
        ])
        proc.run_once()
        proc.flush()
        assert "mixed" not in proc.last_meeting_ids
        assert set(proc.last_meeting_ids) == {"abc-defg-hij", "xyz-1234-klm"}

    def test_metadata_lists_stay_aligned_with_chunks(self):
        proc = build([row(1, "m1", "A", LONG), row(2, "m2", "B", LONG)], chunk_size=40)
        proc.run_once()
        n = len(proc.last_chunks)
        assert n > 0
        assert len(proc.last_meeting_ids) == len(proc.last_chunk_metas) == len(proc.last_vectors) == n

    def test_tracks_max_source_id_for_the_cursor(self):
        proc = build([row(7, "m1", "A", "first"), row(11, "m1", "B", "second")])
        proc.run_once()
        assert proc.last_source_max_id == 11

    def test_state_resets_between_runs(self):
        proc = build([row(1, "m1", "A", LONG)], [], chunk_size=40)
        proc.run_once()
        assert proc.last_chunks
        proc.run_once()  # empty batch
        assert proc.last_chunks == [] and proc.last_meeting_ids == [] and proc.last_chunk_metas == []
        assert proc.last_vectors.shape[0] == 0

    def test_blank_captions_collapse_to_a_single_bare_speaker_label(self):
        # lines are built as "Speaker: text", so a blank caption is never fully
        # empty; it degrades to "A:" and the duplicate is dropped by the cleaner
        proc = build([row(1, "m1", "A", "   "), row(2, "m1", "A", "")])
        assert proc.run_once() == {"rows": 2, "chunks": 0}
        proc.flush()
        assert proc.last_chunks and proc.last_chunks[0].endswith("A:")

    def test_embeds_in_one_batched_call(self):
        embedder = StubEmbedder()
        proc = build([row(1, "m1", "A", LONG), row(2, "m2", "B", LONG)], embedder=embedder, chunk_size=40)
        proc.run_once()
        assert len(embedder.calls) == 1

    def test_chunks_land_in_the_vector_index_with_metadata(self):
        proc = build([row(1, "m1", "Alice", LONG)], chunk_size=40)
        proc.run_once()
        assert len(proc.vectordb.texts) == len(proc.last_chunks) > 0
        assert proc.vectordb.metas[0]["meeting_id"] == "m1"

    def test_buffer_and_summarizer_receive_content_immediately(self):
        # live tiers must not wait for a chunk to seal
        proc = build([row(1, "m1", "Alice", "we agreed on the launch date")])
        proc.run_once()
        assert proc.last_chunks == []
        assert "launch date" in proc.buffer.recent_text()
        assert "launch date" in proc.summarizer.get()

    @pytest.mark.parametrize("speaker", ["Alice", "Unknown"])
    def test_speaker_label_is_carried_into_chunk_text(self, speaker):
        proc = build([row(1, "m1", speaker, "a sentence with enough words to survive")])
        proc.run_once()
        proc.flush()
        assert speaker in "\n".join(proc.last_chunks)


class TestChunkAccumulation:
    def test_short_batches_are_held_until_chunk_size_is_reached(self):
        batches = [[row(i, "m1", "A", SENTENCES[i])] for i in range(5)]
        proc = build(*batches, chunk_size=200, overlap=0)
        produced = [proc.run_once()["chunks"] for _ in batches]
        # nothing seals on the first batch; something seals once enough text piles up
        assert produced[0] == 0
        assert sum(produced) >= 1
        assert proc.pending_line_count() < 5

    def test_sealed_chunks_approach_the_configured_size(self):
        rows = [row(i, "m1", "A", SENTENCES[i]) for i in range(10)]
        proc = build(rows, chunk_size=300, overlap=0)
        proc.run_once()
        assert proc.last_chunks
        bodies = ["\n".join(c.split("\n")[1:]) for c in proc.last_chunks]  # drop header
        assert all(len(b) >= 200 for b in bodies), [len(b) for b in bodies]

    def test_pending_text_is_not_lost_across_runs(self):
        proc = build([row(1, "m1", "A", "first half of the sentence")],
                     [row(2, "m1", "B", "second half of the sentence")],
                     chunk_size=60, overlap=0)
        proc.run_once()
        proc.run_once()
        proc.flush()
        everything = "\n".join(proc.vectordb.texts)
        assert "first half" in everything and "second half" in everything

    def test_partial_caption_split_across_batches_is_deduplicated(self):
        # the dedup seed carries between runs; without it the prefix would be
        # embedded as its own chunk alongside the completed sentence
        proc = build([row(1, "m1", "A", "we should")],
                     [row(2, "m1", "A", "we should prioritise the pipeline")],
                     chunk_size=500)
        proc.run_once()
        proc.run_once()
        proc.flush()
        body = "\n".join(proc.vectordb.texts)
        assert body.count("we should") == 1

    def test_idle_meeting_is_flushed_after_the_quiet_period(self):
        clock = FakeClock()
        proc = build([row(1, "m1", "A", "a short remark")], [], chunk_size=500, flush_seconds=30, clock=clock)
        assert proc.run_once()["chunks"] == 0
        assert proc.run_once()["chunks"] == 0  # still within the quiet period
        clock.advance(31)
        assert proc.run_once()["chunks"] == 1
        assert proc.pending_line_count() == 0

    def test_active_meeting_is_not_idle_flushed(self):
        clock = FakeClock()
        proc = build([row(1, "m1", "A", "first remark")], [row(2, "m1", "A", "second remark")],
                     chunk_size=500, flush_seconds=30, clock=clock)
        proc.run_once()
        clock.advance(29)
        assert proc.run_once()["chunks"] == 0  # new rows reset the quiet timer
        clock.advance(29)
        assert proc.run_once()["chunks"] == 0

    def test_flush_seals_everything_pending(self):
        proc = build([row(1, "m1", "A", "one remark"), row(2, "m2", "B", "other remark")], chunk_size=500)
        proc.run_once()
        assert proc.pending_line_count() == 2
        stats = proc.flush()
        assert stats["chunks"] == 2  # one per meeting
        assert proc.pending_line_count() == 0

    def test_flush_with_nothing_pending_is_a_noop(self):
        proc = build([])
        assert proc.flush() == {"rows": 0, "chunks": 0}


class TestChunkMetadata:
    def _chunk(self):
        proc = build([
            row(1, "abc-defg-hij", "Alice", SENTENCES[0], ts="2026-07-28T10:00:00Z"),
            row(2, "abc-defg-hij", "Bob", SENTENCES[1], ts="2026-07-28T10:04:12Z"),
        ], chunk_size=500)
        proc.run_once()
        proc.flush()
        return proc

    def test_header_carries_meeting_time_range_and_speakers(self):
        text = self._chunk().last_chunks[0]
        header = text.split("\n")[0]
        assert "abc-defg-hij" in header
        assert "2026-07-28T10:00:00Z" in header and "2026-07-28T10:04:12Z" in header
        assert "Alice" in header and "Bob" in header

    def test_meta_matches_the_header(self):
        meta = self._chunk().last_chunk_metas[0]
        assert meta["meeting_id"] == "abc-defg-hij"
        assert meta["ts_start"] == "2026-07-28T10:00:00Z"
        assert meta["ts_end"] == "2026-07-28T10:04:12Z"
        assert meta["speakers"] == "Alice, Bob"

    def test_body_keeps_the_original_speaker_prefixed_lines(self):
        body = self._chunk().last_chunks[0].split("\n")[1:]
        assert body[0].startswith("Alice:") and body[1].startswith("Bob:")
