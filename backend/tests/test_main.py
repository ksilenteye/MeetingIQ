"""
Tests for the FastAPI layer.

These only became possible once bootstrap moved into the ASGI lifespan —
importing `main` used to open the database, load an embedding model and replay
the whole transcript backlog. `test_import_has_no_side_effects` guards that.

The meeting-assistant runtime is stubbed rather than built for real: MiniLM
takes seconds to load and is exercised end-to-end elsewhere. What is under test
here is main.py's own plumbing — persistence, migration, routing, fallbacks.
"""
from __future__ import annotations

import io
import json
import sqlite3
import subprocess
import sys
import textwrap
import zipfile
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
from fastapi.testclient import TestClient

import main

BACKEND = Path(main.__file__).resolve().parent

LEGACY_RAG_SCHEMA = """
    CREATE TABLE rag_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meeting_id TEXT NOT NULL,
        chunk_text TEXT NOT NULL,
        embedding_json TEXT NOT NULL,
        dim INTEGER NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
    )
"""


@pytest.fixture
def db_path(tmp_path, monkeypatch):
    """Point main at a scratch database and reset its module-level state."""
    path = tmp_path / "test.db"
    monkeypatch.setenv("TRANSCRIPT_DB_PATH", str(path))
    monkeypatch.setattr(main, "DB_PATH", path)
    monkeypatch.setattr(main, "_db", None)
    monkeypatch.setattr(main, "_bootstrapped", False)
    monkeypatch.setattr(main, "assistant_runtime", None)
    monkeypatch.setattr(main, "assistant_background_task", None)
    try:
        yield path
    finally:
        # Windows will not delete tmp_path while the handle is open
        if main._db is not None:
            main._db.close()


@pytest.fixture
def no_assistant(monkeypatch):
    monkeypatch.setattr(main, "setup_meeting_assistant", lambda: False)


@pytest.fixture
def client(db_path, no_assistant):
    with TestClient(main.app) as c:
        yield c


def rows(path: Path, sql: str, *args):
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    try:
        return con.execute(sql, args).fetchall()
    finally:
        con.close()


def item(text: str, speaker: str = "Alice", ts: str = "2026-07-30T10:00:00Z"):
    return {"timestamp": ts, "speaker": speaker, "text": text}


# --------------------------------------------------------------------------- #
# import-time behaviour (the point of the lifespan refactor)
# --------------------------------------------------------------------------- #


def test_import_has_no_side_effects(tmp_path):
    """Importing main must not open the DB, load a model, or backfill."""
    probe = tmp_path / "untouched.db"
    script = textwrap.dedent(
        f"""
        import os, sys, types
        os.environ["TRANSCRIPT_DB_PATH"] = {str(probe)!r}
        for name, attrs in (("openai", {{"OpenAI": object}}), ("google", {{}}),
                            ("google.generativeai", {{}})):
            try:
                __import__(name)
            except ImportError:
                m = types.ModuleType(name)
                for k, v in attrs.items():
                    setattr(m, k, v)
                sys.modules[name] = m
        sys.path.insert(0, {str(BACKEND)!r})
        import main
        print(main._db is None, main.assistant_runtime is None, main._bootstrapped,
              "sentence_transformers" in sys.modules, os.path.exists({str(probe)!r}))
        """
    )
    out = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, text=True, cwd=str(BACKEND)
    )
    assert out.returncode == 0, out.stderr
    assert out.stdout.split() == ["True", "True", "False", "False", "False"], out.stdout


def test_bootstrap_is_idempotent(db_path, no_assistant, monkeypatch):
    calls = []
    real_init = main.init_db
    monkeypatch.setattr(main, "init_db", lambda: (calls.append(1), real_init())[1])
    main.bootstrap()
    main.bootstrap()
    assert calls == [1]


