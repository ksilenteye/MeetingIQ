from __future__ import annotations

from typing import Optional

from openai import OpenAI

from llm.base import BaseLLMProvider


class OpenAIProvider(BaseLLMProvider):
    name = "openai"
    DEFAULT_MODEL = "gpt-4o-mini"

    def complete(
        self,
        *,
        api_key: str,
        model: Optional[str],
        system_prompt: str,
        user_prompt: str,
        max_tokens: int = 2048,
    ) -> str:
        client = OpenAI(api_key=api_key)
        m = model or self.DEFAULT_MODEL
        resp = client.chat.completions.create(
            model=m,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            max_tokens=max_tokens,
        )
        choice = resp.choices[0]
        content = choice.message.content
        return (content or "").strip()
