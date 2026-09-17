import { z } from 'zod';
import {
  AXES, AXIS_JA, CURRENT_STATE_NOTE, DEFAULT_LLM_MODEL, JEV_MODEL, JEV_PROVIDER, LLM_PROVIDER,
  PRICING, SCORE_LEVELS,
  axisInstruction, scoreToDelta,
  type Axis, type AxisMap,
} from './constants.ts';
import { confidenceFromProbabilities } from './confidence.ts';

/**
 * 判定の入力。判定の直前に読んだ現在の8軸と、user の発言。
 *
 * 現在値を渡すのは、affectus の agent が毎ターン自分の状態を読んでから
 * 感情の動きを申告するため。現在値の無い判定は、この依存を落としたまま答えることになり、
 * このデモが測ろうとしている課題そのものを再現しない。
 *
 * 記録された返答（agent）は含めない。affectus の agent は他人の会話を見て
 * 感情の動きを当てるのではなく、言われたことに対して自分の感情がどう動くかを決める。
 *
 * 両側はそれぞれ自分の状態に対して判定するため、状態が分岐した2ターン目以降は入力も分かれる。
 * 実運用でもそうなる。公平性は「同じ状態から出発した最初の判定」で担保する。
 */
export interface TurnInput {
  user: string;
  axes: AxisMap;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface JudgeOutcome {
  model: string;
  provider: string;
  deltas: AxisMap;
  confidence: Partial<Record<Axis, number>>;
  rawScore: Partial<Record<Axis, number>>;
  latencyMs: number;
  usage: Usage;
  costUsd: number;
}

export interface EvaluationAnswer {
  type: string;
  score?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export interface EvaluationResult {
  answers: Record<string, EvaluationAnswer>;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export type EvaluateFn = (options: {
  model: string;
  state: unknown;
  questions: unknown;
}) => Promise<EvaluationResult>;

export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: string[];
}

export function buildJevQuestions(): Record<Axis, ScoreQuestion> {
  const questions = {} as Record<Axis, ScoreQuestion>;
  for (const axis of AXES) {
    questions[axis] = {
      type: 'score',
      instructions: axisInstruction(axis),
      criteria: [...SCORE_LEVELS],
    };
  }
  return questions;
}

/**
 * 判定に渡す入力。両者に同じ形・同じ順序で渡す。
 *
 * 軸は固定の順序に並べ、小数2桁に丸める。affectus が返す値は
 * 0.9660641141415135 のような長い float で、下の桁は判定に効かず入力のノイズになる。
 * 丸め方は返答生成（reply.ts の formatAxes）と揃える。
 */
export function buildJudgeInput(turn: TurnInput): { axes: AxisMap; user: string } {
  const axes = {} as AxisMap;
  for (const axis of AXES) axes[axis] = Number((turn.axes[axis] ?? 0).toFixed(2));
  return { axes, user: turn.user };
}

export function costUsd(model: string, usage: Usage): number {
  const price = PRICING[model];
  if (!price) throw new Error(`unknown model price: ${model}`);
  return (
    (usage.inputTokens / 1_000_000) * price.inputPerMTok +
    (usage.outputTokens / 1_000_000) * price.outputPerMTok
  );
}

/**
 * probabilities から確信度を出す。分布として成立していなければ「不明」を返す。
 *
 * confidenceFromProbabilities は実在の分布に対しては正しいが、退化した入力では
 * 意味の違う値を返してしまう。空なら 0（確信度が最低）、全ゼロならエントロピー 0 から
 * 1（確信度が最高）になる。どちらも「不明」とは別の主張であり、画面にそう出てはならない。
 */
function confidenceFrom(probs: Record<string, number> | undefined): number | undefined {
  if (!probs) return undefined;
  const values = Object.values(probs);
  if (values.length === 0) return undefined;
  const total = values.reduce((sum, p) => sum + (Number.isFinite(p) ? p : 0), 0);
  if (!(total > 0)) return undefined;
  return confidenceFromProbabilities(values);
}

export function normalizeUsage(usage: EvaluationResult['usage']): Usage {
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
  };
}

export async function judgeWithJev(
  turn: TurnInput,
  evaluateFn: EvaluateFn,
): Promise<JudgeOutcome> {
  // 問いと state の構築は計測区間の外で行う。設計書が latencyMs を
  // 「モデル呼び出しの区間のみ」と定めており、LLM 側も同じ形にしてあるため。
  const questions = buildJevQuestions();
  const state = buildJudgeInput(turn);

  const started = performance.now();
  const result = await evaluateFn({ model: JEV_MODEL, state, questions });
  const latencyMs = Math.round(performance.now() - started);

  const deltas = {} as AxisMap;
  const confidence: Partial<Record<Axis, number>> = {};
  const rawScore: Partial<Record<Axis, number>> = {};

  for (const axis of AXES) {
    const answer = result.answers[axis];
    // SDK の契約は「質問ごとにちょうど1つの回答」「部分結果なし」を保証する。
    // 破られた場合に既定値で埋めると「変化なし」と区別が付かず、比較データが静かに壊れる。
    if (!answer || typeof answer.score !== 'number') {
      throw new Error(`jev の応答に軸 ${axis} の score がありません`);
    }
    rawScore[axis] = answer.score;
    deltas[axis] = Number(scoreToDelta(answer.score).toFixed(4));

    // インストール済みの ai / @ai-sdk/provider の評価回答型に confidence は存在しない
    // （型定義を検査して確認済み）。実運用では常に下の算出側が使われる。
    // 将来 SDK が持つようになった場合に備えて ?? は残す。
    // probabilities はオプショナル。欠けている場合は「不明」として undefined を入れる。
    // 0 を入れると「確信度が最低」という別の意味になってしまう。
    confidence[axis] = answer.confidence ?? confidenceFrom(answer.probabilities);
  }

  const usage = normalizeUsage(result.usage);
  return {
    model: JEV_MODEL,
    provider: JEV_PROVIDER,
    deltas,
    confidence,
    rawScore,
    latencyMs,
    usage,
    costUsd: costUsd(JEV_MODEL, usage),
  };
}

export const DeltaSchema = z.object({
  joy: z.number(),
  acceptance: z.number(),
  fear: z.number(),
  surprise: z.number(),
  sorrow: z.number(),
  disgust: z.number(),
  anger: z.number(),
  expectancy: z.number(),
});

export type GenerateObjectFn = (options: {
  model: string;
  schema: typeof DeltaSchema;
  prompt: string;
  providerOptions: { gateway: { only: string[] } };
}) => Promise<{
  object: Record<string, number>;
  usage?: { inputTokens?: number; outputTokens?: number };
}>;

/**
 * LLM 側の指示文。現在の状態の扱いは CURRENT_STATE_NOTE を jev 側の問い文と共有する。
 * 同じ課題を同じ言葉で与えないと、判定の差に指示文の差が混ざる。
 */
export function llmInstruction(): string {
  const lines = AXES.map((axis) => `- ${axis}（${AXIS_JA[axis]}）`).join('\n');
  return [
    'user の発言を読み、それを受けてあなた自身の感情が各軸でどう動くかを答えてください。',
    CURRENT_STATE_NOTE,
    '値は -1.0 から 1.0 の範囲で、上がるなら正、下がるなら負、変化がなければ 0 とします。',
    '答えるのは過去の観察ではなく、この発言に対するあなた自身の反応です。',
    '',
    '軸:',
    lines,
  ].join('\n');
}

function clampDelta(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(-1, value));
}

