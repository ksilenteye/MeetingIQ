/**
 * Observes Google Meet's caption UI with MutationObserver + heuristics.
 * Batches deduplicated lines and sends them to the service worker for POST /transcript.
 */
(function meetTranscriptContent() {
  const BaseUtils = globalThis.MeetTranscriptUtils || {};
  const U = {
    normalizeText(s) {
      if (typeof BaseUtils.normalizeText === 'function') return BaseUtils.normalizeText(s);
      return String(s || '')
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    },
    parseCaptionLine(line, lastSpeaker) {
      if (typeof BaseUtils.parseCaptionLine === 'function') return BaseUtils.parseCaptionLine(line, lastSpeaker);
      const raw = U.normalizeText(line);
      if (!raw) return null;
      const m = raw.match(/^([^:]{1,120}):\s*(.+)$/);
      if (m) return { speaker: U.normalizeText(m[1]) || 'Unknown', text: m[2].trim() };
      return { speaker: lastSpeaker || 'Unknown', text: raw };
    },
    tryMergePartial(prev, next) {
      if (typeof BaseUtils.tryMergePartial === 'function') return BaseUtils.tryMergePartial(prev, next);
      const a = U.normalizeText(prev);
      const b = U.normalizeText(next);
      if (!a || !b) return null;
      if (b === a) return b;
      if (b.startsWith(a)) return b;
      if (a.startsWith(b)) return a;
      return null;
    },
    fingerprint(speaker, text) {
      if (typeof BaseUtils.fingerprint === 'function') return BaseUtils.fingerprint(speaker, text);
      return `${U.normalizeText(speaker).toLowerCase()}::${U.normalizeText(text).toLowerCase()}`;
    },
    computeCaptionDelta(prevCumulative, nextFull) {
      if (typeof BaseUtils.computeCaptionDelta === 'function') {
        return BaseUtils.computeCaptionDelta(prevCumulative, nextFull);
      }
      const a = U.normalizeText(prevCumulative);
      const b = U.normalizeText(nextFull);
      if (!b) return { delta: '', newCumulative: a };
      if (!a) return { delta: b, newCumulative: b };
      const al = a.toLowerCase();
      const bl = b.toLowerCase();
      if (bl.startsWith(al)) return { delta: U.normalizeText(b.slice(a.length)), newCumulative: b };
      const aw = a.split(/\s+/).filter(Boolean);
      const bw = b.split(/\s+/).filter(Boolean);
      let i = 0;
      while (i < aw.length && i < bw.length && aw[i].toLowerCase() === bw[i].toLowerCase()) i += 1;
      if (i === 0) return { delta: b, newCumulative: b };
      return { delta: bw.slice(i).join(' ').trim(), newCumulative: b };
    },
    debounce(fn, ms) {
      if (typeof BaseUtils.debounce === 'function') return BaseUtils.debounce(fn, ms);
      let t = null;
      return (...args) => {
        if (t) clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
      };
    },
    throttle(fn, ms) {
      if (typeof BaseUtils.throttle === 'function') return BaseUtils.throttle(fn, ms);
      let last = 0;
      return (...args) => {
        const now = Date.now();
        if (now - last >= ms) {
          last = now;
          fn(...args);
        }
      };
    },
  };

  const DEBOUNCE_MS = 500;
  const FLUSH_MS = 1500;
  const DISCOVERY_MS = 2500;
  const DEDUPE_WINDOW_MS = 4000;
  const SPEAKER_MERGE_WINDOW_MS = 4000;
  const MAX_BUFFER = 200;
  const LOCAL_STORE_CAP = 500;
  const STORAGE_KEY = 'meetTranscriptEnabled';
  const LOCAL_LINES_KEY = 'meetTranscriptLocalLines';
  const SYSTEM_LINE_PATTERNS = [
    /you have joined the call/i,
    /live captions have been turned off/i,
    /live captions have been turned on/i,
    /presentation .* added to the main screen/i,
    /is on the main screen/i,
    /microphone/i,
    /speakers?/i,
    /camera is off/i,
    /hand is lowered/i,
    /muted/i,
    /unmuted/i,
    /host/i,
    /meeting details/i,
    /camera not found/i,
    /videocall/i,
    /turned (on|off)/i,
    /show fewer options/i,
    /show more options/i,
    /chat with everyone/i,
    /^apps?$/i,
    /^more options$/i,
    /^captions?$/i,
    /^raise hand$/i,
    /^present now$/i,
    /^people$/i,
    /^activities$/i,
  ];
  const BAD_SPEAKER_PATTERNS = [
    /unknown/i,
    /videocall/i,
    /microphone/i,
    /speaker/i,
    /captions?/i,
    /meeting/i,
    /camera/i,
    /video/i,
    /device/i,
    /chat with everyone/i,
    /options/i,
    /apps?/i,
    /everyone/i,
    /captions?/i,
  ];
  const BAD_TEXT_PATTERNS = [
    /^apps?$/i,
    /^expand_?less$/i,
    /^expand_?more$/i,
    /^show fewer options$/i,
    /^show more options$/i,
    /^chat with everyone$/i,
    /^camera not found$/i,
    /^you have joined the call/i,
  ];

  /** @type {boolean} */
  let enabled = true;
  /** @type {string | null} */
  let observedMeetingId = null;
  /** @type {Element | null} */
  let captionRoot = null;
  /** @type {MutationObserver | null} */
  let observer = null;
  /** @type {string} */
  let lastSpeaker = 'Unknown';
  /** @type {string} */
  let lastDigestSnapshot = '';
  /** Full caption line last seen per speaker — drives delta extraction (new suffix only). */
  /** @type {Map<string, string>} */
  const lastEmittedCumulativeBySpeaker = new Map();
  /** @type {Array<{ timestamp: string, speaker: string, text: string }>} */
  let outBuffer = [];
  /** @type {Map<string, number>} */
  const recentFingerprints = new Map();
  /** @type {number | null} */
  let discoveryTimer = null;
  /** @type {number | null} */
  let flushTimer = null;
  /** @type {MutationObserver | null} */
  let rootObserver = null;

  const debouncedDigest = U.debounce(digestCaptionDom, DEBOUNCE_MS);
  const throttledDiscovery = U.throttle(findAndBindCaptionRoot, 800);

  function isContextInvalidatedError(err) {
    const msg = String(err?.message || err || '').toLowerCase();
    return msg.includes('extension context invalidated');
  }

  function guard(label, fn) {
    return (...args) => {
      try {
        return fn(...args);
      } catch (err) {
        if (isContextInvalidatedError(err)) {
          stopAll();
          return undefined;
        }
        console.warn(`[MeetTranscript] ${label} failed`, err);
        return undefined;
      }
    };
  }

  function extensionContextActive() {
    try {
      return Boolean(chrome?.runtime?.id);
    } catch (_) {
      return false;
    }
  }

  function safeSendMessage(message) {
    if (!extensionContextActive()) return;
    try {
      chrome.runtime.sendMessage(message, () => {
        void chrome.runtime.lastError;
      });
    } catch (err) {
      if (isContextInvalidatedError(err)) stopAll();
    }
  }

  function stopAll() {
    teardownObserver();
    if (rootObserver) {
      rootObserver.disconnect();
      rootObserver = null;
    }
    if (discoveryTimer) {
      clearInterval(discoveryTimer);
      discoveryTimer = null;
    }
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
  }

  function getMeetingIdFromLocation() {
    const u = new URL(location.href);
    const m = u.pathname.match(/\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
    if (m) return m[1].toLowerCase();
    const q = u.searchParams.get('hs');
    if (q && /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(q)) return q.toLowerCase();
    return `adhoc-${u.pathname.replace(/\W/g, '').slice(0, 24) || 'meet'}`;
  }

  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const st = globalThis.getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function scoreCaptionCandidate(el) {
    let score = 0;
    const live = el.getAttribute?.('aria-live');
    if (live === 'polite' || live === 'assertive') score += 55;
    const role = el.getAttribute?.('role');
    if (role === 'log' || role === 'status') score += 25;
    if (!isVisible(el)) return -1;
    const t = (el.innerText || '').trim();
    if (t.length > 0 && t.length < 4000) score += 12;
    if (/:\s/.test(t)) score += 18;
    if (/[\n\r]/.test(t)) score += 8;
    if (t.length > 2000) score -= 15;
    if (SYSTEM_LINE_PATTERNS.some((p) => p.test(t))) score -= 20;
    // Prefer smaller regions that look like one caption card vs. whole page live region
    const area = el.getBoundingClientRect();
    const pixels = area.width * area.height;
    if (pixels > 0 && pixels < 800000) score += 8;
    if (area.top > window.innerHeight * 0.45) score += 8;
    if (area.left > window.innerWidth * 0.15 && area.right < window.innerWidth * 0.85) score += 4;
    const lines = extractLinesFromRawText(t);
    const signal = captionSignalScore(lines);
    score += signal;
    if (lines.length < 2) score -= 8;
    if (lines.length > 20) score -= 10;
    return score;
  }

  /**
   * Dynamic discovery: prefer aria-live regions; fall back to role=log / Meet-ish containers.
   */
  function findBestCaptionRoot() {
    const pools = [];
    try {
      pools.push(...document.querySelectorAll('[aria-live="polite"], [aria-live="assertive"]'));
    } catch (_) {
      /* ignore */
    }
    try {
      pools.push(...document.querySelectorAll('[role="log"], [role="status"]'));
    } catch (_) {
      /* ignore */
    }
    try {
      pools.push(...document.querySelectorAll('[jsname], [data-message-text], [data-message-id]'));
    } catch (_) {
      /* ignore */
    }
    let best = null;
    let bestScore = -Infinity;
    for (const el of pools) {
      const s = scoreCaptionCandidate(el);
      if (s > bestScore) {
        bestScore = s;
        best = el;
      }
    }
    return bestScore >= 8 ? best : null;
  }

  function extractLinesFromRawText(rawText) {
    const raw = String(rawText || '').replace(/\r\n/g, '\n');
    return raw
      .split('\n')
      .map((l) => U.normalizeText(l))
      .filter(Boolean);
  }

  function extractLinesFromRoot(root) {
    return extractLinesFromRawText(root?.innerText || '');
  }

  function isSystemLine(line) {
    return SYSTEM_LINE_PATTERNS.some((p) => p.test(line));
  }

  function isPlausibleSpeakerName(name) {
    const n = U.normalizeText(name);
    if (!n || n.length < 2 || n.length > 48) return false;
    if (BAD_SPEAKER_PATTERNS.some((p) => p.test(n))) return false;
    if (/\d{3,}/.test(n)) return false;
    const words = n.split(/\s+/).filter(Boolean);
    if (words.length < 1 || words.length > 5) return false;
    if (!/^[\p{L}\p{M}'`.-]+(?:\s+[\p{L}\p{M}'`.-]+)*$/u.test(n)) return false;
    if (n === n.toLowerCase() && !n.includes(' ')) return false;
    return true;
  }

  function isLikelySpeakerLabel(line) {
    if (!line) return false;
    if (line.length > 64) return false;
    if (/[.:!?]$/.test(line)) return false;
    if (/\d/.test(line)) return false;
    if (isSystemLine(line)) return false;
    return isPlausibleSpeakerName(line);
  }

  function isLikelySpokenText(text) {
    const t = U.normalizeText(text);
    if (!t) return false;
    if (isSystemLine(t)) return false;
    if (BAD_TEXT_PATTERNS.some((p) => p.test(t))) return false;
    if (t.length < 8) return false;
    const words = t.split(/\s+/).filter(Boolean);
    if (words.length < 3) return false;
    // Reject button-y labels and identifiers.
    if (/^[a-z_]+$/.test(t)) return false;
    if (/^[A-Za-z ]{1,24}$/.test(t) && words.length <= 2) return false;
    return true;
  }

  function captionSignalScore(lines) {
    if (!lines.length) return -10;
    let signal = 0;
    let systemCount = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (isSystemLine(line)) {
        systemCount += 1;
        continue;
      }
      const parsed = U.parseCaptionLine(line, '');
      if (line.includes(':') && parsed && isPlausibleSpeakerName(parsed.speaker) && isLikelySpokenText(parsed.text)) {
        signal += 20;
      }
      if (i > 0 && isLikelySpeakerLabel(lines[i - 1]) && isLikelySpokenText(line)) {
        signal += 14;
      }
      if (/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}$/.test(line)) signal += 2;
    }
    signal -= systemCount * 6;
    return signal;
  }

  function selectBestCaptionCandidate(lines) {
    if (!lines.length) return null;
    // Prefer explicit "Speaker: text" forms first.
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      const parsed = U.parseCaptionLine(line, lastSpeaker);
      if (!parsed) continue;
      if (line.includes(':') && isPlausibleSpeakerName(parsed.speaker) && isLikelySpokenText(parsed.text)) {
        return parsed;
      }
    }

    // Fallback: two-line pattern where previous line is speaker label.
    for (let i = lines.length - 1; i >= 1; i -= 1) {
      const textLine = lines[i];
      const speakerLine = lines[i - 1];
      if (!textLine || !speakerLine) continue;
      if (!isLikelySpokenText(textLine)) continue;
      if (!isLikelySpeakerLabel(speakerLine)) continue;
      return { speaker: speakerLine, text: textLine };
    }

    // Last fallback: line without speaker only if we already know a speaker and line is not system text.
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (!isLikelySpokenText(line)) continue;
      if (lastSpeaker && isPlausibleSpeakerName(lastSpeaker)) {
        return { speaker: lastSpeaker, text: line };
      }
    }

    return null;
  }

  function pruneDedupeMap(now) {
    for (const [k, t] of recentFingerprints) {
      if (now - t > DEDUPE_WINDOW_MS) recentFingerprints.delete(k);
    }
  }

  function shouldSkipDuplicate(speaker, text, now) {
    pruneDedupeMap(now);
    const fp = U.fingerprint(speaker, text);
    const prev = recentFingerprints.get(fp);
    if (prev && now - prev < DEDUPE_WINDOW_MS) return true;
    recentFingerprints.set(fp, now);
    return false;
  }

  /** Continuation chunks can be short; filter obvious noise only. */
  function isDeltaWorthEmit(delta) {
    const d = U.normalizeText(delta);
    if (!d) return false;
    if (BAD_TEXT_PATTERNS.some((p) => p.test(d))) return false;
    if (d.length < 2 && !/\w/u.test(d)) return false;
    return true;
  }

  /**
   * Append only NEW caption suffix (delta) to buffer — not the full live block.
   */
  function commitLine(speaker, deltaText) {
    const ts = new Date().toISOString();
    const sp = U.normalizeText(speaker) || 'Unknown';
    const tx = U.normalizeText(deltaText);
    if (!tx) return;
    const now = Date.now();
    if (shouldSkipDuplicate(sp, tx, now)) return;

    const last = outBuffer.length ? outBuffer[outBuffer.length - 1] : null;
    if (last && last.speaker === sp) {
      const lastMs = Date.parse(last.timestamp);
      if (!Number.isNaN(lastMs) && now - lastMs <= SPEAKER_MERGE_WINDOW_MS) {
        const needsSpace = last.text && !/[ \n]$/.test(last.text);
        const nextPart = tx.replace(/^[,.;:!?]\s*/, (m) => m.trim());
        last.text = `${last.text}${needsSpace ? ' ' : ''}${nextPart}`.trim();
        // Keep timestamp as first seen chunk for this merged utterance window.
        return;
      }
    }

    outBuffer.push({ timestamp: ts, speaker: sp, text: tx });
    if (outBuffer.length > MAX_BUFFER) outBuffer.splice(0, outBuffer.length - MAX_BUFFER);

    appendLocalStore({ timestamp: ts, speaker: sp, text: tx });
  }

  function resetCaptionState() {
    lastEmittedCumulativeBySpeaker.clear();
    lastDigestSnapshot = '';
    recentFingerprints.clear();
  }

  function appendLocalStore(item) {
    if (!extensionContextActive()) return;
    chrome.storage.local.get([LOCAL_LINES_KEY], guard('appendLocalStore.get', (data) => {
      if (!extensionContextActive()) return;
      const prev = Array.isArray(data[LOCAL_LINES_KEY]) ? data[LOCAL_LINES_KEY] : [];
      prev.push(item);
      const capped = prev.slice(-LOCAL_STORE_CAP);
      try {
        chrome.storage.local.set({ [LOCAL_LINES_KEY]: capped });
      } catch (err) {
        if (isContextInvalidatedError(err)) stopAll();
      }
    }));
  }

  function digestCaptionDom() {
    if (!enabled) return;
    let lines = [];
    if (captionRoot) {
      lines = extractLinesFromRoot(captionRoot);
    } else {
      const fallbackRoot = findBestCaptionRoot();
      if (fallbackRoot) lines = extractLinesFromRoot(fallbackRoot);
    }
    if (!lines.length) return;
    const snapshot = lines.join('\n');
    if (snapshot === lastDigestSnapshot) return;
    lastDigestSnapshot = snapshot;

    const parsed = selectBestCaptionCandidate(lines);
    if (!parsed) return;
    const sp = U.normalizeText(parsed.speaker) || 'Unknown';
    const full = U.normalizeText(parsed.text);
    if (!full) return;

    const prevCumulative = lastEmittedCumulativeBySpeaker.get(sp) || '';
    const { delta, newCumulative } = U.computeCaptionDelta(prevCumulative, full);
    lastEmittedCumulativeBySpeaker.set(sp, newCumulative);
    lastSpeaker = sp;

    if (!delta) return;

    const isFirstSegment = !prevCumulative;
    if (isFirstSegment && !isLikelySpokenText(full)) return;
    if (!isFirstSegment && !isDeltaWorthEmit(delta)) return;

    commitLine(sp, delta);
  }

  function flushPending(force) {
    if (!extensionContextActive()) {
      stopAll();
      return;
    }
    if (!outBuffer.length && !force) return;
    if (!outBuffer.length) return;

    const meeting_id = getMeetingIdFromLocation();
    const batch = outBuffer.splice(0, outBuffer.length);
    safeSendMessage({
      type: 'ENQUEUE',
      payload: { meeting_id, items: batch },
    });
  }

  function onMutations() {
    if (!enabled) return;
    debouncedDigest();
    throttledDiscovery();
  }

  function teardownObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    captionRoot = null;
  }

  function bindObserverTo(root) {
    teardownObserver();
    lastDigestSnapshot = '';
    lastEmittedCumulativeBySpeaker.clear();
    captionRoot = root;
    observer = new MutationObserver(onMutations);
    observer.observe(root, { subtree: true, childList: true, characterData: true });
    // Initial read
    debouncedDigest();
  }

  function findAndBindCaptionRoot() {
    if (!enabled) return;
    const next = findBestCaptionRoot();
    if (!next) {
      if (captionRoot) teardownObserver();
      lastDigestSnapshot = '';
      lastEmittedCumulativeBySpeaker.clear();
      setIndicator(false);
      return;
    }
    if (captionRoot === next) return;
    bindObserverTo(next);
    setIndicator(true);
  }

  /** @param {boolean} active */
  function setIndicator(active) {
    const id = 'meet-transcript-mt-indicator';
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      document.documentElement.appendChild(el);
    }
    el.classList.toggle('meet-transcript-mt-off', !active || !enabled);
  }

  function meetingLifecycleTick() {
    const mid = getMeetingIdFromLocation();
    if (mid !== observedMeetingId) {
      if (observedMeetingId) {
        flushPending(true);
        safeSendMessage({ type: 'MEETING_END', meeting_id: observedMeetingId });
      }
      resetCaptionState();
      observedMeetingId = mid;
      safeSendMessage({ type: 'MEETING_START', meeting_id: mid });
    }
  }

  function start() {
    if (!extensionContextActive()) return;
    chrome.storage.local.get([STORAGE_KEY], guard('storage.get.start', (cfg) => {
      if (!extensionContextActive()) return;
      enabled = cfg[STORAGE_KEY] !== false;
      meetingLifecycleTick();
      findAndBindCaptionRoot();

      rootObserver = new MutationObserver(guard('rootObserver', () => {
        throttledDiscovery();
      }));
      rootObserver.observe(document.documentElement, { subtree: true, childList: true });

      discoveryTimer = setInterval(guard('discoveryTimer', () => {
        meetingLifecycleTick();
        findAndBindCaptionRoot();
      }), DISCOVERY_MS);

      flushTimer = setInterval(guard('flushTimer', () => {
        if (enabled) flushPending(false);
      }), FLUSH_MS);

      window.addEventListener('beforeunload', () => {
        flushPending(true);
        stopAll();
      });

      // SPA navigation within Meet
      const origPush = history.pushState;
      history.pushState = function patchedPushState(...args) {
        const r = origPush.apply(this, args);
        setTimeout(() => {
          guard('pushStateTick', () => {
            meetingLifecycleTick();
            findAndBindCaptionRoot();
          })();
        }, 0);
        return r;
      };
      window.addEventListener('popstate', guard('popstate', () => {
        meetingLifecycleTick();
        findAndBindCaptionRoot();
      }));
    }));

    chrome.storage.onChanged.addListener(guard('storage.onChanged', (changes, area) => {
      if (!extensionContextActive()) return;
      if (area !== 'local') return;
      if (changes[STORAGE_KEY]) {
        enabled = changes[STORAGE_KEY].newValue !== false;
        if (!enabled) {
          teardownObserver();
          flushPending(true);
        } else {
          findAndBindCaptionRoot();
        }
        setIndicator(!!captionRoot);
      }
    }));
  }

  start();
})();
