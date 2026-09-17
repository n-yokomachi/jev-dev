/**
 * 確率分布の尖り具合を 0〜1 の確信度に落とす。
 * 正規化エントロピーの補数を用いる独自定義であり、
 * TypeSafe が返す `confidence` の算出式（非公開）とは一致しない。
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
