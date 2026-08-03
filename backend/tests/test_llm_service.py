from __future__ import annotations

import pytest

from llm.service import (
    MAX_CONTEXT_CHARS,
    _fallback_qa,
    _fallback_summarize,
    format_transcript_block,
    resolve_api_key,
    run_llm_action,
)

LINES = [
    {"speaker": "Alice", "timestamp": "2026-07-28T10:00:00Z", "text": "We should prioritise the RAG pipeline."},
    {"speaker": "Bob", "timestamp": "2026-07-28T10:00:05Z", "text": "The pipeline work lands next sprint."},
    {"speaker": "Carol", "timestamp": "2026-07-28T10:00:09Z", "text": "Lunch is at one."},
]


class TestFallbackQa:
    def test_returns_a_string_when_matches_exist(self):
        # regression: joined (score, text) tuples instead of the text -> TypeError -> 500
        out = _fallback_qa(LINES, "what about the pipeline?")
        assert isinstance(out, str)
        assert "pipeline" in out.lower()

    def test_no_transcript(self):
        assert "No transcript" in _fallback_qa([], "anything?")

    def test_question_with_no_usable_terms(self):
        assert "longer question" in _fallback_qa(LINES, "?? 12 !")

    def test_no_keyword_match(self):
        assert "could not find" in _fallback_qa(LINES, "kubernetes autoscaling").lower()

    def test_ranks_best_match_first(self):
        out = _fallback_qa(LINES, "pipeline sprint work")
        assert out.index("Bob") < out.index("Alice")


class TestFallbackSummarize:
    def test_empty(self):
        assert "No transcript content" in _fallback_summarize([])

    def test_returns_sentences_from_the_tail(self):
        out = _fallback_summarize(LINES)
        assert isinstance(out, str) and out


class TestFormatTranscriptBlock:
    def test_formats_speaker_and_timestamp(self):
        assert "Alice (2026-07-28T10:00:00Z): We should prioritise the RAG pipeline." in format_transcript_block(LINES)

    def test_skips_blank_text_and_defaults_speaker(self):
        out = format_transcript_block([{"text": "  "}, {"text": "kept"}])
        assert out == "Unknown (): kept"

    def test_truncates_to_the_context_cap_keeping_the_tail(self):
        big = [{"speaker": "A", "timestamp": "t", "text": "x" * 200_000}]
        out = format_transcript_block(big)
        assert len(out) <= MAX_CONTEXT_CHARS + 64
        assert out.startswith("(Earlier content omitted for length.)")


class TestResolveApiKey:
    def test_explicit_key_wins(self, monkeypatch):
        monkeypatch.setenv("OPENAI_API_KEY", "from-env")
        assert resolve_api_key("openai", "  explicit  ") == "explicit"

    def test_falls_back_to_env(self, monkeypatch):
        monkeypatch.setenv("GROQ_API_KEY", "gsk_env")
        assert resolve_api_key("groq", None) == "gsk_env"

    def test_gemini_accepts_either_env_name(self, monkeypatch):
        monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
        monkeypatch.setenv("GEMINI_API_KEY", "gem")
        assert resolve_api_key("gemini", "") == "gem"

    def test_unknown_provider_has_no_env(self, monkeypatch):
        assert resolve_api_key("nope", None) == ""


class TestRunLlmAction:
    @pytest.fixture(autouse=True)
    def _no_ambient_keys(self, monkeypatch):
        for name in ("OPENAI_API_KEY", "GROQ_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY"):
            monkeypatch.delenv(name, raising=False)

    def _call(self, **kw):
        args = dict(
            lines=LINES, action="qa", question="what about the pipeline?",
            provider_id="openai", api_key=None, model=None, allow_fallback=True,
        )
        args.update(kw)
        return run_llm_action(**args)

    def test_keyless_qa_uses_heuristic_and_reports_no_llm(self):
        result, used_llm = self._call()
        assert used_llm is False
        assert "pipeline" in result.lower()

    def test_keyless_summarize_uses_heuristic(self):
        result, used_llm = self._call(action="summarize", question=None)
        assert used_llm is False and result

    def test_keyless_without_fallback_explains_how_to_configure(self):
        result, used_llm = self._call(allow_fallback=False)
        assert used_llm is False
        assert "OPENAI_API_KEY" in result

    def test_empty_transcript_short_circuits(self):
        result, used_llm = self._call(lines=[])
        assert used_llm is False
        assert "No transcript lines" in result

    def test_unknown_provider_is_reported_not_raised(self):
        result, used_llm = self._call(api_key="sk-test", provider_id="palm")
        assert used_llm is False
        assert "Unknown LLM provider" in result

    def test_unsupported_action_is_reported(self):
        result, used_llm = self._call(api_key="sk-test", action="translate")
        assert used_llm is False
        assert "Unsupported action" in result

    def test_qa_without_question_is_rejected(self):
        result, used_llm = self._call(api_key="sk-test", question="   ")
        assert used_llm is False
        assert "enter a question" in result.lower()

    def test_provider_failure_is_caught_and_surfaced(self, monkeypatch):
        class Boom:
            def complete(self, **_kw):
                raise RuntimeError("upstream 429")

        monkeypatch.setattr("llm.service.get_provider", lambda _pid: Boom())
        result, used_llm = self._call(api_key="sk-test")
        assert used_llm is False
        assert "LLM request failed" in result and "429" in result

    def test_successful_provider_call_marks_used_llm(self, monkeypatch):
        seen = {}

        class Ok:
            def complete(self, *, api_key, model, system_prompt, user_prompt, **_kw):
                seen.update(api_key=api_key, model=model, user_prompt=user_prompt)
                return "  the answer  "

        monkeypatch.setattr("llm.service.get_provider", lambda _pid: Ok())
        result, used_llm = self._call(api_key="sk-test", model="gpt-4o-mini")
        assert used_llm is True
        assert result == "  the answer  "
        assert seen["api_key"] == "sk-test" and seen["model"] == "gpt-4o-mini"
        assert "pipeline" in seen["user_prompt"]