export async function judgeWithLlm(
  turn: TurnInput,
  generateObjectFn: GenerateObjectFn,
  model: string = DEFAULT_LLM_MODEL,
): Promise<JudgeOutcome> {
  // jev 側の state と同じ形・同じ丸めで渡す。両者の状態が一致している間は、
  // 入力の JSON も一字一句同じになる。
  const prompt = [
    llmInstruction(),
    '',
    JSON.stringify(buildJudgeInput(turn), null, 2),
  ].join('\n');

  const started = performance.now();
  const result = await generateObjectFn({
    model,
    schema: DeltaSchema,
    prompt,
    providerOptions: { gateway: { only: [LLM_PROVIDER] } },
  });
  const latencyMs = Math.round(performance.now() - started);

  const deltas = {} as AxisMap;
  for (const axis of AXES) {
    const value = result.object[axis];
    // DeltaSchema が8軸すべてを必須にしており、generateObject が返す前に検証するので、
    // ここは通常到達しない。それでも既定値では埋めない。clampDelta は非有限値を 0 に
    // 丸めるため、欠けた軸が「変化なし」として通り、比較データが静かに壊れる。
    // jev 側と同じく、軸名を挙げて投げる。
    if (!Number.isFinite(value)) {
      throw new Error(`LLM の応答に軸 ${axis} の数値がありません`);
    }
    deltas[axis] = clampDelta(value);
  }

  const usage = normalizeUsage(result.usage);
  return {
    model,
    provider: LLM_PROVIDER,
    deltas,
    confidence: {},
    rawScore: {},
    latencyMs,
    usage,
    costUsd: costUsd(model, usage),
  };
}
