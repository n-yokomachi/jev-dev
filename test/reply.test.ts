import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReplyPrompt, generateReply, replyInstruction, type ReplyInput } from '../src/reply.ts';
import { AXES, PERSONAS, type AxisMap } from '../src/constants.ts';

function axes(overrides: Partial<AxisMap> = {}): AxisMap {
  const a = {} as AxisMap;
  for (const axis of AXES) a[axis] = 0;
  return { ...a, ...overrides };
}

const input: ReplyInput = {
  user: 'だいたい君は強引だ',
  axes: axes({ sorrow: 0.42, fear: 0.18 }),
  persona: 'friendly',
};

function fakeText() {
  return { text: '……そうですね。少し先を急ぎすぎました。', usage: { inputTokens: 520, outputTokens: 60 } };
}

test('指示文は8軸とプルチックの構造を渡す', () => {
  const text = replyInstruction('friendly');
  for (const axis of AXES) assert.match(text, new RegExp(axis));
  assert.match(text, /対極/);
  assert.match(text, /隣/);
});

test('指示文は感情を言葉にすることを禁じる', () => {
  // 値を字義どおり述べさせると、感情が口調に出ずに説明文になる。
  assert.match(replyInstruction('friendly'), /言葉にして述べない/);
});

test('prompt に感情状態と user の発言が入る', () => {
  const prompt = buildReplyPrompt(input);
  assert.match(prompt, /"sorrow":0\.42/);
  assert.match(prompt, /だいたい君は強引だ/);
});

test('両側の prompt は感情状態だけが違う', () => {
  // 人格は同じ。両側とも同じ人格で生成するのが比較の前提。
  const a = buildReplyPrompt({ user: 'u', axes: axes({ joy: 0.6 }), persona: 'friendly' });
  const b = buildReplyPrompt({ user: 'u', axes: axes({ anger: 0.6 }), persona: 'friendly' });
  assert.notEqual(a, b);
  // 指示文は同一。返答の差が判定の差だけに由来すると言えるようにする。
  assert.ok(a.startsWith(replyInstruction('friendly')));
  assert.ok(b.startsWith(replyInstruction('friendly')));
});

test('指示文は人格を先頭に置く', () => {
  // 人格が「誰が話しているか」、軸が「今どう感じているか」を決める。
  // 感情の読み方より前に人格が来ないと、色をつける先が後から現れることになる。
  for (const persona of ['friendly', 'contrarian'] as const) {
    const text = replyInstruction(persona);
    assert.ok(text.startsWith(PERSONAS[persona].text), `${persona} の人格が先頭に無い`);
    assert.ok(text.indexOf(PERSONAS[persona].text) < text.indexOf('対極'));
  }
});

test('指示文は人格ごとに違い、他方の人格は混ざらない', () => {
  const friendly = replyInstruction('friendly');
  const contrarian = replyInstruction('contrarian');
  assert.notEqual(friendly, contrarian);
  assert.ok(!friendly.includes(PERSONAS.contrarian.text));
  assert.ok(!contrarian.includes(PERSONAS.friendly.text));
});

test('prompt は人格が違えば違う。感情状態と発言が同じでも', () => {
  const a = buildReplyPrompt({ user: 'u', axes: axes({ joy: 0.6 }), persona: 'friendly' });
  const b = buildReplyPrompt({ user: 'u', axes: axes({ joy: 0.6 }), persona: 'contrarian' });
  assert.notEqual(a, b);
  assert.match(b, /天邪鬼/);
  assert.match(a, /明るく協力的/);
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
  const prompt = buildReplyPrompt({ user: 'u', axes: axes(), persona: 'friendly' });
  const order = [...prompt.matchAll(/"([a-z]+)":/g)].map((m) => m[1]);
  assert.deepEqual(order, [...AXES]);
});
