import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildJevQuestions, judgeWithLlm, llmInstruction } from '../src/judges.ts';
import { AXES, CURRENT_STATE_NOTE, type AxisMap } from '../src/constants.ts';

function axesOf(overrides: Partial<AxisMap> = {}): AxisMap {
  const axes = {} as AxisMap;
  for (const axis of AXES) axes[axis] = 0;
  return { ...axes, ...overrides };
}

const turn = { user: 'だいたい君は強引だ', axes: axesOf({ anger: 0.9123456789, joy: 0.2 }) };

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

test('llmInstruction は過去の観察ではなく自分の反応を求める', () => {
  assert.match(llmInstruction(), /あなた自身/);
});

test('現在の状態の扱いは jev の問い文と同じ文言で説明する', () => {
  // 片方だけ現在値の説明が付くと、判定の差に指示文の差が混ざる。
  assert.ok(llmInstruction().includes(CURRENT_STATE_NOTE));
  assert.ok(buildJevQuestions().joy.instructions.includes(CURRENT_STATE_NOTE));
});

test('LLM に渡す prompt は現在の8軸と user の発言を含む', async () => {
  let seen = '';
  await judgeWithLlm(turn, async (options) => {
    seen = options.prompt;
    return { object: fakeObject(), usage: { inputTokens: 0, outputTokens: 0 } };
  });
  assert.match(seen, /だいたい君は強引だ/);
  assert.match(seen, /"user":/);
  // 現在値を落とすと、affectus の agent の課題を再現しない。
  assert.match(seen, /"axes":/);
  assert.match(seen, /"anger": 0\.91/);
  // 記録された返答は入力に含めない。
  assert.doesNotMatch(seen, /"agent":/);
});

test('prompt の入力 JSON は jev の state と同じ形になる', async () => {
  let seen = '';
  await judgeWithLlm(turn, async (options) => {
    seen = options.prompt;
    return { object: fakeObject(), usage: { inputTokens: 0, outputTokens: 0 } };
  });
  // 両者の状態が一致している間は、渡る JSON も一字一句同じでなければならない。
  const expected = JSON.stringify(
    { axes: { ...axesOf({ joy: 0.2 }), anger: 0.91 }, user: 'だいたい君は強引だ' },
    null,
    2,
  );
  assert.ok(seen.includes(expected), `入力 JSON が一致しない:\n${seen}`);
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
