import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildJevQuestions, costUsd, judgeWithJev, type EvaluationResult } from '../src/judges.ts';
import { AXES, CURRENT_STATE_NOTE, type AxisMap } from '../src/constants.ts';

/** 判定の入力に渡す現在の感情状態。実際の affectus と同じく長い float を含める。 */
function axesOf(overrides: Partial<AxisMap> = {}): AxisMap {
  const axes = {} as AxisMap;
  for (const axis of AXES) axes[axis] = 0;
  return { ...axes, ...overrides };
}

const turn = { user: 'だいたい君は強引だ', axes: axesOf({ anger: 0.9123456789, joy: 0.2 }) };

function fakeResult(overrides: Record<string, unknown> = {}): EvaluationResult {
  const answers: Record<string, unknown> = {};
  for (const axis of AXES) {
    answers[axis] = { type: 'score', score: 2, probabilities: { '0': 0, '1': 0, '2': 1, '3': 0, '4': 0 } };
  }
  return {
    answers: { ...answers, ...overrides } as EvaluationResult['answers'],
    usage: { inputTokens: 300, outputTokens: 24 },
  };
}

test('buildJevQuestions は8軸ぶんの score 問いを作る', () => {
  const questions = buildJevQuestions();
  assert.equal(Object.keys(questions).length, 8);
  assert.equal(questions.sorrow.type, 'score');
  assert.equal(questions.sorrow.criteria.length, 5);
  assert.match(questions.sorrow.instructions, /悲しみ/);
});

test('問いは過去の観察ではなく自分の反応を尋ねる', () => {
  const questions = buildJevQuestions();
  assert.match(questions.joy.instructions, /あなた/);
  assert.doesNotMatch(questions.joy.instructions, /agent/);
});

test('問い文は現在の状態の扱いを LLM 側と同じ文言で説明する', () => {
  const questions = buildJevQuestions();
  // 片方だけ現在値の説明が付くと、判定の差に指示文の差が混ざる。
  for (const axis of AXES) {
    assert.ok(
      questions[axis].instructions.includes(CURRENT_STATE_NOTE),
      `${axis} の問い文に現在の状態の説明が無い`,
    );
  }
});

test('jev に渡す state は現在の8軸と user の発言', async () => {
  let seen: unknown;
  await judgeWithJev(turn, async (options) => {
    seen = options.state;
    return fakeResult();
  });
  // 現在値を落とすと、affectus の agent が毎ターン行っている
  // 「自分の状態を読んでから動きを申告する」という課題を再現しない。
  // 記録された返答は混ぜない。
  assert.deepEqual(seen, {
    axes: { ...axesOf({ joy: 0.2 }), anger: 0.91 },
    user: 'だいたい君は強引だ',
  });
  // 軸は固定の順序で並ぶ。順序が揺れると入力が両者で食い違う。
  assert.deepEqual(Object.keys((seen as { axes: AxisMap }).axes), [...AXES]);
});

test('state の軸は小数2桁に丸める', async () => {
  let seen: { axes: AxisMap } | undefined;
  await judgeWithJev(
    { user: 'u', axes: axesOf({ acceptance: 0.9660641141415135 }) },
    async (options) => {
      seen = options.state as { axes: AxisMap };
      return fakeResult();
    },
  );
  // 下の桁は判定に効かず、入力のノイズになるだけ。
  assert.equal(seen?.axes.acceptance, 0.97);
});

test('score 2 は delta 0 になる', async () => {
  const out = await judgeWithJev(turn, async () => fakeResult());
  for (const axis of AXES) assert.equal(out.deltas[axis], 0);
});

test('score 4 は delta +1、score 0 は delta -1 になる', async () => {
  const out = await judgeWithJev(turn, async () =>
    fakeResult({
      sorrow: { type: 'score', score: 4, probabilities: { '0': 0, '1': 0, '2': 0, '3': 0, '4': 1 } },
      joy: { type: 'score', score: 0, probabilities: { '0': 1, '1': 0, '2': 0, '3': 0, '4': 0 } },
    }),
  );
  assert.equal(out.deltas.sorrow, 1);
  assert.equal(out.deltas.joy, -1);
  assert.equal(out.rawScore.sorrow, 4);
});

test('応答の confidence があればそれを使う', async () => {
  const out = await judgeWithJev(turn, async () =>
    fakeResult({ sorrow: { type: 'score', score: 3, probabilities: { '3': 1 }, confidence: 0.42 } }),
  );
  assert.equal(out.confidence.sorrow, 0.42);
});

test('応答に confidence が無ければ probabilities から算出する', async () => {
  const out = await judgeWithJev(turn, async () => fakeResult());
  assert.equal(out.confidence.sorrow, 1);
});

test('usage が欠けていても 0 として扱う', async () => {
  const out = await judgeWithJev(turn, async () => ({ answers: fakeResult().answers }));
  assert.equal(out.usage.inputTokens, 0);
  assert.equal(out.costUsd, 0);
});

test('costUsd は入力のみ課金のモデルで出力を無視する', () => {
  const cost = costUsd('typesafe-ai/jev', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
  assert.equal(cost, 0.042);
});

test('costUsd は入出力とも課金するモデルを合算する', () => {
  const cost = costUsd('anthropic/claude-sonnet-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
  assert.equal(cost, 12);
});

test('latencyMs が数値で返る', async () => {
  const out = await judgeWithJev(turn, async () => fakeResult());
  assert.equal(typeof out.latencyMs, 'number');
  assert.ok(out.latencyMs >= 0);
});

test('jev の provider は typesafe-ai', async () => {
  const out = await judgeWithJev(turn, async () => fakeResult());
  assert.equal(out.provider, 'typesafe-ai');
});

test('軸の回答が欠けていたら投げる', async () => {
  const broken = fakeResult();
  delete broken.answers.sorrow;
  await assert.rejects(
    () => judgeWithJev(turn, async () => broken),
    /sorrow/,
  );
});

test('probabilities が無ければ confidence は undefined', async () => {
  const out = await judgeWithJev(turn, async () =>
    fakeResult({ sorrow: { type: 'score', score: 3 } }),
  );
  assert.equal(out.confidence.sorrow, undefined);
  assert.equal(out.deltas.sorrow, 0.5);
});

test('probabilities が空オブジェクトなら confidence は undefined', async () => {
  const out = await judgeWithJev(turn, async () =>
    fakeResult({ sorrow: { type: 'score', score: 3, probabilities: {} } }),
  );
  // 0 を入れると「確信度が最低」という別の主張になる
  assert.equal(out.confidence.sorrow, undefined);
});

test('probabilities が全ゼロなら confidence は undefined', async () => {
  const out = await judgeWithJev(turn, async () =>
    fakeResult({
      sorrow: { type: 'score', score: 3, probabilities: { '0': 0, '1': 0, '2': 0, '3': 0, '4': 0 } },
    }),
  );
  // エントロピー 0 から 1（確信度が最高）になってしまうのを防ぐ
  assert.equal(out.confidence.sorrow, undefined);
});

test('応答の confidence が 0 ならそのまま 0 を通す', async () => {
  const out = await judgeWithJev(turn, async () =>
    fakeResult({ sorrow: { type: 'score', score: 3, probabilities: { '3': 1 }, confidence: 0 } }),
  );
  assert.equal(out.confidence.sorrow, 0);
});

test('costUsd は単価表に無いモデルで投げる', () => {
  assert.throws(
    () => costUsd('openai/gpt-4o', { inputTokens: 100, outputTokens: 100 }),
    /openai\/gpt-4o/,
  );
});
