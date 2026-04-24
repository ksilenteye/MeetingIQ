from __future__ import annotations

from typing import Optional

from llm.base import BaseLLMProvider


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

        genai.configure(api_key=api_key)
        m = model or self.DEFAULT_MODEL
        gen_model = genai.GenerativeModel(
            m,
            system_instruction=system_prompt,
        )
        gen_cfg = genai.GenerationConfig(max_output_tokens=max_tokens)
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
