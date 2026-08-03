from __future__ import annotations

import sys

import numpy as np
import pytest

from memory.vectordb import VectorDB
from retrieval.retriever import Retriever

DIM = 4


@pytest.fixture(params=["faiss", "numpy"])
def backend(request, monkeypatch):
    """Exercise both index backends; faiss is optional so the fallback must match it."""
    if request.param == "numpy":
        # a None entry in sys.modules makes `import faiss` raise ImportError
        monkeypatch.setitem(sys.modules, "faiss", None)
    else:
        pytest.importorskip("faiss")
    return request.param


@pytest.fixture
def new_db(backend):
    return lambda: VectorDB(DIM)


def unit(i: int) -> np.ndarray:
    v = np.zeros(DIM, dtype=np.float32)
    v[i % DIM] = 1.0
    return v


def vecs(*idx: int) -> np.ndarray:
    return np.vstack([unit(i) for i in idx]).astype(np.float32)


def query(i: int) -> np.ndarray:
    return unit(i).reshape(1, DIM)


class StubEmbedder:
    dim = DIM

    def embed_texts(self, texts):
        return np.vstack([unit(len(t)) for t in texts]).astype(np.float32)


@pytest.fixture
def db(new_db):
    d = new_db()
    d.add(
        ["m1 chunk a", "m2 chunk b", "m1 chunk c"],
        vecs(0, 1, 0),
        [{"meeting_id": "m1"}, {"meeting_id": "m2"}, {"meeting_id": "m1"}],
    )
    return d


class TestAdd:
    def test_empty_add_is_ignored(self, new_db):
        d = new_db()
        d.add([], np.empty((0, DIM), dtype=np.float32))
        assert d.texts == [] and d.metas == []

    def test_metas_default_to_empty_dicts(self, new_db):
        d = new_db()
        d.add(["a", "b"], vecs(0, 1))
        assert d.metas == [{}, {}]

    def test_short_meta_list_is_padded_to_stay_aligned(self, new_db):
        d = new_db()
        d.add(["a", "b"], vecs(0, 1), [{"meeting_id": "m1"}])
        assert len(d.metas) == len(d.texts) == 2
        assert d.metas[1] == {}

    def test_metas_stay_aligned_across_multiple_adds(self, db):
        db.add(["m3 chunk d"], vecs(2), [{"meeting_id": "m3"}])
        assert len(db.metas) == len(db.texts) == 4
        assert db.metas[3]["meeting_id"] == "m3"


class TestSearch:
    def test_empty_index_returns_nothing(self, new_db):
        assert new_db().search(query(0), top_k=5) == []

    def test_returns_text_score_and_meta(self, db):
        hits = db.search(query(0), top_k=1)
        text, score, meta = hits[0]
        assert text.startswith("m1")
        assert score == pytest.approx(1.0)
        assert meta["meeting_id"] == "m1"

    def test_unfiltered_search_spans_meetings(self, db):
        found = {meta["meeting_id"] for _t, _s, meta in db.search(query(0), top_k=3)}
        assert found == {"m1", "m2"}

    def test_meeting_filter_excludes_other_meetings(self, db):
        hits = db.search(query(0), top_k=5, meeting_id="m1")
        assert [t for t, _s, _m in hits] == ["m1 chunk a", "m1 chunk c"]

    def test_meeting_filter_with_no_matches(self, db):
        assert db.search(query(0), top_k=5, meeting_id="nope") == []

    def test_top_k_is_respected_under_filtering(self, db):
        assert len(db.search(query(0), top_k=1, meeting_id="m1")) == 1

    def test_non_positive_top_k(self, db):
        assert db.search(query(0), top_k=0) == []

    def test_filter_finds_matches_beyond_the_global_top_k(self, new_db):
        # the target meeting's only chunk ranks last globally; filtering must not
        # silently truncate it away
        d = new_db()
        texts = [f"noise {i}" for i in range(60)] + ["needle"]
        metas = [{"meeting_id": "loud"} for _ in range(60)] + [{"meeting_id": "quiet"}]
        d.add(texts, vecs(*([0] * 60 + [1])), metas)
        hits = d.search(query(1), top_k=3, meeting_id="quiet")
        assert [t for t, _s, _m in hits] == ["needle"]


class TestRetriever:
    def test_search_returns_plain_text(self, db):
        r = Retriever(StubEmbedder(), db)
        assert all(isinstance(t, str) for t in r.search("x" * 4, top_k=2))

    def test_search_detailed_exposes_meta(self, db):
        r = Retriever(StubEmbedder(), db)
        hits = r.search_detailed("x" * 4, top_k=2)
        assert all(len(h) == 3 for h in hits)

    def test_meeting_filter_is_threaded_through(self, db):
        r = Retriever(StubEmbedder(), db)
        hits = r.search_detailed("x" * 4, top_k=5, meeting_id="m2")
        assert {m["meeting_id"] for _t, _s, m in hits} == {"m2"}


class TestSimilarityThreshold:
    """`unit(4) == unit(0)`, so a 4-char query scores 1.0 on the m1 rows and 0.0 on m2."""

    def test_default_keeps_every_hit(self, db):
        r = Retriever(StubEmbedder(), db)
        assert r.min_score == 0.0
        assert len(r.search_detailed("x" * 4, top_k=5)) == 3

    def test_threshold_drops_weak_hits(self, db):
        r = Retriever(StubEmbedder(), db, min_score=0.6)
        hits = r.search_detailed("x" * 4, top_k=5)
        assert [t for t, _s, _m in hits] == ["m1 chunk a", "m1 chunk c"]

    def test_threshold_can_filter_everything_out(self, db):
        r = Retriever(StubEmbedder(), db, min_score=1.5)
        assert r.search_detailed("x" * 4, top_k=5) == []

    def test_boundary_score_is_inclusive(self, db):
        r = Retriever(StubEmbedder(), db, min_score=1.0)
        assert len(r.search_detailed("x" * 4, top_k=5)) == 2

    def test_per_call_override_beats_the_instance_default(self, db):
        r = Retriever(StubEmbedder(), db, min_score=0.6)
        assert len(r.search_detailed("x" * 4, top_k=5, min_score=0.0)) == 3

    def test_threshold_applies_after_the_meeting_filter(self, db):
        r = Retriever(StubEmbedder(), db, min_score=0.6)
        assert r.search_detailed("x" * 4, top_k=5, meeting_id="m2") == []

    def test_plain_search_honours_the_threshold(self, db):
        r = Retriever(StubEmbedder(), db, min_score=0.6)
        assert r.search("x" * 4, top_k=5) == ["m1 chunk a", "m1 chunk c"]
