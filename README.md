# 🎙️ MeetingIQ

> **Real-time AI-powered meeting intelligence for Google Meet.**  
> Capture live captions, ask questions, and get semantic answers — all from your browser, all on your machine.

![Python](https://img.shields.io/badge/Python-3.11+-3776AB?style=flat&logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-0.110+-009688?style=flat&logo=fastapi&logoColor=white)
![Chrome MV3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?style=flat&logo=googlechrome&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-003B57?style=flat&logo=sqlite&logoColor=white)
![Tests](https://img.shields.io/badge/tests-193%20py%20%2B%2096%20js-brightgreen?style=flat)
![License](https://img.shields.io/badge/License-MIT-green?style=flat)

---

## ✨ What it does

MeetingIQ silently captures every spoken word in a Google Meet session and makes it instantly queryable with AI. No manual copy-paste, no third-party cloud storage — the transcript, the embeddings and the database all stay on your machine.

| Feature | Description |
|---|---|
| 📡 **Live capture** | Chrome extension scrapes Google Meet captions in real time via `MutationObserver` |
| 🎯 **Self-healing caption binding** | The caption box is discovered by scoring the DOM, not by fixed selectors — Meet's markup can change without breaking capture |
| ⚡ **Instant broadcast** | New captions pushed to all open dashboard tabs over WebSocket — no polling |
| 📥 **Offline-safe queue** | Batches survive service-worker shutdown and network outages; retried with exponential backoff |
| 🤖 **Multi-provider LLM** | Summarize or ask questions using **OpenAI**, **Groq**, or **Gemini** — switchable per request |
| 🧠 **Semantic RAG Q&A** | Questions answered from semantically retrieved chunks, filterable per meeting |
| 💾 **Restart-safe memory** | Embeddings persisted to SQLite as float32 BLOBs — the vector index survives backend restarts |
| 🔁 **Heuristic fallback** | Works without any API key using keyword-based summarise and Q&A |

---

## 🆕 What was updated in this revision

The last released version worked, but lost captions, produced stub-sized RAG chunks, and had no tests. This revision fixes all three. Highlights:

### Capture reliability (extension)

- **New `caption-heuristics.js`** — caption-root discovery is now a scored, testable module instead of inline guesswork in `content.js`. Meet's notification toasts carry the same `aria-live` / `role=status` markup as the caption box and used to win the scoring contest (a toast beat the caption box in **28 of 28** measured long-single-speaker frames). Toasts are now *disqualified*, not merely penalised.
- **Corroborated rebinding** — an attached caption root is only abandoned when a challenger beats it by a margin on 3 consecutive evaluations, and the old root keeps capturing throughout. A bad scoring pass can no longer tear down a working capture; only actual DOM detachment triggers an immediate rebind. Meet's caption DOM keeps no history, so every second spent observing the wrong node was permanent data loss.
- **No more swallowed speech** — the old system-line filters (`/host/i`, `/speakers?/i`, `/microphone/i`) were unanchored and silently discarded real speech containing those words. Patterns are now anchored or bounded, with regression tests in both directions.
- **Durable send queue** — MV3 terminates the service worker after ~30s idle, which used to drop queued batches. The queue is now mirrored to `chrome.storage.local` (capped at 500 batches), rehydrated before any send, and re-driven by a retry alarm and `chrome.runtime.onStartup`.
- **Debug tooling** — `__meetTranscript.enableDebug()`, `.rebinds()` and `.candidates()` in the extension's DevTools context explain every binding decision.

### RAG quality (backend)

- **Chunks accumulate across ingest cycles.** Captions arrive a few words at a time and ingest fires on every `POST /transcript`, so the old pipeline embedded one tiny stub chunk per batch. Text is now held per meeting in a pending buffer until it reaches `MA_CHUNK_SIZE`, and a meeting that goes quiet for `MA_PENDING_FLUSH_SECONDS` gets its remainder sealed automatically. `run_once()` returning `chunks: 0` while consuming rows is normal, not a failure.
- **Chunks split on line boundaries** (`seal_chunks`), never mid-utterance, and each carries a header — `[meeting <id> | <ts_start> - <ts_end> | speakers: A, B]` — so time and speaker are embedded *and* stored as columns.
- **Cross-batch dedup.** `stable_indices()` replaces `clean_stable_sentences()` and returns indices rather than text, so speaker and timestamp stay attached. It also carries the last line per meeting between runs, so a partial caption split across two batches is still deduplicated.
- **Per-meeting retrieval.** `VectorDB.search()` and `Retriever` take a `meeting_id` filter (the FAISS path over-fetches then filters), and both backends break score ties by insertion order so results don't depend on whether `faiss` is installed.
- **The similarity threshold actually works now.** `MA_SIMILARITY_THRESHOLD` was documented as `0.6` but was dead code — never read. Measured over 1095 real chunks with MiniLM-L6-v2, `0.6` drops 47% of genuinely relevant hits; the live default is **`0.25`**, which keeps 98% of them while cutting ~89% of the unrelated ones. It is also auto-disabled when the hash-fallback embedder is in use (`Embedder.is_semantic`), because hashed vectors score ~0 for everything and any threshold would filter out the entire index.
- **Embeddings stored as float32 BLOBs** instead of JSON text, with automatic migration of pre-existing databases.

### Backend structure

- `main.py` initialization moved into a `lifespan` context manager; importing `main` is now side-effect free (no DB file, no model load, no backfill), which is what makes the API test suite possible. The SQLite connection is opened lazily by `get_db()`.
- `X-Request-ID` middleware, structured transcript logging, and a `/api/meetings` endpoint for the dashboard's meeting picker.
- Fixed a Q&A fallback bug that returned the first two *characters* of each matched line instead of the line.

### Testing

- **289 tests, added from zero** — 193 pytest (`backend/tests/`) covering the API layer, chunking, cleaning, config policy, routing, retrieval and LLM fallbacks; 96 `node --test` (`extension/tests/`) covering helpers, caption-root scoring, and `content.js` itself booted in a vm against a fake page and a virtual clock.
- No API key, no network, no jsdom, no browser required for any of them.

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Google Meet (browser tab)                                  │
│  └── caption-heuristics.js ── scores caption-root candidates│
│       └── content.js ── MutationObserver ──► caption deltas │
│            └── background.js ──► POST /transcript           │
│                 (persistent queue + exponential backoff)    │
└──────────────────────────────┬──────────────────────────────┘
                               │ HTTP
┌──────────────────────────────▼──────────────────────────────┐
│  FastAPI  main.py                                           │
│  ├── POST /transcript      → SQLite + WebSocket broadcast   │
│  ├── POST /api/llm/action  → LLM service layer              │
│  ├── POST /api/assistant/* → RAG pipeline                   │
│  └── WS   /ws/transcripts  → TranscriptHub                  │
│                                                             │
│  LLM Service Layer          Meeting Assistant Pipeline      │
│  ├── service.py             ├── Processor (read/clean/seal) │
│  ├── BaseLLMProvider        ├── Embedder (MiniLM-L6-v2)     │
│  └── OpenAI │ Groq │ Gemini ├── VectorDB (FAISS / numpy)    │
│                             ├── ShortTermBuffer (90 s)      │
│  SQLite  transcripts.db     ├── RollingSummarizer           │
│  ├── transcripts            ├── QueryRouter                 │
│  ├── llm_history            └── LlmClient (gpt-4o-mini)     │
│  ├── rag_chunks  ◄──── persisted float32 embeddings         │
│  └── rag_state   ◄──── ingest cursor                        │
└─────────────────────────────────────────────────────────────┘
```

---

## 📁 Project Structure

```
MeetingIQ/
├── backend/
│   ├── main.py                    # FastAPI app — endpoints, DB, RAG lifecycle
│   ├── requirements.txt
│   ├── requirements-dev.txt       # -r requirements.txt + pytest
│   ├── pytest.ini
│   ├── llm/
│   │   ├── base.py                # BaseLLMProvider abstract interface
│   │   ├── registry.py            # Singleton provider map
│   │   ├── service.py             # run_llm_action() orchestrator + heuristics
│   │   ├── openai_provider.py
│   │   ├── groq_provider.py
│   │   └── gemini_provider.py
│   ├── meeting-assistant/
│   │   ├── main.py                # build_system(), answer_query()
│   │   ├── config.py              # All env-var config + resolve_min_score()
│   │   ├── db/sqlite_reader.py    # Cursor-based transcript reader
│   │   ├── processing/
│   │   │   ├── cleaner.py         # stable_indices() — cross-batch dedup
│   │   │   ├── chunker.py         # seal_chunks(), render_chunk(), chunk_meta()
│   │   │   └── processor.py       # Ingest orchestrator + pending buffer
│   │   ├── embedding/embedder.py  # MiniLM-L6-v2 + hash fallback (is_semantic)
│   │   ├── memory/
│   │   │   ├── vectordb.py        # FAISS IndexFlatIP + numpy, meeting_id filter
│   │   │   ├── buffer.py          # 90-second sliding deque
│   │   │   └── summarizer.py      # Rolling text compressor
│   │   ├── retrieval/retriever.py # embed → VectorDB search + min_score floor
│   │   ├── query/router.py        # Keyword query router
│   │   └── llm/
│   │       ├── llm_client.py      # Thin OpenAI wrapper
│   │       └── prompt_builder.py  # build_prompt(context, question)
│   ├── static/index.html          # Dashboard UI (served at GET /)
│   └── tests/                     # 193 pytest tests
└── extension/
    ├── manifest.json              # MV3 declaration
    ├── utils.js                   # Shared helpers
    ├── caption-heuristics.js      # Caption-root scoring + rebind arbiter
    ├── content.js                 # MutationObserver caption scraper
    ├── background.js              # Service worker — persistent queue + retry
    ├── popup.html / popup.js      # On/off toggle
    ├── styles/inject.css
    └── tests/                     # 96 node --test tests
```

Manifest load order is `utils.js` → `caption-heuristics.js` → `content.js`, and it matters: `content.js` hard-depends on the heuristics module and stays idle with a `console.error` if it is missing.

---

## 🚀 How to run this project

### Prerequisites

- **Python 3.11+** (3.13 works)
- **Node 18+** — only if you want to run the extension tests
- **Google Chrome 114+**

### 1. Clone

```bash
git clone https://github.com/ksilenteye/MeetingIQ.git
cd MeetingIQ
```

### 2. Start the backend

```bash
cd backend
python -m venv .venv

# Windows (PowerShell)
.venv\Scripts\Activate.ps1
# macOS / Linux
source .venv/bin/activate

pip install -r requirements.txt

# strongly recommended — real semantic embeddings instead of the hash fallback
pip install sentence-transformers

# optional — faster vector search (falls back to numpy if absent)
pip install faiss-cpu

python -m uvicorn main:app --reload --port 8000
```

> **`uvicorn : The term 'uvicorn' is not recognized`?** The package is installed, but its
> `.exe` isn't on `PATH` — Microsoft Store Python only exposes `python` and `pip`, and
> console scripts land in an unlisted `LocalCache\...\Scripts\` folder. Always use the
> `python -m uvicorn` form above (same for `python -m pytest`), or activate a venv, which
> puts that folder on `PATH` for the session.

Dashboard is now live at **http://localhost:8000**.

First start creates `transcripts.db`, applies migrations, rehydrates the vector index and backfills any transcripts already in the database — so it can take a few seconds before `/health` reports `meeting_assistant_ready: true`.

### 3. Load the Chrome extension

1. Open **chrome://extensions**
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select the `extension/` folder
4. The 🎙️ icon appears in your toolbar

There is no build step. After editing extension files, hit **Reload** on the extension card and refresh the Meet tab.

> Against a **hosted** backend, download the extension from the dashboard's "Get started" panel instead (`GET /api/extension.zip`) and load the extracted folder. The server rewrites `API_URL` and `host_permissions` to its own origin as it builds the archive, so no URL is ever committed and there is nothing to configure. On Windows use **Extract All** — Chrome cannot load an extension from the zip preview window.

### 4. Start a Google Meet

Open any Google Meet and turn on **Live captions** (the `CC` button) — nothing is captured without them. Captions flow to the dashboard automatically.

### 5. Ask questions

In the dashboard: paste or pick the meeting ID, choose a provider, paste an API key (or tick **Allow heuristic fallback**), pick **Summarise** or **Q&A**, and hit **Run Action**.

### Verify the whole chain

```bash
curl http://localhost:8000/health                       # meeting_assistant_ready: true
curl http://localhost:8000/api/meetings                 # your meeting should be listed
curl http://localhost:8000/api/assistant/status         # ingest stats
```

Extension badge: *(empty)* means streaming is fine; **`!`** means the last batch failed after 6 retries — check that the backend is running on port 8000.

---

## 🔑 API Keys

Set in the dashboard UI (stored in `localStorage`, sent per request) **or** via environment variables:

| Provider | Env var | Default model |
|---|---|---|
| OpenAI | `OPENAI_API_KEY` | `gpt-4o-mini` |
| Groq | `GROQ_API_KEY` | `llama-3.3-70b-versatile` |
| Gemini | `GOOGLE_API_KEY` / `GEMINI_API_KEY` | `gemini-2.0-flash` |

```bash
# Example — set before running uvicorn
export OPENAI_API_KEY=sk-...
export GROQ_API_KEY=gsk_...
```

> **No key?** The system falls back to keyword-based summarise and Q&A automatically.  
> Tick **Allow heuristic fallback** in the dashboard to enable it.
>
> `/api/assistant/query` is OpenAI-only and reads `OPENAI_API_KEY` **at build time** — set it before starting uvicorn. `/api/llm/action` takes a key per request and supports all three providers.

---

## 🧠 How RAG works

Every caption line goes through this pipeline before it is queryable:

```
Raw caption  →  stable_indices()      →  pending buffer  →  seal_chunks()
                (dedup partial lines,    (per meeting,      (line-aligned,
                 across batches too)      until 500 chars)   50 char overlap)

    →  Embedder.embed_texts()   →   VectorDB.add()   →  rag_chunks (SQLite)
       (MiniLM-L6-v2, 384-dim)     (FAISS or numpy)     (float32 BLOB)
```

Captions arrive a few words at a time, so text accumulates per meeting until it reaches the chunk size instead of producing one stub chunk per caption batch. A meeting that goes quiet for `MA_PENDING_FLUSH_SECONDS` has its remainder sealed automatically, so short meetings still land. The short-term buffer and rolling summary are updated immediately and never wait on this.

Each chunk is stored with a header so time and speaker are retrievable:

```
[meeting abc-defg-hij | 2026-07-28T10:00:00Z - 2026-07-28T10:04:12Z | speakers: Alice, Bob]
Alice: The Q3 hiring budget was approved this morning.
Bob: We will revisit headcount planning again in August.
```

When you ask a question, **QueryRouter** decides which memory tier to use — it is pure keyword matching, so phrasing chooses the tier:

| Query contains | Strategy | Context source |
|---|---|---|
| "just now", "recent", "latest", "now" | **Buffer** | Raw 90-second sliding window |
| "so far", "summary", "overall", "recap" | **Summary** | Compressed rolling summary + recent buffer |
| Anything else | **Retrieval** | Top-K semantically similar chunks from VectorDB |

Retrieved chunks scoring below `MA_SIMILARITY_THRESHOLD` are dropped, so an off-topic question returns nothing rather than the least-bad chunk in the index. `/api/llm/action` falls back to raw transcript rows when that leaves it with no context, and reports `context_mode: "raw_fallback"` so you can tell the two apart.

The threshold only applies when real embeddings are in use. Without `sentence-transformers` the hash fallback produces near-orthogonal vectors for any two different sentences, so every score sits near zero and any threshold would filter out everything; it is disabled automatically in that case unless you set `MA_SIMILARITY_THRESHOLD` yourself.

### Restart-safe persistence

| Table | Purpose |
|---|---|
| `rag_chunks` | Chunk text, float32 embedding BLOB, and `ts_start` / `ts_end` / `speakers` — VectorDB rehydrated from this on startup |
| `rag_state` | Single-row cursor (`last_transcript_id`) — ingest resumes from the right position after a restart |

> Databases created before the BLOB change are migrated automatically on first start (embeddings were previously stored as JSON text). Existing rows are preserved; expect the file to shrink substantially after a `VACUUM`.

> ⚠️ **Switching embedders invalidates the index.** Embeddings are validated by dimension only, and both MiniLM and the hash fallback produce 384-dim vectors — so a database written without `sentence-transformers` will happily load its garbage vectors into a MiniLM index. Wipe `rag_chunks` and reset `rag_state.last_transcript_id` when you install or remove `sentence-transformers`.

---

## 🌐 API Reference

### Transcript

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/transcript` | Ingest a batch of caption lines |
| `GET` | `/api/transcripts` | Fetch recent lines for a meeting |
| `GET` | `/api/meetings` | List meetings present in the database |
| `WS` | `/ws/transcripts` | Live broadcast stream |

### LLM Actions

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/llm/action` | Run summarise or Q&A |
| `GET` | `/api/llm/history` | Fetch past LLM results |
| `GET` | `/api/llm/providers` | List available providers |

**`POST /api/llm/action` body:**

```json
{
  "meeting_id": "abc-defg-hij",
  "action": "qa",
  "question": "What did Majid say about diffusion models?",
  "provider": "groq",
  "api_key": "gsk_...",
  "model": null,
  "limit": 120,
  "allow_fallback": true,
  "use_rag_context": true,
  "rag_top_k": 8
}
```

Response includes `context_mode` (`rag` / `raw` / `raw_fallback`), `context_items` and `used_llm`, so you can tell whether the answer came from retrieval, from raw rows, or from the keyword heuristic.

### Meeting Assistant (RAG pipeline)

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/assistant/query` | Semantic Q&A — `{"query": "...", "meeting_id": "abc-defg-hij"}`; `meeting_id` optional (omit to search every meeting) |
| `POST` | `/api/assistant/ingest` | Manually trigger one ingest cycle |
| `GET` | `/api/assistant/status` | Pipeline ready status + stats |
| `GET` | `/health` | Server health check |

Every response carries an `X-Request-ID` header (echoed from the request if you supply one).

### The two Q&A paths differ

| | `/api/llm/action` | `/api/assistant/query` |
|---|---|---|
| Providers | openai / groq / gemini, key per request | OpenAI only, `OPENAI_API_KEY` at build time |
| Retrieval | `Retriever.search_detailed()` when `use_rag_context` | `QueryRouter` picks buffer / summary / VectorDB |
| Scope | per-meeting | optional `meeting_id`, omit for all meetings |
| No context | drops to raw rows, reports `raw_fallback` | empty context |
| Fallback | heuristic summarise/Q&A when no key | returns a prompt preview |
| History | written to `llm_history` | not persisted |

---

## ⚙️ Configuration

All meeting-assistant settings are controlled via environment variables:

| Variable | Default | Description |
|---|---|---|
| `MA_CHUNK_SIZE` | `500` | Characters per text chunk |
| `MA_OVERLAP` | `50` | Overlap between adjacent chunks |
| `MA_BUFFER_TIME` | `90` | Short-term buffer window in seconds |
| `MA_PROCESS_INTERVAL` | `3` | Seconds between ingest loop ticks |
| `MA_PENDING_FLUSH_SECONDS` | `30` | Quiet period after which a meeting's partial chunk is sealed |
| `MA_EMBEDDING_DIM` | `384` | Embedding vector dimension |
| `MA_TOP_K` | `5` | Default retrieval results count |
| `MA_SIMILARITY_THRESHOLD` | `0.25` | Minimum cosine similarity to include a result; ignored when the hash-fallback embedder is in use unless you set it yourself |
| `MA_SUMMARY_MAX_CHARS` | `4000` | Rolling summarizer buffer before compression |
| `MA_SUMMARY_TARGET_CHARS` | `1200` | Rolling summarizer target length after compression |
| `MA_TRANSCRIPT_DB_PATH` | `../transcripts.db` | Path to SQLite DB, relative to `backend/meeting-assistant/` |
| `TRANSCRIPT_DB_PATH` | *(unset)* | Override DB path for the FastAPI backend |

> The two DB paths resolve to the same file by coincidence of layout. Overriding one without the other splits the system across two databases.

---

## 🔌 Extension Settings

Click the 🎙️ icon to **enable / disable** capture — that is the only setting in the popup.

The backend URL is **hardcoded** as `API_URL` in `background.js` and pinned again in `manifest.json` under `host_permissions` (localhost / 127.0.0.1 on port 8000). Changing host or port means editing **both** files and reloading the extension.

Badge states:

- *(empty)* — streaming OK
- **`!`** — last batch failed after 6 retries (check the backend is running)

Debugging capture, from the extension's DevTools context:

```js
__meetTranscript.enableDebug()   // log every rebind decision + score breakdowns
__meetTranscript.rebinds()       // last 100 rebinds (recorded even with debug off)
__meetTranscript.candidates()    // score the current page right now
```

---

## 🛠️ Development

### Running the tests

```bash
cd backend
pip install -r requirements-dev.txt
python -m pytest                                       # 193 tests
python -m pytest tests/test_processor.py -k accumulation -v   # single file / pattern

cd ..
node --test extension/tests/*.test.mjs                 # 96 tests, no deps
```

Nothing here needs an API key or a network connection. The extension tests have no dependencies either — caption-root selection runs against fake elements, and `content.js` itself is booted in a vm with a fake page, fake `chrome.*` and a virtual clock, so debounce/throttle timings run deterministically. There is no jsdom and no browser involved.

> `node --test extension/tests/` (directory form) fails on Node 24 — pass the file glob as shown.

### Running with auto-reload

```bash
cd backend
python -m uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

### Testing the ingest pipeline manually

```bash
curl -X POST http://localhost:8000/api/assistant/ingest   # force one ingest cycle
curl http://localhost:8000/api/assistant/status           # RAG pipeline status
curl http://localhost:8000/health                         # health check
```

### Posting a test transcript batch

```bash
curl -X POST http://localhost:8000/transcript \
  -H "Content-Type: application/json" \
  -d '{
    "meeting_id": "test-meeting-001",
    "items": [
      {"timestamp": "2026-07-28T10:00:00Z", "speaker": "Alice", "text": "Let us discuss the Q2 roadmap."},
      {"timestamp": "2026-07-28T10:00:05Z", "speaker": "Bob",   "text": "I think we should prioritise the RAG pipeline first."}
    ]
  }'
```

### Checking the database

```bash
cd backend
sqlite3 transcripts.db

.tables
-- transcripts  llm_history  rag_chunks  rag_state

SELECT COUNT(*) FROM rag_chunks;
SELECT last_transcript_id FROM rag_state;
```

### Standalone assistant REPL

The RAG pipeline has its own entry point, but it only runs from inside its own directory because of its flat imports:

```bash
cd backend/meeting-assistant && python main.py
```

### Note on the two `llm` packages

`backend/llm/` (multi-provider) and `backend/meeting-assistant/llm/` (thin OpenAI client) are both importable as top-level `llm`. `main.py` loads the assistant through a `sys.modules` swap to keep them apart. Practical consequence: assistant modules must keep using flat imports (`from config import ...`), and nothing under `meeting-assistant/` should import the multi-provider layer. See [CLAUDE.md](CLAUDE.md) for the full detail.

---

## 📦 Dependencies

### Backend (`requirements.txt`)

```
fastapi>=0.115.0,<0.142.0
uvicorn[standard]>=0.30.0,<0.53.0
pydantic>=2.9.0,<3.0.0
numpy>=1.26.0,<3.0.0
openai>=1.40.0,<3.0.0
google-generativeai==0.8.6
```

Upper bounds are deliberate — the hosted deployment rebuilds on every push, and a surprise major release shouldn't be able to break it. `google-generativeai` is imported lazily inside `GeminiProvider.complete()`, so it costs nothing at startup unless you actually pick Gemini.

### Optional (recommended)

```bash
pip install sentence-transformers   # real semantic embeddings (MiniLM-L6-v2)
pip install faiss-cpu               # fast vector search (falls back to numpy)
```

> The system runs without any optional dependencies using hash-based embeddings and numpy vector search — but hashed vectors are not semantic, so Q&A quality is materially worse. Install `sentence-transformers` for meaningful semantic retrieval.

### Dev (`requirements-dev.txt`)

```
-r requirements.txt
pytest>=8.0.0
```

---

## 🗺️ Roadmap

- [ ] Streaming LLM responses via WebSocket (server-sent events)
- [ ] Configurable backend URL in the extension popup
- [ ] Async embedding queue for large transcript backlogs
- [ ] Speaker time-series analytics in dashboard
- [ ] Export transcript + summary as PDF / DOCX
- [ ] Docker Compose setup for one-command deployment
- [ ] Support for additional LLM providers
- [x] Cross-meeting search across all stored `rag_chunks`
- [x] Test coverage for backend and extension

---

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Run both suites — `python -m pytest` and `node --test extension/tests/*.test.mjs`
4. Commit your changes: `git commit -m "feat: add my feature"`
5. Push and open a Pull Request

Please open an issue first for large changes.

---

## 📄 License

MIT — see [LICENSE](LICENSE) for details.

---

<p align="center">
  Built with FastAPI · sentence-transformers · FAISS · Chrome MV3
</p>
