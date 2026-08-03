from __future__ import annotations

from processing.cleaner import clean_stable_sentences


def test_drops_growing_partial_captions():
    # live captions arrive as a growing prefix; only the final form should survive
    lines = [
        "Alice: we should",
        "Alice: we should prioritise",
        "Alice: we should prioritise the pipeline",
    ]
    assert clean_stable_sentences(lines) == ["Alice: we should"]


def test_keeps_distinct_utterances():
    lines = ["Alice: budget approved", "Bob: migration script is ready"]
    assert clean_stable_sentences(lines) == lines


def test_drops_near_duplicates_above_threshold():
    lines = ["Alice: the quarterly report is ready", "Alice: the quarterly report is readyy"]
    assert clean_stable_sentences(lines) == ["Alice: the quarterly report is ready"]


def test_threshold_is_configurable():
    lines = ["Alice: alpha beta gamma", "Alice: alpha beta delta"]
    assert len(clean_stable_sentences(lines, sim_threshold=0.99)) == 2
    assert len(clean_stable_sentences(lines, sim_threshold=0.5)) == 1


def test_normalizes_whitespace_and_skips_blanks():
    assert clean_stable_sentences(["  Alice:   hello   there  ", "   ", ""]) == ["Alice: hello there"]


def test_empty_input():
    assert clean_stable_sentences([]) == []


def test_dedup_is_only_against_the_immediately_preceding_line():
    # A/B/A interleaving: the repeat of A is not adjacent, so it survives
    lines = ["Alice: same text here", "Bob: different", "Alice: same text here"]
    assert clean_stable_sentences(lines) == lines
