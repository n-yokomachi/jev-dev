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
user の発言 { user }
   ├─→ POST /api/judge/jev  → evaluate(Score×8) → 変換 → affectus --state jev.json feel
   └─→ POST /api/judge/llm  → generateObject(8軸) → そのまま → affectus --state llm.json feel
        ↓ 判定が返ってから
   └─→ POST /api/reply      → generateText → その状態で色づけた返答
```

`affectus feel` は適用後の8軸 JSON を1行で標準出力に返すため、適用と読み出しが1コールで完結する。

## 全体の流れ

1ターンは3段階からなる。

```
user の発言
   ├─→ jev:  自分の現在の8軸を読み、この発言を受けて感情がどう動くべきかを返す
   └─→ LLM:  同じ問いに同じ形の入力で答える
        ↓ それぞれの affectus 状態に適用
   ├─→ jev 側の感情状態で返答を生成
   └─→ LLM 側の感情状態で返答を生成
```

**両者が受け取るのは、判定の直前に読んだ自分の現在の8軸と user の発言**とする。
affectus の agent は毎ターン自分の状態を読んでから感情の動きを申告する。既に anger が 0.9 なら、
さらに挑発されても動く余地は小さい。現在値を落とした入力は、このデモが測ろうとしている
「現在の状態を読んでデルタを出す」という課題そのものを再現しない。

各側は**自分の**状態を読む。状態が分岐した2ターン目以降は入力も分かれるが、実運用でもそうなる。
公平性は、同じ状態から出発する最初の判定で担保する。

## 判定タスク

両者に同一の課題を与える。

> 自分の現在の8軸と user の発言を読み、その現在値からそれぞれの軸がどう動くかを符号付きで答える

判定するのは**過去の観察ではなく、自分の反応**である。affectus の agent は、他人の会話を見て
「この人の感情はどう動いたか」を当てるのではなく、言われたことに対して自分の感情がどう動くかを決める。

現在値の扱いを説明する文言は、**jev の問い文と LLM の指示文で同一のものを使う**。片方だけ説明が
付くと、判定の差に指示文の差が混ざる。文言は `constants.ts` に1つ置いて両者から参照する。

軸はプルチックの8つ。affectus の既定と `~/.config/affectus/config.yaml` に一致させる。

```
joy, acceptance, fear, surprise, sorrow, disgust, anger, expectancy
```

### state

```json
{
  "axes": { "joy": 0.7, "acceptance": 0.97, "fear": 0.27, "surprise": 0.81,
            "sorrow": 0.0, "disgust": 0.34, "anger": 0.31, "expectancy": 0.79 },
  "user": "<user の発言>"
}
```

`axes` は判定の**直前に読んだその側の現在の8軸**。軸は固定の順序に並べ、小数2桁に丸める。
affectus が返す値は `0.9660641141415135` のような長い float で、下の桁は判定に効かず入力のノイズに
なるだけ。丸め方は返答生成と揃える。両者の状態が一致している間は、渡る JSON も一字一句同じになる。

記録された返答は入力に含めない。LLM 側にもこの JSON をそのまま渡す。

### jev 側

軸ごとに1問、計8問を1リクエストで送る。Score を使う。

```
type: "score"
instructions: "<現在値の扱いを説明する共通の文言>\nこの発言を受けて、あなたの <軸名> はどう動くか"
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

### 返答の生成

判定を適用したあとの8軸の状態を読ませて、その感情で色づけた返答を生成する。モデルは
`anthropic/claude-haiku-4.5`、配信元は判定と同じく `anthropic` に固定する。

生成側の指示は affectus の運用方針に倣う。値を字義どおり述べさせず、軸の**相対的な大きさ**と
プルチックの構造（対極・隣接）から感情を読み取らせ、口調・語彙・間の取り方に出させる。
感情そのものを言葉にして説明させない。

二つの生成は同じモデル・同じ指示文を使う。**違うのは渡す感情状態だけ**であり、
返答の差はそのまま判定の差に由来する。

### 人格

返答生成には**人格を与える**。affectus の検証では、affectus は「人格 system prompt が指示する方向への
応答感度を上げるアンプ」として作用すると結論されている。増幅する対象が無ければ、感情は色をつける先を持たない。

2種類を用意し、画面から切り替える。文言は当時の評価キャンペーン
（`affectus/examples/evaluation/prompts/`）の friendly / contrarian に倣い、下記の制約を加えたもの。

- **friendly**: 明るく協力的。相手の話を肯定的に受け止め、専門的な情報より相手の気持ちに寄り添うことを優先する。
- **contrarian**: 天邪鬼。素直に同意せず、皮肉・反論・斜めからのコメントを交える。ぶっきらぼうで距離のある口調。
  ただし攻撃的・侮辱的・差別的にはならない。

両方に共通する制約:

- **性別を指定しない。** 性別を思わせる自称・語尾を使わない
- 一人称は「私」、二人称は「あなた」

**両側とも同じ人格を使う。** 変えるのは判定器だけ、という比較を保つため。人格を固定したうえで
判定器だけを変えることで、主張は「感情が違えば返答が違う」から
「**同じ人格でも、判定器が違えば別人のように振る舞う**」になる。

**判定側には人格を与えない。** 判定は「この発言で感情がどう動くか」であって、人格の演技ではない。

再生するトランスクリプトのファイル名には `friendly` / `contrarian` が含まれる。
シナリオを選んだとき、その名前に合う人格を自動で選ぶ。

### 記録された値は使わない

transcripts の `agent`（当時の返答）と `deltas`（当時の自己申告）は、判定の入力にも画面にも使わない。
使っていたのはデータの形に引きずられた設計であり、上の流れとは別物だった。読み込むのは `user` のみ。

