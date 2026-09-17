# jev × LLM 判定対決ビューア 設計

## 目的

同一の会話ターンを TypeSafe の `jev` と LLM の両方に判定させ、**判定結果のズレと速度差を1画面で見せる**デモを作る。判定結果は affectus の感情状態として蓄積し、2つの状態が会話の進行につれてどう分岐するかを可視化する。

## 非目的

- 「jev が affectus の判定に使えるか」の可否判断。本設計は比較結果を提示するところまでを担い、採否は扱わない
- affectus リポジトリへの変更。バイナリを外部プロセスとして呼ぶだけで、本体には一切手を入れない
- 精度の優劣の結論づけ。後述の非対称性があるため、ズレの数値は精度差として読めない

## 全体構成

プロセスは3つ。

```
jev-dev/
├── bin/affectus          affectus リポジトリから go build した実バイナリ
├── src/
│   ├── server.ts         Node の HTTP サーバー
│   ├── judges.ts         jev / LLM 各判定の呼び出し
│   ├── affectus.ts       バイナリ呼び出しラッパー
│   ├── transcripts.ts    JSONL 読み込み
│   └── constants.ts      問い・軸定義・単価・変換係数
├── public/               index.html / app.js / style.css
└── state/
    ├── config.yaml       model: plutchik
    ├── jev.json          jev 判定を適用する感情状態
    └── llm.json          LLM 判定を適用する感情状態
```

Node 24 は `.ts` の型注釈を実行時に除去するため、ビルド工程を置かない。依存は `ai`（AI SDK 7.0.105 以上）と `zod` のみ。UI はフレームワークを使わない静的ファイル。

`affectus --state <path>` で状態ファイルを分離し、同じ会話を2つの感情状態に並走させる。

### 1ターンの流れ

ブラウザが2本のリクエストを同時に発行し、先に返ったパネルから順に埋まる。これがそのままレースの表現になる。

```
ターン { user, agent }
   ├─→ POST /api/judge/jev  → evaluate(Score×8) → 変換 → affectus --state jev.json feel
   └─→ POST /api/judge/llm  → generateObject(8軸) → そのまま → affectus --state llm.json feel
```

`affectus feel` は適用後の8軸 JSON を1行で標準出力に返すため、適用と読み出しが1コールで完結する。

## 判定タスク

両者に同一の課題を与える。

> 会話ターン（user の発言と agent の返答）を読み、agent の感情が8軸それぞれどう動いたかを符号付きで答える

軸はプルチックの8つ。affectus の既定と `~/.config/affectus/config.yaml` に一致させる。

```
joy, acceptance, fear, surprise, sorrow, disgust, anger, expectancy
```

### state

```json
{ "user": "<user の発言>", "agent": "<agent の返答>" }
```

判定対象はターン全体であり、user 発言単体ではない。

### jev 側

軸ごとに1問、計8問を1リクエストで送る。Score を使う。

```
type: "score"
instructions: "この会話を受けて、agent の <軸名> はどう動いたか"
criteria: ["強く下がった", "下がった", "変化なし", "上がった", "強く上がった"]
```

返る `score` は 0〜4 の確率加重期待値（連続値）。これをコード側で符号付きデルタに変換する。

```
delta = (score / 4 - 0.5) * 2        // -1.0 〜 1.0
```

`confidence` は軸ごとにそのまま保持し、画面に表示する。

問い文は日本語で書く。state が日本語であり、言語を揃えるため。問い文・軸定義・変換係数は `constants.ts` に集約し、1ファイルの編集で差し替えられるようにする。

### LLM 側

同一の state と同一の指示文を渡し、`generateObject` で8軸の数値（-1.0〜1.0）を一度に出力させる。既定モデルは `anthropic/claude-sonnet-5`。UI から切り替えられる。

変換は行わない。出力値をそのまま affectus に渡す。

### 第3の参照値

transcripts には当時の自己申告デルタが `deltas` として記録されている。これを中央パネルに参照表示する。実測ではないため速度の比較対象には含めない。

## データソース

`affectus` リポジトリの以下を読み取り専用で参照する。

```
examples/evaluation/_archive/plutchik-direct-20260810/transcripts/*.jsonl
```

24ファイル、各20ターン。1行1ターンの JSONL で、`turn` / `phase` / `user` / `agent` / `deltas` / `axes` を持つ。`phase` は `negative` / `positive` で、シナリオ中で転換する。

パスは `constants.ts` の定数とし、環境変数 `AFFECTUS_REPO` で上書きできるようにする。

中央パネルには手入力欄も置き、任意のターンを判定させられる。

