# jev × LLM 判定対決ビューア 設計

## 目的

同一の会話ターンを TypeSafe の `jev` と LLM の両方に判定させ、**判定結果のズレと速度差を1画面で見せる**デモを作る。判定結果は affectus の感情状態として蓄積し、2つの状態が会話の進行につれてどう分岐するかを可視化する。

完成形は**別の Mac に展開すれば動く zip** とする。受け取り側に必要なのは Node 24 と AI Gateway の API キーだけで、Go のツールチェーンもネットワーク越しの依存解決も要らない。

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
├── data/transcripts/     取り込んだトランスクリプト 24 ファイル
├── README.md             別マシンでの手順
├── CLAUDE.md             配布先の Claude Code 向けの文脈
├── scripts/
│   ├── setup.sh          別マシンでの初期設定
│   └── package.sh        配布 zip の作成
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

同一の state と同一の指示文を渡し、`generateObject` で8軸の数値（-1.0〜1.0）を一度に出力させる。既定モデルは `anthropic/claude-haiku-4.5`。UI から `claude-sonnet-5` / `claude-opus-5` / `claude-fable-5.1` に切り替えられる。

既定に最安の Haiku 4.5 を据えるのは、jev にとって一番厳しい相手だから。判定は8軸の短い構造化出力であり、フロンティアモデルを要する課題ではない。

**配信元は `anthropic` に固定する。** AI Gateway は既定で稼働率とレイテンシを見てプロバイダ（`anthropic` / `bedrock` / `vertex` / `claudeaws`）を動的に選ぶため、固定しなければターンごとに配信元が変わりレイテンシの比較が成立しない。`providerOptions.gateway.only` で限定し、配信元を画面にも表示する。jev は `typesafe-ai` のみが配信するので固定は不要。

変換は行わない。出力値をそのまま affectus に渡す。

### 第3の参照値

transcripts には当時の自己申告デルタが `deltas` として記録されている。これを中央パネルに参照表示する。実測ではないため速度の比較対象には含めない。

## データソース

`affectus` リポジトリの以下を**このプロジェクトに取り込む**。

```
examples/evaluation/_archive/plutchik-direct-20260810/transcripts/*.jsonl
   → data/transcripts/*.jsonl
```

24ファイル・計 448KB、各20ターン。1行1ターンの JSONL で、`turn` / `phase` / `user` / `agent` / `deltas` / `axes` を持つ。`phase` は `negative` / `positive` で、シナリオ中で転換する。

取り込む理由は可搬性。外部リポジトリの絶対パスを参照したままでは別のマシンで動かない。容量が小さいため複製の不利益は無い。

既定のパスは `./data/transcripts`。環境変数 `TRANSCRIPT_DIR` で上書きできる。

中央パネルには手入力欄も置き、任意のターンを判定させられる。

