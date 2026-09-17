import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confidenceFromProbabilities } from '../src/confidence.ts';

test('1点に集中した分布は 1', () => {
  assert.equal(confidenceFromProbabilities([0, 0, 1, 0, 0]), 1);
});

test('一様分布は 0', () => {
  const c = confidenceFromProbabilities([0.25, 0.25, 0.25, 0.25]);
  assert.ok(Math.abs(c) < 1e-9, `expected ~0, got ${c}`);
});

test('偏った分布は 0 と 1 の間', () => {
  const c = confidenceFromProbabilities([0.7, 0.2, 0.1]);
  assert.ok(c > 0 && c < 1, `expected between 0 and 1, got ${c}`);
});

test('選択肢が1つなら 1', () => {
  assert.equal(confidenceFromProbabilities([1]), 1);
});

test('空の分布は 0', () => {
  assert.equal(confidenceFromProbabilities([]), 0);
});
