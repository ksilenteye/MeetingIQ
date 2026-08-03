from __future__ import annotations

from difflib import SequenceMatcher
from typing import List, Tuple


def _similarity(a: str, b: str) -> float:
    return SequenceMatcher(None, a, b).ratio()


def stable_indices(
    texts: List[str],
    previous: str = "",
    sim_threshold: float = 0.9,
) -> Tuple[List[int], str]:
    """
    Indices of the lines worth keeping, plus the trailing comparison value.

    `previous` seeds the comparison with the last line seen in an earlier batch,
    so partial captions split across two ingest cycles are still deduplicated.
    Feed the returned value back in as `previous` on the next call.

    Returning indices (rather than text) lets callers keep each line's speaker
    and timestamp attached.
    """
    keep: List[int] = []
    last = previous
    for i, line in enumerate(texts):
        text = " ".join(line.split())
        if not text:
            continue
        if last and (text.startswith(last) or _similarity(last, text) >= sim_threshold):
            last = text
            continue
        keep.append(i)
        last = text
    return keep, last


def clean_stable_sentences(
    lines: List[str],
    sim_threshold: float = 0.9,
    previous: str = "",
) -> List[str]:
    keep, _last = stable_indices(lines, previous=previous, sim_threshold=sim_threshold)
    return [" ".join(lines[i].split()) for i in keep]
