import { fileURLToPath } from 'node:url';

export const AXES = [
  'joy', 'acceptance', 'fear', 'surprise',
  'sorrow', 'disgust', 'anger', 'expectancy',
] as const;

export type Axis = (typeof AXES)[number];
export type AxisMap = Record<Axis, number>;

export const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

export const TRANSCRIPT_DIR =
  process.env.TRANSCRIPT_DIR ?? fileURLToPath(new URL('../data/transcripts', import.meta.url));

export const AXIS_JA: Record<Axis, string> = {
  joy: '喜び',
  acceptance: '受容',
  fear: '恐れ',
  surprise: '驚き',
  sorrow: '悲しみ',
  disgust: '嫌悪',
  anger: '怒り',
  expectancy: '期待',
};

export const SCORE_LEVELS = [
  '強く下がった',
  '下がった',
  '変化なし',
  '上がった',
  '強く上がった',
] as const;

/**
 * 現在の感情状態の読み方。**両者の指示文にこの同じ文言を入れる。**
 *
 * affectus の agent は毎ターン自分の状態を読んでから、その発言で感情がどう動くかを
 * 申告する。既に anger が 0.9 なら、さらに挑発されても動く余地は小さい。
 * 現在値を渡さない判定は、この依存を落としたまま答えることになる。
 *
 * 文言を共有するのは、比較の前提が「両者が同じ課題を同じ言葉で与えられること」だから。
 * 片方だけ現在値の扱いを説明すると、判定の差に指示文の差が混ざる。
 */
export const CURRENT_STATE_NOTE =
  'axes は判定の直前に読んだあなた自身の現在の感情状態で、各軸 0.0〜1.0 の生の値です。'
  + 'その現在値を踏まえて、そこからどれだけ動くかを答えてください。'
  + '既に高い軸は上がる余地が小さく、低い軸は下がる余地が小さくなります。';

/**
 * 判定は「過去の観察」ではなく「自分の反応」を問う。affectus の agent は
 * 他人の会話を見て感情の動きを当てるのではなく、言われたことに対して
 * 自分の感情がどう動くかを決める。問い文もその形に揃える。
 *
 * 現在値の扱いは CURRENT_STATE_NOTE を LLM 側と共有する。
 */
export function axisInstruction(axis: Axis): string {
  return `${CURRENT_STATE_NOTE}\nこの発言を受けて、あなたの「${AXIS_JA[axis]}」はどう動くか`;
}

export function scoreToDelta(score: number): number {
  const levels = SCORE_LEVELS.length;
  return (score / (levels - 1) - 0.5) * 2;
}

export const JEV_MODEL = 'typesafe-ai/jev';
export const DEFAULT_LLM_MODEL = 'anthropic/claude-haiku-4.5';

/** 返答生成のモデル。両側とも同じものを使い、違いは渡す感情状態だけにする。 */
export const REPLY_MODEL = 'anthropic/claude-haiku-4.5';

/**
 * LLM 側の配信元を固定する。AI Gateway は既定で稼働率とレイテンシを見て
 * プロバイダ（anthropic / bedrock / vertex / claudeaws）を動的に選ぶため、
 * 固定しないとターンごとに配信元が変わりレイテンシの比較が成立しない。
 * jev は typesafe-ai のみが配信するので固定は不要。
 * https://vercel.com/docs/ai-gateway/models-and-providers/provider-options
 */
export const LLM_PROVIDER = 'anthropic';
export const JEV_PROVIDER = 'typesafe-ai';

export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

/**
 * 1M トークンあたりの米ドル単価。
 * jev: https://docs.typesafe.ai/models （入力のみ課金、出力は無料）
 * Anthropic 各モデル: https://vercel.com/ai-gateway/models?provider=anthropic
 */
export const PRICING: Record<string, ModelPrice> = {
  'typesafe-ai/jev': { inputPerMTok: 0.042, outputPerMTok: 0 },
  'anthropic/claude-haiku-4.5': { inputPerMTok: 1, outputPerMTok: 5 },
  'anthropic/claude-sonnet-5': { inputPerMTok: 2, outputPerMTok: 10 },
  'anthropic/claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'anthropic/claude-fable-5.1': { inputPerMTok: 10, outputPerMTok: 50 },
};

/** UI のモデル選択に出す順。既定は先頭ではなく DEFAULT_LLM_MODEL。 */
export const LLM_MODELS = [
  'anthropic/claude-haiku-4.5',
  'anthropic/claude-sonnet-5',
  'anthropic/claude-opus-5',
  'anthropic/claude-fable-5.1',
] as const;
