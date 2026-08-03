/**
 * Integration cover for extension/content.js — run with:
 *   node --test extension/tests/content-capture.test.mjs
 *
 * caption-root.test.mjs proves the selection logic is right; this proves
 * content.js is wired to it. The whole point of the fix is that captions keep
 * reaching the backend across toasts and node swaps, and that is a property of
 * the plumbing, not of the heuristics module.
 *
 * content.js is loaded into a vm context with a fake page, a fake chrome.* API
 * and a virtual clock, so the debounce/throttle timings are exercised
 * deterministically and instantly. No jsdom, no dependencies.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = (name) => fs.readFileSync(path.join(HERE, '..', name), 'utf8');

const CAPTION_RECT = { width: 640, height: 96, top: 620, left: 320, right: 960, bottom: 716 };
const TOAST_RECT = { width: 400, height: 72, top: 700, left: 24, right: 424, bottom: 772 };

/** A fake element that satisfies everything content.js and describeCandidate touch. */
function el(attrs, text, rect) {
  return {
    attrs,
    innerText: text,
    isConnected: true,
    style: { display: 'block', visibility: 'visible', opacity: '1' },
    classList: { toggle() {} },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    },
    getBoundingClientRect() {
      return { ...rect };
    },
  };
}

const captionEl = (text) => el({ 'aria-live': 'polite' }, text, CAPTION_RECT);
const toastEl = (text) => el({ 'aria-live': 'polite', role: 'status' }, text, TOAST_RECT);

/**
 * Boots content.js against a controllable fake page.
 * Returns handles for driving mutations and reading what was sent to the worker.
 */
