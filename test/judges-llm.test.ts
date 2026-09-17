import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeWithLlm, llmInstruction } from '../src/judges.ts';
import { AXES } from '../src/constants.ts';

const turn = { user: 'だいたい君は強引だ', agent: '……勇み足でした' };

function fakeObject(): Record<string, number> {
  const o: Record<string, number> = {};
  for (const axis of AXES) o[axis] = 0;
  o.sorrow = 0.2;
  o.joy = -0.1;
  return o;
}

test('llmInstruction は8軸すべてを列挙する', () => {
  const text = llmInstruction();
  for (const axis of AXES) assert.match(text, new RegExp(axis));
});

test('LLM の出力をそのままデルタとして使う', async () => {
  const out = await judgeWithLlm(turn, async () => ({
    object: fakeObject(),
    usage: { inputTokens: 400, outputTokens: 90 },
  }));
  assert.equal(out.deltas.sorrow, 0.2);
  assert.equal(out.deltas.joy, -0.1);
  assert.equal(out.deltas.anger, 0);
});

test('confidence と rawScore は空になる', async () => {
  const out = await judgeWithLlm(turn, async () => ({
    object: fakeObject(),
    usage: { inputTokens: 400, outputTokens: 90 },
  }));
  assert.deepEqual(out.confidence, {});
  assert.deepEqual(out.rawScore, {});
});

test('コストは入出力の両方を合算する', async () => {
  const out = await judgeWithLlm(turn, async () => ({
    object: fakeObject(),
    usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
  }));
  assert.equal(out.costUsd, 6);
  assert.equal(out.model, 'anthropic/claude-haiku-4.5');
});

test('配信元を anthropic に固定して呼ぶ', async () => {
  let seen;
  await judgeWithLlm(turn, async (options) => {
    seen = options.providerOptions;
    return { object: fakeObject(), usage: { inputTokens: 0, outputTokens: 0 } };
  });
  assert.deepEqual(seen, { gateway: { only: ['anthropic'] } });
});

test('outcome に provider が入る', async () => {
  const out = await judgeWithLlm(turn, async () => ({
    object: fakeObject(),
    usage: { inputTokens: 0, outputTokens: 0 },
  }));
  assert.equal(out.provider, 'anthropic');
});

test('モデル名を指定できる', async () => {
  const out = await judgeWithLlm(
    turn,
    async () => ({ object: fakeObject(), usage: { inputTokens: 0, outputTokens: 0 } }),
    'typesafe-ai/jev',
  );
  assert.equal(out.model, 'typesafe-ai/jev');
});

test('レンジ外の値は -1〜1 に丸められる', async () => {
  const out = await judgeWithLlm(turn, async () => {
    const o = fakeObject();
    o.anger = 5;
    o.fear = -3;
    return { object: o, usage: { inputTokens: 0, outputTokens: 0 } };
  });
  assert.equal(out.deltas.anger, 1);
  assert.equal(out.deltas.fear, -1);
});

test('軸が欠けていれば軸名を挙げて投げる', async () => {
  const object = fakeObject();
  delete object.disgust;
  await assert.rejects(
    () => judgeWithLlm(turn, async () => ({ object, usage: { inputTokens: 0, outputTokens: 0 } })),
    /disgust/,
  );
});

test('数値でない軸は投げる。0 に丸めて「変化なし」にしない', async () => {
  const object = fakeObject();
  object.anger = Number.NaN;
  await assert.rejects(
    () => judgeWithLlm(turn, async () => ({ object, usage: { inputTokens: 0, outputTokens: 0 } })),
    /anger/,
  );
});
