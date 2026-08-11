/**
 * Score a block of page text the way the extension would, without a live Meet.
 *
 *   node extension/tests/score-block.mjs < block.txt
 *   node extension/tests/score-block.mjs "Add others" "Stop sharing"
 *
 * Paste in whatever Meet leaked into your transcript (one line per line, exactly
 * as it appeared in the dashboard) and this prints whether the block would be
 * disqualified as UI, plus a per-line verdict. This is the fastest way to check
 * a new leak: if the block scores anything other than DISQUALIFIED and its lines
 * read as speech, the fix belongs in UI_CONTROL_LABELS or
 * NOTIFICATION_LINE_PATTERNS in caption-heuristics.js.
 *
 * Geometry is assumed (a caption-sized, bottom-centre element), so the absolute
 * score is indicative only — `notification: true` is the verdict that matters,
 * because it is a hard disqualification independent of layout.
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, '..');

const ctx = { globalThis: undefined };
vm.createContext(ctx);
ctx.globalThis = ctx;
for (const file of ['utils.js', 'caption-heuristics.js']) {
  vm.runInContext(fs.readFileSync(path.join(EXT, file), 'utf8'), ctx, { filename: file });
}
const H = ctx.MeetCaptionHeuristics;

const args = process.argv.slice(2);
const text = args.length
  ? args.join('\n')
  : fs.readFileSync(0, 'utf8');

if (!text.trim()) {
  console.error('No input. Pipe a block of text in, or pass lines as arguments.');
  process.exit(2);
}

const VIEW = { innerWidth: 1280, innerHeight: 800, getComputedStyle: () => null };
const element = {
  innerText: text,
  isConnected: true,
  getAttribute: (name) => ({ 'aria-live': 'polite', role: 'status' }[name] ?? null),
  getBoundingClientRect: () => ({ width: 640, height: 96, top: 620, left: 320, right: 960, bottom: 716 }),
};

const features = H.describeCandidate(element, VIEW, 'input');
const scored = H.scoreCandidateFeatures(features);
const disqualified = scored.score === H.DISQUALIFIED;

console.log('');
console.log(`  verdict        ${disqualified ? 'DISQUALIFIED — treated as Meet UI' : 'ELIGIBLE — could be bound as the caption root'}`);
console.log(`  notification   ${scored.notification}`);
console.log(`  score          ${scored.score}${disqualified ? '' : `  (needs >= ${H.MIN_ACCEPT_SCORE} to bind)`}`);
console.log(`  caption signal ${features.captionSignal}`);
console.log(`  reasons        ${JSON.stringify(scored.reasons)}`);
console.log('');
console.log('  per line:');
for (const line of features.lines) {
  const flags = [
    H.isSystemLine(line) ? 'system' : null,
    H.isUiControlLabel(line) ? 'button-label' : null,
    H.isNotificationLine(line) ? 'notification' : null,
    H.isPlausibleSpeakerName(line) ? 'could-be-speaker' : null,
    H.isLikelySpokenText(line) ? 'reads-as-speech' : null,
  ].filter(Boolean);
  const shown = line.length > 62 ? `${line.slice(0, 59)}...` : line;
  console.log(`    ${shown.padEnd(64)} ${flags.join(', ') || '-'}`);
}
console.log('');

const emitted = H.selectBestCaptionCandidate(features.lines, '');
console.log(`  would emit:    ${emitted ? `${emitted.speaker} => ${emitted.text.slice(0, 60)}` : 'nothing'}`);
console.log('');