## HTTP API

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/` | UI |
| GET | `/api/scenarios` | シナリオ一覧（ファイル名と総ターン数） |
| GET | `/api/scenarios/:id` | 指定シナリオの全ターン |
| POST | `/api/judge/jev` | `{user, agent}` を判定し affectus に適用 |
| POST | `/api/judge/llm` | `{user, agent, model?}` を判定し affectus に適用 |
| GET | `/api/state` | 両状態の現在値（読み出し時の減衰を反映） |
| POST | `/api/reset` | 両状態を baseline に戻す |

判定エンドポイントの応答:

```ts
{
  model: string
  deltas: Record<Axis, number>       // affectus に渡した値
  axes: Record<Axis, number>         // 適用後の8軸
  confidence?: Record<Axis, number>  // jev のみ
  rawScore?: Record<Axis, number>    // jev のみ。0〜4 の期待値
  latencyMs: number
  usage: { inputTokens: number; outputTokens: number }
  costUsd: number
}
```

## 計測と単価

`latencyMs` は**モデル呼び出しの区間のみ**を測る。affectus の適用時間と HTTP の往復は含めない。ブラウザ側でも壁時計時間を持つが、表示する正式な数字はサーバー側の実測値とする。

単価は `constants.ts` に定数として置き、各エントリに出典 URL をコメントで添える。

| モデル | 入力 | 出力 |
|---|---|---|
| `typesafe-ai/jev` | $0.042 / 1M tok | 無料 |
| `anthropic/claude-sonnet-5` | $2 / 1M tok | $10 / 1M tok |

コストは実測トークン数と上記定数の積として算出し、計算過程が追える形で保持する。

## 画面仕様

レイアウトは3カラム。中央に会話ターン、左に LLM、右に jev。

```
┌─────────────────────────────────────────────────────┐
│ シナリオ名 · run        turn 7 / 20        ◀ ❙❙ ▶  │
├──────────────┬──────────────────┬───────────────────┤
│ LLM          │ user 発言        │ jev               │
│ プルチックの輪│ agent 返答       │ プルチックの輪     │
│ 2,140 ms     │                  │ 238 ms            │
│ レイテンシバー│ 当時の自己申告    │ レイテンシバー      │
│ tok / cost   │ L1 距離          │ tok / cost        │
│ 軸ゲージ ×8  │ 手入力欄          │ 軸ゲージ ×8 +点線  │
└──────────────┴──────────────────┴───────────────────┘
```

### 配色（計器）

```
背景        #07090c
パネル      #0d1117
罫線        #1d2530
文字        #c9d4e0
補助文字    #5b6673
LLM アクセント #ffb84d
jev アクセント #4dffb8
```

等幅フォント。グローや影は使わない。

### プルチックの輪

8方向の扇形で、**花弁の長さが各軸の値**（0.0〜1.0）を表す。色は輪の標準配色を用いる。

```
joy #ffd93d / acceptance #a8e05f / fear #4caf50 / surprise #4fc3f7
sorrow #3f51b5 / disgust #9c27b0 / anger #e53935 / expectancy #fb8c00
```

既存の `affectus viz` とは別実装とする。参考にとどめる。

### 軸ゲージ

中央線から左右に伸びる。右が正、左が負。符号がそのまま左右になるため、両者で向きが食い違った軸が視認できる。

jev 側のゲージには軸ごとの `confidence` を点線マーカーとして重ねる。LLM 側は対応する出力が無いため空欄とし、その欠落自体を差として見せる。

### レイテンシバー

両パネルで同一スケール。上限は直近の最大値に追随させる。

### L1 距離

中央下に、両者のデルタベクトルの L1 距離を1数値で表示する。

### 操作

- シナリオ選択、ターンの前後移動、自動再生、一時停止
- 手入力欄からの任意ターン判定
- 両状態のリセット

## 実行手順

```bash
# affectus バイナリの用意（一度だけ）
cd <affectus リポジトリ> && go build -o <jev-dev>/bin/affectus ./cmd/affectus

# 感情状態の初期化（一度だけ）
bin/affectus --config state/config.yaml --state state/jev.json init --model plutchik
bin/affectus --config state/config.yaml --state state/llm.json init --model plutchik --force

# 起動
npm install
node --env-file=.env.local src/server.ts
```

API キーは `.env.local` の `AI_GATEWAY_API_KEY` から読む。

2回目の `init` は `--config` の指定先が既に存在するため `--force` を要する。`--force` は同一内容の config を書き直したうえで対象の state のみを baseline に戻すため、先に作った state には影響しない。

## 既知の制約

- **粒度が非対称**。jev は Score の期待値を線形変換した値、LLM は自由記述の数値を出す。レンジは -1〜1 で揃うが分布は揃わない。ズレの数値をそのまま精度差として読むことはできない
- **段階間の数値較正は弱い**。TypeSafe の jaggedness ページに Score の数値較正の弱さが明記されている。期待値の細かい差に意味を読まない
- **速度差には構造的な要因が含まれる**。LLM は出力トークンを逐次生成し、jev は全出力を並列にサンプリングする。同条件の比較ではなく、設計の違いがそのまま現れる
- **問い文の言語の影響は未検証**。日本語で問いを立てるが、jev の言語ごとの性能差は公開情報が無い
- **減衰は読み出し時に適用される**。再生中に間が空くと両状態とも baseline に寄るが、同じだけ寄るため比較の公平性は保たれる
- **Gateway 経由の応答に `confidence` が含まれない可能性**。Vercel のドキュメントに載る応答例には `confidence` フィールドが無く、`probabilities` のみ。実装時に実応答を確認し、含まれない場合は `probabilities` から算出する

## 出典

- TypeSafe API リファレンス https://docs.typesafe.ai/api
- Score プリミティブ https://docs.typesafe.ai/primitives/score
- jev 1.13 の失敗モード https://docs.typesafe.ai/model-jaggedness/jev-1.13
- 価格 https://docs.typesafe.ai/models
- Vercel AI Gateway の evaluation https://vercel.com/docs/ai-gateway/modalities/evaluation
- Claude Sonnet 5 の単価 https://vercel.com/ai-gateway/models/claude-sonnet-5
