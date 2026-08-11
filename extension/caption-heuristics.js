/**
 * Caption heuristics and caption-root arbitration for Google Meet.
 *
 * Split out of content.js so root selection can be unit-tested without a DOM:
 * every function here is either pure or takes an injected `view` object.
 * manifest.json loads this before content.js.
 *
 * The problem this file exists to solve: Meet's notification toasts (mic
 * nudges, join/leave banners, layout tips) carry the same aria-live/role=status
 * markup as the live caption box, and Meet swaps caption nodes rather than
 * editing them in place. A naive "score everything, bind the winner" pass will
 * therefore hand the observer to a toast, and Meet's caption DOM keeps no
 * history — so any window spent watching the wrong element is permanent loss.
 */
(function initMeetCaptionHeuristics(global) {
  const Utils = global.MeetTranscriptUtils || {};

  const normalizeText = typeof Utils.normalizeText === 'function'
    ? Utils.normalizeText
    : (s) => String(s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

  const parseCaptionLine = typeof Utils.parseCaptionLine === 'function'
    ? Utils.parseCaptionLine
    : (line, lastSpeaker) => {
      const raw = normalizeText(line);
      if (!raw) return null;
      const m = raw.match(/^([^:]{1,120}):\s*(.+)$/);
      if (m) return { speaker: normalizeText(m[1]) || 'Unknown', text: m[2].trim() };
      return { speaker: lastSpeaker || 'Unknown', text: raw };
    };

  /** Score returned for candidates that must never be selected. */
  const DISQUALIFIED = -1000;
  /** A candidate below this is not worth binding at all. */
  const MIN_ACCEPT_SCORE = 8;
  /** A challenger must beat the bound root by this much to even start counting. */
  const SWITCH_MARGIN = 12;
  /** ...and must win this many consecutive evaluations before it takes over. */
  const SWITCH_STREAK = 3;

  /**
   * Button and affordance labels found inside Meet toasts, dialogs and chrome.
   * A line that is exactly one of these is UI, never a person's name — this is
   * what stops a toast's dismiss button being recorded as the speaker "Close".
   */
  const UI_CONTROL_LABELS = new Set([
    'close', 'dismiss', 'got it', 'got it, thanks', 'ok', 'okay', 'undo',
    'hide', 'show', 'learn more', 'not now', 'no thanks', 'cancel', 'retry',
    'try again', 'turn on', 'turn off', 'allow', 'block', 'deny', 'done',
    'save', 'edit', 'delete', 'send', 'open', 'view', 'more', 'less',
    'expand', 'collapse', 'next', 'back', 'yes', 'no', 'settings', 'report',
    'change layout', 'return to home screen', 'rejoin', 'leave call',
    'end call', 'mute', 'unmute', 'pin', 'unpin', 'admit', 'admit all',
    'deny entry', 'join now', 'ask to join', 'present now', 'raise hand',
    'stop presenting', 'switch here', 'copy link', 'copy joining info',
    // Sharing / participant panel controls. Observed being recorded as the
    // speaker of Meet's own panel text ("Add others", "Stop sharing").
    'add others', 'add people', 'invite', 'share screen', 'share this screen',
    'stop sharing', 'stop sharing screen', 'present to everyone',
    'jump to bottom', 'start recording', 'stop recording', 'record meeting',
  ]);

  /**
   * Meet's own notification / banner text.
   *
   * These are matched against caption lines, so they are deliberately anchored
   * or bounded: an unanchored /host/i or /speakers?/i (as an earlier revision
   * used) silently discards real speech like "let's ask the host about that".
   */
  const NOTIFICATION_LINE_PATTERNS = [
    // Mic / camera / device nudges
    /^are you talking\b/i,
    /\byour mic(rophone)? is (off|muted)\b/i,
    /\byour camera is (off|turned off)\b/i,
    /\byou(?:'| a)?re (currently )?muted\b/i,
    /\bno (microphone|camera) (found|detected)\b/i,
    /^(microphone|camera|speakers?) (not found|unavailable|blocked)$/i,
    /\b(mic(rophone)?|camera) (turned|switched) (on|off)\b/i,
    /\bcheck your (audio|video|mic(rophone)?|camera)\b/i,
    // "on" only at end of line: "your microphone is on the table" is speech.
    /\byour mic(rophone)? is on[.!]?$/i,
    /\byour mic(rophone)? is unmuted\b/i,
    // Device-picker entries: "Microphone (2- Realtek(R) Audio)". Matches to the
    // last paren rather than the first — device names nest their own, as in
    // "Realtek(R)", and [^)] would stop inside them.
    /^[\p{L}][\p{L}\d ]{0,39}\(\d+-\s?.{1,60}\)$/u,

    // Join / leave banners. Anchored to a plausible Title-Case name, and
    // excluding pronoun subjects, so that "I joined the call" or "she joined
    // the call yesterday" spoken aloud is not mistaken for one.
    /^(?!(?:I|We|You|He|She|They|It|Everyone|Someone|Nobody|Who|That|This|There)\b)[\p{Lu}][\p{L}'.-]*(?:\s+[\p{L}'.-]+){0,3}\s+(joined|left)(\s+the\s+(call|meeting))?$/u,
    /^\d+ (others?|people|participants?) (joined|left)\b/i,
    /\bis waiting (to join|in the )/i,
    /\bwants to join (this|the) (call|meeting)\b/i,
    /^you have joined the call/i,
    /^you(?:'| a)?re the only one (here|in (this|the) call)/i,

    // Layout / tile tips
    /\bchange your layout\b/i,
    /\bto see more people\b/i,
    /\bshow more tiles\b/i,

    // Presentation / screen share
    /\bpresentation .{0,60}?(added to|removed from) the main screen\b/i,
    /\b(is|was) (now )?on the main screen\b/i,
    /\byou(?:'| a)?re presenting to everyone\b/i,
    /\byou(?:'ve| have)? ?stopped presenting\b/i,
    /\b(started|stopped) presenting\b/i,
    /\byou(?:'| a)?re no longer sharing\b/i,
    /\bshare this meeting link\b/i,
    /^waiting for .{1,60} to be connected$/i,

    // Recording / captions / transcript
    /\bthis (meeting|call) is being recorded\b/i,
    /\brecording (has )?(started|stopped)\b/i,
    /\blive captions (have been )?turned (on|off)\b/i,
    /\bcaptions (are|have been) (on|off|turned on|turned off)\b/i,
    /\btranscript(ion)? (has )?(started|stopped)\b/i,

    // Network / connection
    /\byour (network|connection) (is|quality)\b/i,
    /\b(poor|unstable) (network|connection)\b/i,
    /^reconnecting\b/i,
    /\byou(?:'ve| have)? ?been disconnected\b/i,

    // Accessibility announcer: keyboard hints, hover-tray tips, reaction and
    // participant status. Meet routes these through an aria-live region with
    // the same markup as the caption box, and none of them carry a speaker.
    /\(\s*(ctrl|control|alt|option|shift|cmd|command|win|⌘)\s*\+/i,
    /^press .{1,40} to \w/i,
    /^(use|hit) the .{1,40} (key|button) to \w/i,
    /^you reacted with\b/i,
    /\blooking for others in (the|this) call\b/i,
    /^no one else is here$/i,
    /^(waiting|looking) for (others|someone|people)\b/i,
    /^\d+ (person|people|participants?) in (the|this) call$/i,

    // Meeting chrome
    /\bcopy joining info\b/i,
    /\banyone (in this call|with this link)\b/i,
    /\b(hand is|has) (raised|lowered)( their| his| her)? ?hand?\b/i,
  ];

  /** Whole-line UI chrome: control labels, icon ligatures, clock chips. */
  const UI_CHROME_LINE_PATTERNS = [
    /^apps?$/i,
    /^more options$/i,
    /^show (more|fewer) options$/i,
    /^captions?$/i,
    /^people$/i,
    /^activities$/i,
    /^chat with everyone$/i,
    /^host controls?$/i,
    /^meeting details$/i,
    /^videocall$/i,
    /^expand_?(less|more)$/i,
    /^turn (on|off) (captions|microphone|camera|the mic)$/i,
    /^\d{1,2}:\d{2}(:\d{2})?$/,
    /^[a-z]+(?:_[a-z]+)+$/, // material icon ligatures: mic_off, present_to_all
  ];

  function isUiControlLabel(value) {
    const n = normalizeText(value).replace(/[.!?…]+$/, '').toLowerCase();
    if (!n) return false;
    return UI_CONTROL_LABELS.has(n);
  }

  function isNotificationLine(line) {
    const n = normalizeText(line);
    if (!n) return false;
    return NOTIFICATION_LINE_PATTERNS.some((p) => p.test(n));
  }

  function isUiChromeLine(line) {
    const n = normalizeText(line);
    if (!n) return false;
    if (isUiControlLabel(n)) return true;
    return UI_CHROME_LINE_PATTERNS.some((p) => p.test(n));
  }

  /** Lines that are Meet's own UI rather than anybody's speech. */
  function isSystemLine(line) {
    return isNotificationLine(line) || isUiChromeLine(line);
  }

  function isPlausibleSpeakerName(name) {
    const n = normalizeText(name);
    if (!n || n.length < 2 || n.length > 48) return false;
    // A dismiss button is not a person.
    if (isUiControlLabel(n)) return false;
    if (isSystemLine(n)) return false;
    if (/\d{3,}/.test(n)) return false;
    const words = n.split(/\s+/).filter(Boolean);
    if (words.length < 1 || words.length > 5) return false;
    if (!/^[\p{L}\p{M}'`.-]+(?:\s+[\p{L}\p{M}'`.-]+)*$/u.test(n)) return false;
    if (n === n.toLowerCase() && !n.includes(' ')) return false;
    return true;
  }

  function isLikelySpeakerLabel(line) {
    const n = normalizeText(line);
    if (!n) return false;
    if (n.length > 64) return false;
    if (/[.:!?]$/.test(n)) return false;
    if (/\d/.test(n)) return false;
    if (isSystemLine(n)) return false;
    return isPlausibleSpeakerName(n);
  }

  function isLikelySpokenText(text) {
    const t = normalizeText(text);
    if (!t) return false;
    if (isSystemLine(t)) return false;
    if (t.length < 8) return false;
    const words = t.split(/\s+/).filter(Boolean);
    if (words.length < 3) return false;
    if (/^[a-z_]+$/.test(t)) return false;
    if (/^[A-Za-z ]{1,24}$/.test(t) && words.length <= 2) return false;
    return true;
  }

  /** Continuation chunks can be short; filter obvious noise only. */
  function isDeltaWorthEmit(delta) {
    const d = normalizeText(delta);
    if (!d) return false;
    if (isUiChromeLine(d)) return false;
    if (isNotificationLine(d)) return false;
    if (d.length < 2 && !/\w/u.test(d)) return false;
    return true;
  }

  function extractLines(rawText) {
    return String(rawText || '')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((l) => normalizeText(l))
      .filter(Boolean);
  }

  /** True when the line is an explicit "Speaker: spoken text" caption. */
  function isSpeakerColonLine(line) {
    const n = normalizeText(line);
    if (!n.includes(':')) return false;
    const parsed = parseCaptionLine(n, '');
    if (!parsed) return false;
    return isPlausibleSpeakerName(parsed.speaker) && isLikelySpokenText(parsed.text);
  }

  /**
   * How much this block of lines looks like live captions rather than anything
   * else on the page. Drives both root scoring and notification detection.
   */
  function captionSignalScore(lines) {
    if (!lines || !lines.length) return -10;
    let signal = 0;
    let systemCount = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (isSystemLine(line)) {
        systemCount += 1;
        continue;
      }
      if (isSpeakerColonLine(line)) signal += 20;
      if (i > 0 && isLikelySpeakerLabel(lines[i - 1]) && isLikelySpokenText(line)) signal += 14;
      // Bare Title-Case name on its own line (Meet's speaker-label layout),
      // but not a Title-Case button label like "Close" or "Got it".
      if (!isUiControlLabel(line) && /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}$/.test(line)) signal += 2;
    }
    signal -= systemCount * 6;
    return signal;
  }

  /** Number of lines that are Meet's own notification text. */
  function countNotificationLines(lines) {
    return (lines || []).reduce((n, l) => n + (isNotificationLine(l) ? 1 : 0), 0);
  }

  /** Number of lines that carry real caption content. */
  function countCaptionLines(lines) {
    return (lines || []).reduce((n, l) => n + (isSpeakerColonLine(l) ? 1 : 0), 0);
  }

  /**
   * Content fingerprint for a toast/snackbar.
   *
   * Two independent signals, either of which is enough:
   *  - the block contains Meet notification text and no caption content, or
   *  - the block is small, carries a dismiss-button label, and contains no
   *    "Speaker: text" line (the shape of every Meet snackbar), or
   *  - the block reads as a control panel: two or more whole-line button
   *    labels and no caption content.
   */
  function looksLikeNotificationBlock(lines) {
    const ls = (lines || []).filter(Boolean);
    if (!ls.length) return false;
    const captionLines = countCaptionLines(ls);
    if (captionLines > 0) return false;

    if (countNotificationLines(ls) > 0) return true;

    const controlLabels = ls.filter((l) => isUiControlLabel(l)).length;
    if (controlLabels > 0 && ls.length <= 4) return true;

    // Meet's sharing / device panels interleave a button label with a line of
    // descriptive text, which is exactly the shape of its speaker-label caption
    // layout — so the per-line checks score them as captions and the panel wins
    // the root contest. A caption box never contains two whole-line button
    // labels, no matter how long the conversation runs; a panel always does.
    if (controlLabels >= 2) return true;

    // Entirely UI chrome with nothing spoken in it.
    const chrome = ls.filter((l) => isUiChromeLine(l)).length;
    if (chrome === ls.length) return true;

    return false;
  }

  /**
   * Extract an element into a plain feature object. The only function here that
   * touches the DOM; `view` is injectable so tests can supply a fake window.
   */
  function describeCandidate(el, view, key) {
    const v = view || global;
    const attr = (name) => (typeof el.getAttribute === 'function' ? el.getAttribute(name) : null);

    let visible = true;
    try {
      const st = typeof v.getComputedStyle === 'function' ? v.getComputedStyle(el) : null;
      if (st && (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0)) {
        visible = false;
      }
    } catch (_) {
      /* treat as visible; geometry below is the real check */
    }

    let rect = { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
    try {
      const r = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
      if (r) rect = r;
    } catch (_) {
      /* keep zeroed rect */
    }
    if (!(rect.width > 0 && rect.height > 0)) visible = false;

    const text = String(el.innerText || '');
    const lines = extractLines(text);

    return {
      key,
      ariaLive: attr('aria-live'),
      role: attr('role'),
      visible,
      text,
      lines,
      textLength: text.trim().length,
      lineCount: lines.length,
      hasSpeakerColonLine: lines.some((l) => isSpeakerColonLine(l)),
      captionSignal: captionSignalScore(lines),
      notification: looksLikeNotificationBlock(lines),
      width: rect.width,
      height: rect.height,
      top: rect.top,
      left: rect.left,
      right: rect.right,
      viewportWidth: Number(v.innerWidth) || 0,
      viewportHeight: Number(v.innerHeight) || 0,
    };
  }

  /**
   * Pure scoring over extracted features.
   * Returns { score, notification, reasons } — `reasons` is what the debug log
   * prints so a rebind decision can be read back without re-deriving it.
   */
  function scoreCandidateFeatures(features) {
    const f = features || {};
    const lines = Array.isArray(f.lines) ? f.lines : [];
    const reasons = [];
    let score = 0;
    const add = (label, delta) => {
      if (delta) {
        reasons.push([label, delta]);
        score += delta;
      }
    };

    if (f.visible === false) {
      return { score: DISQUALIFIED, notification: false, reasons: [['not-visible', DISQUALIFIED]] };
    }

    const notification = typeof f.notification === 'boolean'
      ? f.notification
      : looksLikeNotificationBlock(lines);
    if (notification) {
      // Hard disqualification, not a penalty: a toast must never be able to
      // out-score the caption box no matter how caption-like its markup is.
      return { score: DISQUALIFIED, notification: true, reasons: [['meet-notification', DISQUALIFIED]] };
    }

    const live = f.ariaLive;
    if (live === 'polite' || live === 'assertive') add('aria-live', 55);
    if (f.role === 'log') add('role=log', 25);
    else if (f.role === 'status') add('role=status', 10);

    const len = Number(f.textLength) || 0;
    if (len > 0 && len < 4000) add('has-text', 12);
    if (len > 2000) add('very-long-text', -15);

    const signal = typeof f.captionSignal === 'number' ? f.captionSignal : captionSignalScore(lines);
    const hasColonLine = typeof f.hasSpeakerColonLine === 'boolean'
      ? f.hasSpeakerColonLine
      : lines.some((l) => isSpeakerColonLine(l));

    if (hasColonLine) add('speaker-colon-line', 25);
    const lineCount = typeof f.lineCount === 'number' ? f.lineCount : lines.length;
    if (lineCount > 1) add('multiline', 8);
    add('caption-signal', signal);

    // A single long line is what one uninterrupted speaker looks like, so it is
    // only penalised when there is no caption signal to go with it. Penalising
    // it unconditionally (as an earlier revision did) collapsed the caption
    // box's score during exactly the utterances we most need to capture.
    if (lineCount === 0) add('empty', -10);
    else if (lineCount < 2 && signal <= 0) add('single-line-no-signal', -8);
    if (lineCount > 20) add('too-many-lines', -10);

    const pixels = (Number(f.width) || 0) * (Number(f.height) || 0);
    if (pixels > 0 && pixels < 800000) add('caption-sized', 8);
    const vh = Number(f.viewportHeight) || 0;
    const vw = Number(f.viewportWidth) || 0;
    if (vh > 0 && Number(f.top) > vh * 0.45) add('lower-half', 8);
    if (vw > 0 && Number(f.left) > vw * 0.15 && Number(f.right) < vw * 0.85) add('horizontally-centred', 4);

    return { score, notification: false, reasons };
  }

  /**
   * Pick a caption out of a block of lines. `lastSpeaker` carries the speaker
   * forward across continuation lines that carry no label.
   */
  function selectBestCaptionCandidate(lines, lastSpeaker) {
    const ls = (lines || []).filter(Boolean);
    if (!ls.length) return null;

    // Prefer explicit "Speaker: text" forms, most recent first.
    for (let i = ls.length - 1; i >= 0; i -= 1) {
      const line = ls[i];
      if (!line.includes(':')) continue;
      const parsed = parseCaptionLine(line, lastSpeaker);
      if (!parsed) continue;
      if (isPlausibleSpeakerName(parsed.speaker) && isLikelySpokenText(parsed.text)) {
        return { speaker: parsed.speaker, text: parsed.text };
      }
    }

    // Two-line form: a speaker label above its text.
    for (let i = ls.length - 1; i >= 1; i -= 1) {
      const textLine = ls[i];
      const speakerLine = ls[i - 1];
      if (!isLikelySpokenText(textLine)) continue;
      if (!isLikelySpeakerLabel(speakerLine)) continue;
      return { speaker: speakerLine, text: textLine };
    }

    // Unlabelled continuation, only if we already know who is talking.
    for (let i = ls.length - 1; i >= 0; i -= 1) {
      const line = ls[i];
      if (!isLikelySpokenText(line)) continue;
      if (lastSpeaker && isPlausibleSpeakerName(lastSpeaker)) {
        return { speaker: lastSpeaker, text: line };
      }
    }

    return null;
  }

  /**
   * Decides when to hand the MutationObserver to a different element.
   *
   * Rules, in order:
   *  - nothing bound          -> bind the best viable candidate immediately
   *  - bound root detached    -> rebind immediately (a detached node emits no
   *                              mutations, so waiting is pure loss)
   *  - bound root attached    -> keep it unless a challenger beats it by
   *                              `switchMargin` on `switchStreak` consecutive
   *                              evaluations
   *
   * That asymmetry is deliberate: corroboration only ever delays a switch in
   * the case where the current root is still alive and still capturing.
   */
  function createRootArbiter(options) {
    const opts = options || {};
    const switchStreak = Number.isFinite(opts.switchStreak) ? opts.switchStreak : SWITCH_STREAK;
    const switchMargin = Number.isFinite(opts.switchMargin) ? opts.switchMargin : SWITCH_MARGIN;
    const minAccept = Number.isFinite(opts.minAcceptScore) ? opts.minAcceptScore : MIN_ACCEPT_SCORE;

    let challengerKey = null;
    let streak = 0;

    function clearChallenger() {
      challengerKey = null;
      streak = 0;
    }

    return {
      get options() {
        return { switchStreak, switchMargin, minAccept };
      },
      get state() {
        return { challengerKey, streak };
      },
      reset: clearChallenger,

      /**
       * @param {{bound: ?{key: string, score: number, attached: boolean},
       *          candidates: Array<{key: string, score: number, notification?: boolean}>}} input
       * @returns {{action: 'bind'|'keep'|'unbind'|'idle', key: ?string, score: ?number,
       *            reason: string, streak: number, challenger: ?object}}
       */
      evaluate(input) {
        const bound = input && input.bound ? input.bound : null;
        const all = (input && input.candidates) || [];
        const viable = all
          .map((c, index) => ({ ...c, index }))
          .filter((c) => !c.notification && Number(c.score) >= minAccept)
          .sort((a, b) => (b.score - a.score) || (a.index - b.index));
        const best = viable.length ? viable[0] : null;

        if (!bound) {
          clearChallenger();
          if (best) {
            return {
              action: 'bind', key: best.key, score: best.score, reason: 'no-root-bound', streak: 0, challenger: null,
            };
          }
          return {
            action: 'idle', key: null, score: null, reason: 'no-viable-candidate', streak: 0, challenger: null,
          };
        }

        if (!bound.attached) {
          clearChallenger();
          if (best) {
            return {
              action: 'bind', key: best.key, score: best.score, reason: 'bound-root-detached', streak: 0, challenger: null,
            };
          }
          return {
            action: 'unbind', key: null, score: null, reason: 'bound-root-detached-no-replacement', streak: 0, challenger: null,
          };
        }

        // A root that discovery can no longer find is a leftover, not a rival.
        // The switch margin exists to stop flapping between comparable
        // candidates; applying it here let an element that matches no selector
        // any more hold the binding indefinitely while the real caption box sat
        // in the candidate list unbound. Only an explicit false triggers this —
        // callers that omit the flag keep the previous behaviour.
        if (bound.discoverable === false && best) {
          clearChallenger();
          return {
            action: 'bind',
            key: best.key,
            score: best.score,
            reason: 'bound-root-undiscoverable',
            streak: 0,
            challenger: best,
          };
        }

        if (!best || best.key === bound.key) {
          clearChallenger();
          return {
            action: 'keep',
            key: bound.key,
            score: bound.score,
            reason: best ? 'bound-root-still-best' : 'no-viable-challenger',
            streak: 0,
            challenger: null,
          };
        }

        if (best.score < Number(bound.score) + switchMargin) {
          clearChallenger();
          return {
            action: 'keep', key: bound.key, score: bound.score, reason: 'challenger-within-margin', streak: 0, challenger: best,
          };
        }

        if (best.key === challengerKey) streak += 1;
        else {
          challengerKey = best.key;
          streak = 1;
        }

        if (streak >= switchStreak) {
          const decision = {
            action: 'bind', key: best.key, score: best.score, reason: 'challenger-corroborated', streak, challenger: best,
          };
          clearChallenger();
          return decision;
        }

        return {
          action: 'keep', key: bound.key, score: bound.score, reason: 'awaiting-corroboration', streak, challenger: best,
        };
      },
    };
  }

  global.MeetCaptionHeuristics = {
    DISQUALIFIED,
    MIN_ACCEPT_SCORE,
    SWITCH_MARGIN,
    SWITCH_STREAK,
    UI_CONTROL_LABELS,
    NOTIFICATION_LINE_PATTERNS,
    UI_CHROME_LINE_PATTERNS,
    isUiControlLabel,
    isNotificationLine,
    isUiChromeLine,
    isSystemLine,
    isPlausibleSpeakerName,
    isLikelySpeakerLabel,
    isLikelySpokenText,
    isDeltaWorthEmit,
    isSpeakerColonLine,
    extractLines,
    captionSignalScore,
    countNotificationLines,
    countCaptionLines,
    looksLikeNotificationBlock,
    describeCandidate,
    scoreCandidateFeatures,
    selectBestCaptionCandidate,
    createRootArbiter,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
