from __future__ import annotations


def route_query(query: str) -> str:
    q = query.lower()
    if any(k in q for k in ("just now", "recent", "latest", "now")):
        return "buffer"
    if any(k in q for k in ("so far", "summary", "overall", "recap")):
        return "summary"
    return "retrieval"
