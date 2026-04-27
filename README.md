# 🎙️ Meet Transcript

> **Real-time AI-powered meeting intelligence for Google Meet.**  
> Capture live captions, ask questions, and get semantic answers — all from your browser.

![Python](https://img.shields.io/badge/Python-3.11+-3776AB?style=flat&logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-0.110+-009688?style=flat&logo=fastapi&logoColor=white)
![Chrome MV3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?style=flat&logo=googlechrome&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-003B57?style=flat&logo=sqlite&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green?style=flat)

---

## ✨ What it does

Meet Transcript silently captures every spoken word in a Google Meet session and makes it instantly queryable with AI. No manual copy-paste, no third-party cloud storage — everything stays local.

| Feature | Description |
|---|---|
| 📡 **Live capture** | Chrome extension scrapes Google Meet captions in real time via `MutationObserver` |
| ⚡ **Instant broadcast** | New captions pushed to all open dashboard tabs over WebSocket — no polling |
| 🤖 **Multi-provider LLM** | Summarize or ask questions using **OpenAI**, **Groq**, or **Gemini** — switchable per request |
| 🧠 **Semantic RAG Q&A** | Questions answered from semantically retrieved chunks, not raw keyword search |
| 💾 **Restart-safe memory** | Embeddings persisted to SQLite — vector index survives backend restarts |
| 🔁 **Heuristic fallback** | Works without any API key using keyword-based summarise and Q&A |

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Google Meet (browser tab)                                  │
│  └── content.js  ── MutationObserver ──► caption lines      │
│       └── background.js ──► POST /transcript (retry queue)  │
└──────────────────────────────┬──────────────────────────────┘
                               │ HTTP
┌──────────────────────────────▼──────────────────────────────┐
│  FastAPI  main.py                                           │
│  ├── POST /transcript   → SQLite + WebSocket broadcast      │
│  ├── POST /api/llm/action  → LLM service layer              │
│  ├── POST /api/assistant/* → RAG pipeline                   │
│  └── WS   /ws/transcripts  → TranscriptHub                 │
│                                                             │
│  LLM Service Layer          Meeting Assistant Pipeline      │
│  ├── service.py             ├── Processor (read/clean/chunk)│
│  ├── BaseLLMProvider        ├── Embedder (MiniLM-L6-v2)     │
│  └── OpenAI │ Groq │ Gemini ├── VectorDB (FAISS / numpy)   │
│                             ├── ShortTermBuffer (90 s)      │
│  SQLite  transcripts.db     ├── RollingSummarizer           │
│  ├── transcripts            ├── QueryRouter                 │
│  ├── llm_history            └── LlmClient (gpt-4o-mini)    │
│  ├── rag_chunks  ◄──── persisted embeddings                 │
│  └── rag_state   ◄──── ingest cursor                       │
└─────────────────────────────────────────────────────────────┘
```

---

## 📁 Project Structure

```
meet-transcript/
├── backend/
│   ├── main.py                    # FastAPI app — all endpoints, DB, RAG lifecycle
│   ├── requirements.txt
│   ├── llm/
│   │   ├── base.py                # BaseLLMProvider abstract interface
│   │   ├── registry.py            # Singleton provider map
│   │   ├── service.py             # run_llm_action() orchestrator
│   │   ├── openai_provider.py
│   │   ├── groq_provider.py
│   │   └── gemini_provider.py
│   ├── meeting-assistant/
│   │   ├── main.py                # build_system(), answer_query()
│   │   ├── config.py              # All env-var config
│   │   ├── db/sqlite_reader.py    # Cursor-based transcript reader
│   │   ├── processing/
│   │   │   ├── cleaner.py         # Dedup partial captions (SequenceMatcher)
│   │   │   ├── chunker.py         # Sliding-window text chunker
│   │   │   └── processor.py       # Ingest orchestrator
│   │   ├── embedding/embedder.py  # MiniLM-L6-v2 + hash fallback
│   │   ├── memory/
│   │   │   ├── vectordb.py        # FAISS IndexFlatIP + numpy fallback
│   │   │   ├── buffer.py          # 90-second sliding deque
│   │   │   └── summarizer.py      # Rolling text compressor
│   │   ├── retrieval/retriever.py # embed → VectorDB search
│   │   ├── query/router.py        # Keyword query router
│   │   └── llm/
│   │       ├── llm_client.py      # Thin OpenAI wrapper
│   │       └── prompt_builder.py  # build_prompt(context, question)
│   └── static/index.html          # Dashboard UI (served at GET /)
└── extension/
    ├── manifest.json              # MV3 declaration
    ├── content.js                 # MutationObserver caption scraper
    ├── background.js              # Service worker — POST with retry
    ├── utils.js                   # Shared helpers
    ├── popup.html / popup.js      # Extension settings popup
    └── styles/inject.css
```

---

## 🚀 Quick Start

### 1. Clone

```bash
git clone https://github.com/ksilenteye/MeetingIQ/.git
cd meet-transcript
```

### 2. Backend

```bash
cd backend
pip install -r requirements.txt

# Optional — install sentence-transformers for real embeddings
pip install sentence-transformers

# Optional — install FAISS for faster vector search
pip install faiss-cpu

uvicorn main:app --reload --port 8000
```

Dashboard is now live at **http://localhost:8000**

### 3. Chrome Extension

1. Open **chrome://extensions**
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select the `extension/` folder
4. The 🎙️ icon appears in your toolbar

### 4. Start a Google Meet

Open any Google Meet — captions will flow to the dashboard automatically.  
Make sure **Live captions** are enabled in Meet (`CC` button).

---

## 🔑 API Keys

Set in the dashboard UI **or** via environment variables:

| Provider | Env var | Default model |
|---|---|---|
| OpenAI | `OPENAI_API_KEY` | `gpt-4o-mini` |
| Groq | `GROQ_API_KEY` | `llama-3.3-70b-versatile` |
| Gemini | `GOOGLE_API_KEY` | `gemini-2.0-flash` |

```bash
# Example — set before running uvicorn
export OPENAI_API_KEY=sk-...
export GROQ_API_KEY=gsk_...
```

> **No key?** The system falls back to keyword-based summarise and Q&A automatically.  
> Check **Allow heuristic fallback** in the dashboard to enable this.

---

## 🧠 How RAG Works

Every caption line goes through a 5-stage pipeline before being queryable:

```
Raw caption  →  clean_stable_sentences()  →  chunk_text()
                (dedup partial lines)        (500 char windows, 50 overlap)

    →  Embedder.embed_texts()   →   VectorDB.add()   →  rag_chunks (SQLite)
       (MiniLM-L6-v2, 384-dim)     (FAISS or numpy)     (persisted)
```

When you ask a question, **QueryRouter** decides which memory tier to use:

| Query contains | Strategy | Context source |
|---|---|---|
| "just now", "recent", "latest" | **Buffer** | Raw 90-second sliding window |
| "so far", "summary", "recap" | **Summary** | Compressed rolling summary + recent buffer |
| Anything else | **Retrieval** | Top-5 semantically similar chunks from VectorDB |

### Restart-safe persistence

| Table | Purpose |
|---|---|
| `rag_chunks` | Every chunk text + its embedding JSON — VectorDB rehydrated from this on startup |
| `rag_state` | Single-row cursor (`last_transcript_id`) — ingest resumes from the right position after a restart |

---

## 🌐 API Reference

### Transcript

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/transcript` | Ingest a batch of caption lines |
| `GET` | `/api/transcripts` | Fetch recent lines for a meeting |
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

### Meeting Assistant (RAG pipeline)

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/assistant/query` | Semantic Q&A via RAG pipeline |
| `POST` | `/api/assistant/ingest` | Manually trigger one ingest cycle |
| `GET` | `/api/assistant/status` | Pipeline ready status + stats |
| `GET` | `/health` | Server health check |

---

## ⚙️ Configuration

All meeting-assistant settings are controlled via environment variables:

| Variable | Default | Description |
|---|---|---|
| `MA_CHUNK_SIZE` | `500` | Characters per text chunk |
| `MA_OVERLAP` | `50` | Overlap between adjacent chunks |
| `MA_BUFFER_TIME` | `90` | Short-term buffer window in seconds |
| `MA_PROCESS_INTERVAL` | `3` | Seconds between ingest loop ticks |
| `MA_EMBEDDING_DIM` | `384` | Embedding vector dimension |
| `MA_TOP_K` | `5` | Default retrieval results count |
| `MA_SIMILARITY_THRESHOLD` | `0.6` | Minimum cosine similarity to include a result |
| `MA_SUMMARY_MAX_CHARS` | `4000` | Rolling summarizer buffer before compression |
| `MA_SUMMARY_TARGET_CHARS` | `1200` | Rolling summarizer target length after compression |
| `MA_TRANSCRIPT_DB_PATH` | `../transcripts.db` | Path to SQLite database |
| `TRANSCRIPT_DB_PATH` | *(unset)* | Override DB path for the FastAPI backend |

---

## 🔌 Extension Settings

Click the 🎙️ extension icon to configure:

- **Backend URL** — defaults to `http://localhost:8000/transcript`  
- **Enable / Disable** — toggle caption streaming without removing the extension

The extension badge shows:
- *(empty)* — streaming OK
- **`!`** — last batch failed after 6 retries (check backend is running)

---

## 🛠️ Development

### Running with auto-reload

```bash
cd backend
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

### Testing the ingest pipeline manually

```bash
# Trigger one ingest cycle
curl -X POST http://localhost:8000/api/assistant/ingest

# Check RAG pipeline status
curl http://localhost:8000/api/assistant/status

# Health check
curl http://localhost:8000/health
```

### Posting a test transcript batch

```bash
curl -X POST http://localhost:8000/transcript \
  -H "Content-Type: application/json" \
  -d '{
    "meeting_id": "test-meeting-001",
    "items": [
      {"timestamp": "2026-04-27T10:00:00Z", "speaker": "Alice", "text": "Let us discuss the Q2 roadmap."},
      {"timestamp": "2026-04-27T10:00:05Z", "speaker": "Bob",   "text": "I think we should prioritise the RAG pipeline first."}
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

---

## 📦 Dependencies

### Backend (`requirements.txt`)

```
fastapi>=0.110.0
uvicorn[standard]>=0.29.0
pydantic>=2.6.0
openai>=1.40.0
google-generativeai>=0.8.0
```

### Optional (recommended)

```bash
pip install sentence-transformers   # real semantic embeddings (MiniLM-L6-v2)
pip install faiss-cpu               # fast vector search (falls back to numpy)
pip install groq                    # Groq provider (uses openai SDK with custom base_url)
```

> The system runs without any optional dependencies using hash-based embeddings and numpy vector search. Install `sentence-transformers` for meaningful semantic Q&A.

---

## 🗺️ Roadmap

- [ ] Streaming LLM responses via WebSocket (server-sent events)
- [ ] Cross-meeting search across all stored rag_chunks
- [ ] Async embedding queue for large transcript backlogs
- [ ] Speaker time-series analytics in dashboard
- [ ] Export transcript + summary as PDF / DOCX
- [ ] Docker Compose setup for one-command deployment
- [ ] Support for additional LLM providers 
---

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Commit your changes: `git commit -m "feat: add my feature"`
4. Push and open a Pull Request

Please open an issue first for large changes.

---

## 📄 License

MIT — see [LICENSE](LICENSE) for details.

---

<p align="center">
  Built with FastAPI · sentence-transformers · FAISS · Chrome MV3
</p>
