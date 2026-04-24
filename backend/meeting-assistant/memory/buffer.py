from __future__ import annotations

from collections import deque
from typing import Deque, Dict, List

from utils.time_utils import is_within_seconds


class ShortTermBuffer:
    def __init__(self, window_seconds: int) -> None:
        self.window_seconds = window_seconds
        self._items: Deque[Dict[str, str]] = deque()

    def add(self, items: List[Dict[str, str]]) -> None:
        self._items.extend(items)
        self.prune()

    def prune(self) -> None:
        while self._items and not is_within_seconds(
            self._items[0]["timestamp"], self.window_seconds
        ):
            self._items.popleft()

    def recent_text(self) -> str:
        self.prune()
        return "\n".join(f'{x["speaker"]}: {x["text"]}' for x in self._items)
