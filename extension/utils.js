/**
 * Shared helpers: timing, text normalization, partial caption merge, dedupe keys.
 * Kept framework-free for direct inclusion in the content script bundle order.
 */
(function initMeetTranscriptUtils(global) {
  const MeetTranscriptUtils = {};

  /** @param {function(...any): void} fn */
  MeetTranscriptUtils.debounce = function debounce(fn, waitMs) {
    let t = null;
    return function debounced(...args) {
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        t = null;
        fn.apply(this, args);
      }, waitMs);
    };
  };

  /** @param {function(...any): void} fn */
  MeetTranscriptUtils.throttle = function throttle(fn, waitMs) {
    let last = 0;
    let trailing = null;
    return function throttled(...args) {
      const now = Date.now();
      const remain = waitMs - (now - last);
      if (remain <= 0) {
        if (trailing) {
          clearTimeout(trailing);
          trailing = null;
        }
        last = now;
        fn.apply(this, args);
      } else if (!trailing) {
        trailing = setTimeout(() => {
          trailing = null;
          last = Date.now();
          fn.apply(this, args);
        }, remain);
      }
    };
  };

  MeetTranscriptUtils.normalizeText = function normalizeText(s) {
    return String(s || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  };

  /**
   * Stable key for dedupe within a time window (speaker + normalized text).
   */
  MeetTranscriptUtils.fingerprint = function fingerprint(speaker, text) {
    const sp = MeetTranscriptUtils.normalizeText(speaker).toLowerCase();
    const tx = MeetTranscriptUtils.normalizeText(text).toLowerCase();
    return `${sp}::${tx}`;
  };

  /**
   * If `next` looks like an extension/revision of `prev`, return merged text.
   * Otherwise return null (treat as new utterance).
   */
  MeetTranscriptUtils.tryMergePartial = function tryMergePartial(prev, next) {
    const a = MeetTranscriptUtils.normalizeText(prev);
    const b = MeetTranscriptUtils.normalizeText(next);
    if (!a || !b) return null;
    if (b === a) return b;
    if (b.startsWith(a)) return b;
    if (a.startsWith(b)) return a;
    // Common live-caption behavior: small suffix edits
    if (Math.abs(a.length - b.length) <= 3 && (a.slice(0, -2) === b.slice(0, -2))) {
      return a.length >= b.length ? a : b;
    }
    return null;
  };

  /**
   * Parse "Speaker: text" with fallback to previous speaker / Unknown.
   */
  MeetTranscriptUtils.parseCaptionLine = function parseCaptionLine(line, lastSpeaker) {
    const raw = MeetTranscriptUtils.normalizeText(line);
    if (!raw) return null;
    const m = raw.match(/^([^:]{1,120}):\s*(.+)$/);
    if (m) {
      return { speaker: MeetTranscriptUtils.normalizeText(m[1]) || 'Unknown', text: m[2].trim() };
    }
    return { speaker: lastSpeaker || 'Unknown', text: raw };
  };

  /**
   * Live-caption delta: return only the NEW suffix of `nextFull` vs what we already emitted (`prevCumulative`).
   * Handles growing strings, word-level rewrites, and new segments (no shared prefix → emit whole next).
   */
  MeetTranscriptUtils.computeCaptionDelta = function computeCaptionDelta(prevCumulative, nextFull) {
    const a = MeetTranscriptUtils.normalizeText(prevCumulative);
    const b = MeetTranscriptUtils.normalizeText(nextFull);
    if (!b) {
      return { delta: '', newCumulative: a };
    }
    if (!a) {
      return { delta: b, newCumulative: b };
    }
    if (a === b) {
      return { delta: '', newCumulative: b };
    }
    const al = a.toLowerCase();
    const bl = b.toLowerCase();
    if (bl.startsWith(al)) {
      const delta = MeetTranscriptUtils.normalizeText(b.slice(a.length));
      return { delta, newCumulative: b };
    }
    const aw = a.split(/\s+/).filter(Boolean);
    const bw = b.split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < aw.length && i < bw.length && aw[i].toLowerCase() === bw[i].toLowerCase()) {
      i += 1;
    }
    if (i === 0) {
      return { delta: b, newCumulative: b };
    }
    const delta = bw.slice(i).join(' ').trim();
    return { delta, newCumulative: b };
  };

  global.MeetTranscriptUtils = MeetTranscriptUtils;
})(typeof globalThis !== 'undefined' ? globalThis : this);
