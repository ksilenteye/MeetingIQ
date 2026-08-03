from __future__ import annotations

import pytest

from processing.chunker import Line, chunk_meta, chunk_text, render_chunk, seal_chunks


def line(text: str, speaker: str = "Alice", ts: str = "2026-07-28T10:00:00Z") -> Line:
    return Line(text=f"{speaker}: {text}", speaker=speaker, ts=ts)


def test_empty_text_yields_nothing():
    assert chunk_text("", 500, 50) == []


def test_text_shorter_than_chunk_size_is_one_chunk():
    assert chunk_text("short line", 500, 50) == ["short line"]


def test_chunks_cover_the_whole_text():
    text = "".join(f"line {i} " for i in range(200))
    chunks = chunk_text(text, 100, 20)
    assert len(chunks) > 1
    # every chunk is within the size bound, and the tail is present
    assert all(len(c) <= 100 for c in chunks)
    assert text.strip().endswith(chunks[-1][-20:])


def test_adjacent_chunks_overlap():
    text = "abcdefghij" * 20  # 200 chars
    chunks = chunk_text(text, 50, 10)
    # chunk n starts 40 chars after chunk n-1, so the last 10 chars repeat
    assert chunks[0][-10:] == chunks[1][:10]


def test_overlap_at_least_chunk_size_is_clamped_not_infinite():
    # overlap >= chunk_size would make start go backwards forever
    chunks = chunk_text("x" * 300, 100, 100)
    assert len(chunks) < 20
    assert all(chunks)


def test_non_positive_chunk_size_returns_whole_text():
    assert chunk_text("hello", 0, 0) == ["hello"]
    assert chunk_text("", 0, 0) == []


@pytest.mark.parametrize("size,overlap", [(1, 0), (7, 3), (500, 50)])
def test_never_emits_blank_chunks(size, overlap):
    chunks = chunk_text("  spaced   out   text  " * 10, size, overlap)
    assert all(c.strip() for c in chunks)


class TestSealChunks:
    def test_nothing_seals_below_chunk_size(self):
        sealed, leftover = seal_chunks([line("short")], 500, 50)
        assert sealed == []
        assert len(leftover) == 1

    def test_seals_once_the_size_is_reached(self):
        # "Alice: " + 40 chars = 48 per line, so 100 seals every 3 lines
        lines = [line("x" * 40) for _ in range(7)]
        sealed, leftover = seal_chunks(lines, 100, 0)
        assert len(sealed) == 2
        assert all(sum(len(l.text) + 1 for l in g) >= 100 for g in sealed)
        assert len(leftover) == 1

    def test_leftover_is_carried_not_dropped(self):
        lines = [line(f"sentence number {i} with some words") for i in range(6)]
        sealed, leftover = seal_chunks(lines, 120, 0)
        assert sum(len(g) for g in sealed) + len(leftover) == len(lines)

    def test_flush_seals_the_trailing_partial(self):
        sealed, leftover = seal_chunks([line("short")], 500, 50, flush=True)
        assert len(sealed) == 1 and leftover == []

    def test_flush_on_empty_input(self):
        assert seal_chunks([], 500, 50, flush=True) == ([], [])

    def test_overlap_repeats_trailing_lines_into_the_next_chunk(self):
        lines = [line(f"line {i} padded out with filler words here") for i in range(8)]
        sealed, _leftover = seal_chunks(lines, 120, 60)
        assert len(sealed) >= 2
        # the tail of one chunk reappears at the head of the next
        assert sealed[0][-1].text == sealed[1][0].text

    def test_zero_overlap_does_not_repeat(self):
        lines = [line(f"line {i} padded out with filler words here") for i in range(8)]
        sealed, _leftover = seal_chunks(lines, 120, 0)
        assert sealed[0][-1].text != sealed[1][0].text

    def test_overlap_at_least_chunk_size_is_clamped(self):
        lines = [line(f"line {i} with a reasonable amount of text") for i in range(20)]
        sealed, leftover = seal_chunks(lines, 100, 100)
        assert sealed
        assert sum(len(g) for g in sealed) < 500  # no runaway duplication

    def test_single_oversized_line_seals_alone(self):
        sealed, leftover = seal_chunks([line("x" * 900)], 100, 20)
        assert len(sealed) == 1 and len(sealed[0]) == 1 and leftover == []

    def test_non_positive_chunk_size_seals_everything(self):
        lines = [line("a"), line("b")]
        sealed, leftover = seal_chunks(lines, 0, 0)
        assert sealed == [lines] and leftover == []


class TestRenderChunk:
    GROUP = [
        Line(text="Alice: budget approved", speaker="Alice", ts="2026-07-28T10:00:00Z"),
        Line(text="Bob: shipping friday", speaker="Bob", ts="2026-07-28T10:04:12Z"),
    ]

    def test_header_then_body(self):
        out = render_chunk(self.GROUP, "abc-defg-hij")
        header, *body = out.split("\n")
        assert header.startswith("[meeting abc-defg-hij")
        assert "2026-07-28T10:00:00Z" in header and "2026-07-28T10:04:12Z" in header
        assert "Alice, Bob" in header
        assert body == ["Alice: budget approved", "Bob: shipping friday"]

    def test_repeated_speaker_listed_once(self):
        group = [self.GROUP[0], Line(text="Alice: and another thing", speaker="Alice", ts="t2")]
        assert "Alice" in render_chunk(group, "m1").split("\n")[0]
        assert render_chunk(group, "m1").split("\n")[0].count("Alice") == 1

    def test_missing_speaker_falls_back(self):
        group = [Line(text="something said", speaker="", ts="t")]
        assert "speakers: unknown" in render_chunk(group, "m1")


class TestChunkMeta:
    def test_captures_range_and_speakers(self):
        group = [
            Line(text="Alice: one", speaker="Alice", ts="t1"),
            Line(text="Bob: two", speaker="Bob", ts="t2"),
        ]
        assert chunk_meta(group, "m1") == {
            "meeting_id": "m1",
            "ts_start": "t1",
            "ts_end": "t2",
            "speakers": "Alice, Bob",
        }

    def test_empty_group(self):
        meta = chunk_meta([], "m1")
        assert meta["meeting_id"] == "m1" and meta["ts_start"] == "" and meta["speakers"] == ""