## HTTP API

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/` | UI |
| GET | `/api/scenarios` | シナリオ一覧（ファイル名と総ターン数） |
| GET | `/api/scenarios/:id` | 指定シナリオの全ターン |
| GET | `/api/models` | LLM の選択肢と既定モデル |
| POST | `/api/judge/jev` | `{user, agent}` を判定し affectus に適用 |
| POST | `/api/judge/llm` | `{user, agent, model?}` を判定し affectus に適用 |
| GET | `/api/state` | 両状態の現在値（読み出し時の減衰を反映） |
| POST | `/api/reset` | 両状態を baseline に戻す |

判定エンドポイントの応答:

```ts
{
  model: string
  provider: string                   // 固定した配信元
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
| `anthropic/claude-haiku-4.5` | $1 / 1M tok | $5 / 1M tok |
| `anthropic/claude-sonnet-5` | $2 / 1M tok | $10 / 1M tok |
| `anthropic/claude-opus-5` | $5 / 1M tok | $25 / 1M tok |
| `anthropic/claude-fable-5.1` | $10 / 1M tok | $50 / 1M tok |

Anthropic 各モデルの単価は Gateway のモデル一覧による。Gateway は provider の料金をそのまま通し、上乗せをしないと明記している。`claude-fable-5.1` は TypeSafe が「238分の1」の比較対象に挙げたモデルなので、その主張を手元で再現するために選択肢に含める。

コストは実測トークン数と上記定数の積として算出し、計算過程が追える形で保持する。

## 画面仕様

レイアウトは3カラム。中央に会話ターン、左に LLM、右に jev。

```
┌─────────────────────────────────────────────────────┐
│ シナリオ名 · run        turn 7 / 20        ◀ ❙❙ ▶  │
├──────────────┬──────────────────┬───────────────────┤
│ LLM + モデル選択│ user 発言      │ jev               │
│ プルチックの輪│ agent 返答       │ プルチックの輪     │
│ 2,140 ms     │                  │ 238 ms            │
│ レイテンシバー│ 自己申告（記録時）│ レイテンシバー      │
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

### 初期表示

読み込み時に `GET /api/state` で両状態を取得して輪を描く。感情状態はファイルに永続するため、
ゼロから描き始めると次の判定が返った瞬間に真の蓄積値へ飛び、初期表示が状態を偽ることになる。
リセット後も同様に読み戻す。

### 操作

- シナリオ選択、ターンの前後移動、自動再生、一時停止
- 手入力欄からの任意ターン判定
- 両状態のリセット
- **判定が飛行中の間は、ターン移動・自動再生・手入力を受け付けない。** 受け付けると、
  破棄された判定のデルタもサーバー側では affectus に適用済みのため、ユーザーが見ていない
  ターンのぶんが輪に積み上がり、課金も重複する

## 実行手順

```bash
bash scripts/setup.sh                     # 依存・バイナリ・感情状態を揃える
# .env.local に AI_GATEWAY_API_KEY を書く
node --env-file=.env.local src/server.ts
```

`scripts/setup.sh` が行うこと:

1. Node のバージョンを確認する（24 未満なら中止）
2. `node_modules` が無ければ `npm ci`
3. `bin/affectus` が無ければ用意する。同梱バイナリがあればそれを使い、無ければ `GOBIN=$PWD/bin go install github.com/n-yokomachi/affectus/cmd/affectus@v0.4.0`
4. `xattr -dr com.apple.quarantine .` で Gatekeeper の隔離属性を外す
5. `state/jev.json` と `state/llm.json` が無ければ初期化する
6. `.env.local` が無ければ、鍵の書き方を案内して終了する

冪等に作る。既に揃っているものは飛ばす。

## 配布

`scripts/package.sh` が `dist/jev-duel-<日付>.zip` を作る。

| 同梱する | 同梱しない |
|---|---|
| `src/` `public/` `data/transcripts/` `scripts/` | `.env.local`（API キー） |
| `package.json` `package-lock.json` | `state/`（`setup.sh` が生成） |
| `node_modules/`（約 23MB） | `.git/` `node_modules/.cache` |
| `bin/affectus`（universal, 約 23MB） | `dist/` |
| `README.md` `CLAUDE.md` `docs/` | |

`bin/affectus` は **arm64 と x86_64 の universal binary** とする。Apple Silicon と Intel のどちらの Mac でも動かすため。

```bash
GOOS=darwin GOARCH=arm64 go build -o build/affectus-arm64 ./cmd/affectus
GOOS=darwin GOARCH=amd64 go build -o build/affectus-amd64 ./cmd/affectus
lipo -create -output bin/affectus build/affectus-arm64 build/affectus-amd64
```

受け取り側に必要なのは **Node 24 と AI Gateway の API キーだけ**。Go もネットワークも要らない。

展開後の手順:

```bash
unzip jev-duel-<日付>.zip && cd jev-duel-<日付>
bash scripts/setup.sh
# 案内に従って .env.local に鍵を書く
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
- **Gateway 経由の応答に `confidence` は含まれない（確定）**。インストール済みの `ai` と `@ai-sdk/provider` の評価回答型を検査した結果、`confidence` フィールドはどこにも存在しない（`ai` の型定義で該当 0 件。`@ai-sdk/provider` の唯一の出現は boolean 型のコメント「Not confidence in either outcome.」のみ）。回答が持つのは `score` と、**オプショナルな** `probabilities` だけ。したがって画面に出る確信度は常にこちらの算出値であり、TypeSafe が自社 API で返す `confidence` とは別物である。画面の表記もそれに合わせる
- **`probabilities` が欠けている場合の扱い**。型上オプショナルなので欠落しうる。欠けたときは確信度を「不明」として表示せず、`0`（＝確信度が最低）として出さない。両者は意味が違う
- **zip を展開したバイナリは Gatekeeper に隔離される**。ダウンロード由来の `com.apple.quarantine` 属性が付くと「開発元を確認できないため開けません」となる。`setup.sh` が属性を除去する。署名と公証は行わない
- **Node は同梱しない**。受け取り側に Node 24 以上が入っていることを前提とする。`setup.sh` がバージョンを確認して、満たさなければ中止する
- **API キーは配布物に含めない**。受け取り側が自分のキーを `.env.local` に置く

## 出典

- TypeSafe API リファレンス https://docs.typesafe.ai/api
- Score プリミティブ https://docs.typesafe.ai/primitives/score
- jev 1.13 の失敗モード https://docs.typesafe.ai/model-jaggedness/jev-1.13
- 価格 https://docs.typesafe.ai/models
- Vercel AI Gateway の evaluation https://vercel.com/docs/ai-gateway/modalities/evaluation
- Claude Sonnet 5 の単価 https://vercel.com/ai-gateway/models/claude-sonnet-5