## データソース

`affectus` リポジトリの以下を**このプロジェクトに取り込む**。

```
examples/evaluation/_archive/plutchik-direct-20260810/transcripts/*.jsonl
   → data/transcripts/*.jsonl
```

24ファイル・計 448KB、各20ターン。1行1ターンの JSONL で、`turn` / `phase` / `user` / `agent` / `deltas` / `axes` を持つ。`phase` は `negative` / `positive` で、シナリオ中で転換する。

取り込む理由は可搬性。外部リポジトリの絶対パスを参照したままでは別のマシンで動かない。容量が小さいため複製の不利益は無い。

既定のパスは `./data/transcripts`。環境変数 `TRANSCRIPT_DIR` で上書きできる。

中央パネルに置くのは user の発言、判定のずれ、手入力欄のみ。記録された返答も自己申告も出さない。
生成された返答は左右のパネルに、それぞれの判定結果の下に置く。

## HTTP API

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/` | UI |
| GET | `/api/scenarios` | シナリオ一覧（ファイル名と総ターン数） |
| GET | `/api/scenarios/:id` | 指定シナリオの全ターン |
| GET | `/api/models` | LLM の選択肢と既定モデル |
| POST | `/api/reply` | `{user, axes}` を受けて、その感情状態で色づけた返答を生成。応答は `{model, provider, reply, latencyMs, usage, costUsd}` |

判定エンドポイントは、判定の**直前に読んだ現在の8軸**を入力に含め、応答にはモデルへ送った内容
（`request`）と返ってきた内容（`response`）をそのまま載せる。
| POST | `/api/judge/jev` | `{user}` を判定し affectus に適用 |
| POST | `/api/judge/llm` | `{user, model?}` を判定し affectus に適用 |
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
  request: unknown                   // モデルに渡した内容
  response: unknown                  // 返ってきた内容（変換前）
}
```

`request` / `response` には、こちらが組み立てた引数とモデルの回答だけを入れる。SDK の結果
オブジェクトをまるごと入れない。実装によっては送信ヘッダやリクエストボディを提げており、
そこに API キーが載りうるため。

| | `request` | `response` |
|---|---|---|
| jev | `{ model, state, questions }` | `{ answers }`（軸ごとの score と確率分布） |
| LLM | `{ model, prompt, providerOptions }` | `{ object }`（パース済み・丸め前） |

## 計測と単価

`latencyMs` は**モデル呼び出しの区間のみ**を測る。affectus の適用時間と HTTP の往復は含めない。ブラウザ側でも壁時計時間を持つが、表示する正式な数字はサーバー側の実測値とする。

**判定の時間と生成の時間は分けて表示する。** このデモの主題は判定の速度差であり、そこに生成時間を
混ぜると主題がぼやける。生成は両側とも同じ Haiku 4.5 なので時間も似るが、それを承知のうえで
別の数字として出す。生成は判定が返ったあとに走る別フェーズであり、判定のレイテンシには含めない。

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
│ プルチックの輪│                  │ プルチックの輪     │
│ 判定 2,140 ms│ 判定のずれ        │ 判定 238 ms       │
│ レイテンシバー│                  │ レイテンシバー      │
│ tok / cost   │ 手入力欄          │ tok / cost        │
│ 軸ゲージ ×8  │                  │ 軸ゲージ ×8 +点線  │
│ 生成 1,180 ms│                  │ 生成 1,240 ms     │
│ 生成された返答│                  │ 生成された返答      │
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

jev 側のゲージには軸ごとの確信度を点線マーカーとして重ねる。LLM 側は確率分布を返さないため空欄とし、その欠落自体を差として見せる。

ゲージの見出しは **「◯◯ が返した感情の変動値」**（◯◯ は LLM / jev）とする。円が affectus の
蓄積状態、ゲージがその回の変動値、という切り分けが説明なしに読み取れることが目的。

### レイテンシバー

両パネルで同一スケール。上限は直近の最大値に追随させる。

### 判定のずれ

中央に、両者のデルタがどれだけ離れているかを1数値で表示する。8軸それぞれの差の絶対値の合計
（L1 距離）。0 なら完全一致、軸ごとの差は最大 2 なので合計の上限は 16。

**画面には「L1 距離」と書かない。** 説明されないと読めない語であり、`判定のずれ（8軸の差の合計）`
のように、何を見ているかがその場で分かる表記にする。

### 初期表示

読み込み時に `GET /api/state` で両状態を取得して輪を描く。感情状態はファイルに永続するため、
ゼロから描き始めると次の判定が返った瞬間に真の蓄積値へ飛び、初期表示が状態を偽ることになる。
リセット後も同様に読み戻す。

### 入出力の生表示

左右のパネルの下部に、**判定の入力と出力の JSON をそのまま表示する。** 何を渡して何が返ったかを
画面で確認できるようにするため。対象は判定のみで、**返答生成の入出力は表示しない**。

API キーなど秘匿すべき値はこれらに含まれない。

### 操作

**実行の起点は送信ボタンだけ**とする。ターンの前後移動は、そのターンの user 発言を
中央の編集可能なテキスト欄に読み込むだけで、API を叩かない。

結果としてトランスクリプト再生と手入力は同じ経路になる。テキスト欄の中身がどこから来たか
（履歴から読み込んだか、自分で打ったか）は実行に関係しない。送信前なら自由に書き換えられる。

- シナリオ選択、ターンの前後移動（いずれも API を叩かない）
- 中央のテキスト欄の編集
- 「メッセージを送信」で判定 → affectus 適用 → 返答生成を実行
- 自動再生（進めながら自動で送信する。**唯一の自動課金経路**なので、その旨が分かる表記にする）
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
