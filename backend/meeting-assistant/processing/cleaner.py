from __future__ import annotations

from difflib import SequenceMatcher
from typing import List


def _similarity(a: str, b: str) -> float:
    return SequenceMatcher(None, a, b).ratio()


def clean_stable_sentences(lines: List[str], sim_threshold: float = 0.9) -> List[str]:
    out: List[str] = []
    last = ""
    for line in lines:
        text = " ".join(line.split())
        if not text:
            continue
        if last and (text.startswith(last) or _similarity(last, text) >= sim_threshold):
            last = text
            continue
        out.append(text)
        last = text
    return out
