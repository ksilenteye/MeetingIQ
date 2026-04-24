from __future__ import annotations

from typing import List, Tuple

import numpy as np


class VectorDB:
    def __init__(self, dim: int) -> None:
        self.dim = dim
        self.texts: List[str] = []
        self._index = None
        self._vectors = np.empty((0, dim), dtype=np.float32)
        try:
            import faiss  # type: ignore

            self._index = faiss.IndexFlatIP(dim)
        except Exception:
            self._index = None

    def add(self, texts: List[str], vectors: np.ndarray) -> None:
        if len(texts) == 0:
            return
        self.texts.extend(texts)
        if self._index is not None:
            self._index.add(vectors)
        else:
            self._vectors = np.vstack([self._vectors, vectors])

    def search(self, query_vec: np.ndarray, top_k: int = 5) -> List[Tuple[str, float]]:
        if len(self.texts) == 0:
            return []
        if self._index is not None:
            scores, ids = self._index.search(query_vec, min(top_k, len(self.texts)))
            return [
                (self.texts[idx], float(score))
                for score, idx in zip(scores[0], ids[0])
                if idx >= 0
            ]

        sims = (self._vectors @ query_vec[0].T).reshape(-1)
        top_ids = np.argsort(-sims)[:top_k]
        return [(self.texts[i], float(sims[i])) for i in top_ids]
