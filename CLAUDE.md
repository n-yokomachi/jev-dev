# CLAUDE.md — jev × LLM 判定対決ビューア

## これは何

同じ会話ターンを TypeSafe の `jev` と LLM の両方に判定させ、判定結果のズレと速度差を1画面で見せるデモ。判定は affectus（Go 製の感情状態エンジン）の感情状態として別々に蓄積される。

設計の根拠は `docs/superpowers/specs/`、実装の手順は `docs/superpowers/plans/` にある。

## 動かす

```bash
bash scripts/setup.sh
node --env-file=.env.local src/server.ts
```

`.env.local` に `AI_GATEWAY_API_KEY` が要る。**値をログ・コミット・標準出力に出さないこと。**

## 構成の要点

- **ビルド工程は無い。** Node 24 が `.ts` の型注釈を実行時に除去する。TypeScript コンパイラや `tsconfig.json` を足さないこと
- テストは `node:test`。`npm test`（内部は `node --test test/*.test.ts`）で全件。テストフレームワークを足さないこと
- 依存は `ai` と `zod` だけ。UI はフレームワーク無しの静的ファイル。バンドラを入れないこと
- `bin/affectus` は外部プロセスとして呼ぶ。グローバルフラグはサブコマンドの**前**（`affectus --config P --state P feel '<json>'`）
- 感情の軸は常にこの8つ、この順序: `joy, acceptance, fear, surprise, sorrow, disgust, anger, expectancy`
- デルタのレンジは `-1.0` 〜 `1.0`
- **LLM 側の配信元は `anthropic` に固定してある。** レイテンシ比較の条件を揃えるためなので外さないこと

## 触るときの注意

- 問いの文・軸定義・単価・変換係数は `src/constants.ts` に集約してある。判定の挙動を変えたいときはまずここを見る
- `state/jev.json` と `state/llm.json` は実行のたびに育つ。比較をやり直すときは画面の reset を使う
- `affectus` 本体（https://github.com/n-yokomachi/affectus）には手を入れない
