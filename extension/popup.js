const STORAGE_KEY = 'meetTranscriptEnabled';

/**
 * Known Meet surfaces that used to leak into the transcript.
 *
 * Each sample is a line captured from a real session. The popup re-runs them
 * against the caption-heuristics.js that Chrome actually loaded, so "did my
 * reload take?" is answerable from the toolbar instead of the DevTools context
 * dropdown. Add a row here whenever a new leak is fixed — a stale build then
 * shows the missing row rather than looking identical to a current one.
 */
const SELF_TEST = [
  { label: 'Sharing / device panel', sample: 'Your microphone is on.' },
  {
    label: 'Accessibility announcer',
    sample: 'Press Down Arrow to open the hover tray and Escape to close it.',
  },
];

/** Real speech that must never be filtered — catches an over-broad pattern. */
const SPEECH_GUARD = 'your microphone is on the table next to the laptop';

function row(label, ok, detail) {
  const div = document.createElement('div');
  div.className = 'row';
  div.innerHTML =
    `<span class="${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✗'}</span>` +
    `<span><b>${label}</b>${detail ? ` — ${detail}` : ''}</span>`;
  return div;
}

function renderSelfTest() {
  const host = document.getElementById('selfTest');
  const hint = document.getElementById('diagHint');
  const H = globalThis.MeetCaptionHeuristics;

  if (!H || typeof H.isNotificationLine !== 'function') {
    host.appendChild(row('caption-heuristics.js', false, 'did not load'));
    hint.textContent = 'The extension package is incomplete. Re-load it from the extension folder.';
    return;
  }

  let missing = 0;
  for (const entry of SELF_TEST) {
    const filtered = H.isNotificationLine(entry.sample);
    if (!filtered) missing += 1;
    host.appendChild(row(entry.label, filtered, filtered ? 'filtered' : 'NOT filtered'));
  }

  const speechKept = !H.isNotificationLine(SPEECH_GUARD);
  host.appendChild(row('Real speech kept', speechKept, speechKept ? '' : 'over-filtering'));

  if (missing > 0) {
    hint.innerHTML =
      '<span class="bad">This build is out of date.</span> Open <code>chrome://extensions</code> ' +
      'and press Reload on this extension, then refresh the Meet tab.';
  } else if (!speechKept) {
    hint.innerHTML = '<span class="bad">A filter is too broad</span> — it is discarding real speech.';
  } else {
    hint.textContent = 'All known Meet UI surfaces are filtered, and speech is untouched.';
  }
}

/**
 * What the content script bound to on the active tab.
 *
 * executeScript with the default ISOLATED world lands in the same world as the
 * content script, so __meetTranscript is visible — it is not reachable from the
 * page world or from this popup's own context.
 */
