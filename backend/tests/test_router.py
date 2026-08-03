from __future__ import annotations

import pytest

from query.router import route_query


@pytest.mark.parametrize(
    "query",
    ["what did he say just now", "the recent discussion", "latest update", "what is happening now"],
)
def test_recency_words_route_to_buffer(query):
    assert route_query(query) == "buffer"


@pytest.mark.parametrize(
    "query",
    ["what have we covered so far", "give me a summary", "overall impression", "quick recap please"],
)
def test_summary_words_route_to_summary(query):
    assert route_query(query) == "summary"


def test_everything_else_routes_to_retrieval():
    assert route_query("what did Majid say about diffusion models") == "retrieval"
    assert route_query("") == "retrieval"


def test_routing_is_case_insensitive():
    assert route_query("SUMMARY So Far") == "summary"
    assert route_query("JUST NOW") == "buffer"


def test_buffer_wins_when_both_kinds_of_keyword_appear():
    # documents current precedence: the buffer check runs first
    assert route_query("summary of what happened just now") == "buffer"


def test_substring_matches_count():
    # "now" matches inside "knowledge" — known over-eager behaviour, pinned so a
    # future word-boundary fix is a deliberate change rather than a surprise
    assert route_query("what knowledge base do we use") == "buffer"
