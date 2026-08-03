from __future__ import annotations

import hashlib
from typing import List

import numpy as np


class Embedder:
    def __init__(self, dim: int = 384) -> None:
        self.dim = dim
        self._model = None
        try:
            from sentence_transformers import SentenceTransformer  # type: ignore

            self._model = SentenceTransformer("all-MiniLM-L6-v2")
            self.dim = self._model.get_sentence_embedding_dimension()
        except Exception:
            self._model = None

    @property
    def is_semantic(self) -> bool:
        """
        True when a real sentence-transformers model is loaded.

        The hash fallback below is deterministic but not semantic: two different
        sentences hash to near-orthogonal vectors, so their cosine similarity sits
        around 0 no matter how related they are. Callers that compare scores
        against a similarity threshold must check this first.
        """
        return self._model is not None

    def embed_texts(self, texts: List[str]) -> np.ndarray:
        if not texts:
            return np.empty((0, self.dim), dtype=np.float32)

        if self._model is not None:
            vecs = self._model.encode(texts, normalize_embeddings=True)
            return np.asarray(vecs, dtype=np.float32)

        out = np.zeros((len(texts), self.dim), dtype=np.float32)
        for i, text in enumerate(texts):
            h = hashlib.sha256(text.encode("utf-8")).digest()
            ints = np.frombuffer(h * ((self.dim // len(h)) + 1), dtype=np.uint8)[: self.dim]
            v = (ints.astype(np.float32) / 255.0) - 0.5
            norm = float(np.linalg.norm(v)) or 1.0
            out[i] = v / norm
        return out
