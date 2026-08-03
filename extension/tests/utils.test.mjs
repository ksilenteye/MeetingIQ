/**
 * Tests for extension/utils.js — run with:  node --test extension/tests/
 *
 * utils.js is a plain IIFE that attaches to globalThis (no module system, so it
 * can be listed directly in the manifest's content_scripts), so it is evaluated
 * in a vm context here rather than imported.
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
const U = ctx.MeetTranscriptUtils;

// Objects built inside the vm carry that context's Object.prototype, which
// deepStrictEqual treats as unequal. Re-wrap them as host plain objects.
const plain = (o) => (o == null ? o : { ...o });

describe('normalizeText', () => {
  test('collapses whitespace and nbsp', () => {
    assert.equal(U.normalizeText('  a  b   c  '), 'a b c');
  });
  test('handles null-ish input', () => {
    assert.equal(U.normalizeText(null), '');
    assert.equal(U.normalizeText(undefined), '');
  });
});

describe('computeCaptionDelta', () => {
  test('first caption emits the whole line', () => {
    const r = U.computeCaptionDelta('', 'hello there');
    assert.deepEqual(plain(r), { delta: 'hello there', newCumulative: 'hello there' });
  });

  test('growing caption emits only the new suffix', () => {
    const r = U.computeCaptionDelta('we should', 'we should prioritise the pipeline');
    assert.equal(r.delta, 'prioritise the pipeline');
    assert.equal(r.newCumulative, 'we should prioritise the pipeline');
  });

  test('unchanged caption emits nothing', () => {
    assert.equal(U.computeCaptionDelta('same text', 'same text').delta, '');
  });

  test('prefix match is case-insensitive', () => {
    const r = U.computeCaptionDelta('We Should', 'we should go now');
    assert.equal(r.delta, 'go now');
  });

  test('mid-caption word rewrite emits from the divergence point', () => {
    // Meet revises earlier words as recognition improves
    const r = U.computeCaptionDelta('i think we should', 'i think we must ship');
    assert.equal(r.delta, 'must ship');
    assert.equal(r.newCumulative, 'i think we must ship');
  });

  test('completely new utterance emits in full', () => {
    const r = U.computeCaptionDelta('alpha beta', 'gamma delta');
    assert.equal(r.delta, 'gamma delta');
  });

  test('empty next keeps the previous cumulative', () => {
    const r = U.computeCaptionDelta('alpha beta', '');
    assert.deepEqual(plain(r), { delta: '', newCumulative: 'alpha beta' });
  });

  test('replaying a full transcript never duplicates text', () => {
    // the property that matters: concatenated deltas reconstruct the final line
    const frames = ['we', 'we should', 'we should ship', 'we should ship today'];
    let cumulative = '';
    const parts = [];
    for (const f of frames) {
      const { delta, newCumulative } = U.computeCaptionDelta(cumulative, f);
      if (delta) parts.push(delta);
      cumulative = newCumulative;
    }
    assert.equal(parts.join(' '), 'we should ship today');
  });
});

describe('parseCaptionLine', () => {
  test('splits speaker and text', () => {
    assert.deepEqual(plain(U.parseCaptionLine('Alice: hello world', '')), { speaker: 'Alice', text: 'hello world' });
  });
  test('falls back to the previous speaker when unlabelled', () => {
    assert.deepEqual(plain(U.parseCaptionLine('continued speech', 'Bob')), { speaker: 'Bob', text: 'continued speech' });
  });
  test('falls back to Unknown with no previous speaker', () => {
    assert.equal(U.parseCaptionLine('orphan line', '').speaker, 'Unknown');
  });
  test('blank line yields null', () => {
    assert.equal(U.parseCaptionLine('   ', 'Bob'), null);
  });
  test('only the first colon splits', () => {
    assert.deepEqual(plain(U.parseCaptionLine('Alice: re: the budget', '')), { speaker: 'Alice', text: 're: the budget' });
  });
});

describe('tryMergePartial', () => {
  test('extension of previous merges forward', () => {
    assert.equal(U.tryMergePartial('we should', 'we should go'), 'we should go');
  });
  test('truncation keeps the longer form', () => {
    assert.equal(U.tryMergePartial('we should go', 'we should'), 'we should go');
  });
  test('unrelated text is not merged', () => {
    assert.equal(U.tryMergePartial('alpha', 'beta gamma'), null);
  });
  test('blank input is not merged', () => {
    assert.equal(U.tryMergePartial('', 'beta'), null);
  });
});

describe('fingerprint', () => {
  test('is stable across case and spacing', () => {
    assert.equal(U.fingerprint('Alice', 'Hello  There'), U.fingerprint('alice', 'hello there'));
  });
  test('distinguishes speakers', () => {
    assert.notEqual(U.fingerprint('Alice', 'hi'), U.fingerprint('Bob', 'hi'));
  });
});
