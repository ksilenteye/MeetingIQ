/**
 * MV3 service worker: receives batched captions, POSTs to FastAPI with retries.
 *
 * The worker is terminated after ~30s idle, so the pending queue is mirrored to
 * chrome.storage.local. A retry alarm wakes the worker back up and the queue is
 * rehydrated before any send is attempted.
 */
// The `meetingiq:api-url` marker is load-bearing: GET /api/extension.zip rewrites
// this line to point at whatever host served the download, so a hosted backend
// never needs its URL committed here. Keep the marker if you edit the literal;
// backend/tests/test_main.py fails loudly if it goes missing.
const API_URL = 'http://localhost:8000/transcript'; // meetingiq:api-url
// 9 attempts -> ~2 minutes of retries (1+2+4+8+16+30+30+30s). 6 gave only 31s,
// because the final attempt drops the batch without sleeping, which is narrower
// than a free-tier cold start and silently lost the first captions of a meeting.
const MAX_ATTEMPTS = 9;
const ALARM_RETRY = 'meet-transcript-retry';
const QUEUE_KEY = 'meetTranscriptQueue';
const QUEUE_CAP = 500;

/** @type {Array<{ payload: object, attempts: number }>} */
let queue = [];
let processing = false;
/** @type {Promise<void> | null} */
let hydration = null;

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['meetTranscriptEnabled'], (d) => {
    if (d.meetTranscriptEnabled === undefined) {
      chrome.storage.local.set({ meetTranscriptEnabled: true });
    }
  });
});

chrome.runtime.onStartup.addListener(() => {
  void processQueue();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'ENQUEUE' && message.payload) {
    void enqueue(message.payload);
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === 'MEETING_START' || message?.type === 'MEETING_END') {
    console.info('[MeetTranscript]', message.type, message.meeting_id);
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

/**
 * Rehydrate before touching the queue, so a batch enqueued early in this worker
 * lifetime is never persisted and then read back in as a duplicate.
 */
async function enqueue(payload) {
  await ensureHydrated();
  queue.push({ payload, attempts: 0 });
  await persistQueue();
  scheduleProcessSoon();
}

/**
 * Load any batches persisted by a previous worker lifetime. Saved jobs are older
 * than anything enqueued in this lifetime, so they go in front.
 */
function ensureHydrated() {
  if (!hydration) {
    hydration = (async () => {
      try {
        const data = await chrome.storage.local.get([QUEUE_KEY]);
        const saved = Array.isArray(data[QUEUE_KEY]) ? data[QUEUE_KEY] : [];
        if (saved.length) {
          queue = saved.concat(queue);
          console.info('[MeetTranscript] restored', saved.length, 'queued batches');
        }
      } catch (e) {
        console.warn('[MeetTranscript] queue hydrate failed', e?.message || e);
      }
    })();
  }
  return hydration;
}

async function persistQueue() {
  try {
    await chrome.storage.local.set({ [QUEUE_KEY]: queue.slice(-QUEUE_CAP) });
  } catch (e) {
    console.warn('[MeetTranscript] queue persist failed', e?.message || e);
  }
}

function scheduleProcessSoon() {
  if (processing) return;
  void processQueue();
}

function backoffMs(attempt) {
  return Math.min(30000, 1000 * Math.pow(2, Math.max(0, attempt)));
}

async function processQueue() {
  if (processing) return;
  processing = true;
  try {
    await ensureHydrated();
    while (queue.length) {
      const job = queue[0];
      try {
        const res = await fetch(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(job.payload),
        });
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status} ${errText}`);
        }
        queue.shift();
        await persistQueue();
        chrome.action.setBadgeText({ text: '' }).catch(() => {});
        chrome.action.setBadgeBackgroundColor({ color: '#2e4e7e' }).catch(() => {});
      } catch (e) {
        job.attempts += 1;
        console.warn('[MeetTranscript] send failed', e?.message || e, 'attempt', job.attempts);
        if (job.attempts >= MAX_ATTEMPTS) {
          queue.shift();
          await persistQueue();
          chrome.action.setBadgeText({ text: '!' }).catch(() => {});
          chrome.action.setBadgeBackgroundColor({ color: '#b00020' }).catch(() => {});
          continue;
        }
        await persistQueue();
        const delay = backoffMs(job.attempts - 1);
        chrome.alarms.create(ALARM_RETRY, { when: Date.now() + delay });
        break;
      }
    }
  } finally {
    processing = false;
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_RETRY) {
    void processQueue();
  }
});
