from __future__ import annotations


def build_prompt(context: str, question: str) -> str:
    return (
        "You are a meeting assistant. Answer with concise, factual output.\n\n"
        f"Context:\n{context}\n\n"
        f"Question:\n{question}\n"
    )
