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

test('偏った分布は期待値どおりの確信度になる', () => {
  // H = -(0.7ln0.7 + 0.2ln0.2 + 0.1ln0.1) = 0.801819
  // 正規化 = H / ln(3) = 0.729847 → confidence = 1 - 0.729847 = 0.270153
  const c = confidenceFromProbabilities([0.7, 0.2, 0.1]);
  assert.ok(Math.abs(c - 0.270153) < 1e-6, `expected ~0.270153, got ${c}`);
});

test('選択肢が1つなら 1', () => {
  assert.equal(confidenceFromProbabilities([1]), 1);
});

test('空の分布は 0', () => {
  assert.equal(confidenceFromProbabilities([]), 0);
});