async function renderBoundState() {
  const host = document.getElementById('boundState');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // With only activeTab, tab.url can be undefined until the action grants it.
  // Absent is not the same as wrong — try the injection and let it report.
  if (!tab || (tab.url && !/^https:\/\/meet\.google\.com\//.test(tab.url))) {
    host.innerHTML = '<span class="warn">—</span> Open this on a Google Meet tab.';
    return;
  }

  let result;
  try {
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const api = globalThis.__meetTranscript;
        if (!api) return { present: false };
        const state = api.state();
        const candidates = api.candidates();
        // A candidate with neither aria-live nor role only enters the pool via
        // the wide DOM fallback, which content.js runs only when the live-region
        // pass yields nothing viable. Its presence means the caption container
        // was never found — a different failure from "a toast out-scored it".
        const liveRegions = candidates.filter((c) => c.ariaLive || c.role);
        return {
          present: true,
          boundKey: state.boundKey,
          meetingId: state.meetingId,
          enabled: state.enabled,
          total: candidates.length,
          disqualified: candidates.filter((c) => c.notification).length,
          liveRegionCount: liveRegions.length,
          wideFallback: candidates.some((c) => !c.ariaLive && !c.role),
          lastSpeaker: state.lastSpeaker,
          buffered: state.buffered,
          arbiter: state.arbiter,
          lastRebind: (api.rebinds().slice(-1)[0] || null) && {
            reason: api.rebinds().slice(-1)[0].reason,
            to: api.rebinds().slice(-1)[0].to,
            at: api.rebinds().slice(-1)[0].at,
          },
          // "bound" only tells us a root exists; which one it is decides whether
          // captions or Meet chrome are being read
          boundIsTopCandidate: (() => {
            const viable = candidates.filter((c) => !c.notification).sort((a, b) => b.score - a.score);
            return viable.length ? viable[0].key === state.boundKey : false;
          })(),
          boundSnippet: (candidates.find((c) => c.key === state.boundKey) || {}).snippet || null,
          top: candidates
            .slice()
            .sort((a, b) => b.score - a.score)
            .slice(0, 5)
            .map((c) => ({
              key: c.key,
              bound: c.key === state.boundKey,
              score: c.score,
              live: c.ariaLive || null,
              role: c.role || null,
              rejected: c.notification,
              snippet: (c.snippet || '').slice(0, 70),
            })),
        };
      },
    });
    result = injected && injected.result;
  } catch (err) {
    host.innerHTML = `<span class="bad">✗</span><span>Could not inspect the tab: ${err.message}</span>`;
    return;
  }

  if (!result || !result.present) {
    host.innerHTML =
      '<span class="bad">✗</span><span>Content script not running. Refresh the Meet tab.</span>';
    return;
  }

  host.innerHTML = '';
  const bound = Boolean(result.boundKey);
  host.appendChild(
    row(
      bound ? 'Caption root bound' : 'Nothing bound yet',
      bound,
      bound ? result.boundKey : 'turn on captions and speak'
    )
  );
  if (bound) {
    host.appendChild(
      row(
        'Bound to the best candidate',
        result.boundIsTopCandidate,
        result.boundIsTopCandidate ? '' : 'bound to something else — stale binding'
      )
    );
    const reading = (result.boundSnippet || '').trim();
    host.appendChild(
      row('Reading text', Boolean(reading), reading ? `“${reading.slice(0, 50)}”` : 'bound node is empty')
    );
  }
  if (result.wideFallback) {
    host.appendChild(
      row('Caption container found', false, 'fell back to a whole-page DOM scan')
    );
  }

  const detail = document.createElement('div');
  detail.className = 'hint';
  detail.style.marginTop = '4px';
  const rows = (result.top || [])
    .map(
      (c) =>
        `${c.bound ? '<b>← BOUND</b> ' : ''}` +
        `${c.rejected ? '<span class="bad">rejected</span>' : `<b>${c.score}</b>`} ` +
        `[live=${c.live || '-'} role=${c.role || '-'}] ` +
        `<em>${c.snippet || '(no text)'}</em>`
    )
    .join('<br>');
  const arb = result.arbiter || {};
  detail.innerHTML =
    `meeting: <b>${result.meetingId || '—'}</b> · buffered: ${result.buffered} · ` +
    `last speaker: ${result.lastSpeaker || '—'}<br>` +
    `last rebind: ${result.lastRebind ? `${result.lastRebind.reason} → ${result.lastRebind.to}` : 'none'} · ` +
    `challenger: ${arb.challengerKey || '—'} streak ${arb.streak || 0}<br>` +
    `candidates: ${result.total} · live regions: ${result.liveRegionCount} · ` +
    `${result.disqualified} rejected as Meet UI<br>` +
    (rows || 'no candidates');
  host.appendChild(detail);

  const copyBtn = document.createElement('button');
  copyBtn.textContent = 'Copy diagnostics';
  copyBtn.style.cssText = 'margin-top:8px;font-size:11px;padding:3px 8px;cursor:pointer';
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(JSON.stringify(result, null, 1));
    copyBtn.textContent = 'Copied';
  });
  host.appendChild(copyBtn);
}

/**
 * Walk the whole page for the element that actually holds the caption text and
 * report its markup.
 *
 * collectCandidates() searches by accessibility markup and then by a capped
 * `[jsname]` pool; when both miss, there is no way to tell from the candidate
 * list *why*. This looks the other way round — find the text a human can see on
 * screen, then describe the element and its ancestors — so the selector can be
 * corrected against what Meet actually renders instead of what it used to.
 *
 * Deliberately run on demand: it touches every element and forces layout.
 */
