from __future__ import annotations

import logging
import time
from pathlib import Path

from config import (
    BUFFER_TIME,
    EMBEDDING_DIM,
    OPENAI_API_KEY,
    PROCESS_INTERVAL,
    SUMMARY_MAX_CHARS,
    SUMMARY_TARGET_CHARS,
    TOP_K,
    TRANSCRIPT_DB_PATH,
    TRANSCRIPT_TABLE,
    resolve_min_score,
)
from db.sqlite_reader import SQLiteTranscriptReader
from embedding.embedder import Embedder
from llm.llm_client import LlmClient
from llm.prompt_builder import build_prompt
from memory.buffer import ShortTermBuffer
from memory.summarizer import RollingSummarizer
from memory.vectordb import VectorDB
from processing.processor import Processor
from query.router import route_query
from retrieval.retriever import Retriever

logger = logging.getLogger("meeting_assistant")


def build_system() -> tuple[Processor, ShortTermBuffer, RollingSummarizer, Retriever, LlmClient]:
    db_path = str((Path(__file__).resolve().parent / TRANSCRIPT_DB_PATH).resolve())
    reader = SQLiteTranscriptReader(db_path=db_path, table=TRANSCRIPT_TABLE)
    buffer = ShortTermBuffer(window_seconds=BUFFER_TIME)
    embedder = Embedder(dim=EMBEDDING_DIM)
    vectordb = VectorDB(dim=embedder.dim)
    summarizer = RollingSummarizer(SUMMARY_MAX_CHARS, SUMMARY_TARGET_CHARS)
    processor = Processor(reader, buffer, embedder, vectordb, summarizer)
    min_score = resolve_min_score(embedder.is_semantic)
    if not embedder.is_semantic:
        logger.warning(
            "sentence-transformers unavailable; using the hash fallback embedder "
            "(similarity threshold %.2f)",
            min_score,
        )
    retriever = Retriever(embedder, vectordb, min_score=min_score)
    llm = LlmClient(api_key=OPENAI_API_KEY)
    return processor, buffer, summarizer, retriever, llm


def answer_query(
    query: str,
    buffer: ShortTermBuffer,
    summarizer: RollingSummarizer,
    retriever: Retriever,
    llm: LlmClient,
    meeting_id: str | None = None,
) -> str:
    route = route_query(query)
    if route == "buffer":
        context = buffer.recent_text()
    elif route == "summary":
        context = f"{summarizer.get()}\n\nRecent:\n{buffer.recent_text()}"
    else:
        hits = retriever.search(query, top_k=TOP_K, meeting_id=meeting_id)
        context = "\n---\n".join(hits)

    prompt = build_prompt(context=context, question=query)
    return llm.answer(prompt)


def main() -> None:
    processor, buffer, summarizer, retriever, llm = build_system()
    print("Meeting Assistant started. Type a question, or press Enter to continue ingesting.")
    while True:
        stats = processor.run_once()
        if stats["rows"] > 0:
            print(f'Ingested rows={stats["rows"]}, chunks={stats["chunks"]}')

        try:
            user_query = input("> ").strip()
        except (KeyboardInterrupt, EOFError):
            print("\nStopping.")
            break

        if user_query:
            print(answer_query(user_query, buffer, summarizer, retriever, llm))
        time.sleep(PROCESS_INTERVAL)


if __name__ == "__main__":
    main()