def test_bootstrap_creates_every_table(db_path, no_assistant):
    main.bootstrap()
    names = {r[0] for r in rows(db_path, "SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"transcripts", "llm_history", "rag_chunks", "rag_state"} <= names


def test_bootstrap_survives_an_assistant_that_fails_to_load(db_path, monkeypatch):
    monkeypatch.setattr(main, "setup_meeting_assistant", lambda: False)
    main.bootstrap()
    assert main._bootstrapped is True


def test_db_path_is_resolved_at_first_use_not_at_import(tmp_path, monkeypatch):
    moved = tmp_path / "moved.db"
    monkeypatch.setenv("TRANSCRIPT_DB_PATH", str(moved))
    monkeypatch.setattr(main, "_db", None)
    monkeypatch.setattr(main, "DB_PATH", Path("stale.db"))
    try:
        main.get_db().execute("SELECT 1")
        assert main.DB_PATH == moved and moved.exists()
    finally:
        main._db.close()


# --------------------------------------------------------------------------- #
# transcript endpoints
# --------------------------------------------------------------------------- #


class TestTranscripts:
    def test_post_stores_and_echoes_the_count(self, client, db_path):
        r = client.post("/transcript", json={"meeting_id": "m1", "items": [item("hello"), item("world")]})
        assert r.status_code == 200
        assert r.json()["accepted"] == 2
        assert len(rows(db_path, "SELECT * FROM transcripts")) == 2

    def test_empty_batch_is_accepted_and_stores_nothing(self, client, db_path):
        assert client.post("/transcript", json={"meeting_id": "m1", "items": []}).json()["accepted"] == 0
        assert rows(db_path, "SELECT * FROM transcripts") == []

    def test_get_returns_rows_oldest_first(self, client):
        client.post("/transcript", json={"meeting_id": "m1", "items": [item("first"), item("second")]})
        got = client.get("/api/transcripts", params={"meeting_id": "m1"}).json()["items"]
        assert [i["text"] for i in got] == ["first", "second"]

    def test_get_is_scoped_to_one_meeting(self, client):
        client.post("/transcript", json={"meeting_id": "m1", "items": [item("mine")]})
        client.post("/transcript", json={"meeting_id": "m2", "items": [item("theirs")]})
        got = client.get("/api/transcripts", params={"meeting_id": "m1"}).json()["items"]
        assert [i["text"] for i in got] == ["mine"]

    def test_limit_keeps_the_most_recent_rows(self, client):
        client.post(
            "/transcript",
            json={"meeting_id": "m1", "items": [item(f"line {i}") for i in range(5)]},
        )
        got = client.get("/api/transcripts", params={"meeting_id": "m1", "limit": 2}).json()["items"]
        assert [i["text"] for i in got] == ["line 3", "line 4"]

    def test_meetings_listing_counts_items(self, client):
        client.post("/transcript", json={"meeting_id": "m1", "items": [item("a"), item("b")]})
        client.post("/transcript", json={"meeting_id": "m2", "items": [item("c")]})
        counts = {m["meeting_id"]: m["item_count"] for m in client.get("/api/meetings").json()["items"]}
        assert counts == {"m1": 2, "m2": 1}

    def test_malformed_batch_is_rejected(self, client):
        assert client.post("/transcript", json={"items": []}).status_code == 422

    def test_websocket_receives_the_batch(self, client):
        with client.websocket_connect("/ws/transcripts") as ws:
            client.post("/transcript", json={"meeting_id": "m1", "items": [item("live")]})
            msg = ws.receive_json()
        assert msg["type"] == "transcript_batch"
        assert msg["meeting_id"] == "m1"
        assert [i["text"] for i in msg["items"]] == ["live"]


class TestRequestId:
    def test_generated_when_absent(self, client):
        r = client.get("/health")
        assert r.headers["X-Request-ID"]

    def test_client_supplied_id_is_echoed(self, client):
        r = client.post(
            "/transcript",
            json={"meeting_id": "m1", "items": [item("x")]},
            headers={"x-request-id": "abc-123"},
        )
        assert r.headers["X-Request-ID"] == "abc-123"
        assert r.json()["request_id"] == "abc-123"


class TestHealth:
    def test_reports_the_assistant_as_down_when_it_failed_to_load(self, client):
        body = client.get("/health").json()
        assert body["status"] == "ok"
        assert body["meeting_assistant_ready"] is False

    def test_assistant_endpoints_refuse_without_a_runtime(self, client):
        assert client.get("/api/assistant/status").json() == {"ready": False}
        assert client.post("/api/assistant/query", json={"query": "hi"}).json()["ok"] is False
        assert client.post("/api/assistant/ingest").json()["ok"] is False


# --------------------------------------------------------------------------- #
# dashboard read models
#
# Every figure the dashboard shows is counted from rows. These pin the counting
# rules, because a stat tile that silently starts estimating is indistinguishable
# from one that is right.
# --------------------------------------------------------------------------- #


class TestPages:
    def test_root_serves_the_landing_page(self, client):
        body = client.get("/").text
        assert "Smarter Meetings" in body
        assert '/app' in body  # the CTA into the dashboard

    def test_app_serves_the_dashboard(self, client):
        assert 'data-view="dashboard"' in client.get("/app").text

    def test_static_assets_are_mounted(self, client):
        assert client.get("/static/css/theme.css").status_code == 200
        assert client.get("/static/js/app.js").status_code == 200


class TestDemoVideo:
    """
    Never points at the real recording — it is ~1 GB, and a test that reads it
    would dominate the suite's runtime.
    """

    @pytest.fixture
    def stub_video(self, tmp_path, monkeypatch):
        path = tmp_path / "DEMO.mp4"
        path.write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"payload" * 100)
        monkeypatch.setattr(main, "DEMO_VIDEO", path)
        return path

    def test_serves_the_file_as_video(self, client, stub_video):
        r = client.get("/demo.mp4")
        assert r.status_code == 200
        assert r.headers["content-type"] == "video/mp4"
        assert r.content == stub_video.read_bytes()

    def test_range_requests_are_supported(self, client, stub_video):
        """The moov atom is at the end of the real file, so the browser seeks."""
        r = client.get("/demo.mp4", headers={"Range": "bytes=0-7"})
        assert r.status_code == 206
        assert r.content == b"\x00\x00\x00\x18"[:4] + b"ftyp"
        assert r.headers["content-range"].startswith("bytes 0-7/")

    def test_missing_file_404s_instead_of_erroring(self, client, tmp_path, monkeypatch):
        monkeypatch.setattr(main, "DEMO_VIDEO", tmp_path / "absent.mp4")
        assert client.get("/demo.mp4").status_code == 404

    def test_health_reports_availability(self, client, stub_video):
        assert client.get("/health").json()["demo_video_available"] is True


class TestMeetingListing:
    def test_duration_spans_first_to_last_caption(self, client):
        client.post(
            "/transcript",
            json={
                "meeting_id": "m1",
                "items": [
                    item("start", ts="2026-07-30T10:00:00Z"),
                    item("end", speaker="Bob", ts="2026-07-30T10:45:00Z"),
                ],
            },
        )
        m = client.get("/api/meetings").json()["items"][0]
        assert m["duration_seconds"] == 45 * 60
        assert m["speaker_count"] == 2
        assert sorted(m["speakers"]) == ["Alice", "Bob"]

    def test_unparseable_timestamps_yield_zero_not_an_error(self, client):
        client.post(
            "/transcript",
            json={"meeting_id": "m1", "items": [item("x", ts="not-a-date")]},
        )
        assert client.get("/api/meetings").json()["items"][0]["duration_seconds"] == 0


class TestStats:
    def test_counts_rows_and_sums_each_meeting_span_separately(self, client):
        for meeting in ("m1", "m2"):
            client.post(
                "/transcript",
                json={
                    "meeting_id": meeting,
                    "items": [
                        item("a", ts="2026-07-30T10:00:00Z"),
                        item("b", speaker="Bob", ts="2026-07-30T10:10:00Z"),
                    ],
                },
            )
        body = client.get("/api/stats").json()
        assert body["total_meetings"] == 2
        assert body["total_lines"] == 4
        assert body["total_speakers"] == 2
        # the two meetings overlap in wall-clock time and still count once each
        assert body["captured_seconds"] == 2 * 600

    def test_empty_database_reports_zeroes(self, client):
        body = client.get("/api/stats").json()
        assert body["total_meetings"] == 0
        assert body["captured_seconds"] == 0
        assert body["indexed_chunks"] == 0


class TestInsights:
    def test_speaker_shares_are_relative_to_the_returned_rows(self, client):
        client.post(
            "/transcript",
            json={
                "meeting_id": "m1",
                "items": [item("one two three four"), item("five", speaker="Bob")],
            },
        )
        speakers = {s["speaker"]: s for s in client.get("/api/insights").json()["speakers"]}
        assert speakers["Alice"]["words"] == 4
        assert speakers["Bob"]["words"] == 1
        assert round(sum(s["share"] for s in speakers.values())) == 100

    def test_meeting_id_scopes_every_section(self, client):
        client.post("/transcript", json={"meeting_id": "m1", "items": [item("mine")]})
        client.post(
            "/transcript",
            json={"meeting_id": "m2", "items": [item("theirs", speaker="Bob")]},
        )
        body = client.get("/api/insights", params={"meeting_id": "m1"}).json()
        assert [s["speaker"] for s in body["speakers"]] == ["Alice"]


class TestActionItems:
    def summarised(self, client, result, meeting_id="m1"):
        main.save_llm_history(meeting_id, "summarize", None, result, used_llm=True)

    def test_bullets_under_an_action_heading_are_taken_verbatim(self, client):
        self.summarised(
            client,
            "Key points\n- we shipped the thing\n\nAction Items\n- Alex: send the deck\n- book a room\n",
        )
        items = client.get("/api/action-items").json()["items"]
        texts = [i["text"] for i in items]
        assert "Alex: send the deck" in texts
        assert "book a room" in texts
        # a blank line inside the section must not close it
        assert all(i["source"] == "section" for i in items if i["text"] == "book a room")

    def test_bullets_elsewhere_need_action_phrasing(self, client):
        self.summarised(client, "Notes\n- the weather was fine\n- Priya will prepare the report\n")
        items = client.get("/api/action-items").json()["items"]
        assert [i["text"] for i in items] == ["Priya will prepare the report"]
        assert items[0]["source"] == "heuristic"
        assert items[0]["owner"] == "Priya"

    def test_a_later_heading_closes_the_action_section(self, client):
        self.summarised(client, "Action Items\n- send the deck\n\nAttendees\n- the weather was fine\n")
        assert [i["text"] for i in client.get("/api/action-items").json()["items"]] == [
            "send the deck"
        ]

    def test_only_the_newest_summary_per_meeting_is_used(self, client):
        self.summarised(client, "Action Items\n- old task\n")
        self.summarised(client, "Action Items\n- new task\n")
        assert [i["text"] for i in client.get("/api/action-items").json()["items"]] == ["new task"]

    def test_qa_history_is_never_mined_for_actions(self, client):
        main.save_llm_history("m1", "qa", "what next?", "- Priya will send the deck")
        assert client.get("/api/action-items").json()["items"] == []

    def test_no_summaries_means_an_empty_list(self, client):
        client.post("/transcript", json={"meeting_id": "m1", "items": [item("hello")]})
        assert client.get("/api/action-items").json()["items"] == []


# --------------------------------------------------------------------------- #
# extension packaging
#
# The zip is stamped with the origin that served it, so these guard the one
# failure that is invisible from the server: a build that still points at
# localhost installs cleanly on the visitor's machine and captures nothing.
# --------------------------------------------------------------------------- #


HOSTED = {"host": "demo.onrender.com", "x-forwarded-proto": "https"}


def zip_of(response):
    return zipfile.ZipFile(io.BytesIO(response.content))


class TestExtensionZip:
    def test_serves_a_valid_zip_as_an_attachment(self, client):
        r = client.get("/api/extension.zip")
        assert r.status_code == 200
        assert r.headers["content-type"] == "application/zip"
        assert "meetingiq-extension.zip" in r.headers["content-disposition"]
        assert zip_of(r).testzip() is None

    def test_contains_every_runtime_file_at_the_root(self, client):
        names = set(zip_of(client.get("/api/extension.zip")).namelist())
        assert {
            "manifest.json", "background.js", "content.js", "utils.js",
            "caption-heuristics.js", "popup.html", "popup.js",
            "icons/icon16.png", "styles/inject.css", "LOAD-ME-FIRST.txt",
        } <= names

    def test_excludes_the_test_suite(self, client):
        names = zip_of(client.get("/api/extension.zip")).namelist()
        assert not [n for n in names if n.startswith("tests/") or n.endswith(".test.mjs")]

    def test_archive_paths_never_use_backslashes(self, client):
        # str(PurePath) on Windows would emit "icons\icon16.png", which unzip
        # tools read as a filename rather than a path, and Chrome then cannot
        # find the icons. zipfile round-trips it happily, so only this catches it.
        names = zip_of(client.get("/api/extension.zip")).namelist()
        assert not [n for n in names if "\\" in n]

    def test_api_url_follows_the_forwarded_origin(self, client):
        js = zip_of(client.get("/api/extension.zip", headers=HOSTED)).read("background.js").decode()
        assert "const API_URL = 'https://demo.onrender.com/transcript';" in js
        assert "localhost:8000" not in js

    def test_manifest_gains_the_origin_and_keeps_the_others(self, client):
        raw = zip_of(client.get("/api/extension.zip", headers=HOSTED)).read("manifest.json")
        perms = json.loads(raw)["host_permissions"]
        assert "https://demo.onrender.com/*" in perms   # or MV3 blocks the POST
        assert "https://meet.google.com/*" in perms     # or the content script never runs
        assert "http://localhost:8000/*" in perms       # local dev still works

    def test_popup_copy_is_rewritten_too(self, client):
        html = zip_of(client.get("/api/extension.zip", headers=HOSTED)).read("popup.html").decode()
        assert "https://demo.onrender.com/transcript" in html
        assert "localhost:8000" not in html

    def test_instructions_name_the_resolved_backend(self, client):
        txt = zip_of(client.get("/api/extension.zip", headers=HOSTED)).read("LOAD-ME-FIRST.txt")
        assert "https://demo.onrender.com/transcript" in txt.decode()

    def test_a_local_download_still_points_at_the_local_server(self, client):
        js = zip_of(client.get("/api/extension.zip")).read("background.js").decode()
        assert "http://testserver/transcript" in js

    def test_public_base_url_overrides_the_request(self, client, monkeypatch):
        monkeypatch.setenv("PUBLIC_BASE_URL", "https://pinned.example/")
        js = zip_of(client.get("/api/extension.zip")).read("background.js").decode()
        assert "'https://pinned.example/transcript'" in js

    def test_render_external_url_is_used_when_present(self, client, monkeypatch):
        monkeypatch.setenv("RENDER_EXTERNAL_URL", "https://svc.onrender.com")
        js = zip_of(client.get("/api/extension.zip")).read("background.js").decode()
        assert "'https://svc.onrender.com/transcript'" in js

    def test_a_hostile_host_header_is_refused(self, client):
        # the host lands in a JS string literal, so it is validated not trusted
        r = client.get("/api/extension.zip", headers={"host": "a'+fetch('//evil')+'b"})
        assert r.status_code == 400

    def test_builds_are_byte_identical(self, client):
        assert client.get("/api/extension.zip").content == client.get("/api/extension.zip").content


class TestExtensionRewriteGuards:
    """A silently-skipped rewrite ships a zip pointing at localhost, so every
    rewrite fails loudly instead."""

    def test_the_real_sources_still_match_every_marker(self):
        # the highest-value test here: editing background.js or popup.html and
        # dropping the marker becomes a red test rather than a broken download
        main._build_extension_zip("https://demo.onrender.com")

    def test_a_missing_background_marker_is_fatal(self):
        with pytest.raises(main.ExtensionBuildError):
            main._rewrite_background_js("const API_URL = 'x';\n", "https://d.example")

    def test_a_missing_popup_marker_is_fatal(self):
        with pytest.raises(main.ExtensionBuildError):
            main._rewrite_popup_html("<code>http://localhost:8000/transcript</code>", "https://d.example")

    def test_losing_the_meet_permission_is_fatal(self):
        broken = json.dumps({"manifest_version": 3, "host_permissions": []})
        with pytest.raises(main.ExtensionBuildError):
            main._rewrite_manifest_json(broken, "https://d.example")

    def test_a_non_mv3_manifest_is_fatal(self):
        broken = json.dumps({"manifest_version": 2, "host_permissions": ["https://meet.google.com/*"]})
        with pytest.raises(main.ExtensionBuildError):
            main._rewrite_manifest_json(broken, "https://d.example")

    def test_a_local_origin_is_added_only_once(self):
        source = (main.EXTENSION_DIR / "manifest.json").read_text(encoding="utf-8")
        out = json.loads(main._rewrite_manifest_json(source, "http://localhost:8000"))
        assert out["host_permissions"].count("http://localhost:8000/*") == 1


# --------------------------------------------------------------------------- #
# LLM action endpoint
# --------------------------------------------------------------------------- #


class TestLlmAction:
    def test_keyless_summarize_falls_back_instead_of_failing(self, client):
        client.post("/transcript", json={"meeting_id": "m1", "items": [item("we shipped the release")]})
        r = client.post(
            "/api/llm/action",
            json={"meeting_id": "m1", "action": "summarize", "provider": "openai", "allow_fallback": True},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["used_llm"] is False and body["result"]
        assert body["context_mode"] == "raw"

    def test_keyless_qa_falls_back_instead_of_failing(self, client):
        client.post("/transcript", json={"meeting_id": "m1", "items": [item("the budget was approved")]})
        r = client.post(
            "/api/llm/action",
            json={
                "meeting_id": "m1",
                "action": "qa",
                "question": "what happened to the budget?",
                "provider": "openai",
                "allow_fallback": True,
            },
        )
        assert r.status_code == 200
        assert "budget" in r.json()["result"].lower()

    def test_result_is_written_to_history(self, client):
        client.post("/transcript", json={"meeting_id": "m1", "items": [item("something happened")]})
        client.post(
            "/api/llm/action",
            json={"meeting_id": "m1", "action": "summarize", "provider": "groq", "allow_fallback": True},
        )
        history = client.get("/api/llm/history", params={"meeting_id": "m1"}).json()["items"]
        assert len(history) == 1
        assert history[0]["action"] == "summarize"
        assert history[0]["provider"] == "groq"
        assert history[0]["used_llm"] is False

    def test_rag_request_without_a_runtime_reports_the_fallback(self, client):
        client.post("/transcript", json={"meeting_id": "m1", "items": [item("no index here")]})
        body = client.post(
            "/api/llm/action",
            json={
                "meeting_id": "m1",
                "action": "summarize",
                "provider": "openai",
                "allow_fallback": True,
                "use_rag_context": True,
            },
        ).json()
        # context_mode used to claim "rag" even when retrieval returned nothing
        assert body["context_mode"] == "raw_fallback"
        assert body["context_items"] == 1

    def test_providers_are_listed(self, client):
        ids = {p["id"] for p in client.get("/api/llm/providers").json()["items"]}
        assert {"openai", "groq", "gemini"} <= ids


# --------------------------------------------------------------------------- #
# rag_chunks persistence and migration
# --------------------------------------------------------------------------- #


class TestRagChunkPersistence:
    def test_embeddings_round_trip_as_float32_blobs(self, db_path, no_assistant):
        main.bootstrap()
        vectors = np.array([[0.5, -0.25, 0.125, 1.0]], dtype=np.float32)
        n = main._save_rag_chunks(
            ["m1"], ["chunk one"], vectors, [{"ts_start": "t0", "ts_end": "t1", "speakers": "Alice"}]
        )
        assert n == 1
        row = rows(db_path, "SELECT * FROM rag_chunks")[0]
        assert isinstance(row["embedding"], bytes) and len(row["embedding"]) == 4 * 4
        assert row["dim"] == 4 and row["speakers"] == "Alice"
        assert np.array_equal(main._decode_embedding(row), vectors[0])

    def test_missing_metadata_is_stored_as_empty_strings(self, db_path, no_assistant):
        main.bootstrap()
        main._save_rag_chunks(["m1"], ["c"], np.zeros((1, 4), dtype=np.float32))
        row = rows(db_path, "SELECT * FROM rag_chunks")[0]
        assert (row["ts_start"], row["ts_end"], row["speakers"]) == ("", "", "")

    def test_saving_nothing_is_a_no_op(self, db_path, no_assistant):
        main.bootstrap()
        assert main._save_rag_chunks([], [], np.empty((0, 4), dtype=np.float32)) == 0

    def test_decode_prefers_the_blob_over_legacy_json(self, db_path, no_assistant):
        main.bootstrap()
        blob = np.array([1.0, 2.0], dtype=np.float32).tobytes()
        row = {"embedding": blob, "embedding_json": json.dumps([9.0, 9.0])}
        assert np.array_equal(main._decode_embedding(row), np.array([1.0, 2.0], dtype=np.float32))

    @pytest.mark.parametrize("stored", [None, "", "not json", "[]", "null"])
    def test_undecodable_rows_return_none(self, stored):
        assert main._decode_embedding({"embedding": None, "embedding_json": stored}) is None

    def test_dedupe_keeps_the_lowest_id_per_meeting_and_text(self, db_path, no_assistant):
        main.bootstrap()
        v = np.ones((1, 4), dtype=np.float32)
        main._save_rag_chunks(["m1"], ["same"], v)
        main._save_rag_chunks(["m1"], ["same"], v * 2)  # same text, different vector
        main._save_rag_chunks(["m2"], ["same"], v)  # other meeting: kept
        assert main._dedupe_rag_chunks() == 1
        kept = rows(db_path, "SELECT id, meeting_id FROM rag_chunks ORDER BY id")
        assert [(r["id"], r["meeting_id"]) for r in kept] == [(1, "m1"), (3, "m2")]

    def test_cursor_round_trips(self, db_path, no_assistant):
        main.bootstrap()
        main._set_rag_last_transcript_id(42)
        assert main._get_rag_last_transcript_id() == 42

    def test_cursor_is_clamped_to_zero(self, db_path, no_assistant):
        main.bootstrap()
        main._set_rag_last_transcript_id(-5)
        assert main._get_rag_last_transcript_id() == 0


class TestLegacyMigration:
    @pytest.fixture
    def legacy_db(self, db_path):
        con = sqlite3.connect(db_path)
        con.execute(LEGACY_RAG_SCHEMA)
        con.execute(
            "CREATE INDEX idx_rag_chunks_meeting_id ON rag_chunks(meeting_id)"
        )
        con.executemany(
            "INSERT INTO rag_chunks (meeting_id, chunk_text, embedding_json, dim, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            [
                ("m1", "first chunk", json.dumps([0.1, 0.2, 0.3, 0.4]), 4, "2026-01-01 00:00:00"),
                ("m2", "second chunk", json.dumps([1.0, 0.0, 0.0, 0.0]), 4, "2026-01-02 00:00:00"),
            ],
        )
        con.commit()
        con.close()
        return db_path

    def test_vectors_survive_the_rebuild(self, legacy_db, no_assistant):
        main.bootstrap()
        got = rows(legacy_db, "SELECT * FROM rag_chunks ORDER BY id")
        assert [r["chunk_text"] for r in got] == ["first chunk", "second chunk"]
        assert np.allclose(
            main._decode_embedding(got[0]), np.array([0.1, 0.2, 0.3, 0.4], dtype=np.float32)
        )

    def test_ids_and_created_at_are_preserved(self, legacy_db, no_assistant):
        main.bootstrap()
        got = rows(legacy_db, "SELECT id, created_at FROM rag_chunks ORDER BY id")
        assert [(r["id"], r["created_at"]) for r in got] == [
            (1, "2026-01-01 00:00:00"),
            (2, "2026-01-02 00:00:00"),
        ]

    def test_the_legacy_table_and_its_index_are_gone(self, legacy_db, no_assistant):
        main.bootstrap()
        names = {r[0] for r in rows(legacy_db, "SELECT name FROM sqlite_master")}
        assert "rag_chunks_legacy" not in names
        assert "idx_rag_chunks_meeting_id" in names

    def test_running_twice_is_harmless(self, legacy_db, no_assistant):
        main.bootstrap()
        main._migrate_rag_chunks_schema()
        assert len(rows(legacy_db, "SELECT * FROM rag_chunks")) == 2

    def test_a_corrupt_row_is_kept_with_a_null_embedding(self, db_path, no_assistant):
        con = sqlite3.connect(db_path)
        con.execute(LEGACY_RAG_SCHEMA)
        con.execute(
            "INSERT INTO rag_chunks (meeting_id, chunk_text, embedding_json, dim) VALUES (?, ?, ?, ?)",
            ("m1", "broken", "{not json", 4),
        )
        con.commit()
        con.close()
        main.bootstrap()
        row = rows(db_path, "SELECT * FROM rag_chunks")[0]
        assert row["chunk_text"] == "broken" and row["embedding"] is None


# --------------------------------------------------------------------------- #
# assistant plumbing, against a stub runtime
# --------------------------------------------------------------------------- #


class StubProcessor:
    """Emits one chunk per run until `remaining` is exhausted."""

    def __init__(self, batches):
        self.batches = list(batches)
        self.reader = SimpleNamespace(last_id=0)
        self.last_chunks = []
        self.last_vectors = np.empty((0, 4), dtype=np.float32)
        self.last_meeting_ids = []
        self.last_chunk_metas = []
        self.last_source_max_id = 0
        self.flushed = False

    def run_once(self):
        if not self.batches:
            self._clear()
            return {"rows": 0, "chunks": 0}
        meeting, text = self.batches.pop(0)
        self.last_chunks = [text]
        self.last_meeting_ids = [meeting]
        self.last_vectors = np.ones((1, 4), dtype=np.float32)
        self.last_chunk_metas = [{"ts_start": "t0", "ts_end": "t1", "speakers": "Alice"}]
        self.last_source_max_id += 1
        return {"rows": 1, "chunks": 1}

    def flush(self):
        self.flushed = True
        self._clear()
        return {"rows": 0, "chunks": 0}

    def _clear(self):
        self.last_chunks = []
        self.last_meeting_ids = []
        self.last_chunk_metas = []
        self.last_vectors = np.empty((0, 4), dtype=np.float32)


class StubVectorDB:
    def __init__(self):
        self.added = []

    def add(self, texts, vectors, metas=None):
        self.added.append((list(texts), np.asarray(vectors), list(metas or [])))


def install_stub_runtime(monkeypatch, batches=(), hits=(), answer="stub answer"):
    processor = StubProcessor(batches)
    vectordb = StubVectorDB()
    runtime = {
        "module": SimpleNamespace(
            answer_query=lambda *a, **kw: answer, PROCESS_INTERVAL=3600
        ),
        "processor": processor,
        "buffer": object(),
        "summarizer": object(),
        "retriever": SimpleNamespace(search_detailed=lambda *a, **kw: list(hits)),
        "llm": object(),
        "embedder": SimpleNamespace(dim=4),
        "vectordb": vectordb,
        "stats": {"rows_total": 0, "chunks_total": 0, "last_rows": 0, "last_chunks": 0},
        "ready": True,
    }
    monkeypatch.setattr(main, "assistant_runtime", runtime)
    return runtime


class TestAssistantPlumbing:
    def test_ingest_persists_chunks_and_advances_the_cursor(self, db_path, no_assistant, monkeypatch):
        main.bootstrap()
        rt = install_stub_runtime(monkeypatch, batches=[("m1", "chunk text")])
        stats = main.run_assistant_ingest_once()
        assert stats == {"rows": 1, "chunks": 1}
        assert rt["stats"]["last_persisted"] == 1
        assert len(rows(db_path, "SELECT * FROM rag_chunks")) == 1
        assert main._get_rag_last_transcript_id() == 1

    def test_an_empty_cycle_leaves_the_cursor_alone(self, db_path, no_assistant, monkeypatch):
        main.bootstrap()
        main._set_rag_last_transcript_id(7)
        install_stub_runtime(monkeypatch, batches=[])
        assert main.run_assistant_ingest_once() == {"rows": 0, "chunks": 0}
        assert main._get_rag_last_transcript_id() == 7

    def test_ingest_is_a_no_op_without_a_runtime(self, db_path, no_assistant):
        main.bootstrap()
        assert main.run_assistant_ingest_once() == {"rows": 0, "chunks": 0}

    def test_backfill_drains_every_batch_then_flushes(self, db_path, no_assistant, monkeypatch):
        main.bootstrap()
        rt = install_stub_runtime(monkeypatch, batches=[("m1", "a"), ("m1", "b"), ("m2", "c")])
        stats = main.backfill_assistant_history()
        assert stats["rows"] == 3 and stats["loops"] == 4  # 3 batches + the empty one
        assert rt["processor"].flushed is True
        assert len(rows(db_path, "SELECT * FROM rag_chunks")) == 3

    def test_backfill_respects_its_loop_cap(self, db_path, no_assistant, monkeypatch):
        main.bootstrap()
        install_stub_runtime(monkeypatch, batches=[("m1", str(i)) for i in range(10)])
        assert main.backfill_assistant_history(max_loops=2)["loops"] == 2

    def test_restore_loads_stored_chunks_into_the_index(self, db_path, no_assistant, monkeypatch):
        main.bootstrap()
        rt = install_stub_runtime(monkeypatch)
        main._save_rag_chunks(
            ["m1"], ["restored"], np.ones((1, 4), dtype=np.float32), [{"speakers": "Bob"}]
        )
        assert main._load_rag_chunks_for_assistant() == 1
        texts, vectors, metas = rt["vectordb"].added[0]
        assert texts == ["restored"]
        assert vectors.shape == (1, 4)
        assert metas[0] == {"meeting_id": "m1", "ts_start": "", "ts_end": "", "speakers": "Bob"}

    def test_restore_skips_rows_from_a_different_embedder(self, db_path, no_assistant, monkeypatch):
        main.bootstrap()
        rt = install_stub_runtime(monkeypatch)
        main._save_rag_chunks(["m1"], ["four dims"], np.ones((1, 4), dtype=np.float32))
        main._save_rag_chunks(["m1"], ["eight dims"], np.ones((1, 8), dtype=np.float32))
        assert main._load_rag_chunks_for_assistant() == 1
        assert rt["vectordb"].added[0][0] == ["four dims"]

    def test_rag_context_carries_metadata_through(self, db_path, no_assistant, monkeypatch):
        main.bootstrap()
        install_stub_runtime(
            monkeypatch,
            hits=[("chunk body", 0.9, {"ts_start": "t0", "speakers": "Alice, Bob"})],
        )
        req = main.LlmActionRequest(meeting_id="m1", action="qa", question="who?", rag_top_k=3)
        lines = main._rag_context_lines_for_request(req)
        assert lines == [
            {"meeting_id": "m1", "timestamp": "t0", "speaker": "Alice, Bob", "text": "chunk body"}
        ]

    def test_rag_context_labels_speakerless_chunks(self, db_path, no_assistant, monkeypatch):
        main.bootstrap()
        install_stub_runtime(monkeypatch, hits=[("body", 0.9, {})])
        req = main.LlmActionRequest(meeting_id="m1", action="summarize")
        assert main._rag_context_lines_for_request(req)[0]["speaker"] == "RAG"

    def test_thresholded_out_hits_degrade_to_raw_transcripts(self, db_path, no_assistant, monkeypatch):
        """An empty retrieval must not leave the model with no context at all."""
        main.bootstrap()
        install_stub_runtime(monkeypatch, hits=[])
        with TestClient(main.app) as c:
            c.post("/transcript", json={"meeting_id": "m1", "items": [item("raw line")]})
            body = c.post(
                "/api/llm/action",
                json={
                    "meeting_id": "m1",
                    "action": "summarize",
                    "provider": "openai",
                    "allow_fallback": True,
                    "use_rag_context": True,
                },
            ).json()
        assert body["context_mode"] == "raw_fallback" and body["context_items"] == 1

    def test_query_endpoint_echoes_the_meeting_filter(self, db_path, no_assistant, monkeypatch):
        main.bootstrap()
        install_stub_runtime(monkeypatch, answer="the answer")
        with TestClient(main.app) as c:
            body = c.post("/api/assistant/query", json={"query": "q", "meeting_id": "m9"}).json()
        assert body == {"ok": True, "query": "q", "meeting_id": "m9", "answer": "the answer"}

    def test_status_exposes_running_totals(self, db_path, no_assistant, monkeypatch):
        main.bootstrap()
        install_stub_runtime(monkeypatch, batches=[("m1", "a"), ("m1", "b")])
        main.run_assistant_ingest_once()
        main.run_assistant_ingest_once()
        with TestClient(main.app) as c:
            stats = c.get("/api/assistant/status").json()["stats"]
        assert stats["rows_total"] == 2 and stats["persisted_total"] == 2
