from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

import numpy as np

Hit = Tuple[str, float, Dict[str, Any]]

# When filtering by meeting, FAISS can only be asked for the global top-N, so
# over-fetch and filter afterwards.
_FILTER_OVERFETCH = 10
_FILTER_MIN_FETCH = 50


class VectorDB:
    def __init__(self, dim: int) -> None:
        self.dim = dim
        self.texts: List[str] = []
        self.metas: List[Dict[str, Any]] = []
        self._index = None
        self._vectors = np.empty((0, dim), dtype=np.float32)
        try:
            import faiss  # type: ignore

            self._index = faiss.IndexFlatIP(dim)
        except Exception:
            self._index = None

    def add(
        self,
        texts: List[str],
        vectors: np.ndarray,
        metas: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        if len(texts) == 0:
            return
        self.texts.extend(texts)
        if metas is None:
            metas = [{} for _ in texts]
        # keep metas index-aligned with texts even if a caller passes too few
        if len(metas) < len(texts):
            metas = list(metas) + [{} for _ in range(len(texts) - len(metas))]
        self.metas.extend(metas[: len(texts)])
        if self._index is not None:
            self._index.add(vectors)
        else:
            self._vectors = np.vstack([self._vectors, vectors])

    def search(
        self,
        query_vec: np.ndarray,
        top_k: int = 5,
        meeting_id: Optional[str] = None,
    ) -> List[Hit]:
        """Nearest chunks as (text, score, meta), optionally restricted to one meeting."""
        if len(self.texts) == 0 or top_k <= 0:
            return []
        if self._index is not None:
            return self._search_faiss(query_vec, top_k, meeting_id)
        return self._search_numpy(query_vec, top_k, meeting_id)

    def _matches(self, idx: int, meeting_id: Optional[str]) -> bool:
        if meeting_id is None:
            return True
        return self.metas[idx].get("meeting_id") == meeting_id

    def _search_faiss(self, query_vec: np.ndarray, top_k: int, meeting_id: Optional[str]) -> List[Hit]:
        fetch = top_k if meeting_id is None else max(top_k * _FILTER_OVERFETCH, _FILTER_MIN_FETCH)
        fetch = min(fetch, len(self.texts))
        scores, ids = self._index.search(query_vec, fetch)
        matched: List[Tuple[float, int]] = []
        for score, idx in zip(scores[0], ids[0]):
            i = int(idx)
            if i < 0 or i >= len(self.texts):
                continue
            if not self._matches(i, meeting_id):
                continue
            matched.append((float(score), i))
        # break ties by insertion order so results do not depend on whether FAISS
        # is installed — the numpy fallback sorts stably
        matched.sort(key=lambda pair: (-pair[0], pair[1]))
        return [(self.texts[i], score, self.metas[i]) for score, i in matched[:top_k]]

    def _search_numpy(self, query_vec: np.ndarray, top_k: int, meeting_id: Optional[str]) -> List[Hit]:
        sims = (self._vectors @ np.asarray(query_vec)[0].T).reshape(-1)
        candidates = [i for i in range(len(self.texts)) if self._matches(i, meeting_id)]
        if not candidates:
            return []
        idx = np.asarray(candidates)
        # stable sort so equally-scoring chunks come back in insertion (chronological)
        # order rather than an arbitrary one
        order = idx[np.argsort(-sims[idx], kind="stable")][:top_k]
        return [(self.texts[int(i)], float(sims[int(i)]), self.metas[int(i)]) for i in order]
