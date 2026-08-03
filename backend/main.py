from __future__ import annotations

import asyncio
import importlib.util
import io
import json
import logging
import os
import re
import sqlite3
import threading
import uuid
import zipfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator, Dict, List, Optional

import numpy as np
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, Response
from pydantic import BaseModel, Field

from llm.registry import list_providers
from llm.service import run_llm_action

LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=LOG_LEVEL,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("meet_transcript")


class TranscriptItem(BaseModel):
    timestamp: str = Field(..., description="ISO-8601 timestamp from client")
    speaker: str
    text: str


class TranscriptBatch(BaseModel):
    meeting_id: str
    items: List[TranscriptItem]


class LlmActionRequest(BaseModel):
    meeting_id: str
    action: str = Field(..., description="summarize | qa")
    question: Optional[str] = None
    limit: int = 120
    provider: str = Field(default="openai", description="openai | groq | gemini")
    api_key: Optional[str] = Field(default=None, description="Override; else use env vars")
    model: Optional[str] = Field(default=None, description="Optional model id for provider")
    allow_fallback: bool = Field(
        default=True,
        description="If true and no API key, use heuristic summary/Q&A",
    )
    use_rag_context: bool = Field(
        default=False,
        description="If true, use RAG retriever context instead of raw transcript rows",
    )
    rag_top_k: int = Field(default=8, description="Number of retrieved RAG chunks")


class AssistantQueryRequest(BaseModel):
    query: str = Field(..., description="Question for meeting assistant")
    meeting_id: Optional[str] = Field(
        default=None,
        description="Restrict retrieval to one meeting; omit to search across all of them",
    )


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """
    Own the whole startup/shutdown sequence.

    Everything below used to run at module import: `import main` opened the
    database, loaded an embedding model, and replayed the entire transcript
    backlog before the first line of the caller's own code. It now happens when
    the server actually starts, which is also what makes this module importable
    from a test or a one-off script. Names referenced here are defined further
    down the file and resolved when the app starts, not when it is created.
    """
    global assistant_background_task
    await run_in_threadpool(bootstrap)
    if assistant_runtime and assistant_runtime.get("ready"):
        assistant_background_task = asyncio.create_task(assistant_ingest_loop())
    try:
        yield
    finally:
        if assistant_background_task:
            assistant_background_task.cancel()
            try:
                await assistant_background_task
            except asyncio.CancelledError:
                pass
            assistant_background_task = None


