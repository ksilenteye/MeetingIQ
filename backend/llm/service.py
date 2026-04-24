from __future__ import annotations

import os
import re
import logging
from typing import Any, Dict, List, Optional, Tuple

from llm.registry import get_provider

logger = logging.getLogger("meet_transcript.llm")

MAX_CONTEXT_CHARS = 120_000

SUMMARIZE_SYSTEM = """You are an expert at summarizing meeting transcripts.
Produce a concise, accurate summary of the discussion. Use bullet points if helpful.
Focus on decisions, key topics, and action items if present."""


QA_SYSTEM = """You answer questions using ONLY the provided meeting transcript as context.
If the answer is not supported by the transcript, say you cannot find it in the transcript.
Be concise and cite speaker names when relevant."""


def format_transcript_block(lines: List[Dict[str, Any]]) -> str:
    parts = []
    for row in lines:
        sp = row.get("speaker") or "Unknown"
        ts = row.get("timestamp") or ""
        tx = (row.get("text") or "").strip()
        if not tx:
            continue
        parts.append(f"{sp} ({ts}): {tx}")
    text = "\n".join(parts)
    if len(text) > MAX_CONTEXT_CHARS:
        text = "(Earlier content omitted for length.)\n" + text[-MAX_CONTEXT_CHARS:]
    return text


def resolve_api_key(provider_id: str, api_key: Optional[str]) -> str:
    if api_key and str(api_key).strip():
        return str(api_key).strip()
    env_names = {
        "openai": ("OPENAI_API_KEY",),
        "groq": ("GROQ_API_KEY",),
        "gemini": ("GOOGLE_API_KEY", "GEMINI_API_KEY"),
    }
    for env in env_names.get(provider_id, ()):
        v = os.getenv(env)
        if v:
            return v.strip()
    return ""


def _fallback_summarize(lines: List[Dict[str, Any]]) -> str:
    if not lines:
        return "No transcript content yet for this meeting."
    tail = lines[-12:]
    merged = " ".join(x["text"] for x in tail if x.get("text"))
    chunks = [c.strip() for c in re.split(r"(?<=[.!?])\s+", merged) if c.strip()]
    if not chunks:
        return merged[:800] + ("…" if len(merged) > 800 else "")
    return " ".join(chunks[:6])


def _fallback_qa(lines: List[Dict[str, Any]], question: str) -> str:
    if not lines:
        return "No transcript available yet to answer from."
    q = (question or "").lower()
    terms = {w for w in re.findall(r"[a-zA-Z]{3,}", q)}
    if not terms:
        return "Please ask a longer question."
    scored: List[tuple[int, str]] = []
    for row in lines:
        t = (row.get("text") or "").lower()
        score = sum(1 for term in terms if term in t)
        if score:
            scored.append((score, f'{row.get("speaker")}: {row.get("text")}'))
    if not scored:
        return "I could not find a direct answer in the current transcript context."
    scored.sort(key=lambda x: x[0], reverse=True)
    return "Based on transcript: " + " | ".join(s[:2] for s in scored[:3])


def run_llm_action(
    *,
    lines: List[Dict[str, Any]],
    action: str,
    question: Optional[str],
    provider_id: str,
    api_key: Optional[str],
    model: Optional[str],
    allow_fallback: bool = True,
) -> Tuple[str, bool]:
    """
    Returns (result_text, used_llm).
    """
    action = (action or "").strip().lower()
    pid = (provider_id or "openai").strip().lower()
    key = resolve_api_key(pid, api_key)

    transcript = format_transcript_block(lines)
    if not transcript.strip():
        msg = "No transcript lines available for this meeting."
        return msg, False

    if not key:
        if allow_fallback:
            if action == "summarize":
                return _fallback_summarize(lines), False
            if action == "qa":
                return _fallback_qa(lines, question or ""), False
        return (
            "No API key configured. Set it in the UI or use environment variables: "
            "OPENAI_API_KEY, GROQ_API_KEY, or GOOGLE_API_KEY / GEMINI_API_KEY.",
            False,
        )

    try:
        provider = get_provider(pid)
    except ValueError as e:
        return str(e), False

    try:
        if action == "summarize":
            user = (
                "Here is the meeting transcript.\n\n"
                f"{transcript}\n\n"
                "Provide a clear summary."
            )
            out = provider.complete(
                api_key=key,
                model=model,
                system_prompt=SUMMARIZE_SYSTEM,
                user_prompt=user,
            )
            return out, True

        if action == "qa":
            q = (question or "").strip()
            if not q:
                return "Please enter a question for Q&A.", False
            user = (
                "Transcript:\n"
                f"{transcript}\n\n"
                f"Question: {q}\n\n"
                "Answer using only the transcript above."
            )
            out = provider.complete(
                api_key=key,
                model=model,
                system_prompt=QA_SYSTEM,
                user_prompt=user,
            )
            return out, True

        return "Unsupported action. Use summarize or qa.", False
    except Exception as exc:
        logger.exception("LLM call failed: %s", exc)
        return f"LLM request failed: {exc}", False
