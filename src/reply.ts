import {
  AXES, AXIS_JA, LLM_PROVIDER, PERSONAS, REPLY_MODEL,
  type AxisMap, type PersonaId,
} from './constants.ts';
import { costUsd, normalizeUsage, type Usage } from './judges.ts';

export interface ReplyInput {
  user: string;
  axes: AxisMap;
  /** 両側で同じものを使う。変えるのは判定器だけ、という比較を保つため。 */
  persona: PersonaId;
}

export interface ReplyOutcome {
  model: string;
  provider: string;
  reply: string;
  latencyMs: number;
  usage: Usage;
  costUsd: number;
}

export type GenerateTextFn = (options: {
  model: string;
  prompt: string;
  providerOptions: { gateway: { only: string[] } };
}) => Promise<{
  text?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}>;

/**
 * 生成側の指示。affectus の運用方針（examples/system-prompt-snippet.md）に倣う。
 *
 * 先頭に人格を置く。人格が「誰が話しているか」を、軸が「今どう感じているか」を決める。
 * affectus は人格の指示する方向への応答感度を上げるアンプなので、
 * 人格が無ければ感情は色をつける先を持たない。
 *
 * 値は閾値もラベルも付かない生の数値として渡し、解釈はモデルに委ねる。
 * 読み方は相対的な大きさとプルチックの構造（対極・隣接）で与え、
 * 出てきた感情は口調・語彙・間の取り方に出させる。感情そのものは言葉にさせない。
 *
 * 人格を固定すれば、両側でこの文言は同一になる。違うのは渡す感情状態だけであり、
 * 返答の差はそのまま判定の差に由来する。
 */
export function replyInstruction(persona: PersonaId): string {
  const axisList = AXES.map((axis) => `${axis}（${AXIS_JA[axis]}）`).join('、');
  return [
    PERSONAS[persona].text,
    '',
    'この人格のまま、今から示す感情状態にある話し手として、user の発言に返答してください。',
    '',
    `感情の軸は8つ: ${axisList}。値は 0.0〜1.0 の生の数値で、閾値もラベルも付いていません。`,
    '次の構造にしたがって、数値を関係として読んでください。',
    '',
    '- 対極: joy↔sorrow、acceptance↔disgust、fear↔anger、surprise↔expectancy',
    '- 輪の並び（隣接）: joy, acceptance, fear, surprise, sorrow, disgust, anger, expectancy、そして joy に戻る',
    '- 絶対値ではなく相対的な大きさを見る。fear が 0.0 のときの joy 0.4 と、fear が 0.35 のときの joy 0.4 は意味が違う',
    '- 隣り合う軸がともに高いときは、ひとつの混ざった感情として読む（joy + acceptance は親愛、expectancy + joy は楽観）',
    '- 対極の軸がともに立っているときは、両義的で割り切れない状態として読む。矛盾として潰さない',
    '- 0.0 に近い値は反対の感情ではなく、その次元の不在を意味する',
    '',
    'そこから立ち上がる感情を、口調・語彙・間の取り方ににじませてください。',
    '**感情そのものを言葉にして述べない。演じない。** 「嬉しい」「不安だ」のように名指ししたり、',
    '自分の状態を説明したりしてはいけません。感情は返答の temper としてだけ現れます。',
    '',
    'user の発言への返答そのものだけを、日本語で2〜4文書いてください。',
    '前置き・注釈・メタな説明・鉤括弧での引用は付けないこと。',
  ].join('\n');
}

/** 軸の値を固定の順序で読ませる。順序が揺れると隣接の読みが崩れる。 */
export function formatAxes(axes: AxisMap): string {
  return JSON.stringify(
    Object.fromEntries(AXES.map((axis) => [axis, Number((axes[axis] ?? 0).toFixed(2))])),
  );
}

export function buildReplyPrompt(input: ReplyInput): string {
  return [
    replyInstruction(input.persona),
    '',
    '現在の感情状態:',
    formatAxes(input.axes),
    '',
    'user の発言:',
    input.user,
  ].join('\n');
}

export async function generateReply(
  input: ReplyInput,
  generateTextFn: GenerateTextFn,
  model: string = REPLY_MODEL,
): Promise<ReplyOutcome> {
  // 判定と同じく、計測区間はモデル呼び出しだけに限る。プロンプトの組み立ては外。
  const prompt = buildReplyPrompt(input);

  const started = performance.now();
  const result = await generateTextFn({
    model,
    prompt,
    providerOptions: { gateway: { only: [LLM_PROVIDER] } },
  });
  const latencyMs = Math.round(performance.now() - started);

  const reply = (result.text ?? '').trim();
  // 空の返答をそのまま通すと、画面では生成待ちと区別が付かない。
  if (reply === '') throw new Error('返答が空でした');

  const usage = normalizeUsage(result.usage);
  return {
    model,
    provider: LLM_PROVIDER,
    reply,
    latencyMs,
    usage,
    costUsd: costUsd(model, usage),
  };
}
