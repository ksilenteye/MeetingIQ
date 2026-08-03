from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Tuple


def chunk_text(text: str, chunk_size: int, overlap: int) -> List[str]:
    """Character-window chunker. Kept for callers that only have flat text."""
    if chunk_size <= 0:
        return [text] if text else []
    if overlap >= chunk_size:
        overlap = max(0, chunk_size // 5)
    if not text:
        return []

    chunks: List[str] = []
    start = 0
    while start < len(text):
        end = min(len(text), start + chunk_size)
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        if end == len(text):
            break
        start = end - overlap
    return chunks


@dataclass
class Line:
    """One cleaned transcript line with the attribution it came in with."""

    text: str  # "Alice: we should ship on Friday"
    speaker: str
    ts: str


def seal_chunks(
    lines: List[Line],
    chunk_size: int,
    overlap: int,
    flush: bool = False,
) -> Tuple[List[List[Line]], List[Line]]:
    """
    Group lines into chunks of at least `chunk_size` characters, splitting only on
    line boundaries so speaker attribution is never cut in half.

    Returns (sealed groups, leftover lines). Leftover has not reached chunk_size
    yet and is meant to be carried into the next call — that is what lets chunks
    span ingest batches instead of one stub chunk per caption. Pass flush=True to
    seal the trailing partial group as well.
    """
    if chunk_size <= 0:
        return ([list(lines)], []) if lines else ([], [])
    if overlap >= chunk_size:
        overlap = max(0, chunk_size // 5)

    sealed: List[List[Line]] = []
    buf: List[Line] = []
    size = 0

    for line in lines:
        buf.append(line)
        size += len(line.text) + 1
        if size >= chunk_size:
            sealed.append(buf)
            buf, size = _carry_overlap(buf, overlap)

    if flush and buf:
        sealed.append(buf)
        buf, size = [], 0

    return sealed, buf


def _carry_overlap(group: List[Line], overlap: int) -> Tuple[List[Line], int]:
    """Trailing lines of a sealed group that fit within `overlap` chars, for context bleed."""
    carry: List[Line] = []
    size = 0
    for line in reversed(group):
        cost = len(line.text) + 1
        if size + cost > overlap:
            break
        carry.insert(0, line)
        size += cost
    # a group is only sealed once it exceeds chunk_size > overlap, so carry is
    # always a strict subset and the buffer cannot grow without bound
    return carry, size


def render_chunk(group: List[Line], meeting_id: str) -> str:
    """Chunk body with a header, so time range and speakers are embedded and retrievable."""
    speakers: List[str] = []
    for line in group:
        if line.speaker and line.speaker not in speakers:
            speakers.append(line.speaker)
    ts_start = group[0].ts if group else ""
    ts_end = group[-1].ts if group else ""
    header = f"[meeting {meeting_id} | {ts_start} - {ts_end} | speakers: {', '.join(speakers) or 'unknown'}]"
    return "\n".join([header] + [line.text for line in group])


def chunk_meta(group: List[Line], meeting_id: str) -> Dict[str, Any]:
    speakers: List[str] = []
    for line in group:
        if line.speaker and line.speaker not in speakers:
            speakers.append(line.speaker)
    return {
        "meeting_id": meeting_id,
        "ts_start": group[0].ts if group else "",
        "ts_end": group[-1].ts if group else "",
        "speakers": ", ".join(speakers),
    }
