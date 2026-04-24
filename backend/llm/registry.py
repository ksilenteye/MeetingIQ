from __future__ import annotations

from typing import Dict, List

from llm.base import BaseLLMProvider
from llm.gemini_provider import GeminiProvider
from llm.groq_provider import GroqProvider
from llm.openai_provider import OpenAIProvider

_PROVIDERS: Dict[str, BaseLLMProvider] = {
    "openai": OpenAIProvider(),
    "groq": GroqProvider(),
    "gemini": GeminiProvider(),
}


def get_provider(name: str) -> BaseLLMProvider:
    key = (name or "").strip().lower()
    if key not in _PROVIDERS:
        raise ValueError(f"Unknown LLM provider: {name}. Use: {', '.join(_PROVIDERS)}")
    return _PROVIDERS[key]


def list_providers() -> List[dict]:
    out = []
    for pid, p in _PROVIDERS.items():
        dm = getattr(p, "DEFAULT_MODEL", "")
        out.append({"id": pid, "default_model": dm, "label": pid.replace("_", " ").title()})
    return out
