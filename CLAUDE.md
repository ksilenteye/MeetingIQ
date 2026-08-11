# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Chrome MV3 extension scrapes Google Meet live captions → FastAPI backend stores them in SQLite, broadcasts over WebSocket, and answers questions about them via LLMs and a local RAG pipeline. Everything runs locally; no cloud storage.

## Commands

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000        # landing at / , dashboard at /app

# optional, materially changes behavior:
pip install sentence-transformers   # real MiniLM-L6-v2 embeddings (else hash-based fallback)
pip install faiss-cpu               # FAISS IndexFlatIP (else numpy matmul search)
pip install groq                    # not actually imported — GroqProvider uses the openai SDK
```

The extension is loaded unpacked from `extension/` via `chrome://extensions` (Developer mode → Load unpacked). There is no build step.

Tests (no linter config or CI in this repo):

```bash
cd backend
pip install -r requirements-dev.txt
python -m pytest                          # 231 tests
python -m pytest tests/test_processor.py -k accumulation -v   # single file / pattern

cd .. && node --test extension/tests/*.test.mjs               # 137 tests, no deps

# score a block of leaked Meet UI the way the extension would, without a live call
node extension/tests/score-block.mjs < block.txt
```

`node --test extension/tests/` (directory form) fails on Node 24 — pass the files. The extension tests are: `utils.test.mjs` (helpers), `caption-root.test.mjs` (root scoring + rebind arbiter, pure), `content-capture.test.mjs` (content.js booted in a vm against a fake page, fake `chrome.*` and a virtual clock, so debounce/throttle timings run deterministically).

`backend/tests/conftest.py` pins `backend/` ahead of `meeting-assistant/` on `sys.path` (the two-`llm`-packages problem below) and stubs `openai`/`google.generativeai` when they aren't installed. `tests/test_main.py` drives the real app through `TestClient` but stubs the assistant runtime — building it for real loads MiniLM and costs seconds per test.

Manual smoke checks:

```bash
curl http://localhost:8000/health                       # includes meeting_assistant_ready
curl http://localhost:8000/api/assistant/status         # ingest stats
curl -X POST http://localhost:8000/api/assistant/ingest # force one ingest cycle
sqlite3 backend/transcripts.db ".tables"                # transcripts llm_history rag_chunks rag_state
```

The meeting-assistant pipeline also has a standalone REPL, but it only works from inside its own directory because of its flat imports:

```bash
cd backend/meeting-assistant && python main.py
```

## Architecture

### Two separate `llm` packages — the main import hazard

`backend/llm/` (multi-provider: OpenAI/Groq/Gemini) and `backend/meeting-assistant/llm/` (thin OpenAI-only client) are both top-level-importable packages named `llm`. `main.py:_load_meeting_assistant_module()` works around this: it inserts `backend/meeting-assistant` into `sys.path`, **pops every `llm*` module out of `sys.modules`**, loads the assistant via `importlib.util.spec_from_file_location`, then restores them. The directory name `meeting-assistant` contains a hyphen and is deliberately not a package.

Consequences when editing:
- Assistant modules must keep using flat imports (`from config import ...`, `from memory.buffer import ...`). Adding `backend.`-style or relative imports breaks the loader.
- Anything in `backend/meeting-assistant/` importing the multi-provider layer will silently get the wrong `llm` package.

### Startup sequence

`backend/main.py` does all of its initialization in the `lifespan` async context manager: `await run_in_threadpool(bootstrap)` (schema + migrations, `setup_meeting_assistant()`, rag_chunks dedupe, VectorDB rehydration, full backfill loop), then the 3-second ingest loop task. Shutdown cancels that task.

Importing `main` is deliberately side-effect free — no DB file, no embedding model, no backfill — which is what makes `tests/test_main.py` possible. Two consequences:

- The SQLite connection is opened on first use by `get_db()`, which is also where `TRANSCRIPT_DB_PATH` is read. Never cache the connection in a module global; there is no `db` global any more.
- A script that imports `main` and expects a working database must call `main.bootstrap()` (idempotent) or drive the app through `with TestClient(main.app)`. Bare `TestClient(main.app)` without the context manager skips lifespan and leaves the schema uncreated.

