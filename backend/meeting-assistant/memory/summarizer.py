from __future__ import annotations

from typing import List


class RollingSummarizer:
    def __init__(self, max_chars: int, target_chars: int) -> None:
        self.max_chars = max_chars
        self.target_chars = target_chars
        self.summary = ""

    def update(self, new_sentences: List[str]) -> str:
        if not new_sentences:
            return self.summary
        appended = " ".join(new_sentences).strip()
        if not appended:
            return self.summary
        if self.summary:
            self.summary = f"{self.summary} {appended}".strip()
        else:
            self.summary = appended
        if len(self.summary) > self.max_chars:
            self.summary = self.summary[-self.target_chars :]
        return self.summary

    def get(self) -> str:
        return self.summary
