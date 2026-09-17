import {
  AXES, JEV_MODEL, JEV_PROVIDER, PRICING, SCORE_LEVELS,
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