app = FastAPI(title="Meet Transcript API", version="1.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = Path(os.getenv("TRANSCRIPT_DB_PATH", str(BASE_DIR / "transcripts.db")))
db_lock = threading.Lock()

# The extension is shipped from the running server (see /api/extension.zip), so a
# deployment never needs its URL hardcoded anywhere.
EXTENSION_DIR = BASE_DIR.parent / "extension"
EXTENSION_ZIP_NAME = "meetingiq-extension.zip"

_db: Optional[sqlite3.Connection] = None
# guards the one-time connect only; never held while db_lock is, so the two
# cannot deadlock against each other
_db_connect_lock = threading.Lock()


def _db_connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def get_db() -> sqlite3.Connection:
    """
    The process-wide SQLite connection, opened on first use.

    Connecting lazily is what keeps `import main` free of side effects:
    TRANSCRIPT_DB_PATH is read here rather than at import, so a caller can point
    the app at another database before the first query.
    """
    global _db, DB_PATH
    if _db is None:
        with _db_connect_lock:
            if _db is None:
                DB_PATH = Path(os.getenv("TRANSCRIPT_DB_PATH", str(BASE_DIR / "transcripts.db")))
                _db = _db_connect()
    return _db


assistant_lock = threading.Lock()
assistant_runtime: Optional[Dict[str, Any]] = None
assistant_background_task: Optional[asyncio.Task[Any]] = None


RAG_CHUNKS_SCHEMA = """
    CREATE TABLE IF NOT EXISTS rag_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meeting_id TEXT NOT NULL,
        chunk_text TEXT NOT NULL,
        embedding BLOB,
        embedding_json TEXT,
        dim INTEGER NOT NULL,
        ts_start TEXT,
        ts_end TEXT,
        speakers TEXT,
        created_at TEXT DEFAULT (datetime('now'))
    )
"""

RAG_CHUNKS_INDEX = (
    "CREATE INDEX IF NOT EXISTS idx_rag_chunks_meeting_id ON rag_chunks(meeting_id)"
)


def _migrate_rag_chunks_schema() -> None:
    """
    Rebuild the pre-BLOB rag_chunks table.

    Embeddings used to be stored as JSON text (~8.4 kB per 384-dim vector) in a
    NOT NULL column. SQLite cannot relax NOT NULL or change a column type in
    place, so the table is rebuilt and every vector converted to a float32 BLOB
    (~1.5 kB). Existing rows are preserved.
    """
    with db_lock:
        cols = {row[1] for row in get_db().execute("PRAGMA table_info(rag_chunks)")}
        if not cols or "embedding" in cols:
            return

        logger.info("migrating rag_chunks to blob embeddings")
        rows = get_db().execute(
            "SELECT id, meeting_id, chunk_text, embedding_json, dim, created_at "
            "FROM rag_chunks ORDER BY id ASC"
        ).fetchall()

        converted: List[tuple[Any, ...]] = []
        for r in rows:
            blob: Optional[bytes] = None
            try:
                vec = json.loads(r["embedding_json"] or "null")
                if isinstance(vec, list) and vec:
                    blob = np.asarray(vec, dtype=np.float32).tobytes()
            except Exception:
                blob = None
            converted.append(
                (r["id"], r["meeting_id"], r["chunk_text"], blob, r["dim"], r["created_at"])
            )

        get_db().execute("ALTER TABLE rag_chunks RENAME TO rag_chunks_legacy")
        get_db().execute(RAG_CHUNKS_SCHEMA)
        get_db().executemany(
            "INSERT INTO rag_chunks (id, meeting_id, chunk_text, embedding, dim, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            converted,
        )
        # dropping the legacy table also drops its identically-named index
        get_db().execute("DROP TABLE rag_chunks_legacy")
        get_db().execute(RAG_CHUNKS_INDEX)
        get_db().commit()
        logger.info("migrated rag_chunks rows=%s", len(converted))


def _init_rag_table() -> None:
    with db_lock:
        get_db().execute(RAG_CHUNKS_SCHEMA)
        get_db().execute(RAG_CHUNKS_INDEX)
        get_db().execute(
            """
            CREATE TABLE IF NOT EXISTS rag_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                last_transcript_id INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT DEFAULT (datetime('now'))
            )
            """
        )
        get_db().execute("INSERT OR IGNORE INTO rag_state (id, last_transcript_id) VALUES (1, 0)")
        get_db().commit()
    _migrate_rag_chunks_schema()


def _save_rag_chunks(
    meeting_ids: List[str],
    chunks: List[str],
    vectors: Any,
    metas: Optional[List[Dict[str, Any]]] = None,
) -> int:
    if not chunks:
        return 0
    metas = metas or []
    rows: List[tuple[Any, ...]] = []
    dim = int(getattr(vectors, "shape", [0, 0])[1] if len(getattr(vectors, "shape", [])) == 2 else 0)
    for idx, chunk in enumerate(chunks):
        mid = meeting_ids[idx] if idx < len(meeting_ids) else "unknown"
        meta = metas[idx] if idx < len(metas) else {}
        blob = np.asarray(vectors[idx], dtype=np.float32).tobytes() if idx < len(vectors) else b""
        rows.append(
            (
                mid,
                chunk,
                blob,
                dim,
                meta.get("ts_start", ""),
                meta.get("ts_end", ""),
                meta.get("speakers", ""),
            )
        )
    with db_lock:
        get_db().executemany(
            """
            INSERT INTO rag_chunks (meeting_id, chunk_text, embedding, dim, ts_start, ts_end, speakers)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )
        get_db().commit()
    return len(rows)


def _set_rag_last_transcript_id(last_id: int) -> None:
    with db_lock:
        get_db().execute(
            """
            UPDATE rag_state
            SET last_transcript_id = ?, updated_at = datetime('now')
            WHERE id = 1
            """,
            (max(0, int(last_id)),),
        )
        get_db().commit()


def _get_rag_last_transcript_id() -> int:
    with db_lock:
        cur = get_db().execute("SELECT last_transcript_id FROM rag_state WHERE id = 1")
        row = cur.fetchone()
    return int(row["last_transcript_id"]) if row else 0


def _load_rag_chunks_for_assistant(limit: int = 200000) -> int:
    if not assistant_runtime or not assistant_runtime.get("ready"):
        return 0
    with db_lock:
        cur = get_db().execute(
            """
            SELECT meeting_id, chunk_text, embedding, embedding_json, dim, ts_start, ts_end, speakers
            FROM rag_chunks
            ORDER BY id ASC
            LIMIT ?
            """,
            (limit,),
        )
        rows = cur.fetchall()
    if not rows:
        return 0

    texts: List[str] = []
    vecs: List[np.ndarray] = []
    metas: List[Dict[str, Any]] = []
    expected_dim = int(getattr(assistant_runtime["embedder"], "dim", 0))
    for r in rows:
        dim = int(r["dim"] or 0)
        if expected_dim and dim and dim != expected_dim:
            continue
        vec = _decode_embedding(r)
        if vec is None:
            continue
        if expected_dim and len(vec) != expected_dim:
            continue
        texts.append(r["chunk_text"])
        vecs.append(vec)
        metas.append(
            {
                "meeting_id": r["meeting_id"],
                "ts_start": r["ts_start"] or "",
                "ts_end": r["ts_end"] or "",
                "speakers": r["speakers"] or "",
            }
        )
    if not texts:
        return 0
    assistant_runtime["vectordb"].add(texts, np.asarray(vecs, dtype=np.float32), metas)
    return len(texts)


def _decode_embedding(row: sqlite3.Row) -> Optional[np.ndarray]:
    """Read a stored vector, accepting both the BLOB and the legacy JSON column."""
    blob = row["embedding"]
    if blob:
        try:
            return np.frombuffer(blob, dtype=np.float32)
        except Exception:
            return None
    raw = row["embedding_json"]
    if not raw:
        return None
    try:
        vec = json.loads(raw)
    except Exception:
        return None
    if not isinstance(vec, list) or not vec:
        return None
    return np.asarray(vec, dtype=np.float32)


def _dedupe_rag_chunks() -> int:
    with db_lock:
        before = get_db().execute("SELECT COUNT(*) AS n FROM rag_chunks").fetchone()
        get_db().execute(
            """
            DELETE FROM rag_chunks
            WHERE id NOT IN (
                SELECT MIN(id)
                FROM rag_chunks
                GROUP BY meeting_id, chunk_text
            )
            """
        )
        get_db().commit()
        after = get_db().execute("SELECT COUNT(*) AS n FROM rag_chunks").fetchone()
    before_n = int(before["n"]) if before else 0
    after_n = int(after["n"]) if after else 0
    return max(0, before_n - after_n)


def _load_meeting_assistant_module() -> Optional[Any]:
    assistant_main = BASE_DIR / "meeting-assistant" / "main.py"
    if not assistant_main.exists():
        logger.warning("meeting-assistant module not found at %s", assistant_main)
        return None

    # The assistant project uses flat imports (config, db, etc.), so add its folder to sys.path.
    import sys

    assistant_root = str(assistant_main.parent.resolve())
    if assistant_root not in sys.path:
        sys.path.insert(0, assistant_root)

    # Avoid collision with backend `llm` package while loading assistant module.
    saved_llm_modules: Dict[str, Any] = {}
    for name in list(sys.modules.keys()):
        if name == "llm" or name.startswith("llm."):
            saved_llm_modules[name] = sys.modules.pop(name)

    try:
        spec = importlib.util.spec_from_file_location("meeting_assistant_main", assistant_main)
        if spec is None or spec.loader is None:
            return None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        for name in list(sys.modules.keys()):
            if name == "llm" or name.startswith("llm."):
                sys.modules.pop(name, None)
        sys.modules.update(saved_llm_modules)


def setup_meeting_assistant() -> bool:
    global assistant_runtime
    try:
        module = _load_meeting_assistant_module()
        if module is None:
            return False
        processor, buffer, summarizer, retriever, llm = module.build_system()
        assistant_runtime = {
            "module": module,
            "processor": processor,
            "buffer": buffer,
            "summarizer": summarizer,
            "retriever": retriever,
            "llm": llm,
            "embedder": processor.embedder,
            "vectordb": processor.vectordb,
            "stats": {"rows_total": 0, "chunks_total": 0, "last_rows": 0, "last_chunks": 0},
            "ready": True,
        }
        assistant_runtime["processor"].reader.last_id = _get_rag_last_transcript_id()
        return True
    except Exception:
        logger.exception("Failed to initialize meeting assistant runtime")
        assistant_runtime = None
        return False


def run_assistant_ingest_once() -> Dict[str, int]:
    if not assistant_runtime or not assistant_runtime.get("ready"):
        return {"rows": 0, "chunks": 0}
    with assistant_lock:
        stats = assistant_runtime["processor"].run_once()
        persisted = _save_rag_chunks(
            assistant_runtime["processor"].last_meeting_ids,
            assistant_runtime["processor"].last_chunks,
            assistant_runtime["processor"].last_vectors,
            assistant_runtime["processor"].last_chunk_metas,
        )
        runtime_stats = assistant_runtime["stats"]
        runtime_stats["rows_total"] += int(stats.get("rows", 0))
        runtime_stats["chunks_total"] += int(stats.get("chunks", 0))
        runtime_stats["last_rows"] = int(stats.get("rows", 0))
        runtime_stats["last_chunks"] = int(stats.get("chunks", 0))
        runtime_stats["last_persisted"] = persisted
        runtime_stats["persisted_total"] = int(runtime_stats.get("persisted_total", 0)) + persisted
        if int(stats.get("rows", 0)) > 0:
            _set_rag_last_transcript_id(int(assistant_runtime["processor"].last_source_max_id))
        return stats


def _rag_context_lines_for_request(req: LlmActionRequest) -> List[Dict[str, Any]]:
    """
    Retrieve this meeting's most relevant chunks from the in-memory index.

    Previously this re-read up to 2500 rows and JSON-decoded every embedding on
    each request; the vector index is already resident and now carries the
    meeting_id needed to scope the search.
    """
    if not assistant_runtime or not assistant_runtime.get("ready"):
        return []
    top_k = max(1, min(req.rag_top_k, 30))
    if req.action.strip().lower() == "qa" and (req.question or "").strip():
        query = (req.question or "").strip()
    else:
        query = f"summary decisions action items for meeting {req.meeting_id}"

    with assistant_lock:
        hits = assistant_runtime["retriever"].search_detailed(
            query, top_k=top_k, meeting_id=req.meeting_id
        )
    return [
        {
            "meeting_id": req.meeting_id,
            "timestamp": meta.get("ts_start", ""),
            "speaker": meta.get("speakers") or "RAG",
            "text": text,
        }
        for text, _score, meta in hits
    ]


def run_assistant_flush() -> Dict[str, int]:
    """Seal every meeting's partial chunk and persist the result."""
    if not assistant_runtime or not assistant_runtime.get("ready"):
        return {"rows": 0, "chunks": 0}
    with assistant_lock:
        stats = assistant_runtime["processor"].flush()
        _save_rag_chunks(
            assistant_runtime["processor"].last_meeting_ids,
            assistant_runtime["processor"].last_chunks,
            assistant_runtime["processor"].last_vectors,
            assistant_runtime["processor"].last_chunk_metas,
        )
    return stats


def backfill_assistant_history(max_loops: int = 10000) -> Dict[str, int]:
    total_rows = 0
    total_chunks = 0
    loops = 0
    while loops < max_loops:
        loops += 1
        stats = run_assistant_ingest_once()
        rows = int(stats.get("rows", 0))
        total_rows += rows
        total_chunks += int(stats.get("chunks", 0))
        if rows == 0:
            break
    # nothing more is coming during a backfill, so don't leave the tail pending
    total_chunks += int(run_assistant_flush().get("chunks", 0))
    return {"rows": total_rows, "chunks": total_chunks, "loops": loops}


_bootstrapped = False


def bootstrap(backfill: bool = True) -> None:
    """
    Create the schema, build the assistant runtime, and catch up on backlog.

    Idempotent — the second call is a no-op — so a script that imports this
    module can invoke it directly instead of relying on the ASGI lifespan.
    Blocking on purpose: it runs under `run_in_threadpool` at startup.
    """
    global _bootstrapped
    if _bootstrapped:
        return

    init_db()
    if setup_meeting_assistant():
        deduped = _dedupe_rag_chunks()
        if deduped:
            logger.info("assistant deduped rag_chunks removed=%s", deduped)
        restored = _load_rag_chunks_for_assistant()
        if restored:
            logger.info("assistant restored rag_chunks=%s from sqlite", restored)
            if _get_rag_last_transcript_id() == 0:
                with db_lock:
                    cur = get_db().execute(
                        "SELECT COALESCE(MAX(id), 0) AS max_id FROM transcripts"
                    )
                    row = cur.fetchone()
                _set_rag_last_transcript_id(int(row["max_id"]) if row else 0)
            assistant_runtime["processor"].reader.last_id = _get_rag_last_transcript_id()
        if backfill:
            backfill_stats = backfill_assistant_history()
            logger.info(
                "assistant backfill completed rows=%s chunks=%s loops=%s",
                backfill_stats["rows"],
                backfill_stats["chunks"],
                backfill_stats["loops"],
            )
    _bootstrapped = True


async def assistant_ingest_loop() -> None:
    if not assistant_runtime:
        return
    interval = float(getattr(assistant_runtime["module"], "PROCESS_INTERVAL", 3))
    while True:
        try:
            stats = await run_in_threadpool(run_assistant_ingest_once)
            if stats.get("rows", 0):
                logger.info(
                    "assistant_ingest rows=%s chunks=%s",
                    stats.get("rows", 0),
                    stats.get("chunks", 0),
                )
        except Exception:
            logger.exception("assistant ingest loop error")
        await asyncio.sleep(interval)


def init_db() -> None:
    with db_lock:
        get_db().execute(
            """
            CREATE TABLE IF NOT EXISTS transcripts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                meeting_id TEXT NOT NULL,
                ts_iso TEXT NOT NULL,
                speaker TEXT NOT NULL,
                text TEXT NOT NULL,
                created_at TEXT DEFAULT (datetime('now'))
            )
            """
        )
        get_db().execute(
            "CREATE INDEX IF NOT EXISTS idx_transcripts_meeting_id ON transcripts(meeting_id)"
        )
        get_db().execute(
            """
            CREATE TABLE IF NOT EXISTS llm_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                meeting_id TEXT NOT NULL,
                action TEXT NOT NULL,
                question TEXT,
                result TEXT NOT NULL,
                created_at TEXT DEFAULT (datetime('now'))
            )
            """
        )
        get_db().execute(
            "CREATE INDEX IF NOT EXISTS idx_llm_history_meeting_id ON llm_history(meeting_id)"
        )
        get_db().commit()
    _migrate_llm_history_columns()
    _init_rag_table()


def _migrate_llm_history_columns() -> None:
    for stmt in (
        "ALTER TABLE llm_history ADD COLUMN provider TEXT",
        "ALTER TABLE llm_history ADD COLUMN model TEXT",
        "ALTER TABLE llm_history ADD COLUMN used_llm INTEGER DEFAULT 0",
    ):
        try:
            with db_lock:
                get_db().execute(stmt)
                get_db().commit()
        except sqlite3.OperationalError:
            pass


def save_transcripts(meeting_id: str, items: List[TranscriptItem]) -> int:
    if not items:
        return 0
    rows = [(meeting_id, item.timestamp, item.speaker, item.text) for item in items]
    with db_lock:
        get_db().executemany(
            """
            INSERT INTO transcripts (meeting_id, ts_iso, speaker, text)
            VALUES (?, ?, ?, ?)
            """,
            rows,
        )
        get_db().commit()
    return len(rows)


def get_recent_transcripts(meeting_id: str, limit: int = 200) -> List[Dict[str, Any]]:
    cap = max(1, min(limit, 1000))
    with db_lock:
        cur = get_db().execute(
            """
            SELECT meeting_id, ts_iso, speaker, text
            FROM transcripts
            WHERE meeting_id = ?
            ORDER BY id DESC
            LIMIT ?
            """,
            (meeting_id, cap),
        )
        rows = cur.fetchall()
    rows.reverse()
    return [
        {
            "meeting_id": r["meeting_id"],
            "timestamp": r["ts_iso"],
            "speaker": r["speaker"],
            "text": r["text"],
        }
        for r in rows
    ]


def list_meetings(limit: int = 100) -> List[Dict[str, Any]]:
    cap = max(1, min(limit, 1000))
    with db_lock:
        cur = get_db().execute(
            """
            SELECT meeting_id, COUNT(*) AS item_count, MAX(created_at) AS last_seen
            FROM transcripts
            GROUP BY meeting_id
            ORDER BY MAX(id) DESC
            LIMIT ?
            """,
            (cap,),
        )
        rows = cur.fetchall()
    return [
        {
            "meeting_id": r["meeting_id"],
            "item_count": r["item_count"],
            "last_seen": r["last_seen"],
        }
        for r in rows
    ]


def save_llm_history(
    meeting_id: str,
    action: str,
    question: Optional[str],
    result: str,
    provider: Optional[str] = None,
    model: Optional[str] = None,
    used_llm: bool = False,
) -> None:
    with db_lock:
        get_db().execute(
            """
            INSERT INTO llm_history (meeting_id, action, question, result, provider, model, used_llm)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (meeting_id, action, question, result, provider, model, 1 if used_llm else 0),
        )
        get_db().commit()


def get_llm_history(meeting_id: str, limit: int = 100) -> List[Dict[str, Any]]:
    cap = max(1, min(limit, 500))
    with db_lock:
        cur = get_db().execute(
            """
            SELECT action, question, result, created_at, provider, model, used_llm
            FROM llm_history
            WHERE meeting_id = ?
            ORDER BY id DESC
            LIMIT ?
            """,
            (meeting_id, cap),
        )
        rows = cur.fetchall()
    rows.reverse()
    out: List[Dict[str, Any]] = []
    for r in rows:
        row = dict(r)
        if "used_llm" in row and row["used_llm"] is not None:
            row["used_llm"] = bool(row["used_llm"])
        out.append(row)
    return out


class TranscriptHub:
    def __init__(self) -> None:
        self.clients: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        async with self._lock:
            self.clients.add(ws)

    async def disconnect(self, ws: WebSocket) -> None:
        async with self._lock:
            self.clients.discard(ws)

    async def broadcast(self, payload: Dict[str, Any]) -> None:
        async with self._lock:
            targets = list(self.clients)
        stale: List[WebSocket] = []
        for ws in targets:
            try:
                await ws.send_json(payload)
            except Exception:
                stale.append(ws)
        if stale:
            async with self._lock:
                for ws in stale:
                    self.clients.discard(ws)


hub = TranscriptHub()


# --------------------------------------------------------------------------- #
# extension packaging
#
# The extension is built on demand and stamped with the origin that served the
# download, so the same source tree yields a localhost build in development and a
# hosted build in production with nothing committed either way. Every rewrite is
# guarded: a source file that no longer matches raises instead of silently
# shipping a zip that points at localhost, which would fail at the recruiter's
# machine with nothing but a `!` badge to explain it.
# --------------------------------------------------------------------------- #


class ExtensionBuildError(RuntimeError):
    """A source file no longer matches what the zip builder expects."""


# host lands in a JS string literal and in JSON, so it is validated rather than trusted
_HOST_RE = re.compile(r"^[A-Za-z0-9.\-]+(?::\d{1,5})?$")
_API_URL_RE = re.compile(r"^const API_URL = '[^']*';[ \t]*// meetingiq:api-url[ \t]*$", re.M)
_POPUP_URL_RE = re.compile(r'(<code data-meetingiq="api-url">)[^<]*(</code>)')

_ZIP_SKIP_DIRS = {"tests", "__pycache__", "node_modules", ".git", ".idea", ".vscode"}
_ZIP_SKIP_FILES = {".DS_Store", "Thumbs.db", "desktop.ini"}
_ZIP_SKIP_SUFFIXES = (".pyc", ".log", ".zip", ".map")


def _public_base_url(request: Request) -> str:
    """
    The origin the client actually reached us on, for baking into the build.

    request.url is not sufficient behind a proxy: Render terminates TLS and
    forwards plain HTTP from a non-loopback address, and uvicorn's proxy-header
    handling trusts only 127.0.0.1 by default, so the scheme reads back as
    "http". An http build would POST /transcript, follow the 301 to https, and be
    downgraded to a GET by the browser -> 405 -> every caption silently dropped.
    RENDER_EXTERNAL_URL is preferred precisely so production does not depend on
    getting the proxy flags right.
    """
    for env_name in ("PUBLIC_BASE_URL", "RENDER_EXTERNAL_URL"):
        override = os.getenv(env_name, "").strip().rstrip("/")
        if override:
            return override

    scheme = (
        request.headers.get("x-forwarded-proto", "").split(",")[0].strip()
        or request.url.scheme
        or "https"
    )
    host = (
        request.headers.get("x-forwarded-host", "").split(",")[0].strip()
        or request.headers.get("host", "").strip()
        or request.url.netloc
    )
    if scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="unsupported forwarded scheme")
    if not _HOST_RE.match(host):
        raise HTTPException(status_code=400, detail="unsupported host")
    return f"{scheme}://{host}"


def _rewrite_background_js(text: str, base_url: str) -> str:
    replacement = f"const API_URL = '{base_url}/transcript'; // meetingiq:api-url"
    out, n = _API_URL_RE.subn(replacement.replace("\\", "\\\\"), text, count=1)
    if n != 1:
        raise ExtensionBuildError(
            "background.js: no line matching "
            "`const API_URL = '...'; // meetingiq:api-url`"
        )
    return out


def _rewrite_popup_html(text: str, base_url: str) -> str:
    out, n = _POPUP_URL_RE.subn(rf"\g<1>{base_url}/transcript\g<2>", text, count=1)
    if n != 1:
        raise ExtensionBuildError('popup.html: no <code data-meetingiq="api-url"> element')
    return out


def _rewrite_manifest_json(text: str, base_url: str) -> str:
    """
    Add the serving origin to host_permissions.

    Appends rather than replaces: meet.google.com is what lets the content script
    run at all, and leaving the localhost entries in place means the same
    unpacked folder still works against a local backend. Under MV3 the service
    worker's fetch is blocked without a matching host permission, so rewriting
    API_URL alone would produce an extension that looks installed and captures
    nothing.
    """
    data = json.loads(text)
    if data.get("manifest_version") != 3:
        raise ExtensionBuildError("manifest.json is no longer MV3")
    perms = list(data.get("host_permissions") or [])
    if "https://meet.google.com/*" not in perms:
        raise ExtensionBuildError("manifest.json lost the meet.google.com host permission")
    origin = f"{base_url}/*"
    if origin not in perms:
        perms.append(origin)
    data["host_permissions"] = perms
    return json.dumps(data, indent=2, ensure_ascii=False) + "\n"


_REWRITERS = {
    "background.js": _rewrite_background_js,
    "manifest.json": _rewrite_manifest_json,
    "popup.html": _rewrite_popup_html,
}


def _load_instructions(base_url: str) -> str:
    return (
        "MeetingIQ - Chrome extension\n"
        "============================\n\n"
        f"This copy is wired to: {base_url}/transcript\n"
        "You do not need to configure anything.\n\n"
        "1. Extract this zip to a folder. On Windows use right-click > Extract All;\n"
        "   do not load it from the zip preview window.\n"
        "2. Open chrome://extensions and turn on Developer mode (top right).\n"
        "3. Click 'Load unpacked' and pick the extracted folder - the one with\n"
        "   manifest.json in it. A microphone icon appears in your toolbar.\n"
        "4. Join a Google Meet and turn on live captions (the CC button).\n"
        "   Nothing is captured without them.\n"
        f"5. Open {base_url} and pick your meeting from the dropdown.\n"
    )


def _zip_entry(name: str) -> zipfile.ZipInfo:
    # fixed timestamp keeps builds byte-identical, which is what makes the
    # determinism test meaningful
    info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = 0o644 << 16
    return info


def _build_extension_zip(base_url: str) -> bytes:
    buf = io.BytesIO()
    seen_manifest = False
    background_js = ""
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, dirnames, filenames in os.walk(EXTENSION_DIR):
            dirnames[:] = sorted(
                d for d in dirnames if d not in _ZIP_SKIP_DIRS and not d.startswith(".")
            )
            for name in sorted(filenames):
                if name in _ZIP_SKIP_FILES or name.startswith("."):
                    continue
                if name.endswith(_ZIP_SKIP_SUFFIXES):
                    continue
                src = Path(root) / name
                # as_posix(), not str(): on Windows str() yields "icons\icon16.png",
                # which unzip tools read as a filename containing a backslash rather
                # than a path, and Chrome then cannot find the icons. Python's own
                # zipfile round-trips it fine, so only a real Chrome load catches it.
                arcname = src.relative_to(EXTENSION_DIR).as_posix()
                rewriter = _REWRITERS.get(arcname)
                if rewriter is None:
                    payload = src.read_bytes()
                else:
                    rewritten = rewriter(src.read_text(encoding="utf-8"), base_url)
                    payload = rewritten.encode("utf-8")
                    if arcname == "background.js":
                        background_js = rewritten
                if arcname == "manifest.json":
                    seen_manifest = True
                zf.writestr(_zip_entry(arcname), payload)
        zf.writestr(_zip_entry("LOAD-ME-FIRST.txt"), _load_instructions(base_url))

    if not seen_manifest:
        raise ExtensionBuildError("manifest.json missing from extension/")
    # catches a second API_URL-like reference being added and only one being rewritten
    is_local = "localhost" in base_url or "127.0.0.1" in base_url
    if not is_local and "localhost:8000" in background_js:
        raise ExtensionBuildError("background.js still references localhost after rewrite")
    return buf.getvalue()


@app.middleware("http")
async def request_id_middleware(request: Request, call_next):
    rid = request.headers.get("x-request-id") or str(uuid.uuid4())
    request.state.request_id = rid
    response = await call_next(request)
    response.headers["X-Request-ID"] = rid
    return response


@app.get("/health")
def health():
    assistant_ready = bool(assistant_runtime and assistant_runtime.get("ready"))
    return {
        "status": "ok",
        "meeting_assistant_ready": assistant_ready,
        # false means the deploy did not include ../extension, so the dashboard's
        # download button is dead — worth catching before a visitor finds it
        "extension_zip_available": EXTENSION_DIR.is_dir(),
    }


@app.get("/", response_class=HTMLResponse)
def ui_root():
    html_path = BASE_DIR / "static" / "index.html"
    return html_path.read_text(encoding="utf-8")


@app.get("/api/extension.zip")
def api_extension_zip(request: Request):
    """
    Package the extension for whoever is asking, stamped with this server's URL.

    Sync on purpose: the walk, reads and deflate run in the threadpool instead of
    stalling the event loop mid-caption-broadcast. Rebuilt per request rather
    than cached — the payload is ~20 KB and caching it would serve a stale zip in
    development, since `uvicorn --reload` watches backend/ and never sees edits
    to ../extension/.
    """
    base_url = _public_base_url(request)
    if not EXTENSION_DIR.is_dir():
        raise HTTPException(status_code=503, detail="extension sources not deployed")
    blob = _build_extension_zip(base_url)
    return Response(
        content=blob,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{EXTENSION_ZIP_NAME}"',
            "Cache-Control": "no-store",
        },
    )


@app.get("/api/transcripts")
def api_transcripts(meeting_id: str, limit: int = 200):
    return {"meeting_id": meeting_id, "items": get_recent_transcripts(meeting_id, limit)}


@app.get("/api/meetings")
def api_meetings(limit: int = 100):
    return {"items": list_meetings(limit)}


@app.get("/api/llm/history")
def api_llm_history(meeting_id: str, limit: int = 100):
    return {"meeting_id": meeting_id, "items": get_llm_history(meeting_id, limit)}


@app.get("/api/llm/providers")
def api_llm_providers():
    return {"items": list_providers()}


@app.post("/api/llm/action")
def api_llm_action(req: LlmActionRequest):
    context_mode = "raw"
    lines: List[Dict[str, Any]] = []
    if req.use_rag_context:
        run_assistant_ingest_once()
        lines = _rag_context_lines_for_request(req)
        context_mode = "rag" if lines else "raw_fallback"
    if not lines:
        # no index yet, or every hit was below the similarity threshold
        lines = get_recent_transcripts(req.meeting_id, req.limit)
    action = req.action.strip().lower()
    result, used_llm = run_llm_action(
        lines=lines,
        action=action,
        question=req.question,
        provider_id=req.provider,
        api_key=req.api_key,
        model=req.model,
        allow_fallback=req.allow_fallback,
    )
    save_llm_history(
        req.meeting_id,
        action,
        req.question,
        result,
        provider=req.provider,
        model=req.model,
        used_llm=used_llm,
    )
    return {
        "meeting_id": req.meeting_id,
        "action": action,
        "result": result,
        "used_llm": used_llm,
        "provider": req.provider,
        "model": req.model,
        "context_mode": context_mode,
        "context_items": len(lines),
    }


@app.get("/api/assistant/status")
def api_assistant_status():
    if not assistant_runtime:
        return {"ready": False}
    return {
        "ready": bool(assistant_runtime.get("ready")),
        "stats": assistant_runtime.get("stats", {}),
    }


@app.post("/api/assistant/query")
def api_assistant_query(req: AssistantQueryRequest):
    if not assistant_runtime or not assistant_runtime.get("ready"):
        return {"ok": False, "error": "meeting assistant is not initialized"}
    with assistant_lock:
        answer = assistant_runtime["module"].answer_query(
            req.query,
            assistant_runtime["buffer"],
            assistant_runtime["summarizer"],
            assistant_runtime["retriever"],
            assistant_runtime["llm"],
            meeting_id=req.meeting_id,
        )
    return {"ok": True, "query": req.query, "meeting_id": req.meeting_id, "answer": answer}


@app.post("/api/assistant/ingest")
def api_assistant_ingest():
    if not assistant_runtime or not assistant_runtime.get("ready"):
        return {"ok": False, "error": "meeting assistant is not initialized"}
    stats = run_assistant_ingest_once()
    return {"ok": True, "stats": stats}


@app.websocket("/ws/transcripts")
async def ws_transcripts(ws: WebSocket):
    await hub.connect(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        await hub.disconnect(ws)
    except Exception:
        await hub.disconnect(ws)


@app.post("/transcript")
async def post_transcript(batch: TranscriptBatch, request: Request):
    rid = getattr(request.state, "request_id", "-")
    n = await run_in_threadpool(save_transcripts, batch.meeting_id, batch.items)
    logger.info(
        "transcript_batch meeting_id=%s items=%s request_id=%s",
        batch.meeting_id,
        n,
        rid,
    )
    # debug, not info: on a hosted deployment this would put verbatim meeting
    # content into the platform's log stream
    for i, item in enumerate(batch.items):
        logger.debug(
            "  [%s] ts=%s speaker=%r text=%r",
            i,
            item.timestamp,
            item.speaker,
            item.text[:500] + ("…" if len(item.text) > 500 else ""),
        )
    await hub.broadcast(
        {
            "type": "transcript_batch",
            "meeting_id": batch.meeting_id,
            "items": [item.model_dump() for item in batch.items],
        }
    )
    if assistant_runtime and assistant_runtime.get("ready"):
        # Ingest does SQLite writes plus embedding inference; keep it off the event loop
        # so caption POSTs never stall WebSocket broadcasts or other requests.
        await run_in_threadpool(run_assistant_ingest_once)
    return {"accepted": n, "meeting_id": batch.meeting_id, "request_id": rid}


