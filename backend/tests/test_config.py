from __future__ import annotations

import config
import pytest

from embedding.embedder import Embedder


@pytest.fixture
def threshold(monkeypatch):
    """Set (value, explicitly_set_by_user) on the config module."""

    def apply(value: float, explicit: bool):
        monkeypatch.setattr(config, "SIMILARITY_THRESHOLD", value)
        monkeypatch.setattr(config, "SIMILARITY_THRESHOLD_EXPLICIT", explicit)

    return apply


class TestResolveMinScore:
    def test_semantic_embedder_gets_the_configured_threshold(self, threshold):
        threshold(0.6, False)
        assert config.resolve_min_score(True) == 0.6

    def test_hash_fallback_disables_an_unset_threshold(self, threshold):
        # 0.6 against near-orthogonal hash vectors would return nothing at all
        threshold(0.6, False)
        assert config.resolve_min_score(False) == 0.0

    def test_explicit_env_var_applies_even_to_the_hash_fallback(self, threshold):
        threshold(0.25, True)
        assert config.resolve_min_score(False) == 0.25

    def test_explicit_zero_stays_zero(self, threshold):
        threshold(0.0, True)
        assert config.resolve_min_score(True) == 0.0


class TestEmbedderIsSemantic:
    def test_hash_fallback_reports_not_semantic(self, monkeypatch):
        monkeypatch.setattr(Embedder, "__init__", _hash_only_init)
        assert Embedder(dim=8).is_semantic is False

    def test_hash_vectors_score_near_zero_against_each_other(self, monkeypatch):
        """The reason resolve_min_score exists — proven, not assumed."""
        monkeypatch.setattr(Embedder, "__init__", _hash_only_init)
        e = Embedder(dim=384)
        a, b = e.embed_texts(["the hiring budget was approved", "what did we decide about hiring?"])
        assert abs(float(a @ b)) < 0.3
        same = e.embed_texts(["identical text", "identical text"])
        assert float(same[0] @ same[1]) == pytest.approx(1.0, abs=1e-5)


def _hash_only_init(self, dim: int = 384) -> None:
    """Embedder.__init__ with the sentence-transformers probe skipped."""
    self.dim = dim
    self._model = None
