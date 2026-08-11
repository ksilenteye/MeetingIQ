/**
 * Observes Google Meet's caption UI with MutationObserver + heuristics.
 * Batches deduplicated lines and sends them to the service worker for POST /transcript.
 *
 * Root selection lives in caption-heuristics.js (loaded first by the manifest)
 * so it can be unit-tested without a DOM; this file is the DOM and chrome.*
 * plumbing around it.
 */
(function meetTranscriptContent() {
  const H = globalThis.MeetCaptionHeuristics;
  if (!H) {
    // Manifest load order guarantees this file exists; if it somehow did not
    // load, stay idle rather than fall back to a weaker heuristic that would
    // quietly record Meet's notification toasts as if they were speech.
    console.error('[MeetTranscript] caption-heuristics.js failed to load; capture disabled.');
    return;
  }

  const BaseUtils = globalThis.MeetTranscriptUtils || {};
  const U = {
    normalizeText(s) {
      if (typeof BaseUtils.normalizeText === 'function') return BaseUtils.normalizeText(s);
      return String(s || '')
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    },
    parseCaptionLine(line, lastSpeakerName) {
      if (typeof BaseUtils.parseCaptionLine === 'function') return BaseUtils.parseCaptionLine(line, lastSpeakerName);
      const raw = U.normalizeText(line);
      if (!raw) return null;
      const m = raw.match(/^([^:]{1,120}):\s*(.+)$/);
      if (m) return { speaker: U.normalizeText(m[1]) || 'Unknown', text: m[2].trim() };
      return { speaker: lastSpeakerName || 'Unknown', text: raw };
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
  const DEBUG_KEY = 'meetTranscriptDebug';
  const LOCAL_LINES_KEY = 'meetTranscriptLocalLines';
  /** `[jsname]` matches a large slice of Meet's DOM; only scan it as a last resort. */
  const WIDE_POOL_CAP = 400;
  /** Bounds for the cheap textContent pre-filter on the wide pool. */
  const WIDE_MIN_TEXT = 12;
  const WIDE_MAX_TEXT = 4000;
  const REBIND_LOG_CAP = 100;

  /** @type {boolean} */
  let enabled = true;
  /** @type {boolean} */
  let debugEnabled = false;
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

  /** Stable per-element ids so the arbiter can recognise the same candidate across ticks. */
  const candidateKeys = new WeakMap();
  let candidateKeySeq = 0;
  /** Ring buffer of actual rebinds, readable from the console after a caption gap. */
  const rebindLog = [];

  const arbiter = H.createRootArbiter();

  const debouncedDigest = U.debounce(digestCaptionDom, DEBOUNCE_MS);
  const throttledDiscovery = U.throttle(() => findAndBindCaptionRoot('mutation'), 800);

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

  function keyFor(el) {
    let key = candidateKeys.get(el);
    if (!key) {
      candidateKeySeq += 1;
      key = `c${candidateKeySeq}`;
      candidateKeys.set(el, key);
    }
    return key;
  }

  function isAttached(el) {
    if (!el) return false;
    if (typeof el.isConnected === 'boolean') return el.isConnected;
    return document.documentElement.contains(el);
  }

  function describeAndScore(el) {
    const key = keyFor(el);
    const features = H.describeCandidate(el, window, key);
    const scored = H.scoreCandidateFeatures(features);
    return {
      el,
      key,
      features,
      score: scored.score,
      notification: scored.notification,
      reasons: scored.reasons,
    };
  }

  function queryPool(selector) {
    try {
      return Array.from(document.querySelectorAll(selector));
    } catch (_) {
      return [];
    }
  }

  /**
   * Score every plausible caption container on the page.
   *
   * The narrow accessibility pools are scanned first; the wide `[jsname]` pool
   * costs a forced layout per element, so it is only consulted when the narrow
   * pools produced nothing bindable.
   */
  function collectCandidates() {
    const seen = new Set();
    const scored = [];
    const consume = (elements) => {
      for (const el of elements) {
        if (seen.has(el)) continue;
        seen.add(el);
        scored.push(describeAndScore(el));
      }
    };

    consume(queryPool('[aria-live="polite"], [aria-live="assertive"]'));
    consume(queryPool('[role="log"], [role="status"]'));
    // Meet no longer marks the caption box as a live region. Measured on a live
    // call: the entire page had two elements matching the pools above, and both
    // were notification surfaces. The caption text sits in an attribute-less
    // div two levels under a role="region" wrapper, which is the only stable
    // handle left. Binding that ancestor is also sturdier than the text node,
    // which Meet swaps rather than edits — and the observer is subtree:true, so
    // descendant changes still fire.
    consume(queryPool('[role="region"]'));

    const haveViable = scored.some((c) => !c.notification && c.score >= H.MIN_ACCEPT_SCORE);
    if (!haveViable) {
      // Filter on textContent (which forces no layout) *before* capping. The old
      // code sliced the raw pool in document order, and the caption box was
      // measured at index 484 of 538 — the cap of 80 never came close to it, so
      // the fallback could not rescue a missed caption box either.
      const pool = queryPool('[jsname], [data-message-text], [data-message-id]').filter((el) => {
        const len = (el.textContent || '').trim().length;
        return len >= WIDE_MIN_TEXT && len <= WIDE_MAX_TEXT;
      });
      consume(pool.slice(0, WIDE_POOL_CAP));
    }
    return scored;
  }

  function bestViableCandidate(candidates) {
    const list = candidates || collectCandidates();
    let best = null;
    for (const c of list) {
      if (c.notification || c.score < H.MIN_ACCEPT_SCORE) continue;
      if (!best || c.score > best.score) best = c;
    }
    return best;
  }

  function summariseCandidate(c) {
    return {
      key: c.key,
      score: c.score,
      notification: c.notification,
      ariaLive: c.features.ariaLive,
      role: c.features.role,
      lines: c.features.lineCount,
      reasons: c.reasons,
      snippet: c.features.lines.slice(0, 3).join(' | ').slice(0, 160),
    };
  }

  /**
   * Records why the caption root was (or was not) changed. Console output is
   * behind the meetTranscriptDebug flag; actual rebinds are always kept in a
   * small ring buffer so a gap can be diagnosed after the fact.
   */
  function logRootDecision(trigger, decision, bound, candidates) {
    const changed = decision.action === 'bind' || decision.action === 'unbind';
    if (changed) {
      rebindLog.push({
        at: new Date().toISOString(),
        trigger,
        action: decision.action,
        reason: decision.reason,
        from: bound ? bound.key : null,
        fromScore: bound ? bound.score : null,
        fromAttached: bound ? bound.attached : null,
        to: decision.key,
        toScore: decision.score,
        candidates: candidates.map(summariseCandidate),
      });
      if (rebindLog.length > REBIND_LOG_CAP) rebindLog.splice(0, rebindLog.length - REBIND_LOG_CAP);
    }
    if (!debugEnabled) return;
    const label = `[MeetTranscript] root ${decision.action} (${decision.reason}) via ${trigger}`;
    console.groupCollapsed(label);
    console.log('bound', bound);
    console.log('decision', decision);
    console.table(candidates.map(summariseCandidate));
    console.groupEnd();
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
    arbiter.reset();
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
    if (captionRoot && isAttached(captionRoot)) {
      lines = H.extractLines(captionRoot.innerText || '');
    } else {
      // Unbound (or bound to a node Meet just removed): read the best candidate
      // directly so the rebind window is not a capture gap.
      const fallback = bestViableCandidate();
      if (fallback) lines = H.extractLines(fallback.el.innerText || '');
    }
    if (!lines.length) return;
    const snapshot = lines.join('\n');
    if (snapshot === lastDigestSnapshot) return;
    lastDigestSnapshot = snapshot;

    const parsed = H.selectBestCaptionCandidate(lines, lastSpeaker);
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
    if (isFirstSegment && !H.isLikelySpokenText(full)) return;
    if (!isFirstSegment && !H.isDeltaWorthEmit(delta)) return;

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
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    captionRoot = root;
    // Force a re-read of the new root's contents...
    lastDigestSnapshot = '';
    // ...but deliberately keep lastEmittedCumulativeBySpeaker. Meet swaps caption
    // nodes constantly; clearing delta state on every swap makes the still-visible
    // line look brand new and re-emits text we have already sent.
    observer = new MutationObserver(onMutations);
    observer.observe(root, { subtree: true, childList: true, characterData: true });
    // Initial read
    debouncedDigest();
  }

  /**
   * Re-evaluate which element is the live caption box.
   *
   * Never tears capture down merely because this pass scored badly — only a
   * detached root or a corroborated better candidate causes a change. See
   * createRootArbiter in caption-heuristics.js for the rules.
   */
  function findAndBindCaptionRoot(trigger) {
    if (!enabled) return;
    const candidates = collectCandidates();

    let bound = null;
    if (captionRoot) {
      const attached = isAttached(captionRoot);
      let entry = candidates.find((c) => c.el === captionRoot);
      // Still in the pool? Then it is a real rival and the switch margin
      // applies. Absent from it means no selector reaches this element any
      // more — re-score it so capture continues, but tell the arbiter not to
      // defend it against a candidate discovery *can* still see.
      const discoverable = Boolean(entry);
      if (!entry && attached) entry = describeAndScore(captionRoot);
      bound = {
        key: keyFor(captionRoot),
        score: entry ? entry.score : H.DISQUALIFIED,
        attached,
        discoverable,
      };
    }

    const decision = arbiter.evaluate({ bound, candidates });
    logRootDecision(trigger || 'unknown', decision, bound, candidates);

    if (decision.action === 'bind') {
      const next = candidates.find((c) => c.key === decision.key);
      if (next && next.el !== captionRoot) bindObserverTo(next.el);
    } else if (decision.action === 'unbind') {
      teardownObserver();
    }
    setIndicator(Boolean(captionRoot));
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

  function setDebug(next) {
    debugEnabled = Boolean(next);
    if (!extensionContextActive()) return;
    try {
      chrome.storage.local.set({ [DEBUG_KEY]: debugEnabled });
    } catch (err) {
      if (isContextInvalidatedError(err)) stopAll();
    }
  }

  /**
   * Console handle for diagnosing caption gaps. Pick the "Meet Transcript Stream"
   * context in the DevTools console dropdown, then:
   *   __meetTranscript.enableDebug()   // log every rebind decision from now on
   *   __meetTranscript.rebinds()       // the last 100 rebinds, always recorded
   *   __meetTranscript.candidates()    // score every candidate right now
   */
  globalThis.__meetTranscript = {
    get debug() {
      return debugEnabled;
    },
    enableDebug() {
      setDebug(true);
      return true;
    },
    disableDebug() {
      setDebug(false);
      return false;
    },
    rebinds() {
      return rebindLog.slice();
    },
    candidates() {
      return collectCandidates().map(summariseCandidate);
    },
    state() {
      return {
        enabled,
        debugEnabled,
        meetingId: observedMeetingId,
        boundKey: captionRoot ? keyFor(captionRoot) : null,
        boundAttached: captionRoot ? isAttached(captionRoot) : null,
        arbiter: arbiter.state,
        buffered: outBuffer.length,
        lastSpeaker,
      };
    },
  };

  function start() {
    if (!extensionContextActive()) return;
    chrome.storage.local.get([STORAGE_KEY, DEBUG_KEY], guard('storage.get.start', (cfg) => {
      if (!extensionContextActive()) return;
      enabled = cfg[STORAGE_KEY] !== false;
      debugEnabled = cfg[DEBUG_KEY] === true;
      meetingLifecycleTick();
      findAndBindCaptionRoot('start');

      rootObserver = new MutationObserver(guard('rootObserver', () => {
        throttledDiscovery();
        // While unbound there is no caption observer to drive the digest, so the
        // page-level observer has to — otherwise a rebind window captures nothing.
        if (!captionRoot) debouncedDigest();
      }));
      rootObserver.observe(document.documentElement, { subtree: true, childList: true });

      discoveryTimer = setInterval(guard('discoveryTimer', () => {
        meetingLifecycleTick();
        findAndBindCaptionRoot('interval');
        if (!captionRoot) debouncedDigest();
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
            findAndBindCaptionRoot('pushstate');
          })();
        }, 0);
        return r;
      };
      window.addEventListener('popstate', guard('popstate', () => {
        meetingLifecycleTick();
        findAndBindCaptionRoot('popstate');
      }));
    }));

    chrome.storage.onChanged.addListener(guard('storage.onChanged', (changes, area) => {
      if (!extensionContextActive()) return;
      if (area !== 'local') return;
      if (changes[DEBUG_KEY]) {
        debugEnabled = changes[DEBUG_KEY].newValue === true;
      }
      if (changes[STORAGE_KEY]) {
        enabled = changes[STORAGE_KEY].newValue !== false;
        if (!enabled) {
          teardownObserver();
          arbiter.reset();
          flushPending(true);
        } else {
          findAndBindCaptionRoot('toggle');
        }
        setIndicator(!!captionRoot);
      }
    }));
  }

  start();
})();
