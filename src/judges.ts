import { z } from 'zod';
import {
  AXES, AXIS_JA, DEFAULT_LLM_MODEL, JEV_MODEL, JEV_PROVIDER, LLM_PROVIDER, PRICING, SCORE_LEVELS,
  axisInstruction, scoreToDelta,
  type Axis, type AxisMap,
} from './constants.ts';
import { confidenceFromProbabilities } from './confidence.ts';

export interface TurnInput {
  user: string;
  agent: string;
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

export function costUsd(model: string, usage: Usage): number {
  const price = PRICING[model];
  if (!price) throw new Error(`unknown model price: ${model}`);
  return (
    (usage.inputTokens / 1_000_000) * price.inputPerMTok +
    (usage.outputTokens / 1_000_000) * price.outputPerMTok
  );
}

function normalizeUsage(usage: EvaluationResult['usage']): Usage {
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
  };
}

export async function judgeWithJev(
  turn: TurnInput,
  evaluateFn: EvaluateFn,
): Promise<JudgeOutcome> {
  const started = performance.now();
  const result = await evaluateFn({
    model: JEV_MODEL,
    state: { user: turn.user, agent: turn.agent },
    questions: buildJevQuestions(),
  });
  const latencyMs = Math.round(performance.now() - started);

  const deltas = {} as AxisMap;
  const confidence: Partial<Record<Axis, number>> = {};
  const rawScore: Partial<Record<Axis, number>> = {};

  for (const axis of AXES) {
    const answer = result.answers[axis];
    const score = answer?.score ?? 2;
    rawScore[axis] = score;
    deltas[axis] = Number(scoreToDelta(score).toFixed(4));
    confidence[axis] =
      answer?.confidence ??
      confidenceFromProbabilities(Object.values(answer?.probabilities ?? {}));
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

export function llmInstruction(): string {
  const lines = AXES.map((axis) => `- ${axis}（${AXIS_JA[axis]}）`).join('\n');
  return [
    '次の会話ターンを読み、agent の感情が各軸でどう動いたかを答えてください。',
    '値は -1.0 から 1.0 の範囲で、上がったなら正、下がったなら負、変化がなければ 0 とします。',
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
  const prompt = [
    llmInstruction(),
    '',
    JSON.stringify({ user: turn.user, agent: turn.agent }, null, 2),
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
    deltas[axis] = clampDelta(result.object[axis] ?? 0);
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
