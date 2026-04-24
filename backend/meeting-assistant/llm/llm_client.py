from __future__ import annotations

import os

from openai import OpenAI


class LlmClient:
    def __init__(self, api_key: str | None = None, model: str = "gpt-4o-mini") -> None:
        key = api_key or os.getenv("OPENAI_API_KEY", "")
        self.model = model
        self._client = OpenAI(api_key=key) if key else None

    def answer(self, prompt: str) -> str:
        if self._client is None:
            return "LLM disabled (missing OPENAI_API_KEY). Prompt preview:\n" + prompt[:800]
        resp = self._client.responses.create(
            model=self.model,
            input=prompt,
        )
        return resp.output_text.strip() if resp.output_text else ""
