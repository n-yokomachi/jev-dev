/**
 * 確率分布の尖り具合を 0〜1 の確信度に落とす。正規化エントロピーの補数を用いる独自定義。
 *
 * AI SDK 経由の評価回答は `score` と（オプショナルな）`probabilities` のみを持ち、
 * confidence フィールドを持たない（型定義を検査して確認済み）。
 * よって画面に出る確信度は常にこの関数の出力であり、
 * TypeSafe が自社 API で返す `confidence` とは別物である。
 */
export function confidenceFromProbabilities(probs: number[]): number {
  if (probs.length === 0) return 0;
  if (probs.length === 1) return 1;

  let entropy = 0;
  for (const p of probs) {
    if (p > 0) entropy -= p * Math.log(p);
  }
  const normalized = entropy / Math.log(probs.length);
  return Math.min(1, Math.max(0, 1 - normalized));
}
