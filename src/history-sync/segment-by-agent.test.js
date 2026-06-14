'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { segmentByAgent, normAgent } = require('./segment-by-agent');

// shorthand: build items tagged with an agent
const C = (t) => ({ text: t, agent: 'claude' });
const X = (t) => ({ text: t, agent: 'codex' });

test('the canonical example [c,c,x,x,c] → 3 segments [[c,c],[x,x],[c]]', () => {
  const segs = segmentByAgent([C('1'), C('2'), X('3'), X('4'), C('5')]);
  assert.deepStrictEqual(segs.map(s => s.agent), ['claude', 'codex', 'claude']);
  assert.deepStrictEqual(segs.map(s => s.items.map(i => i.text)), [['1', '2'], ['3', '4'], ['5']]);
});

test('all-same agent collapses to one segment', () => {
  const segs = segmentByAgent([C('a'), C('b'), C('c')]);
  assert.strictEqual(segs.length, 1);
  assert.strictEqual(segs[0].agent, 'claude');
  assert.strictEqual(segs[0].items.length, 3);
});

test('empty input → no segments', () => {
  assert.deepStrictEqual(segmentByAgent([]), []);
  assert.deepStrictEqual(segmentByAgent(undefined), []);
});

test('missing/unknown agent normalizes to claude (native default)', () => {
  const segs = segmentByAgent([{ text: 'a' }, { text: 'b', agent: 'bogus' }, X('c')]);
  assert.deepStrictEqual(segs.map(s => s.agent), ['claude', 'codex']);
  assert.deepStrictEqual(segs[0].items.map(i => i.text), ['a', 'b']);
});

test('alternating every item → one segment each', () => {
  const segs = segmentByAgent([C('1'), X('2'), C('3'), X('4')]);
  assert.deepStrictEqual(segs.map(s => s.agent), ['claude', 'codex', 'claude', 'codex']);
  assert.ok(segs.every(s => s.items.length === 1));
});

test('order is preserved across and within segments', () => {
  const segs = segmentByAgent([X('1'), X('2'), C('3')]);
  const flat = segs.flatMap(s => s.items.map(i => i.text));
  assert.deepStrictEqual(flat, ['1', '2', '3']);
});

test('normAgent maps only codex through; everything else → claude', () => {
  assert.strictEqual(normAgent('codex'), 'codex');
  assert.strictEqual(normAgent('claude'), 'claude');
  assert.strictEqual(normAgent(undefined), 'claude');
  assert.strictEqual(normAgent('CODEX'), 'claude'); // exact match only
});
