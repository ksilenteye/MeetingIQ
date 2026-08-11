/**
 * Tests for extension/caption-heuristics.js — run with:  node --test extension/tests/
 *
 * Regression cover for the caption-gap bug: Meet notification toasts share the
 * aria-live / role=status markup of the live caption box, and a single scoring
 * pass could hand the MutationObserver to a toast. Meet's caption DOM keeps no
 * history, so any window spent watching the wrong element is permanent loss.
 *
 * caption-heuristics.js is a plain IIFE that attaches to globalThis (no module
 * system, so it can be listed directly in the manifest's content_scripts), so
 * it is evaluated in a vm context here rather than imported. Only
 * describeCandidate touches the DOM and it takes an injected view, so the fake
 * elements below are enough — no jsdom, no dependencies.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ctx = { globalThis: undefined };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(HERE, '..', 'utils.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(HERE, '..', 'caption-heuristics.js'), 'utf8'), ctx);
const H = ctx.MeetCaptionHeuristics;
const U = ctx.MeetTranscriptUtils;

// ---------------------------------------------------------------------------
// Fake DOM
// ---------------------------------------------------------------------------

const VIEW = {
  innerWidth: 1280,
  innerHeight: 800,
  getComputedStyle(el) {
    return el.__style;
  },
};

/** Meet's caption box: wide, bottom-centre. */
const CAPTION_RECT = { width: 640, height: 96, top: 620, left: 320, right: 960, bottom: 716 };
/** Meet's snackbar: narrower, bottom-left. */
const TOAST_RECT = { width: 400, height: 72, top: 700, left: 24, right: 424, bottom: 772 };

function makeElement({ ariaLive = null, role = null, text = '', rect = CAPTION_RECT, style = {}, connected = true } = {}) {
  const attrs = { 'aria-live': ariaLive, role };
  return {
    innerText: text,
    isConnected: connected,
    __style: { display: 'block', visibility: 'visible', opacity: '1', ...style },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    getBoundingClientRect() {
      return { ...rect };
    },
  };
}

/** Meet's caption container: aria-live region, no role=log. */
function captionBox(text) {
  return makeElement({ ariaLive: 'polite', role: null, text, rect: CAPTION_RECT });
}

/** Meet's notification snackbar: same live-region markup, plus a dismiss button. */
function toast(text) {
  return makeElement({ ariaLive: 'polite', role: 'status', text, rect: TOAST_RECT });
}

function scoreOf(el) {
  const features = H.describeCandidate(el, VIEW, 'k');
  return H.scoreCandidateFeatures(features);
}

