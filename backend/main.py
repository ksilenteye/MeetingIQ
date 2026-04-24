from __future__ import annotations

import asyncio
import importlib.util
import json
import logging
import os
import sqlite3
import threading
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from llm.registry import list_providers
from llm.service import run_llm_action

try:
    import graphiti_core  # type: ignore  # noqa: F401

    GRAPHIFY_AVAILABLE = True
except Exception:
    GRAPHIFY_AVAILABLE = False

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


app = FastAPI(title="Meet Transcript API", version="1.1.0")
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


def _db_connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


db = _db_connect()


assistant_lock = threading.Lock()
assistant_runtime: Optional[Dict[str, Any]] = None
assistant_background_task: Optional[asyncio.Task[Any]] = None


def _init_rag_table() -> None:
    with db_lock:
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS rag_chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                meeting_id TEXT NOT NULL,
                chunk_text TEXT NOT NULL,
                embedding_json TEXT NOT NULL,
                dim INTEGER NOT NULL,
                created_at TEXT DEFAULT (datetime('now'))
            )
            """
        )
        db.execute("CREATE INDEX IF NOT EXISTS idx_rag_chunks_meeting_id ON rag_chunks(meeting_id)")
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS rag_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                last_transcript_id INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT DEFAULT (datetime('now'))
            )
            """
        )
        db.execute("INSERT OR IGNORE INTO rag_state (id, last_transcript_id) VALUES (1, 0)")
        db.commit()


def _save_rag_chunks(meeting_ids: List[str], chunks: List[str], vectors: Any) -> int:
    if not chunks:
        return 0
    rows: List[tuple[str, str, str, int]] = []
    dim = int(getattr(vectors, "shape", [0, 0])[1] if len(getattr(vectors, "shape", [])) == 2 else 0)
    for idx, chunk in enumerate(chunks):
        mid = meeting_ids[idx] if idx < len(meeting_ids) else "unknown"
        vec = vectors[idx].tolist() if idx < len(vectors) else []
        rows.append((mid, chunk, json.dumps(vec), dim))
    with db_lock:
        db.executemany(
            """
            INSERT INTO rag_chunks (meeting_id, chunk_text, embedding_json, dim)
            VALUES (?, ?, ?, ?)
            """,
            rows,
        )
        db.commit()
    return len(rows)


def _set_rag_last_transcript_id(last_id: int) -> None:
    with db_lock:
        db.execute(
            """
            UPDATE rag_state
            SET last_transcript_id = ?, updated_at = datetime('now')
            WHERE id = 1
            """,
            (max(0, int(last_id)),),
        )
        db.commit()


def _get_rag_last_transcript_id() -> int:
    with db_lock:
        cur = db.execute("SELECT last_transcript_id FROM rag_state WHERE id = 1")
        row = cur.fetchone()
    return int(row["last_transcript_id"]) if row else 0


def _load_rag_chunks_for_assistant(limit: int = 200000) -> int:
    if not assistant_runtime or not assistant_runtime.get("ready"):
        return 0
    with db_lock:
        cur = db.execute(
            """
            SELECT chunk_text, embedding_json, dim
            FROM rag_chunks
            ORDER BY id ASC
            LIMIT ?
            """,
            (limit,),
        )
        rows = cur.fetchall()
    if not rows:
        return 0
    import numpy as np

    texts: List[str] = []
    vecs: List[List[float]] = []
    expected_dim = int(getattr(assistant_runtime["embedder"], "dim", 0))
    for r in rows:
        text = r["chunk_text"]
        dim = int(r["dim"] or 0)
        if expected_dim and dim and dim != expected_dim:
            continue
        try:
            vec = json.loads(r["embedding_json"])
        except Exception:
            continue
        if not isinstance(vec, list):
            continue
        if expected_dim and len(vec) != expected_dim:
            continue
        texts.append(text)
        vecs.append([float(x) for x in vec])
    if not texts:
        return 0
    assistant_runtime["vectordb"].add(texts, np.asarray(vecs, dtype=np.float32))
    return len(texts)


