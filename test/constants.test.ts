import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LLM_MODEL, JEV_MODEL, LLM_MODELS, PRICING, REPLY_MODEL } from '../src/constants.ts';

test('UI に出す全モデルに単価がある', () => {
  // 単価が無いと costUsd が投げる。しかも投げるのは課金される呼び出しのあとになる。
  for (const model of LLM_MODELS) {
    assert.ok(PRICING[model], `${model} の単価が PRICING に無い`);
  }
});

test('既定モデルと jev にも単価がある', () => {
  assert.ok(LLM_MODELS.includes(DEFAULT_LLM_MODEL), '既定モデルが選択肢に含まれること');
  assert.ok(PRICING[JEV_MODEL], 'jev の単価があること');
});

test('生成モデルにも単価がある', () => {
  assert.ok(PRICING[REPLY_MODEL], `${REPLY_MODEL} の単価が PRICING に無い`);
});