function candidate(key, el) {
  const features = H.describeCandidate(el, VIEW, key);
  const scored = H.scoreCandidateFeatures(features);
  return { key, score: scored.score, notification: scored.notification };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * (a) One speaker talking continuously. The caption box holds a single line
 * that grows without bound and never gains a second speaker — the condition
 * under which an earlier "< 2 lines" penalty collapsed the box's score.
 */
const LONG_TURN_CLAUSES = [
  'so what I want to walk through today is the ingest path',
  'and then the retrieval side of it once that lands',
  'because right now every caption batch triggers a full pass',
  'which is fine at this volume but it will not hold',
  'once we have four or five meetings running at the same time',
  'so the plan is to buffer per meeting and seal on a size boundary',
  'and only then embed the chunk and push it into the index',
];
const LONG_TURN_FRAMES = LONG_TURN_CLAUSES.map((_, i) => `Kartikay Seth: ${LONG_TURN_CLAUSES.slice(0, i + 1).join(' ')}`);

/** (b) The exact toasts observed leaking into the transcript panel. */
const TOAST_FIXTURES = [
  'Close\nAre you talking? Your mic is off.',
  'Close\nTo see more people, change your layout to show more tiles',
  'Close\nKartikay seth joined',
  'Close\nThe presentation Roadmap.pdf was removed from the main screen.',
  'Got it\nYour connection is unstable',
  'Dismiss\nThis meeting is being recorded',
];

/**
 * (d) Meet's sharing / device panel, captured verbatim from a live session
 * where it beat the caption box and became the bound root. It has no colon
 * captions, so the `captionLines > 0` guard does not protect against it, and
 * its "button label / description line" shape is the same shape as Meet's
 * speaker-label caption layout — so every per-line check scored it as speech.
 * Measured before the fix: panel 129 vs caption box 137, a margin held only by
 * `horizontally-centred`, which the caption box loses in a narrow window.
 */
const SHARING_PANEL = [
  'Add others',
  'Or share this meeting link with others you want in the meeting',
  'Stop sharing',
  'Waiting for Read AI to be connected',
  "You're no longer sharing audio and video with Read AI",
  'Your microphone is on.',
  'Microphone (2- Realtek(R) Audio)',
  'Array (2- Realtek(R) Audio)',
].join('\n');

/**
 * The caption box from that same session. Meet was rendering the speaker-label
 * layout (name on its own line, speech beneath) rather than "Speaker: text",
 * so this must survive every rule added to catch the panel above.
 */
const LABEL_LAYOUT_CAPTIONS = [
  'Kavya Bhardwaj',
  "Sending anything. Or working, not any caption. Let me just. So? Hello! Now, let's take it to Sparky now.",
  'You',
  "Hello! Yeah, so it's. Working, I think. And it should start. Catching the phrase, but I don't think it is scrolling.",
].join('\n');

/** (c) Two speakers alternating quickly; Meet shows the last couple of lines. */
const ALTERNATION_FRAMES = [
  'Alice Chen: so the migration',
  'Alice Chen: so the migration landed last night',
  'Alice Chen: so the migration landed last night\nBob Iyer: nice, did the',
  'Alice Chen: so the migration landed last night\nBob Iyer: nice, did the backfill finish',
  'Bob Iyer: nice, did the backfill finish\nAlice Chen: it finished around two',
  'Bob Iyer: nice, did the backfill finish\nAlice Chen: it finished around two in the morning',
  'Alice Chen: it finished around two in the morning\nBob Iyer: great, then we can cut over',
];

// ---------------------------------------------------------------------------
// Scoring: caption box vs notification toast
// ---------------------------------------------------------------------------

describe('notification detection', () => {
  for (const text of TOAST_FIXTURES) {
    const first = text.split('\n')[1];
    test(`toast is disqualified: "${first}"`, () => {
      const scored = scoreOf(toast(text));
      assert.equal(scored.notification, true);
      assert.equal(scored.score, H.DISQUALIFIED);
    });
  }

  test('a caption box is never classified as a notification', () => {
    for (const frame of LONG_TURN_FRAMES.concat(ALTERNATION_FRAMES)) {
      const scored = scoreOf(captionBox(frame));
      assert.equal(scored.notification, false, `misclassified: ${frame.slice(0, 60)}`);
    }
  });

  test('a caption containing toast-ish words is still a caption', () => {
    // A "Speaker: text" line is caption content, so the block cannot be a toast.
    const scored = scoreOf(captionBox('Alice Chen: can you hear me through the speakers or not'));
    assert.equal(scored.notification, false);
    assert.ok(scored.score >= H.MIN_ACCEPT_SCORE);
  });

  test('toast still loses on structure alone, with disqualification bypassed', () => {
    // Defence in depth: even if a future Meet toast dodged the text patterns,
    // the structural score should not beat a live caption box.
    const toastFeatures = H.describeCandidate(toast(TOAST_FIXTURES[0]), VIEW, 't');
    const bypassed = H.scoreCandidateFeatures({ ...toastFeatures, notification: false });
    const caption = scoreOf(captionBox(LONG_TURN_FRAMES[0]));
    assert.ok(
      caption.score > bypassed.score + H.SWITCH_MARGIN,
      `caption ${caption.score} should beat toast ${bypassed.score} by more than the switch margin`,
    );
  });
});

// ---------------------------------------------------------------------------
// (a) one speaker talking continuously, no rebind
// ---------------------------------------------------------------------------

describe('scenario (a): one speaker talking continuously', () => {
  test('the caption box stays bindable through every frame of a long turn', () => {
    for (const frame of LONG_TURN_FRAMES) {
      const scored = scoreOf(captionBox(frame));
      assert.ok(
        scored.score >= H.MIN_ACCEPT_SCORE,
        `frame scored ${scored.score}, below the accept floor: ${frame.slice(0, 60)}`,
      );
    }
  });

  test('a single long line is not penalised when it carries caption signal', () => {
    const oneLine = scoreOf(captionBox(LONG_TURN_FRAMES[LONG_TURN_FRAMES.length - 1]));
    const reasons = Object.fromEntries(oneLine.reasons);
    assert.equal(reasons['single-line-no-signal'], undefined);
    assert.ok(reasons['speaker-colon-line'] > 0);
  });

  test('a single line with no caption signal is still penalised', () => {
    const junk = scoreOf(captionBox('roadmap'));
    const reasons = Object.fromEntries(junk.reasons);
    assert.equal(reasons['single-line-no-signal'], -8);
  });

  test('the arbiter never rebinds during an uninterrupted turn', () => {
    const arbiter = H.createRootArbiter();
    const actions = LONG_TURN_FRAMES.map((frame) => arbiter.evaluate({
      bound: { key: 'caption', score: scoreOf(captionBox(frame)).score, attached: true },
      candidates: [candidate('caption', captionBox(frame))],
    }).action);
    assert.deepEqual(actions, LONG_TURN_FRAMES.map(() => 'keep'));
  });

  test('a momentarily unscorable caption box is kept, not torn down', () => {
    // Meet briefly empties the caption node between turns. Previously this
    // produced a null candidate and an immediate teardown, and with no observer
    // bound nothing drove the digest — a total capture gap.
    const arbiter = H.createRootArbiter();
    const blank = arbiter.evaluate({
      bound: { key: 'caption', score: -10, attached: true },
      candidates: [],
    });
    assert.equal(blank.action, 'keep');
    assert.equal(blank.reason, 'no-viable-challenger');
  });
});

// ---------------------------------------------------------------------------
// (b) a notification toast appears mid-meeting, captions also present
// ---------------------------------------------------------------------------

describe('scenario (b): notification toast appears mid-meeting', () => {
  test('the toast never takes the binding, however long it is on screen', () => {
    const arbiter = H.createRootArbiter();
    const frame = LONG_TURN_FRAMES[3];
    for (let tick = 0; tick < 20; tick += 1) {
      const toastText = TOAST_FIXTURES[tick % TOAST_FIXTURES.length];
      const decision = arbiter.evaluate({
        bound: { key: 'caption', score: scoreOf(captionBox(frame)).score, attached: true },
        candidates: [candidate('caption', captionBox(frame)), candidate('toast', toast(toastText))],
      });
      assert.equal(decision.action, 'keep', `tick ${tick} switched to ${decision.key}`);
    }
  });

  test('with no caption box bound, a toast is still never bound', () => {
    const arbiter = H.createRootArbiter();
    const decision = arbiter.evaluate({
      bound: null,
      candidates: [candidate('toast', toast(TOAST_FIXTURES[0]))],
    });
    assert.equal(decision.action, 'idle');
    assert.equal(decision.reason, 'no-viable-candidate');
  });

  test('a transient high-scoring impostor cannot hijack the binding', () => {
    // Two ticks of a challenger that beats the bound root outright, then gone.
    const arbiter = H.createRootArbiter();
    const bound = { key: 'caption', score: 120, attached: true };
    for (let tick = 0; tick < 2; tick += 1) {
      const d = arbiter.evaluate({
        bound,
        candidates: [{ key: 'caption', score: 120 }, { key: 'impostor', score: 200 }],
      });
      assert.equal(d.action, 'keep');
      assert.equal(d.reason, 'awaiting-corroboration');
      assert.equal(d.streak, tick + 1);
    }
    const after = arbiter.evaluate({ bound, candidates: [{ key: 'caption', score: 120 }] });
    assert.equal(after.action, 'keep');
    assert.equal(arbiter.state.streak, 0, 'streak must reset when the challenger disappears');
  });

  test('alternating challengers never accumulate a streak between them', () => {
    const arbiter = H.createRootArbiter();
    const bound = { key: 'caption', score: 120, attached: true };
    for (let tick = 0; tick < 8; tick += 1) {
      const rival = tick % 2 === 0 ? 'toastA' : 'toastB';
      const d = arbiter.evaluate({
        bound,
        candidates: [{ key: 'caption', score: 120 }, { key: rival, score: 200 }],
      });
      assert.equal(d.action, 'keep', `tick ${tick} switched to ${d.key}`);
      assert.equal(d.streak, 1);
    }
  });

  test('a genuinely better candidate does win, after corroboration', () => {
    const arbiter = H.createRootArbiter();
    const bound = { key: 'caption', score: 120, attached: true };
    const candidates = [{ key: 'caption', score: 120 }, { key: 'newCaption', score: 200 }];
    assert.equal(arbiter.evaluate({ bound, candidates }).action, 'keep');
    assert.equal(arbiter.evaluate({ bound, candidates }).action, 'keep');
    const third = arbiter.evaluate({ bound, candidates });
    assert.equal(third.action, 'bind');
    assert.equal(third.key, 'newCaption');
    assert.equal(third.reason, 'challenger-corroborated');
    assert.equal(third.streak, H.SWITCH_STREAK);
  });

  test('a challenger within the margin is not worth the switch', () => {
    const arbiter = H.createRootArbiter();
    const bound = { key: 'caption', score: 120, attached: true };
    const candidates = [{ key: 'caption', score: 120 }, { key: 'other', score: 120 + H.SWITCH_MARGIN - 1 }];
    for (let tick = 0; tick < 5; tick += 1) {
      const d = arbiter.evaluate({ bound, candidates });
      assert.equal(d.action, 'keep');
      assert.equal(d.reason, 'challenger-within-margin');
    }
  });
});

// ---------------------------------------------------------------------------
// (c) rapid alternation between two speakers
// ---------------------------------------------------------------------------

/**
 * Mirrors digestCaptionDom in content.js: pick a caption out of the visible
 * lines, emit only the new suffix for that speaker, apply the same gating.
 */
function runDigest(frames) {
  const cumulativeBySpeaker = new Map();
  const emitted = [];
  let lastSpeaker = 'Unknown';
  let lastSnapshot = '';

  for (const frame of frames) {
    const lines = H.extractLines(frame);
    const snapshot = lines.join('\n');
    if (snapshot === lastSnapshot) continue;
    lastSnapshot = snapshot;

    const parsed = H.selectBestCaptionCandidate(lines, lastSpeaker);
    if (!parsed) continue;
    const speaker = U.normalizeText(parsed.speaker) || 'Unknown';
    const full = U.normalizeText(parsed.text);
    if (!full) continue;

    const prev = cumulativeBySpeaker.get(speaker) || '';
    const { delta, newCumulative } = U.computeCaptionDelta(prev, full);
    cumulativeBySpeaker.set(speaker, newCumulative);
    lastSpeaker = speaker;
    if (!delta) continue;
    if (!prev && !H.isLikelySpokenText(full)) continue;
    if (prev && !H.isDeltaWorthEmit(delta)) continue;
    emitted.push({ speaker, text: delta });
  }
  return emitted;
}

describe('scenario (c): rapid alternation between two speakers', () => {
  test('the arbiter keeps the same root while speakers alternate', () => {
    const arbiter = H.createRootArbiter();
    for (const frame of ALTERNATION_FRAMES) {
      const decision = arbiter.evaluate({
        bound: { key: 'caption', score: scoreOf(captionBox(frame)).score, attached: true },
        candidates: [candidate('caption', captionBox(frame))],
      });
      assert.equal(decision.action, 'keep');
    }
  });

  test('both speakers are attributed, and nothing else is', () => {
    const speakers = new Set(runDigest(ALTERNATION_FRAMES).map((e) => e.speaker));
    assert.deepEqual([...speakers].sort(), ['Alice Chen', 'Bob Iyer']);
  });

  test('alternation emits each utterance exactly once', () => {
    const emitted = runDigest(ALTERNATION_FRAMES);
    const bySpeaker = new Map();
    for (const e of emitted) {
      bySpeaker.set(e.speaker, [...(bySpeaker.get(e.speaker) || []), e.text]);
    }
    assert.equal(
      bySpeaker.get('Alice Chen').join(' '),
      'so the migration landed last night it finished around two in the morning',
    );
    assert.equal(
      bySpeaker.get('Bob Iyer').join(' '),
      'nice, did the backfill finish great, then we can cut over',
    );
  });

  test('a toast interleaved with alternating captions contributes nothing', () => {
    const withToast = [
      ALTERNATION_FRAMES[0],
      ALTERNATION_FRAMES[1],
      'Close\nKartikay seth joined',
      ALTERNATION_FRAMES[2],
      'Close\nAre you talking? Your mic is off.',
      ALTERNATION_FRAMES[3],
    ];
    const emitted = runDigest(withToast);
    for (const e of emitted) {
      assert.notEqual(e.speaker, 'Close');
      assert.ok(!/mic is off|seth joined/i.test(e.text), `leaked toast text: ${e.text}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Rebinding without a capture gap
// ---------------------------------------------------------------------------

describe('rebinding', () => {
  test('a detached root is replaced immediately, with no corroboration delay', () => {
    const arbiter = H.createRootArbiter();
    const decision = arbiter.evaluate({
      bound: { key: 'old', score: 130, attached: false },
      candidates: [candidate('new', captionBox(ALTERNATION_FRAMES[0]))],
    });
    assert.equal(decision.action, 'bind');
    assert.equal(decision.key, 'new');
    assert.equal(decision.reason, 'bound-root-detached');
  });

  test('a detached root with no replacement unbinds rather than holding a dead node', () => {
    const arbiter = H.createRootArbiter();
    const decision = arbiter.evaluate({
      bound: { key: 'old', score: 130, attached: false },
      candidates: [candidate('toast', toast(TOAST_FIXTURES[0]))],
    });
    assert.equal(decision.action, 'unbind');
    assert.equal(decision.reason, 'bound-root-detached-no-replacement');
  });

  test('an in-progress challenger streak is discarded when the root detaches', () => {
    const arbiter = H.createRootArbiter();
    arbiter.evaluate({
      bound: { key: 'caption', score: 120, attached: true },
      candidates: [{ key: 'caption', score: 120 }, { key: 'rival', score: 200 }],
    });
    assert.equal(arbiter.state.streak, 1);
    arbiter.evaluate({
      bound: { key: 'caption', score: 120, attached: false },
      candidates: [{ key: 'rival', score: 200 }],
    });
    assert.equal(arbiter.state.streak, 0);
  });

  test('binding from cold takes the best candidate with no delay', () => {
    const arbiter = H.createRootArbiter();
    const decision = arbiter.evaluate({
      bound: null,
      candidates: [
        candidate('toast', toast(TOAST_FIXTURES[0])),
        candidate('caption', captionBox(ALTERNATION_FRAMES[3])),
      ],
    });
    assert.equal(decision.action, 'bind');
    assert.equal(decision.key, 'caption');
    assert.equal(decision.reason, 'no-root-bound');
  });

  test('candidates below the accept floor are never bound', () => {
    const arbiter = H.createRootArbiter();
    const decision = arbiter.evaluate({
      bound: null,
      candidates: [{ key: 'weak', score: H.MIN_ACCEPT_SCORE - 1 }],
    });
    assert.equal(decision.action, 'idle');
  });

  test('an invisible element is disqualified', () => {
    const hidden = makeElement({ ariaLive: 'polite', text: ALTERNATION_FRAMES[0], style: { display: 'none' } });
    assert.equal(scoreOf(hidden).score, H.DISQUALIFIED);
  });
});

// ---------------------------------------------------------------------------
// Parse layer: UI chrome must never become a speaker or a line of speech
// ---------------------------------------------------------------------------

describe('UI labels are never speakers', () => {
  for (const label of ['Close', 'Got it', 'Dismiss', 'Undo', 'Turn on', 'Learn more', 'Change layout']) {
    test(`"${label}" is not a plausible speaker name`, () => {
      assert.equal(H.isPlausibleSpeakerName(label), false);
      assert.equal(H.isLikelySpeakerLabel(label), false);
    });
  }

  test('the observed toast block yields no caption at all', () => {
    for (const text of TOAST_FIXTURES) {
      const parsed = H.selectBestCaptionCandidate(H.extractLines(text), 'Alice Chen');
      assert.equal(parsed, null, `toast produced a caption: ${JSON.stringify(parsed)}`);
    }
  });

  test('a real speaker name is still accepted', () => {
    assert.equal(H.isPlausibleSpeakerName('Kartikay Seth'), true);
    assert.equal(H.isPlausibleSpeakerName('Adnan Saif'), true);
    assert.equal(H.isPlausibleSpeakerName("O'Brien"), true);
  });
});

describe('notification text is excluded, real speech is not', () => {
  const notifications = [
    'Are you talking? Your mic is off.',
    'To see more people, change your layout to show more tiles',
    'Kartikay seth joined',
    'Adnan Saif left the call',
    'The presentation Roadmap.pdf was removed from the main screen.',
    'This meeting is being recorded',
    'Live captions have been turned off',
    '3 others joined',
  ];
  for (const line of notifications) {
    test(`excluded: "${line}"`, () => {
      assert.equal(H.isNotificationLine(line), true);
      assert.equal(H.isLikelySpokenText(line), false);
    });
  }

  // These contain words that unanchored patterns used to match anywhere in a
  // line, which silently discarded real speech.
  const speech = [
    'can you hear me through the speakers or not',
    "let's ask the host about the budget line",
    'I joined the team last year so I missed that',
    'I joined the call a couple of minutes late',
    'we left the meeting notes in the shared drive',
    'she joined the call yesterday and walked us through it',
    'the microphone array in that room is genuinely terrible',
    'who is presenting the roadmap deck on Thursday',
  ];
  for (const line of speech) {
    test(`kept: "${line}"`, () => {
      assert.equal(H.isNotificationLine(line), false, 'flagged as a notification');
      assert.equal(H.isLikelySpokenText(line), true);
    });
  }
});

describe("scenario (d): Meet's sharing / device panel", () => {
  test('the panel is disqualified, not merely out-scored', () => {
    const scored = scoreOf(toast(SHARING_PANEL));
    assert.equal(scored.notification, true);
    assert.equal(scored.score, H.DISQUALIFIED);
  });

  test('the caption box beside it is untouched and still binds', () => {
    const scored = scoreOf(captionBox(LABEL_LAYOUT_CAPTIONS));
    assert.equal(scored.notification, false);
    assert.ok(
      scored.score >= H.MIN_ACCEPT_SCORE,
      `speaker-label captions scored ${scored.score}`
    );
  });

  test('with nothing bound, the captions are chosen over the panel', () => {
    const decision = H.createRootArbiter().evaluate({
      bound: null,
      candidates: [
        candidate('panel', toast(SHARING_PANEL)),
        candidate('captions', captionBox(LABEL_LAYOUT_CAPTIONS)),
      ],
    });
    assert.equal(decision.key, 'captions');
  });

  test('the panel never takes a binding it already holds nothing on', () => {
    // the observed failure: the panel wins first and keeps winning
    const arbiter = H.createRootArbiter();
    for (let tick = 0; tick < 20; tick += 1) {
      const decision = arbiter.evaluate({
        bound: { key: 'captions', score: scoreOf(captionBox(LABEL_LAYOUT_CAPTIONS)).score, attached: true },
        candidates: [
          candidate('captions', captionBox(LABEL_LAYOUT_CAPTIONS)),
          candidate('panel', toast(SHARING_PANEL)),
        ],
      });
      assert.equal(decision.action, 'keep', `tick ${tick} switched to ${decision.key}`);
    }
  });

  test('the panel alone binds nothing at all', () => {
    const decision = H.createRootArbiter().evaluate({
      bound: null,
      candidates: [candidate('panel', toast(SHARING_PANEL))],
    });
    assert.equal(decision.action, 'idle');
    assert.equal(decision.reason, 'no-viable-candidate');
  });

  test('no line of it can be emitted as a caption', () => {
    const parsed = H.selectBestCaptionCandidate(H.extractLines(SHARING_PANEL), 'Kavya Bhardwaj');
    assert.equal(parsed, null, `panel produced a caption: ${JSON.stringify(parsed)}`);
  });

  test('its button labels are never speakers', () => {
    for (const label of ['Add others', 'Stop sharing', 'Jump to bottom']) {
      assert.equal(H.isPlausibleSpeakerName(label), false, label);
      assert.equal(H.isLikelySpeakerLabel(label), false, label);
    }
  });

  test('two whole-line button labels mark a block as UI on their own', () => {
    // no notification phrasing anywhere in it — the shape alone must be enough
    const bare = ['Add others', 'Some ordinary sentence of text here', 'Stop sharing'].join('\n');
    assert.equal(H.looksLikeNotificationBlock(H.extractLines(bare)), true);
  });

  test('one button label in a long block is not enough on its own', () => {
    // guards the rule above from swallowing a caption box that happens to
    // contain a single short line matching a control label
    const captions = [
      'Alice Chen: we should close the loop on that before Friday',
      'Bob Iyer: agreed, I will send the summary tonight',
      'Done',
    ].join('\n');
    assert.equal(H.looksLikeNotificationBlock(H.extractLines(captions)), false);
  });
});

describe('device and sharing chrome is excluded, similar speech is not', () => {
  const excluded = [
    'Your microphone is on.',
    'Microphone (2- Realtek(R) Audio)',
    'Array (2- Realtek(R) Audio)',
    "You're no longer sharing audio and video with Read AI",
    'Or share this meeting link with others you want in the meeting',
    'Waiting for Read AI to be connected',
  ];
  for (const line of excluded) {
    test(`excluded: "${line}"`, () => {
      assert.equal(H.isNotificationLine(line), true);
      assert.equal(H.isLikelySpokenText(line), false);
    });
  }

  // "on" is only a notification at the end of the line; these say the same
  // words in the middle of real sentences and must survive.
  const speech = [
    'your microphone is on the table next to the laptop',
    'I think your microphone is on mute again',
    'we are sharing audio and video with the whole team now',
    'can you share this meeting recording with the design folks',
  ];
  for (const line of speech) {
    test(`kept: "${line}"`, () => {
      assert.equal(H.isNotificationLine(line), false, 'flagged as a notification');
      assert.equal(H.isLikelySpokenText(line), true);
    });
  }
});

/**
 * (e) Meet's accessibility announcer, captured verbatim from a second live
 * session. A different element from the sharing panel in (d) — no button
 * labels, no speaker at all, so every row landed under speaker "Unknown".
 * Measured before the fix: ELIGIBLE at 119, and it emitted.
 */
const A11Y_ANNOUNCER = [
  'Raise hand (ctrl + alt + h)',
  'You reacted with 👍.',
  'Looking for others in the call...',
  'No one else is here',
  'Press Down Arrow to open the hover tray and Escape to close it.',
].join('\n');

describe("scenario (e): Meet's accessibility announcer", () => {
  test('the announcer block is disqualified', () => {
    const scored = scoreOf(toast(A11Y_ANNOUNCER));
    assert.equal(scored.notification, true);
    assert.equal(scored.score, H.DISQUALIFIED);
  });

  test('no line of it can be emitted as a caption', () => {
    const parsed = H.selectBestCaptionCandidate(H.extractLines(A11Y_ANNOUNCER), 'Kavya Bhardwaj');
    assert.equal(parsed, null, `announcer produced a caption: ${JSON.stringify(parsed)}`);
  });

  test('it loses to the caption box with nothing bound', () => {
    const decision = H.createRootArbiter().evaluate({
      bound: null,
      candidates: [
        candidate('announcer', toast(A11Y_ANNOUNCER)),
        candidate('captions', captionBox(LABEL_LAYOUT_CAPTIONS)),
      ],
    });
    assert.equal(decision.key, 'captions');
  });
});

describe('announcer chrome is excluded, similar speech is not', () => {
  const excluded = [
    'Raise hand (ctrl + alt + h)',
    'You reacted with 👍.',
    'Looking for others in the call...',
    'No one else is here',
    'Press Down Arrow to open the hover tray and Escape to close it.',
  ];
  for (const line of excluded) {
    test(`excluded: "${line}"`, () => {
      assert.equal(H.isNotificationLine(line), true);
    });
  }

  // Anchored at line start, so the same words mid-sentence stay speech.
  const speech = [
    'I think we should press ahead with the launch next week',
    'can you raise hand if you have seen the new dashboard',
    'no one else is here yet so let us start with the roadmap',
    'she reacted with genuine surprise when we showed her the numbers',
  ];
  for (const line of speech) {
    test(`kept: "${line}"`, () => {
      assert.equal(H.isNotificationLine(line), false, 'flagged as a notification');
      assert.equal(H.isLikelySpokenText(line), true);
    });
  }
});

describe('a bound root that discovery can no longer find', () => {
  // Observed live: the popup reported `bound c60`, c60 absent from a 5-element
  // candidate list, and the real caption box sitting unbound at 52. The margin
  // rule was defending a leftover against the only element still discoverable.
  const leftover = { key: 'c60', score: 44, attached: true, discoverable: false };
  const captionBox = { key: 'captions', score: 52 };

  test('is replaced immediately, without waiting for corroboration', () => {
    const decision = H.createRootArbiter().evaluate({
      bound: leftover,
      candidates: [captionBox],
    });
    assert.equal(decision.action, 'bind');
    assert.equal(decision.key, 'captions');
    assert.equal(decision.reason, 'bound-root-undiscoverable');
  });

  test('is kept when there is nothing viable to replace it with', () => {
    const decision = H.createRootArbiter().evaluate({
      bound: leftover,
      candidates: [{ key: 'toast', score: 300, notification: true }],
    });
    assert.equal(decision.action, 'keep');
  });

  test('a discoverable root is still defended by the switch margin', () => {
    // the regression guard: this is the rule that stops a toast flapping the
    // binding away from a working caption box
    const decision = H.createRootArbiter().evaluate({
      bound: { key: 'captions', score: 44, attached: true, discoverable: true },
      candidates: [{ key: 'other', score: 52 }],
    });
    assert.equal(decision.action, 'keep');
    assert.equal(decision.reason, 'challenger-within-margin');
  });

  test('callers that omit the flag keep the old behaviour', () => {
    const decision = H.createRootArbiter().evaluate({
      bound: { key: 'captions', score: 44, attached: true },
      candidates: [{ key: 'other', score: 52 }],
    });
    assert.equal(decision.action, 'keep');
  });
});

describe('extractLines', () => {
  // Arrays built inside the vm carry that context's Array.prototype, which
  // deepStrictEqual treats as unequal. Re-wrap them as host arrays.
  const lines = (s) => [...H.extractLines(s)];

  test('splits, normalises and drops blanks', () => {
    assert.deepEqual(lines('  Alice: hi  \r\n\n  Bob:  there '), ['Alice: hi', 'Bob: there']);
  });
  test('handles empty input', () => {
    assert.deepEqual(lines(''), []);
    assert.deepEqual(lines(null), []);
  });
});
