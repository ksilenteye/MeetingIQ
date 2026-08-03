from __future__ import annotations

import threading
from typing import Optional

from llm.base import BaseLLMProvider

# genai.configure() sets a module-global credential rather than returning a
# client, and /api/llm/action is a sync route, so FastAPI runs it in the
# threadpool with real concurrency. Without this lock two callers supplying
# different keys can interleave configure/generate_content and have their keys
# swapped — one caller's request billed to the other's quota. Held across the
# whole call because the global is read at generate_content() time, not at
# configure() time.
_genai_lock = threading.Lock()


class GeminiProvider(BaseLLMProvider):
    name = "gemini"
    DEFAULT_MODEL = "gemini-2.0-flash"

    def complete(
        self,
        *,
        api_key: str,
        model: Optional[str],
        system_prompt: str,
        user_prompt: str,
        max_tokens: int = 2048,
    ) -> str:
        import google.generativeai as genai

        m = model or self.DEFAULT_MODEL
        gen_cfg = genai.GenerationConfig(max_output_tokens=max_tokens)
        with _genai_lock:
            genai.configure(api_key=api_key)
            gen_model = genai.GenerativeModel(
                m,
                system_instruction=system_prompt,
            )
            resp = gen_model.generate_content(user_prompt, generation_config=gen_cfg)
        text = getattr(resp, "text", None)
        if text:
            return text.strip()
        parts = []
        for cand in getattr(resp, "candidates", []) or []:
            for part in getattr(cand.content, "parts", []) or []:
                if getattr(part, "text", None):
                    parts.append(part.text)
        return "\n".join(parts).strip()
