/**
 * MV3 service worker: receives batched captions, POSTs to FastAPI with retries.
 */
const API_URL = 'http://localhost:8000/transcript';
const MAX_ATTEMPTS = 6;
const ALARM_RETRY = 'meet-transcript-retry';

/** @type {Array<{ payload: object, attempts: number }>} */
let queue = [];
let processing = false;

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['meetTranscriptEnabled'], (d) => {
    if (d.meetTranscriptEnabled === undefined) {
      chrome.storage.local.set({ meetTranscriptEnabled: true });
    }
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'ENQUEUE' && message.payload) {
    queue.push({ payload: message.payload, attempts: 0 });
    scheduleProcessSoon();
    sendResponse({ ok: true, queued: queue.length });
    return true;
  }
  if (message?.type === 'MEETING_START' || message?.type === 'MEETING_END') {
    console.info('[MeetTranscript]', message.type, message.meeting_id);
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

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
        chrome.action.setBadgeText({ text: '' }).catch(() => {});
        chrome.action.setBadgeBackgroundColor({ color: '#2e4e7e' }).catch(() => {});
      } catch (e) {
        job.attempts += 1;
        console.warn('[MeetTranscript] send failed', e?.message || e, 'attempt', job.attempts);
        if (job.attempts >= MAX_ATTEMPTS) {
          queue.shift();
          chrome.action.setBadgeText({ text: '!' }).catch(() => {});
          chrome.action.setBadgeBackgroundColor({ color: '#b00020' }).catch(() => {});
          continue;
        }
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