function captionProbe() {
  const vh = window.innerHeight || 0;
  const found = [];

  for (const el of document.querySelectorAll('*')) {
    let text = '';
    try {
      text = (el.innerText || '').trim();
    } catch (_) {
      continue;
    }
    if (text.length < 40 || text.length > 3000) continue;

    const r = el.getBoundingClientRect();
    if (!(r.width > 120 && r.height > 20)) continue;
    if (vh && r.top < vh * 0.3) continue; // captions render low in the frame

    // keep only the deepest element holding this text, not every ancestor of it
    let deepest = true;
    for (const child of el.children) {
      const ct = ((child.innerText || '').trim()).length;
      if (ct >= text.length * 0.9) {
        deepest = false;
        break;
      }
    }
    if (!deepest) continue;

    const chain = [];
    let node = el;
    for (let hop = 0; node && hop < 6; hop += 1) {
      chain.push(
        [
          node.tagName.toLowerCase(),
          node.getAttribute('aria-live') ? `live=${node.getAttribute('aria-live')}` : null,
          node.getAttribute('role') ? `role=${node.getAttribute('role')}` : null,
          node.hasAttribute('jsname') ? 'jsname' : null,
        ]
          .filter(Boolean)
          .join(' ')
      );
      node = node.parentElement;
    }

    found.push({
      text: text.slice(0, 70),
      len: text.length,
      top: Math.round(r.top),
      live: el.getAttribute('aria-live'),
      role: el.getAttribute('role'),
      jsname: el.hasAttribute('jsname'),
      cls: (el.className && String(el.className).slice(0, 40)) || null,
      chain,
    });
  }

  // How far into document order the first [jsname] match sits, which is what
  // the capped wide pool slices against.
  const jsnamePool = Array.from(document.querySelectorAll('[jsname], [data-message-text], [data-message-id]'));
  const indexes = found
    .map((f) => f.text)
    .map((t) => jsnamePool.findIndex((n) => ((n.innerText || '').trim()).startsWith(t.slice(0, 30))));

  return {
    jsnamePoolSize: jsnamePool.length,
    firstMatchIndexInPool: indexes.filter((i) => i >= 0)[0] ?? -1,
    liveRegionsOnPage: document.querySelectorAll('[aria-live], [role="log"], [role="status"]').length,
    found: found.slice(0, 4),
  };
}

async function runProbe() {
  const out = document.getElementById('probeOut');
  out.textContent = 'scanning…';
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const [injected] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: captionProbe,
  });
  const data = injected && injected.result;
  if (!data || !data.found.length) {
    out.innerHTML =
      '<span class="bad">No caption-shaped text found.</span> Speak, wait for the caption ' +
      'to appear, and press this while it is still on screen.';
    return;
  }
  out.innerHTML =
    `jsname pool: ${data.jsnamePoolSize} · first match at index ` +
    `<b>${data.firstMatchIndexInPool}</b> · live regions: ${data.liveRegionsOnPage}<br><br>` +
    data.found
      .map(
        (f) =>
          `<em>${f.text}</em><br>live=${f.live || '-'} role=${f.role || '-'} ` +
          `jsname=${f.jsname} top=${f.top}<br>chain: ${f.chain.join(' &lt; ')}`
      )
      .join('<br><br>');

  const btn = document.createElement('button');
  btn.textContent = 'Copy probe';
  btn.style.cssText = 'margin-top:8px;font-size:11px;padding:3px 8px;cursor:pointer';
  btn.addEventListener('click', () => {
    navigator.clipboard.writeText(JSON.stringify(data, null, 1));
    btn.textContent = 'Copied';
  });
  out.appendChild(btn);
}

document.addEventListener('DOMContentLoaded', () => {
  const cb = document.getElementById('enabled');
  chrome.storage.local.get([STORAGE_KEY], (data) => {
    cb.checked = data[STORAGE_KEY] !== false;
  });
  cb.addEventListener('change', () => {
    chrome.storage.local.set({ [STORAGE_KEY]: cb.checked });
  });

  renderSelfTest();
  document.getElementById('probeBtn').addEventListener('click', () => {
    runProbe().catch((err) => {
      document.getElementById('probeOut').innerHTML =
        `<span class="bad">✗</span> ${err && err.message ? err.message : 'probe failed'}`;
    });
  });
  // never leave the panel stuck on "checking…" if anything above throws
  renderBoundState().catch((err) => {
    document.getElementById('boundState').innerHTML =
      `<span class="bad">✗</span> ${err && err.message ? err.message : 'inspection failed'}`;
  });
});