`lifespan` is defined above `app = FastAPI(..., lifespan=lifespan)` and references functions declared much further down the file; that resolves at startup, not at definition.

### Transcript flow

`content.js` binds a `MutationObserver` to a dynamically discovered caption root (scored over `aria-live` / `role=log` candidates — no fixed selectors, since Meet's DOM changes). It emits **only the new suffix** of each caption via `computeCaptionDelta`, not the full growing line, then batches to `background.js`, which POSTs to `/transcript` with exponential backoff (6 attempts, badge `!` on give-up).

`utils.js` defines the shared helpers; `content.js` re-implements every one of them inline as a fallback (the `U` object) in case the bundle order fails. Changing a helper means changing it in both places. **`caption-heuristics.js` is the deliberate exception** — it is too large to keep a second copy of, so `content.js` hard-depends on it and stays idle (with a `console.error`) if it is missing. Manifest load order is `utils.js`, `caption-heuristics.js`, `content.js`.

### Finding the candidates (`collectCandidates` in `content.js`)

Scoring can only choose among elements the collector hands it, and **the collector missing the caption box looks exactly like a scoring bug from the dashboard** — Meet UI in the transcript either way. Two failures here were diagnosed only by probing a live call:

- **Meet's caption box carries no live-region markup.** The whole page had *two* elements matching `[aria-live]` / `[role=log|status]`, and both were notification surfaces. The caption text sits in an attribute-less `div` two levels under a `[role="region"]` wrapper, which is now in the narrow pool. Bind the landmark, not the text node: Meet swaps caption nodes rather than editing them, and the observer is `subtree: true`.
- **The wide `[jsname]` fallback was capped in document order.** `.slice(0, 80)` against a 538-element pool, with the caption box at **index 484** — the fallback could never rescue a missed caption box. The pre-filter now runs on `textContent` (no forced layout) before the cap.

The popup is the diagnostic surface for all of this: a self-test showing whether the loaded build filters each known UI leak, what the content script actually bound to, and a **Find caption element** probe that works backwards from visible text to report the element's markup, ancestor chain, and index in the `[jsname]` pool. Reach for it before changing any heuristic — three rounds of pattern work here fixed real leaks but never touched the actual cause.

### Caption-root selection (`caption-heuristics.js`)

Meet's notification toasts carry the same `aria-live` / `role=status` markup as the caption box, and Meet swaps caption nodes rather than editing them. Meet's caption DOM keeps no history, so **any window spent observing the wrong element is permanent data loss**, not delayed capture. Three rules exist because of that:

- **Toasts are disqualified, not penalised.** `looksLikeNotificationBlock()` returns true for a block with notification text and no `Speaker: text` line, or a small block carrying a dismiss-button label. Such candidates score `DISQUALIFIED` (-1000) and can never be bound. `isPlausibleSpeakerName()` rejects `UI_CONTROL_LABELS`, so a toast's "Close" button cannot become a speaker.
- **Two whole-line button labels mark a block as UI.** Meet's sharing and device panels alternate a control label with a line of descriptive text — structurally identical to its *speaker-label* caption layout (name on one line, speech beneath), so every per-line check scores them as captions. Observed live: such a panel scored 129 against the caption box's 137, a margin carried entirely by `horizontally-centred`, and it took and held the binding — recording "Add others" and "Stop sharing" as speakers. The `captionLines > 0` guard does not help, because label-layout captions have no colons either. The rule that separates them is count: a caption box never contains two whole-line button labels, a panel always does.
- **The switch margin defends rivals, not leftovers.** `findAndBindCaptionRoot` passes `bound.discoverable` — false when the bound element is no longer returned by any collector selector. `describeAndScore` still re-scores it so capture continues, but the arbiter hands the binding straight to any viable candidate instead of applying the margin. Without this, a root bound before the caption box became findable held on permanently: observed live as `bound c60`, c60 absent from a 5-element candidate list, and the caption box sitting unbound at 52 while `Unknown / Other ways to join` kept reaching the database. Omitting the flag preserves the old behaviour, so only the collector opts in.
- **Switching roots requires corroboration.** `createRootArbiter()` only abandons an *attached, discoverable* root when a challenger beats it by `SWITCH_MARGIN` (12) on `SWITCH_STREAK` (3) consecutive evaluations — up to ~2.4 s at the 800 ms discovery throttle, during which the old root is still bound and still capturing. A *detached* root rebinds immediately; waiting there would be pure loss.
- **A bad scoring pass never tears down capture.** Only detachment unbinds. While unbound, `rootObserver` drives `debouncedDigest()` and `digestCaptionDom` reads the best candidate directly, so a rebind is not a gap. `bindObserverTo` keeps `lastEmittedCumulativeBySpeaker` across rebinds; clearing it re-emits whatever is still on screen.

Measured against the reconstructed pre-fix scorer: a toast scored 132 vs the caption box's 117 in **28 of 28** long-single-speaker frames. It now scores -1000, or 89 vs 132 with disqualification bypassed.

Meet has **more than one** aria-live surface that competes with the caption box, and they leak one at a time depending on what is on screen — so a session that shows no change after a fix usually means a *different* surface is bound, not that the fix failed. Two are known and regression-tested: the sharing/device panel (scenario (d)) and the accessibility announcer (scenario (e)) — keyboard hints, hover-tray tips, reaction and participant status, no speaker label anywhere, so every row lands under speaker `Unknown`. Speaker `Unknown` in the dashboard is the tell for the announcer; button labels as speakers is the tell for a control panel.

When a live session shows Meet's own UI in the transcript, the fix belongs in `UI_CONTROL_LABELS` (whole-line button text) and `NOTIFICATION_LINE_PATTERNS` (banner phrasing) — not in the scoring weights. Bounding matters: `/\byour mic(rophone)? is on[.!]?$/i` is anchored to end-of-line precisely so "your microphone is on the table" stays speech, and the device-picker pattern matches to the *last* paren because device names nest their own, as in "Realtek(R)".

`SYSTEM_LINE_PATTERNS` were unanchored (`/host/i`, `/speakers?/i`, `/microphone/i`) and silently discarded real speech containing those words; the patterns in `NOTIFICATION_LINE_PATTERNS` are anchored or bounded, and `caption-root.test.mjs` regression-tests both directions. Adding a pattern means adding a kept-speech case alongside it.

Debug mode is off by default behind the `meetTranscriptDebug` key in `chrome.storage.local`. In the DevTools console (select the extension's context): `__meetTranscript.enableDebug()` logs every rebind decision with all competing candidates and their score breakdowns; `__meetTranscript.rebinds()` returns the last 100 rebinds, which are recorded whether or not debug is on; `__meetTranscript.candidates()` scores the page right now.

The backend URL lives in the committed sources as `API_URL` in `background.js`, pinned again in `manifest.json` `host_permissions` (localhost/127.0.0.1 on port 8000) and shown in `popup.html`. Editing all three by hand is only needed for a *local* port change — for a hosted backend the server rewrites them when it builds the download (see Deployment). The popup only toggles capture on/off.

### RAG pipeline (`backend/meeting-assistant/`)

`Processor.run_once()` is the ingest unit: cursor-read new `transcripts` rows → bucket per meeting (`group_rows_by_meeting`) → `stable_indices` drops partial/near-duplicate captions via `SequenceMatcher` → `seal_chunks` → embed → add to in-memory `VectorDB` → update `ShortTermBuffer` and `RollingSummarizer`. It exposes `last_chunks` / `last_vectors` / `last_meeting_ids` / `last_chunk_metas` / `last_source_max_id` so `main.py` can persist them.

**Chunks accumulate across ingest cycles.** Captions arrive a few words at a time and ingest fires on every `POST /transcript`, so text is held per meeting in `Processor._pending` until it reaches `chunk_size` rather than being embedded as a stub chunk per batch. Consequences:

- `run_once()` routinely returns `chunks: 0` while still consuming rows — that is not a failure.
- A meeting that goes quiet for `MA_PENDING_FLUSH_SECONDS` (default 30) has its remainder sealed automatically; `Processor.flush()` forces it, and `run_assistant_flush()` in `main.py` wraps that. Backfill calls it so the tail isn't stranded.
- `_dedupe_seed` carries the last line per meeting between runs, so a partial caption split across two batches is still deduplicated.
- `ShortTermBuffer` and `RollingSummarizer` are still fed immediately — the live tiers never wait for a chunk to seal.

Chunk boundaries land on line boundaries (`seal_chunks`), never mid-utterance, and each chunk gets a header line — `[meeting <id> | <ts_start> - <ts_end> | speakers: A, B]` — so time range and speakers are embedded and retrievable. `chunk_meta()` returns the same facts as columns.

Persistence: `rag_chunks` stores chunk text, a float32 `embedding` BLOB, and `ts_start`/`ts_end`/`speakers`; `rag_state` holds the single-row `last_transcript_id` cursor. `_migrate_rag_chunks_schema()` rebuilds the pre-BLOB table on first run (the old `embedding_json` column was `NOT NULL`, which SQLite can't relax in place) and `_decode_embedding()` still reads legacy JSON rows.

**Embeddings are only validated by dimension**, and both the MiniLM and hash-fallback embedders produce 384-dim vectors — so a database written without `sentence-transformers` installed will load its garbage vectors into a MiniLM index and vice versa. Wipe `rag_chunks` (and reset `rag_state.last_transcript_id`) when switching embedder implementations.

`VectorDB` keeps a `metas` list index-aligned with `texts`, and `search(query_vec, top_k, meeting_id=None)` filters on it — the FAISS path over-fetches then filters, since FAISS can only return a global top-N. Both backends sort ties by insertion order so results don't depend on whether `faiss` is installed.

`Retriever` applies a `min_score` floor on top of that. The policy lives in `config.resolve_min_score()`, called from `build_system()`: `MA_SIMILARITY_THRESHOLD` applies only when `Embedder.is_semantic` (a real sentence-transformers model loaded), because the hash fallback returns ~0 similarity for any two different sentences and any threshold would filter out every result. An explicitly-set env var overrides that guard. The documented default was `0.6` while the value was dead code; measured over 1095 real chunks with MiniLM that drops 47% of genuinely relevant hits, so the live default is `0.25`.

### Front end (`backend/static/`)

Two pages, no build step and no framework: `landing.html` at `GET /` and `app.html` at `GET /app`. Both route handlers `read_text()` their file per request so `--reload` picks up markup edits; only `css/` and `js/` come from the `StaticFiles` mount at `/static`, which means **a css or js edit needs a hard reload in the browser, a markup edit does not**.

`css/theme.css` declares the brand ramp and every shared component (`.btn`, `.card`, `.pill`, `.icon-tile`) against surface/text variables it deliberately leaves unset. `landing.css` fills those in light, `app.css` in dark — so a component written once renders on both, and adding one means adding it to `theme.css`, not to a page stylesheet. Two rules in `app.css` are load-bearing and were bugs first: `.topbar .search input` needs the extra specificity because the generic `input[type="search"]` rule below it has the same weight and wins on source order, and `.bar-track` / `.bar-fill` are `<span>`s that need explicit `display: block` or `width` is ignored and every chart bar renders full-width.

`app.js` is one file holding all eight views; `setView()` toggles `[hidden]` on `section.view` and mirrors the name into `location.hash`. Transcript text is untrusted DOM scraped from Meet, so it reaches the page only via `esc()` or `textContent` — `highlight()` escapes before it injects `<mark>`, and that ordering is the whole reason it is safe.

The landing page's demo player streams `DEMO.mp4` from the **repo root** via `GET /demo.mp4` (`FileResponse`, which answers Range requests). It is not under `static/` on purpose: the `StaticFiles` mount would be a second way to reach it, and keeping it out means a deploy without the file 404s cleanly instead of shipping a broken player — `/health` reports `demo_video_available` so that is visible before a visitor finds a dead play button.

`landing.js` attaches the `<video>` on click rather than setting `preload`, so visiting the page costs nothing for anyone who does not watch. Keep it that way when replacing the recording, and **check two things**: the duration label in `landing.html` (`.demo-meta`) is hardcoded and will silently lie about a new cut, and the file must stay well under GitHub's 100 MB limit — an earlier 990 MB version could not be pushed at all. Faststart (`moov` before `mdat`) is worth preserving; without it a browser must range-read the tail before playback can begin.

The dashboard shows counted values only. There is no "time saved" or "accuracy" figure anywhere because nothing in this system measures either; the four stat tiles are meetings, summed caption span, transcript rows and `llm_history` rows. Keep it that way when adding tiles — `overview_stats()`, `insights()` and `extract_action_items()` in `main.py` all read rows and nothing else.

### Two unrelated Q&A paths

| | `/api/llm/action` | `/api/assistant/query` |
|---|---|---|
| Providers | openai / groq / gemini, key per request | OpenAI only, `OPENAI_API_KEY` at build time |
| Retrieval | when `use_rag_context`: `Retriever.search_detailed(..., meeting_id=...)` against the in-memory index | `QueryRouter` picks buffer / rolling summary / VectorDB top-K |
| Scope | per-meeting | optional `meeting_id` in the request body; omit to search across all meetings |
| No usable context | drops to raw transcript rows and reports `context_mode: "raw_fallback"` | empty retrieval yields an empty context |
| Fallback | heuristic keyword summarize/Q&A when no key and `allow_fallback` | returns a prompt preview string |
| History | written to `llm_history` | not persisted |

The `QueryRouter` is pure keyword matching (`"just now"/"recent"/"latest"/"now"` → buffer; `"so far"/"summary"/"overall"/"recap"` → summary; else retrieval), so query phrasing decides which memory tier answers.

### Database path

The FastAPI backend defaults to `backend/transcripts.db` (`TRANSCRIPT_DB_PATH`); the assistant defaults to `MA_TRANSCRIPT_DB_PATH=../transcripts.db` resolved relative to `backend/meeting-assistant/` — the same file by coincidence of layout. Overriding one without the other splits the system across two databases. `transcripts.db` is committed to the repo with real data in it.

`_migrate_llm_history_columns()` is the migration mechanism: `ALTER TABLE ... ADD COLUMN` statements wrapped in try/except on `OperationalError`. Add new columns there.

## Configuration

Provider keys: `OPENAI_API_KEY`, `GROQ_API_KEY`, `GOOGLE_API_KEY` / `GEMINI_API_KEY` (env vars, or entered in the dashboard UI which stores them in `localStorage` and sends them per request). Assistant tuning uses `MA_*` env vars — see `backend/meeting-assistant/config.py`; the README table documents them.

## Deployment

`render.yaml` at the repo root is the source of truth (Render blueprint, free tier). Two constraints are load-bearing: **one worker only** — `VectorDB` is in-process and `assistant_ingest_loop()` is a single asyncio task, so a second worker double-ingests and races the `rag_state` cursor — and **no `*_API_KEY` env vars on the service**, because `resolve_api_key()` falls back to them whenever a request omits a key, which would bill every anonymous visitor's calls to the owner. The disk is ephemeral: `transcripts.db` ships in the repo and re-seeds the demo meetings on every cold start, and anything captured live is lost on the next spin-down.

`GET /api/extension.zip` builds the extension on demand and rewrites `background.js`'s `API_URL`, `manifest.json`'s `host_permissions`, and `popup.html`'s displayed URL to the origin that served the download — resolved from `PUBLIC_BASE_URL`, then `RENDER_EXTERNAL_URL`, then the forwarded headers. The rewrites key on the `meetingiq:api-url` marker comment and the `data-meetingiq="api-url"` attribute rather than on the literal URL, and a non-match raises `ExtensionBuildError` instead of silently shipping a localhost build. If you edit those lines, keep the markers — `TestExtensionRewriteGuards` builds the real sources and fails if they go missing. Both `API_URL` and `host_permissions` must be rewritten: under MV3 the fetch is blocked without a matching host permission, so rewriting only the URL yields an extension that installs cleanly and captures nothing.
