from __future__ import annotations

from typing import List

from embedding.embedder import Embedder
from memory.vectordb import VectorDB


class Retriever:
    def __init__(self, embedder: Embedder, vectordb: VectorDB) -> None:
        self.embedder = embedder
        self.vectordb = vectordb

    def search(self, query: str, top_k: int = 5) -> List[str]:
        qvec = self.embedder.embed_texts([query])
        results = self.vectordb.search(qvec, top_k=top_k)
        return [text for text, _score in results]