function boot(initialElements) {
  let now = 1_000_000;
  let timerSeq = 0;
  const timers = new Map();
  let elements = [...initialElements];

  const sent = [];
  const storage = { meetTranscriptEnabled: true };
  /** @type {Array<{target: any, cb: Function, live: boolean}>} */
  const observers = [];

  const documentElement = {
    attrs: {},
    isConnected: true,
    getAttribute: () => null,
    appendChild() {},
    contains: (node) => elements.includes(node),
  };

  const matchers = {
    '[aria-live="polite"], [aria-live="assertive"]': (e) => e.attrs['aria-live'] === 'polite' || e.attrs['aria-live'] === 'assertive',
    '[role="log"], [role="status"]': (e) => e.attrs.role === 'log' || e.attrs.role === 'status',
    '[jsname], [data-message-text], [data-message-id]': (e) => 'jsname' in e.attrs || 'data-message-text' in e.attrs || 'data-message-id' in e.attrs,
  };

  const ctx = {
    console: { log() {}, warn() {}, error() {}, table() {}, groupCollapsed() {}, groupEnd() {} },
    URL,
    location: { href: 'https://meet.google.com/jrf-ttqe-dxu' },
    history: { pushState() {} },
    setTimeout(fn, ms) {
      timerSeq += 1;
      timers.set(timerSeq, { fn, at: now + (Number(ms) || 0), every: 0 });
      return timerSeq;
    },
    setInterval(fn, ms) {
      timerSeq += 1;
      const every = Math.max(1, Number(ms) || 1);
      timers.set(timerSeq, { fn, at: now + every, every });
      return timerSeq;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    clearInterval(id) {
      timers.delete(id);
    },
    MutationObserver: class {
      constructor(cb) {
        this.cb = cb;
        this.entry = null;
      }

      observe(target) {
        this.entry = { target, cb: this.cb, live: true };
        observers.push(this.entry);
      }

      disconnect() {
        if (this.entry) this.entry.live = false;
      }
    },
    document: {
      documentElement,
      getElementById: () => null,
      createElement: () => ({ classList: { toggle() {} } }),
      querySelectorAll(selector) {
        const match = matchers[selector];
        if (!match) return [];
        return elements.filter(match);
      },
    },
    window: {
      innerWidth: 1280,
      innerHeight: 800,
      getComputedStyle: (node) => node.style,
      addEventListener() {},
    },
    chrome: {
      runtime: {
        id: 'test-extension-id',
        lastError: undefined,
        sendMessage(message, cb) {
          sent.push(message);
          if (typeof cb === 'function') cb();
        },
      },
      storage: {
        local: {
          get(keys, cb) {
            const out = {};
            for (const k of keys) out[k] = storage[k];
            cb(out);
          },
          set(patch) {
            Object.assign(storage, patch);
          },
        },
        onChanged: { addListener() {} },
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(`Date.now = () => globalThis.__now;`, ctx);
  ctx.__now = now;

  for (const file of ['utils.js', 'caption-heuristics.js', 'content.js']) {
    vm.runInContext(SRC(file), ctx, { filename: file });
  }

  function advance(ms) {
    const target = now + ms;
    for (;;) {
      let next = null;
      for (const [id, t] of timers) {
        if (t.at <= target && (next === null || t.at < next.timer.at)) next = { id, timer: t };
      }
      if (!next) break;
      now = next.timer.at;
      ctx.__now = now;
      if (next.timer.every) next.timer.at = now + next.timer.every;
      else timers.delete(next.id);
      next.timer.fn();
    }
    now = target;
    ctx.__now = now;
  }

  const fire = (predicate) => {
    for (const o of observers.slice()) {
      if (o.live && predicate(o)) o.cb([], null);
    }
  };

  return {
    ctx,
    advance,
    /** Elements currently bound by the caption observer (not the page observer). */
    boundTargets: () => observers.filter((o) => o.live && o.target !== documentElement).map((o) => o.target),
    /** Meet mutated the caption subtree. */
    fireCaption: () => fire((o) => o.target !== documentElement),
    /** Meet mutated the page (toast appearing, node swap). */
    firePage: () => fire((o) => o.target === documentElement),
    setElements: (next) => {
      elements = [...next];
    },
    elements: () => elements,
    /** Everything content.js handed to the service worker. */
    sent: () => sent.slice(),
    items: () => sent.filter((m) => m.type === 'ENQUEUE').flatMap((m) => m.payload.items),
    state: () => ctx.__meetTranscript.state(),
    rebinds: () => ctx.__meetTranscript.rebinds(),
  };
}

/** Push one caption frame through the bound observer and let the debounce settle. */
function frame(app, node, text) {
  node.innerText = text;
  app.fireCaption();
  app.advance(700);
}

const LONG_TURN = [
  'Kartikay Seth: so what I want to walk through today',
  'Kartikay Seth: so what I want to walk through today is the ingest path',
  'Kartikay Seth: so what I want to walk through today is the ingest path and then retrieval',
  'Kartikay Seth: so what I want to walk through today is the ingest path and then retrieval once that lands',
];

const TOASTS = [
  'Close\nAre you talking? Your mic is off.',
  'Close\nTo see more people, change your layout to show more tiles',
  'Close\nKartikay seth joined',
  'Close\nThe presentation Roadmap.pdf was removed from the main screen.',
];

describe('content.js: startup', () => {
  test('binds the caption box and reports a meeting start', () => {
    const caption = captionEl(LONG_TURN[0]);
    const app = boot([caption]);
    app.advance(700);
    assert.deepEqual(app.boundTargets(), [caption]);
    assert.ok(app.sent().some((m) => m.type === 'MEETING_START' && m.meeting_id === 'jrf-ttqe-dxu'));
  });

  test('never binds a toast, even as the only candidate on the page', () => {
    const app = boot([toastEl(TOASTS[0])]);
    app.advance(3000);
    assert.deepEqual(app.boundTargets(), []);
    assert.deepEqual(app.items(), []);
  });

  test('debug logging is off by default', () => {
    const app = boot([captionEl(LONG_TURN[0])]);
    app.advance(700);
    assert.equal(app.state().debugEnabled, false);
  });
});

describe('content.js: (a) one speaker talking continuously', () => {
  test('captures the whole turn as suffix deltas without rebinding', () => {
    const caption = captionEl('');
    const app = boot([caption]);
    app.advance(700);
    for (const text of LONG_TURN) frame(app, caption, text);
    app.advance(2000);

    assert.deepEqual(app.boundTargets(), [caption], 'root changed during a single turn');
    const items = app.items();
    assert.ok(items.length > 0, 'nothing captured');
    for (const item of items) assert.equal(item.speaker, 'Kartikay Seth');
    const joined = items.map((i) => i.text).join(' ');
    assert.equal(joined, 'so what I want to walk through today is the ingest path and then retrieval once that lands');
  });

  test('a long turn produces no rebinds at all', () => {
    const caption = captionEl('');
    const app = boot([caption]);
    app.advance(700);
    for (const text of LONG_TURN) frame(app, caption, text);
    // Drive the discovery interval hard: this is what used to tear capture down.
    app.advance(20000);
    assert.deepEqual(app.boundTargets(), [caption]);
    assert.equal(app.rebinds().length, 1, `expected only the initial bind, got ${JSON.stringify(app.rebinds().map((r) => r.reason))}`);
  });

  test('an emptied caption node does not unbind', () => {
    const caption = captionEl(LONG_TURN[3]);
    const app = boot([caption]);
    app.advance(700);
    frame(app, caption, '');
    app.advance(10000);
    assert.deepEqual(app.boundTargets(), [caption], 'a blank caption box was torn down');
  });
});

describe('content.js: (b) a toast appears mid-meeting', () => {
  test('the toast neither takes the binding nor enters the transcript', () => {
    const caption = captionEl('');
    const app = boot([caption]);
    app.advance(700);
    frame(app, caption, LONG_TURN[1]);

    for (const toastText of TOASTS) {
      app.setElements([caption, toastEl(toastText)]);
      app.firePage();
      app.advance(1200);
      assert.deepEqual(app.boundTargets(), [caption], `toast took the binding: ${toastText}`);
    }

    frame(app, caption, LONG_TURN[3]);
    app.advance(2000);

    const items = app.items();
    for (const item of items) {
      assert.notEqual(item.speaker, 'Close');
      assert.ok(!/mic is off|seth joined|main screen|show more tiles/i.test(item.text), `toast text leaked: ${item.text}`);
    }
    // The speech that spanned the toasts still arrived.
    assert.equal(items.map((i) => i.text).join(' '), 'so what I want to walk through today is the ingest path and then retrieval once that lands');
  });

  test('speech continues to be captured while a toast is on screen', () => {
    const caption = captionEl('');
    const app = boot([caption]);
    app.advance(700);
    app.setElements([caption, toastEl(TOASTS[0])]);
    app.firePage();
    app.advance(1200);
    for (const text of LONG_TURN) frame(app, caption, text);
    app.advance(2000);
    assert.ok(app.items().length > 0, 'capture stopped while a toast was visible');
  });
});

describe('content.js: (c) rapid alternation between two speakers', () => {
  const FRAMES = [
    'Alice Chen: so the migration',
    'Alice Chen: so the migration landed last night',
    'Alice Chen: so the migration landed last night\nBob Iyer: nice, did the',
    'Alice Chen: so the migration landed last night\nBob Iyer: nice, did the backfill finish',
    'Bob Iyer: nice, did the backfill finish\nAlice Chen: it finished around two',
    'Bob Iyer: nice, did the backfill finish\nAlice Chen: it finished around two in the morning',
  ];

  test('both speakers are captured and the root never changes', () => {
    const caption = captionEl('');
    const app = boot([caption]);
    app.advance(700);
    for (const text of FRAMES) frame(app, caption, text);
    app.advance(2000);

    assert.deepEqual(app.boundTargets(), [caption]);
    const speakers = [...new Set(app.items().map((i) => i.speaker))].sort();
    assert.deepEqual(speakers, ['Alice Chen', 'Bob Iyer']);
  });

  test('no speech is duplicated across the alternation', () => {
    const caption = captionEl('');
    const app = boot([caption]);
    app.advance(700);
    for (const text of FRAMES) frame(app, caption, text);
    app.advance(2000);

    const bySpeaker = new Map();
    for (const item of app.items()) {
      bySpeaker.set(item.speaker, `${bySpeaker.get(item.speaker) || ''} ${item.text}`.trim());
    }
    assert.equal(bySpeaker.get('Alice Chen'), 'so the migration landed last night it finished around two in the morning');
    assert.equal(bySpeaker.get('Bob Iyer'), 'nice, did the backfill finish');
  });
});

describe('content.js: rebinding without a capture gap', () => {
  test('a swapped-in caption node is picked up immediately and keeps capturing', () => {
    const first = captionEl('');
    const app = boot([first]);
    app.advance(700);
    frame(app, first, 'Alice Chen: we should ship the migration');
    app.advance(2000);
    const before = app.items().length;

    // Meet replaces the caption node rather than editing it.
    first.isConnected = false;
    const second = captionEl('Bob Iyer: agreed, let us cut over tonight');
    app.setElements([second]);
    app.firePage();
    app.advance(1200);

    assert.deepEqual(app.boundTargets(), [second], 'did not rebind to the replacement node');
    const reasons = app.rebinds().map((r) => r.reason);
    assert.ok(reasons.includes('bound-root-detached'), `rebind reasons were ${JSON.stringify(reasons)}`);

    frame(app, second, 'Bob Iyer: agreed, let us cut over tonight and tell the team');
    app.advance(2000);
    const items = app.items();
    assert.ok(items.length > before, 'nothing captured after the swap');
    assert.equal(items.map((i) => i.text).join(' '), 'we should ship the migration agreed, let us cut over tonight and tell the team');
  });

  test('a node swap that preserves the visible text emits nothing twice', () => {
    // bindObserverTo keeps the per-speaker cumulative state; clearing it would
    // make the still-visible line look brand new and re-send it.
    //
    // The swap must happen after DEDUPE_WINDOW_MS (4 s) has elapsed. Inside that
    // window the fingerprint dedupe suppresses the duplicate on its own, so an
    // earlier swap would pass whether or not the cumulative state survived.
    const first = captionEl('');
    const app = boot([first]);
    app.advance(700);
    frame(app, first, 'Alice Chen: we should ship the migration tonight');
    app.advance(6000);
    const before = app.items().map((i) => i.text).join(' ');
    assert.ok(before.length > 0, 'nothing captured before the swap');

    first.isConnected = false;
    const second = captionEl('Alice Chen: we should ship the migration tonight');
    app.setElements([second]);
    app.firePage();
    app.advance(2000);

    assert.deepEqual(app.boundTargets(), [second]);
    assert.equal(app.items().map((i) => i.text).join(' '), before, 'text was re-emitted after the swap');
  });

  test('a detached root with only a toast available unbinds rather than capturing the toast', () => {
    const caption = captionEl('Alice Chen: we should ship the migration');
    const app = boot([caption]);
    app.advance(700);
    app.advance(2000);
    const before = app.items().length;

    caption.isConnected = false;
    app.setElements([toastEl(TOASTS[0])]);
    app.firePage();
    app.advance(3000);

    assert.deepEqual(app.boundTargets(), []);
    assert.equal(app.items().length, before, 'toast text was captured after the root detached');
  });

  test('capture resumes when a caption box reappears after an unbound window', () => {
    const caption = captionEl('Alice Chen: we should ship the migration');
    const app = boot([caption]);
    app.advance(700);
    app.advance(2000);

    caption.isConnected = false;
    app.setElements([]);
    app.firePage();
    app.advance(3000);
    assert.deepEqual(app.boundTargets(), []);

    const revived = captionEl('Bob Iyer: right, then we cut over tonight');
    app.setElements([revived]);
    app.firePage();
    app.advance(3000);

    assert.deepEqual(app.boundTargets(), [revived]);
    assert.ok(
      app.items().some((i) => /cut over tonight/.test(i.text)),
      'speech after the unbound window was lost',
    );
  });
});

describe('content.js: debug handle', () => {
  let app;
  beforeEach(() => {
    app = boot([captionEl(LONG_TURN[0])]);
    app.advance(700);
  });

  test('rebinds are recorded even with debug off', () => {
    const log = app.rebinds();
    assert.equal(log.length, 1);
    assert.equal(log[0].action, 'bind');
    assert.equal(log[0].reason, 'no-root-bound');
    assert.equal(log[0].trigger, 'start');
    assert.ok(Array.isArray(log[0].candidates));
  });

  test('the rebind record carries competing candidates and their scores', () => {
    app.setElements([...app.elements(), toastEl(TOASTS[0])]);
    app.firePage();
    app.advance(1200);
    const entry = app.rebinds()[0];
    assert.ok(entry.candidates.every((c) => typeof c.score === 'number'));
    assert.ok(entry.candidates.every((c) => Array.isArray(c.reasons)));
  });

  test('enableDebug flips the flag and persists it', () => {
    assert.equal(app.state().debugEnabled, false);
    app.ctx.__meetTranscript.enableDebug();
    assert.equal(app.state().debugEnabled, true);
    app.ctx.__meetTranscript.disableDebug();
    assert.equal(app.state().debugEnabled, false);
  });

  test('candidates() scores the page on demand', () => {
    app.setElements([...app.elements(), toastEl(TOASTS[0])]);
    const scored = app.ctx.__meetTranscript.candidates();
    assert.equal(scored.length, 2);
    const toastRow = scored.find((c) => c.notification);
    assert.ok(toastRow, 'the toast was not flagged as a notification');
  });
});
