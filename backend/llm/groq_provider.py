from __future__ import annotations

from typing import Optional

from openai import OpenAI

from llm.base import BaseLLMProvider

GROQ_BASE_URL = "https://api.groq.com/openai/v1"


class GroqProvider(BaseLLMProvider):
    """Groq exposes an OpenAI-compatible API."""

    name = "groq"
    DEFAULT_MODEL = "llama-3.3-70b-versatile"

    def complete(
        self,
        *,
        api_key: str,
        model: Optional[str],
        system_prompt: str,
        user_prompt: str,
        max_tokens: int = 2048,
    ) -> str:
        client = OpenAI(api_key=api_key, base_url=GROQ_BASE_URL)
        m = model or self.DEFAULT_MODEL
        resp = client.chat.completions.create(
            model=m,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            max_tokens=max_tokens,
        )
        content = resp.choices[0].message.content
        return (content or "").strip()
