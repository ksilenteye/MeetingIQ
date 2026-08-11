# MeetingIQ — 5-minute demo script

Spoken narration for a screen recording. Roughly 700 words of speech at a normal
pace, leaving room to pause while things load.

**Read this before recording:** the flow below assumes a working local setup.
Timings are targets, not a stopwatch — if capture is slow to appear, keep
talking through it rather than cutting.

---

## Pre-flight checklist

Do all of this *before* you hit record, so nothing is fumbled on camera.

- [ ] Backend running: `cd backend && uvicorn main:app --port 8000`. Wait for
      `/health` to return `meeting_assistant_ready: true` — first start loads the
      embedding model and can take ~20 seconds.
- [ ] `http://localhost:8000` loads the landing page.
- [ ] Extension loaded and **reloaded** at `chrome://extensions`, and the Meet
      tab refreshed afterwards.
- [ ] Click the 🎙️ toolbar icon: all three **Caption filters** rows show ✓, and
      **Bound to the best candidate** shows ✓ once you are in a meeting.
- [ ] A second participant, or a second device, so the transcript shows more than
      one speaker. Two speakers make the demo far more convincing than one.
- [ ] Decide your LLM story: paste an OpenAI or Groq key in **Settings**, or
      leave it empty and demo the heuristic fallback. If you plan to show Gemini,
      run `pip install google-generativeai` first — it is in `requirements.txt`
      but may not be in your local environment.
- [ ] Close unrelated tabs. Set the browser to a clean window.

---

## 0:00 — 0:30 · Hook

**Screen:** the landing page at `localhost:8000`, top of the hero.

> Every meeting produces two things: a conversation, and the notes nobody
> actually took. MeetingIQ fixes the second one.
>
> It's a Chrome extension plus a small local server. It reads Google Meet's live
> captions as they appear, stores them, and lets you ask questions about what was
> said — while the meeting is still going.
>
> The important part: everything runs on your machine. No third-party service
> ever sees your transcript.

---

## 0:30 — 1:15 · The landing page

**Screen:** scroll slowly through the landing page.

> This is the front page. Let me show you what it does before we set it up.

**Action:** scroll to *Why MeetingIQ?*

> Four things. Live transcription streamed to your dashboard over a WebSocket, so
> there's no refresh button. AI summaries using whichever provider you choose.
> Action items pulled out of those summaries. And your data stays in a SQLite
> file on your own machine.

**Action:** scroll to *How It Works*.

> Under the hood it's four steps: capture the captions, store them, index them
> into a local vector database, and answer questions against that index — so
> answers are grounded in what was actually said, not invented.

**Action:** scroll to *How to Install the Extension*.

> Setup takes about two minutes. Let's do it now.

---

## 1:15 — 2:00 · Install the extension

**Screen:** click **Add to Chrome** in the hero or the install card.

> The download comes from the server itself, and it's built on demand — it
> already knows the address of the backend it came from, so there's nothing to
> configure.

**Action:** show the downloaded zip, extract it.

> Extract it — on Windows, right-click, Extract All. Don't load it from inside
> the zip preview window, Chrome can't read it there.

**Action:** open `chrome://extensions`, toggle **Developer mode**, click
**Load unpacked**, pick the extracted folder.

> Developer mode on, Load unpacked, choose the folder with `manifest.json` in it.
> And there's the microphone icon in the toolbar.

**Action:** click the 🎙️ icon so the popup opens.

> The popup is also a health check. It tells me the filters are current and, once
> I'm in a meeting, exactly which element on the page it's reading captions from.

---

## 2:00 — 3:00 · Capture a real meeting

**Screen:** a live Google Meet.

> Now the actual meeting. One thing matters here: **captions have to be on.** Hit
> the CC button. If captions are off, there is nothing on the page to read, and
> MeetingIQ captures nothing.

**Action:** turn on captions. Speak a couple of sentences. Have the second
participant speak too.

> I'll talk for a moment so we get something to work with.

**Action:** click the 🎙️ icon.

> The popup confirms it: caption root bound, bound to the best candidate, and
> it's reading my own words back to me. Google Meet's interface is full of things
> that look like captions — notification toasts, device menus, tooltips — so the
> extension scores every candidate on the page and rejects the ones that are just
> UI. You can see three rejected right there.

---

## 3:00 — 4:15 · The dashboard

**Screen:** open `localhost:8000/app` beside the Meet window.

> Here's the dashboard, side by side with the call.

**Action:** show **Transcripts** with the meeting selected. Speak once more.

> Transcript, live. New lines appear as we talk — that's the WebSocket, not
> polling. And notice each line is attributed to the right speaker.

**Action:** type a question in **Ask about this meeting**, click **Ask**.

> I can ask about it while the meeting is still running. The answer is grounded
> in the retrieved transcript, so it's answering from what was said rather than
> guessing.

**Action:** go to **Summaries**, pick the meeting, click **Generate**.

> Summaries are generated on demand, and every run is stored so you can compare
> them. If no API key is set, it falls back to a keyword-based summary — useful,
> and honest about not being AI-generated.

**Action:** click **Action Items**, then **Insights**.

> Action items are pulled straight out of those summaries — no second AI pass,
> just extraction from text a model already wrote. And Insights: talk time per
> speaker, lines captured per day, AI usage. Every number here is counted from
> the database. Nothing is estimated.

---

## 4:15 — 4:45 · Why it's built this way

**Screen:** back on the dashboard, or the Settings page.

> A note on privacy, because it drove most of the design. Transcripts live in a
> SQLite file on this machine. Your API key is stored in your browser and sent
> per request — the server never keeps it. And the whole thing runs locally, so
> nothing about your meetings leaves your computer unless you choose a cloud LLM
> provider.

---

## 4:45 — 5:00 · Close

**Screen:** landing page, or the dashboard overview.

> That's MeetingIQ. A Chrome extension, a FastAPI backend, SQLite, and a local
> retrieval pipeline — capturing meetings, summarizing them, and answering
> questions about them, entirely on your own machine.
>
> Thanks for watching.

---

## If something goes wrong on camera

Keep talking; these are all recoverable.

| Symptom | Say this, then fix |
|---|---|
| No lines appearing | "Captions need to be on for this" — hit CC, wait a few seconds. |
| Popup shows a ✗ | "Let me reload the extension" — reload at `chrome://extensions`, refresh Meet. |
| Summary errors out | Switch to the heuristic fallback in Settings — it needs no key. |
| Dashboard looks empty | Check the meeting dropdown; the view is per-meeting. |
| Server not responding | Free-tier and local servers both sleep; reload the page and give it a moment. |

## Recording notes

- Record at 1920×1080. The dashboard is dense; anything smaller loses the table.
- Side-by-side Meet and dashboard is the single most persuasive shot in the demo.
  Spend real time there.
- Speak while pages load rather than cutting — it reads as confidence.
- Consider a short pause after each section so you can trim cleanly later.