def _dedupe_rag_chunks() -> int:
    with db_lock:
        before = db.execute("SELECT COUNT(*) AS n FROM rag_chunks").fetchone()
        db.execute(
            """
            DELETE FROM rag_chunks
            WHERE id NOT IN (
                SELECT MIN(id)
                FROM rag_chunks
                GROUP BY meeting_id, chunk_text, embedding_json
            )
            """
        )
        db.commit()
        after = db.execute("SELECT COUNT(*) AS n FROM rag_chunks").fetchone()
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
    if not assistant_runtime or not assistant_runtime.get("ready"):
        return []
    top_k = max(1, min(req.rag_top_k, 30))
    if req.action.strip().lower() == "qa" and (req.question or "").strip():
        query = (req.question or "").strip()
    else:
        query = f"summary decisions action items for meeting {req.meeting_id}"
    with db_lock:
        cur = db.execute(
            """
            SELECT chunk_text, embedding_json
            FROM rag_chunks
            WHERE meeting_id = ?
            ORDER BY id DESC
            LIMIT 2500
            """,
            (req.meeting_id,),
        )
        rows = cur.fetchall()
    if not rows:
        return []
    import numpy as np

    with assistant_lock:
        qvec = assistant_runtime["embedder"].embed_texts([query])[0]
    texts: List[str] = []
    scores: List[float] = []
    for r in rows:
        try:
            vec = np.asarray(json.loads(r["embedding_json"]), dtype=np.float32)
        except Exception:
            continue
        if vec.ndim != 1 or len(vec) != len(qvec):
            continue
        score = float(vec @ qvec)
        texts.append(r["chunk_text"])
        scores.append(score)
    if not texts:
        return []
    order = np.argsort(-np.asarray(scores))[:top_k]
    chunks = [texts[int(i)] for i in order]
    return [
        {"meeting_id": req.meeting_id, "timestamp": "", "speaker": "RAG", "text": c}
        for c in chunks
    ]


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
    return {"rows": total_rows, "chunks": total_chunks, "loops": loops}


async def assistant_ingest_loop() -> None:
    if not assistant_runtime:
        return
    interval = float(getattr(assistant_runtime["module"], "PROCESS_INTERVAL", 3))
    while True:
        try:
            stats = run_assistant_ingest_once()
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
        db.execute(
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
        db.execute(
            "CREATE INDEX IF NOT EXISTS idx_transcripts_meeting_id ON transcripts(meeting_id)"
        )
        db.execute(
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
        db.execute(
            "CREATE INDEX IF NOT EXISTS idx_llm_history_meeting_id ON llm_history(meeting_id)"
        )
        db.commit()
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
                db.execute(stmt)
                db.commit()
        except sqlite3.OperationalError:
            pass


def save_transcripts(meeting_id: str, items: List[TranscriptItem]) -> int:
    if not items:
        return 0
    rows = [(meeting_id, item.timestamp, item.speaker, item.text) for item in items]
    with db_lock:
        db.executemany(
            """
            INSERT INTO transcripts (meeting_id, ts_iso, speaker, text)
            VALUES (?, ?, ?, ?)
            """,
            rows,
        )
        db.commit()
    return len(rows)


def get_recent_transcripts(meeting_id: str, limit: int = 200) -> List[Dict[str, Any]]:
    cap = max(1, min(limit, 1000))
    with db_lock:
        cur = db.execute(
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
        cur = db.execute(
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
        db.execute(
            """
            INSERT INTO llm_history (meeting_id, action, question, result, provider, model, used_llm)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (meeting_id, action, question, result, provider, model, 1 if used_llm else 0),
        )
        db.commit()


def get_llm_history(meeting_id: str, limit: int = 100) -> List[Dict[str, Any]]:
    cap = max(1, min(limit, 500))
    with db_lock:
        cur = db.execute(
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
        "graphify_available": GRAPHIFY_AVAILABLE,
        "graphify_package": "graphiti-core",
        "meeting_assistant_ready": assistant_ready,
    }


@app.get("/", response_class=HTMLResponse)
def ui_root():
    html_path = BASE_DIR / "static" / "index.html"
    return html_path.read_text(encoding="utf-8")


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
    if req.use_rag_context:
        run_assistant_ingest_once()
        lines = _rag_context_lines_for_request(req)
        if not lines:
            lines = get_recent_transcripts(req.meeting_id, req.limit)
    else:
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
        "context_mode": "rag" if req.use_rag_context else "raw",
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
        )
    return {"ok": True, "query": req.query, "answer": answer}


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
    n = save_transcripts(batch.meeting_id, batch.items)
    logger.info(
        "transcript_batch meeting_id=%s items=%s request_id=%s",
        batch.meeting_id,
        n,
        rid,
    )
    for i, item in enumerate(batch.items):
        logger.info(
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
        run_assistant_ingest_once()
    return {"accepted": n, "meeting_id": batch.meeting_id, "request_id": rid}


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
                cur = db.execute("SELECT COALESCE(MAX(id), 0) AS max_id FROM transcripts")
                row = cur.fetchone()
            _set_rag_last_transcript_id(int(row["max_id"]) if row else 0)
        assistant_runtime["processor"].reader.last_id = _get_rag_last_transcript_id()
    backfill_stats = backfill_assistant_history()
    logger.info(
        "assistant backfill completed rows=%s chunks=%s loops=%s",
        backfill_stats["rows"],
        backfill_stats["chunks"],
        backfill_stats["loops"],
    )


@app.on_event("startup")
async def startup_event() -> None:
    global assistant_background_task
    if assistant_runtime and assistant_runtime.get("ready"):
        assistant_background_task = asyncio.create_task(assistant_ingest_loop())


@app.on_event("shutdown")
async def shutdown_event() -> None:
    global assistant_background_task
    if assistant_background_task:
        assistant_background_task.cancel()
        try:
            await assistant_background_task
        except asyncio.CancelledError:
            pass
        assistant_background_task = None
