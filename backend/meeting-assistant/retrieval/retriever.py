from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from embedding.embedder import Embedder
from memory.vectordb import VectorDB


class Retriever:
    """
    Embed a query and pull the closest chunks out of the index.

    ``min_score`` drops hits whose cosine similarity falls below it. It is 0.0
    (keep everything) unless a caller supplies one; ``build_system()`` is where
    the MA_SIMILARITY_THRESHOLD policy is decided, because that is the only
    place that knows whether the embedder produces comparable scores.
    """

    def __init__(
        self,
        embedder: Embedder,
        vectordb: VectorDB,
        min_score: float = 0.0,
    ) -> None:
        self.embedder = embedder
        self.vectordb = vectordb
        self.min_score = float(min_score)

    def search(self, query: str, top_k: int = 5, meeting_id: Optional[str] = None) -> List[str]:
        return [text for text, _score, _meta in self.search_detailed(query, top_k, meeting_id)]

    def search_detailed(
        self,
        query: str,
        top_k: int = 5,
        meeting_id: Optional[str] = None,
        min_score: Optional[float] = None,
    ) -> List[Tuple[str, float, Dict[str, Any]]]:
        threshold = self.min_score if min_score is None else float(min_score)
        qvec = self.embedder.embed_texts([query])
        hits = self.vectordb.search(qvec, top_k=top_k, meeting_id=meeting_id)
        if threshold <= 0.0:
            return hits
        return [hit for hit in hits if hit[1] >= threshold]
