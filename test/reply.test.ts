import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReplyPrompt, generateReply, replyInstruction } from '../src/reply.ts';
import { AXES, type AxisMap } from '../src/constants.ts';

function axes(overrides: Partial<AxisMap> = {}): AxisMap {
  const a = {} as AxisMap;
  for (const axis of AXES) a[axis] = 0;
  return { ...a, ...overrides };
}

const input = { user: 'だいたい君は強引だ', axes: axes({ sorrow: 0.42, fear: 0.18 }) };

function fakeText() {
  return { text: '……そうですね。少し先を急ぎすぎました。', usage: { inputTokens: 520, outputTokens: 60 } };
}

test('指示文は8軸とプルチックの構造を渡す', () => {
  const text = replyInstruction();
  for (const axis of AXES) assert.match(text, new RegExp(axis));
  assert.match(text, /対極/);
  assert.match(text, /隣/);
});

test('指示文は感情を言葉にすることを禁じる', () => {
  // 値を字義どおり述べさせると、感情が口調に出ずに説明文になる。
  assert.match(replyInstruction(), /言葉にして述べない/);
});

test('prompt に感情状態と user の発言が入る', () => {
  const prompt = buildReplyPrompt(input);
  assert.match(prompt, /"sorrow":0\.42/);
  assert.match(prompt, /だいたい君は強引だ/);
});

test('両側の prompt は感情状態だけが違う', () => {
  const a = buildReplyPrompt({ user: 'u', axes: axes({ joy: 0.6 }) });
  const b = buildReplyPrompt({ user: 'u', axes: axes({ anger: 0.6 }) });
  assert.notEqual(a, b);
  // 指示文は同一。返答の差が判定の差だけに由来すると言えるようにする。
  assert.ok(a.startsWith(replyInstruction()));
  assert.ok(b.startsWith(replyInstruction()));
});

test('生成した返答とレイテンシを返す', async () => {
  const out = await generateReply(input, async () => fakeText());
  assert.equal(out.reply, '……そうですね。少し先を急ぎすぎました。');
  assert.equal(typeof out.latencyMs, 'number');
  assert.ok(out.latencyMs >= 0);
  assert.equal(out.model, 'anthropic/claude-haiku-4.5');
});

test('配信元を anthropic に固定して呼ぶ', async () => {
  let seen;
  await generateReply(input, async (options) => {
    seen = options.providerOptions;
    return fakeText();
  });
  assert.deepEqual(seen, { gateway: { only: ['anthropic'] } });
});

test('コストは入出力の両方を合算する', async () => {
  const out = await generateReply(input, async () => ({
    text: 'ok',
    usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
  }));
  assert.equal(out.costUsd, 6);
  assert.equal(out.provider, 'anthropic');
});

test('usage が欠けていても 0 として扱う', async () => {
  const out = await generateReply(input, async () => ({ text: 'ok' }));
  assert.equal(out.usage.inputTokens, 0);
  assert.equal(out.costUsd, 0);
});

test('空の返答は投げる', async () => {
  // 空のまま通すと、画面では生成待ちと区別が付かない。
  await assert.rejects(() => generateReply(input, async () => ({ text: '   ' })), /空/);
  await assert.rejects(() => generateReply(input, async () => ({})), /空/);
});

test('軸の順序は AXES に固定される', () => {
  const prompt = buildReplyPrompt({ user: 'u', axes: axes() });
  const order = [...prompt.matchAll(/"([a-z]+)":/g)].map((m) => m[1]);
  assert.deepEqual(order, [...AXES]);
});
