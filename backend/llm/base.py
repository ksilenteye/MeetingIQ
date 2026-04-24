from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Optional


class BaseLLMProvider(ABC):
    """Contract for chat-completions style LLM calls."""

    name: str = "base"

    @abstractmethod
    def complete(
        self,
        *,
        api_key: str,
        model: Optional[str],
        system_prompt: str,
        user_prompt: str,
        max_tokens: int = 2048,
    ) -> str:
        raise NotImplementedError
