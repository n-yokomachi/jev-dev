# jev × LLM 判定対決ビューア Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 同一の会話ターンを `jev` と LLM の両方に判定させ、判定結果のズレと速度差を1画面で見せるローカル Web アプリを作る。

**Architecture:** Node の HTTP サーバーが判定と affectus バイナリ呼び出しを担い、ブラウザが2本のリクエストを同時に投げて先に返ったパネルから埋める。判定結果は2つの affectus 状態ファイルに別々に蓄積する。UI はフレームワーク無しの静的ファイル。

**Tech Stack:** Node 24（`.ts` の型注釈は実行時に除去されるためビルド工程なし）、AI SDK 7.0.105 以上（`ai`）、`zod`、テストは `node:test`、affectus は Go ビルド済みバイナリを外部プロセスとして呼ぶ。

**Spec:** `docs/superpowers/specs/2026-09-17-jev-llm-judgment-duel-design.md`

## Global Constraints

- 軸は常にこの8つ、この順序: `joy, acceptance, fear, surprise, sorrow, disgust, anger, expectancy`
- デルタのレンジは `-1.0` 〜 `1.0`。affectus の `delta_clamp` と LLM の出力レンジに一致させる
- Score の段階は5つ: `["強く下がった", "下がった", "変化なし", "上がった", "強く上がった"]`
- 変換式: `delta = (score / 4 - 0.5) * 2`
- affectus の呼び出しはグローバルフラグをサブコマンドの**前**に置く: `affectus --config P --state P <cmd> [args]`
- `affectus feel` の出力は**小数2桁に丸めた1行 JSON**。`affectus get` はインデント付き JSON
- 単価定数（1M トークンあたりの米ドル、入力 / 出力）: `typesafe-ai/jev` は $0.042 / 無料、`anthropic/claude-haiku-4.5` は $1 / $5、`anthropic/claude-sonnet-5` は $2 / $10、`anthropic/claude-opus-5` は $5 / $25、`anthropic/claude-fable-5.1` は $10 / $50
- LLM 側の既定モデルは `anthropic/claude-haiku-4.5`、配信元は `anthropic` に固定
- API キーは `.env.local` の `AI_GATEWAY_API_KEY`。コード・コミット・ログのいずれにも値を出さない
- 配色（計器）: 背景 `#07090c` / パネル `#0d1117` / 罫線 `#1d2530` / 文字 `#c9d4e0` / 補助 `#5b6673` / LLM `#ffb84d` / jev `#4dffb8`
- 依存に UI フレームワークとバンドラを追加しない

## File Structure

| ファイル | 責務 |
|---|---|
| `src/constants.ts` | 軸定義、問い文、Score 段階、変換式、単価、パス |
| `src/confidence.ts` | 確率分布から確信度を算出（応答に `confidence` が無い場合の代替） |
| `src/affectus.ts` | affectus バイナリの呼び出しラッパー |
| `src/transcripts.ts` | JSONL トランスクリプトの読み込み |
| `src/judges.ts` | jev / LLM 各判定の実行と計測 |
| `src/server.ts` | HTTP サーバーとルーティング |
| `public/index.html` | 画面の骨格 |
| `public/style.css` | 計器スタイル |
| `public/app.js` | 描画・操作・2本同時リクエスト |
| `scripts/probe-jev.ts` | 実応答の形を確認する使い捨てスクリプト |
| `scripts/setup.sh` | 別マシンでの初期設定（冪等） |
| `scripts/package.sh` | 配布 zip の作成 |
| `data/transcripts/` | 取り込んだトランスクリプト 24 ファイル |
| `README.md` | 別マシンでの手順 |

---

### Task 1: 基盤と affectus ラッパー

**Files:**
- Create: `package.json`, `src/constants.ts`, `src/affectus.ts`, `bin/affectus`（ビルド生成物）
- Test: `test/affectus.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: `AXES`, `Axis`, `AxisMap`, `AFFECTUS_REPO`, `TRANSCRIPT_DIR`（`src/constants.ts`）／ `AffectusEnv`, `Runner`, `parseAxes()`, `init()`, `feel()`, `getAxes()`, `resetState()`（`src/affectus.ts`）

- [ ] **Step 1: 依存と affectus バイナリを用意**

```bash
cd /Users/Naoki/work/workshop/jev-dev
npm init -y
npm pkg set type=module
npm install ai zod
mkdir -p src test public scripts state bin
(cd /Users/Naoki/work/workshop/affectus && go build -o /Users/Naoki/work/workshop/jev-dev/bin/affectus ./cmd/affectus)
./bin/affectus --config state/config.yaml --state state/jev.json init --model plutchik
./bin/affectus --config state/config.yaml --state state/llm.json init --model plutchik --force
```

`ai` が 7.0.105 以上であることを確認する。

```bash
node -p "require('./node_modules/ai/package.json').version"
```

`state/` と `bin/` を `.gitignore` に追加する。

```bash
printf 'state/\nbin/\n' >> .gitignore
```

- [ ] **Step 2: `src/constants.ts` を書く**

```ts
export const AXES = [
  'joy', 'acceptance', 'fear', 'surprise',
  'sorrow', 'disgust', 'anger', 'expectancy',
] as const;

export type Axis = (typeof AXES)[number];
export type AxisMap = Record<Axis, number>;

export const AFFECTUS_REPO =
  process.env.AFFECTUS_REPO ?? '/Users/Naoki/work/workshop/affectus';

export const TRANSCRIPT_DIR =
  `${AFFECTUS_REPO}/examples/evaluation/_archive/plutchik-direct-20260810/transcripts`;
```

- [ ] **Step 3: 失敗するテストを書く**

`test/affectus.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { feel, init, parseAxes, type AffectusEnv } from '../src/affectus.ts';

const fakeEnv: AffectusEnv = {
  bin: 'bin/affectus',
  config: 'state/config.yaml',
  state: 'state/jev.json',
};

test('parseAxes は1行 JSON を読む', () => {
  const axes = parseAxes('{"joy":0.60,"acceptance":0.00}\n');
  assert.equal(axes.joy, 0.6);
  assert.equal(axes.acceptance, 0);
});

test('parseAxes はインデント付き JSON も読む', () => {
  const axes = parseAxes('{\n  "joy": 0.123456\n}\n');
  assert.equal(axes.joy, 0.123456);
});

test('feel はグローバルフラグをサブコマンドの前に置く', async () => {
  let seen: string[] = [];
  const runner = async (_bin: string, args: string[]) => {
    seen = args;
    return '{"joy":0.20}';
  };
  const axes = await feel(fakeEnv, { joy: 0.2 }, runner);
  assert.deepEqual(seen, [
    '--config', 'state/config.yaml',
    '--state', 'state/jev.json',
    'feel', '{"joy":0.2}',
  ]);
  assert.equal(axes.joy, 0.2);
});

test('実バイナリで init から feel まで通る', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'affectus-test-'));
  const env: AffectusEnv = {
    bin: resolve('bin/affectus'),
    config: join(dir, 'config.yaml'),
    state: join(dir, 'state.json'),
  };
  await init(env);
  const axes = await feel(env, { joy: 0.6, sorrow: 0.2 });
  assert.equal(axes.joy, 0.6);
  assert.equal(axes.sorrow, 0.2);
  assert.equal(axes.anger, 0);
});
```

- [ ] **Step 4: テストを実行して失敗を確認**

Run: `node --test test/affectus.test.ts`
Expected: FAIL（`../src/affectus.ts` が存在しない旨のエラー）

- [ ] **Step 5: `src/affectus.ts` を実装**

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Axis, AxisMap } from './constants.ts';

const execFileAsync = promisify(execFile);

export interface AffectusEnv {
  bin: string;
  config: string;
  state: string;
}

export type Runner = (bin: string, args: string[]) => Promise<string>;

export const execRunner: Runner = async (bin, args) => {
  const { stdout } = await execFileAsync(bin, args);
  return stdout;
};

function globalArgs(env: AffectusEnv): string[] {
  return ['--config', env.config, '--state', env.state];
}

export function parseAxes(stdout: string): AxisMap {
  return JSON.parse(stdout.trim()) as AxisMap;
}

export async function init(
  env: AffectusEnv,
  force = false,
  runner: Runner = execRunner,
): Promise<void> {
  const args = [...globalArgs(env), 'init', '--model', 'plutchik'];
  if (force) args.push('--force');
  await runner(env.bin, args);
}

export async function feel(
  env: AffectusEnv,
  deltas: Partial<Record<Axis, number>>,
  runner: Runner = execRunner,
): Promise<AxisMap> {
  const out = await runner(env.bin, [
    ...globalArgs(env), 'feel', JSON.stringify(deltas),
  ]);
  return parseAxes(out);
}

export async function getAxes(
  env: AffectusEnv,
  runner: Runner = execRunner,
): Promise<AxisMap> {
  const out = await runner(env.bin, [...globalArgs(env), 'get']);
  return parseAxes(out);
}

export async function resetState(
  env: AffectusEnv,
  runner: Runner = execRunner,
): Promise<void> {
  await runner(env.bin, [...globalArgs(env), 'reset']);
}
```

- [ ] **Step 6: テストを実行して通過を確認**

Run: `node --test test/affectus.test.ts`
Expected: PASS（4件）

- [ ] **Step 7: commit**

```bash
git add package.json package-lock.json .gitignore src/constants.ts src/affectus.ts test/affectus.test.ts
git commit -m "feat: affectus バイナリのラッパーを追加"
```

---

### Task 1b: 可搬性

別の Mac に持っていっても動くようにする。外部リポジトリの絶対パスへの依存を断ち、初期設定を1コマンドにまとめる。

**Files:**
- Create: `data/transcripts/*.jsonl`（24ファイル、コピー）, `scripts/setup.sh`, `README.md`
- Modify: `src/constants.ts`（`AFFECTUS_REPO` を廃し、`TRANSCRIPT_DIR` と `PROJECT_ROOT` を差し替え）
- Test: `test/data.test.ts`

**Interfaces:**
- Consumes: `AXES`, `Axis`, `AxisMap`（Task 1 の `src/constants.ts`）
- Produces: `PROJECT_ROOT`, `TRANSCRIPT_DIR`（`src/constants.ts`。`AFFECTUS_REPO` は削除。Task 6 が `PROJECT_ROOT` を使う）

- [ ] **Step 1: トランスクリプトを取り込む**

```bash
mkdir -p data/transcripts
cp /Users/Naoki/work/workshop/affectus/examples/evaluation/_archive/plutchik-direct-20260810/transcripts/*.jsonl data/transcripts/
ls data/transcripts/*.jsonl | wc -l   # 24 であること
du -sh data/transcripts               # 448K 前後であること
```

- [ ] **Step 2: 失敗するテストを書く**

`test/data.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PROJECT_ROOT, TRANSCRIPT_DIR } from '../src/constants.ts';

async function jsonlFiles(): Promise<string[]> {
  return (await readdir(TRANSCRIPT_DIR)).filter((f) => f.endsWith('.jsonl')).sort();
}

test('取り込んだトランスクリプトが24ファイルある', async () => {
  assert.equal((await jsonlFiles()).length, 24);
});

test('各ファイルが20ターン持つ', async () => {
  for (const file of await jsonlFiles()) {
    const lines = (await readFile(join(TRANSCRIPT_DIR, file), 'utf8'))
      .split('\n')
      .filter((line) => line.trim() !== '');
    assert.equal(lines.length, 20, `${file} のターン数`);
  }
});

test('PROJECT_ROOT と TRANSCRIPT_DIR は cwd に依存しない絶対パス', () => {
  assert.ok(PROJECT_ROOT.startsWith('/'), PROJECT_ROOT);
  assert.ok(TRANSCRIPT_DIR.startsWith('/'), TRANSCRIPT_DIR);
});
```

- [ ] **Step 3: テストを実行して失敗を確認**

Run: `node --test test/data.test.ts`
Expected: FAIL（`PROJECT_ROOT` が `src/constants.ts` に無い）

- [ ] **Step 4: `src/constants.ts` のパス定数を差し替える**

Task 1 で書いた次の2つを削除する。

```ts
export const AFFECTUS_REPO =
  process.env.AFFECTUS_REPO ?? '/Users/Naoki/work/workshop/affectus';

export const TRANSCRIPT_DIR =
  `${AFFECTUS_REPO}/examples/evaluation/_archive/plutchik-direct-20260810/transcripts`;
```

代わりに、ファイル冒頭に import を足し、同じ位置に次を置く。

```ts
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

export const TRANSCRIPT_DIR =
  process.env.TRANSCRIPT_DIR ?? fileURLToPath(new URL('../data/transcripts', import.meta.url));
```

`import.meta.url` を基準にすることで、どのディレクトリから起動してもパスが解決する。

- [ ] **Step 5: テストを実行して通過を確認**

Run: `node --test test/data.test.ts`
Expected: PASS（3件）

- [ ] **Step 6: `scripts/setup.sh` を書く**

```bash
#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

say() { printf '%s\n' "$*"; }

# 1. Node のバージョン
if ! command -v node >/dev/null 2>&1; then
  say "node が見つかりません。Node 24 以上を入れてください: https://nodejs.org/"
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 24 ]; then
  say "Node 24 以上が必要です（現在 v$(node -p 'process.versions.node')）"
  exit 1
fi
say "node v$(node -p 'process.versions.node') OK"

# 2. 依存
if [ -d node_modules ]; then
  say "node_modules あり、飛ばします"
else
  say "npm ci を実行します"
  npm ci
fi

# 3. affectus バイナリ
if [ -x bin/affectus ]; then
  say "bin/affectus あり、飛ばします"
elif command -v go >/dev/null 2>&1; then
  say "go install で affectus を取得します"
  mkdir -p bin
  GOBIN="$ROOT/bin" go install github.com/n-yokomachi/affectus/cmd/affectus@v0.4.0
else
  say "bin/affectus が無く、go も入っていません。"
  say "Go を入れるか、リリースのバイナリを bin/affectus に置いてください:"
  say "  https://github.com/n-yokomachi/affectus/releases"
  exit 1
fi

# 4. Gatekeeper の隔離属性を外す
xattr -dr com.apple.quarantine . 2>/dev/null || true

# 5. 感情状態
mkdir -p state
if [ ! -f state/jev.json ]; then
  bin/affectus --config state/config.yaml --state state/jev.json init --model plutchik
  say "state/jev.json を作成しました"
fi
if [ ! -f state/llm.json ]; then
  bin/affectus --config state/config.yaml --state state/llm.json init --model plutchik --force
  say "state/llm.json を作成しました"
fi

# 6. API キー
if [ ! -f .env.local ]; then
  say ""
  say "最後に API キーが要ります。次を実行して、貼り付けてください。"
  say "  printf 'AI_GATEWAY_API_KEY: '; read -rs KEY; echo; printf 'AI_GATEWAY_API_KEY=%s\\n' \"\$KEY\" > .env.local; unset KEY; chmod 600 .env.local"
  say ""
  say "キーは Vercel の AI Gateway → API Keys で発行できます。"
  exit 0
fi

say ""
say "準備できました。起動するには:"
say "  node --env-file=.env.local src/server.ts"
```

実行権限を付ける。

```bash
chmod +x scripts/setup.sh
```

- [ ] **Step 7: 冪等性を確認**

Run: `./scripts/setup.sh && ./scripts/setup.sh`
Expected: 2回目は「あり、飛ばします」が並び、状態ファイルが作り直されないこと。両実行とも最後に起動コマンドの案内が出ること。

`state/jev.json` の中身が2回目の実行後も変わっていないことを確認する。

```bash
shasum state/jev.json && ./scripts/setup.sh >/dev/null && shasum state/jev.json
```

Expected: 2つのハッシュが一致

- [ ] **Step 8: `README.md` を書く**

````markdown
# jev × LLM 判定対決ビューア

同じ会話ターンを TypeSafe の `jev` と LLM の両方に判定させ、判定結果のズレと速度差を1画面で見せるデモ。判定は [affectus](https://github.com/n-yokomachi/affectus) の感情状態として別々に蓄積され、2つの状態が会話の進行につれて分岐していく様子をプルチックの輪で見られる。

## 必要なもの

- macOS（Apple Silicon / Intel のどちらでも）
- Node 24 以上
- Vercel AI Gateway の API キー

配布 zip には affectus のバイナリと `node_modules` が入っているので、Go もネットワーク越しの依存解決も要らない。

## 使い方

```bash
./scripts/setup.sh
# 案内に従って .env.local に API キーを書く
node --env-file=.env.local src/server.ts
```

ブラウザで http://localhost:8787 を開く。

シナリオを選ぶと、会話が1ターンずつ流れる。`▶❙` で1ターン進め、`▶` で自動再生。中央の入力欄から任意のターンを判定させることもできる。

## 画面の読み方

- **左が LLM、右が jev。** 同じ会話ターンを同時に判定させ、先に返ったほうから埋まる
- **プルチックの輪**は花弁の長さが各軸の強さ。左右で形が違えば、判定が食い違っている
- **軸ゲージ**は中央線から右が正、左が負。jev 側の点線は軸ごとの確信度で、LLM 側にはこれに相当する出力が無い
- **L1 距離**は両者のデルタがどれだけ離れているかの1数値

## 構成

| ディレクトリ | 内容 |
|---|---|
| `src/` | サーバーと判定ロジック |
| `public/` | 画面 |
| `data/transcripts/` | 再生用の会話ログ 24 シナリオ × 20 ターン |
| `bin/` | affectus バイナリ |
| `state/` | 2つの感情状態（`setup.sh` が生成） |

## テスト

```bash
node --test test/*.test.ts
```

## 配布 zip を作る

```bash
./scripts/package.sh
```

`dist/` に zip ができる。API キーと感情状態は含まれない。
````

- [ ] **Step 8b: `CLAUDE.md` を書く**

配布先の Mac でも Claude Code が使えるため、向こうのエージェントが最初から文脈を持てるようにする。

````markdown
# CLAUDE.md — jev × LLM 判定対決ビューア

## これは何

同じ会話ターンを TypeSafe の `jev` と LLM の両方に判定させ、判定結果のズレと速度差を1画面で見せるデモ。判定は affectus（Go 製の感情状態エンジン）の感情状態として別々に蓄積される。

設計の根拠は `docs/superpowers/specs/`、実装の手順は `docs/superpowers/plans/` にある。

## 動かす

```bash
./scripts/setup.sh
node --env-file=.env.local src/server.ts
```

`.env.local` に `AI_GATEWAY_API_KEY` が要る。**値をログ・コミット・標準出力に出さないこと。**

## 構成の要点

- **ビルド工程は無い。** Node 24 が `.ts` の型注釈を実行時に除去する。TypeScript コンパイラや `tsconfig.json` を足さないこと
- テストは `node:test`。`node --test test/*.test.ts` で全件。テストフレームワークを足さないこと
- 依存は `ai` と `zod` だけ。UI はフレームワーク無しの静的ファイル。バンドラを入れないこと
- `bin/affectus` は外部プロセスとして呼ぶ。グローバルフラグはサブコマンドの**前**（`affectus --config P --state P feel '<json>'`）
- 感情の軸は常にこの8つ、この順序: `joy, acceptance, fear, surprise, sorrow, disgust, anger, expectancy`
- デルタのレンジは `-1.0` 〜 `1.0`
- **LLM 側の配信元は `anthropic` に固定してある。** レイテンシ比較の条件を揃えるためなので外さないこと

## 触るときの注意

- 問いの文・軸定義・単価・変換係数は `src/constants.ts` に集約してある。判定の挙動を変えたいときはまずここを見る
- `state/jev.json` と `state/llm.json` は実行のたびに育つ。比較をやり直すときは画面の reset を使う
- `affectus` 本体（https://github.com/n-yokomachi/affectus）には手を入れない
````

- [ ] **Step 9: 全テストを実行**

Run: `node --test test/*.test.ts`
Expected: PASS（7件。Task 1 の4件と Task 1b の3件）

- [ ] **Step 10: commit**

```bash
git add data/transcripts scripts/setup.sh README.md CLAUDE.md src/constants.ts test/data.test.ts
git commit -m "feat: 別マシンで動かすための取り込みと初期設定スクリプトを追加"
```

---

### Task 2: トランスクリプトの読み込み

**Files:**
- Create: `src/transcripts.ts`
- Test: `test/transcripts.test.ts`

**Interfaces:**
- Consumes: `Axis`, `AxisMap`, `TRANSCRIPT_DIR`（`src/constants.ts`）
- Produces: `Turn`, `Scenario`, `ScenarioSummary`, `listScenarios(dir)`, `loadScenario(dir, id)`（`src/transcripts.ts`）

- [ ] **Step 1: 失敗するテストを書く**

`test/transcripts.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listScenarios, loadScenario } from '../src/transcripts.ts';
import { TRANSCRIPT_DIR } from '../src/constants.ts';

async function fixtureDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'transcripts-'));
  const lines = [
    JSON.stringify({
      turn: 1, phase: 'negative', user: 'u1', agent: 'a1',
      deltas: { sorrow: 0.2 },
      axes: { joy: 0, acceptance: 0, fear: 0, surprise: 0, sorrow: 0.2, disgust: 0, anger: 0, expectancy: 0 },
    }),
    JSON.stringify({
      turn: 2, phase: 'positive', user: 'u2', agent: 'a2',
      deltas: { joy: 0.3 },
      axes: { joy: 0.3, acceptance: 0, fear: 0, surprise: 0, sorrow: 0.2, disgust: 0, anger: 0, expectancy: 0 },
    }),
  ];
  await writeFile(join(dir, 'sample_friendly-on_run1.jsonl'), lines.join('\n') + '\n');
  return dir;
}

test('listScenarios はファイル名とターン数を返す', async () => {
  const dir = await fixtureDir();
  const list = await listScenarios(dir);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'sample_friendly-on_run1');
  assert.equal(list[0].turnCount, 2);
});

test('loadScenario は全ターンを順に返す', async () => {
  const dir = await fixtureDir();
  const scenario = await loadScenario(dir, 'sample_friendly-on_run1');
  assert.equal(scenario.turns.length, 2);
  assert.equal(scenario.turns[0].user, 'u1');
  assert.equal(scenario.turns[1].phase, 'positive');
  assert.equal(scenario.turns[0].deltas.sorrow, 0.2);
});

test('loadScenario は id にパス区切りを含む要求を拒む', async () => {
  const dir = await fixtureDir();
  await assert.rejects(() => loadScenario(dir, '../secret'), /invalid scenario id/);
});

test('実データのディレクトリに24シナリオある', async () => {
  const list = await listScenarios(TRANSCRIPT_DIR);
  assert.equal(list.length, 24);
  assert.equal(list[0].turnCount, 20);
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `node --test test/transcripts.test.ts`
Expected: FAIL（`../src/transcripts.ts` が存在しない）

- [ ] **Step 3: `src/transcripts.ts` を実装**

```ts
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Axis, AxisMap } from './constants.ts';

export interface Turn {
  turn: number;
  phase: string;
  user: string;
  agent: string;
  deltas: Partial<Record<Axis, number>>;
  axes: AxisMap;
}

export interface Scenario {
  id: string;
  turns: Turn[];
}

export interface ScenarioSummary {
  id: string;
  turnCount: number;
}

function parseLines(text: string): Turn[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Turn);
}

export async function listScenarios(dir: string): Promise<ScenarioSummary[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort();
  const out: ScenarioSummary[] = [];
  for (const file of files) {
    const text = await readFile(join(dir, file), 'utf8');
    out.push({ id: file.replace(/\.jsonl$/, ''), turnCount: parseLines(text).length });
  }
  return out;
}

export async function loadScenario(dir: string, id: string): Promise<Scenario> {
  if (id.includes('/') || id.includes('\\') || id.includes('..')) {
    throw new Error(`invalid scenario id: ${id}`);
  }
  const text = await readFile(join(dir, `${id}.jsonl`), 'utf8');
  return { id, turns: parseLines(text) };
}
```

- [ ] **Step 4: テストを実行して通過を確認**

Run: `node --test test/transcripts.test.ts`
Expected: PASS（4件）

- [ ] **Step 5: commit**

```bash
git add src/transcripts.ts test/transcripts.test.ts
git commit -m "feat: トランスクリプトの読み込みを追加"
```

---

### Task 3: 確信度の算出

`jev` の応答に `confidence` が含まれない経路のための代替。TypeSafe 側の算出式は公開されていないため、**正規化エントロピーによる独自定義**とする。分布が1点に集中すれば 1、一様なら 0。

**Files:**
- Create: `src/confidence.ts`
- Test: `test/confidence.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: `confidenceFromProbabilities(probs: number[]): number`（`src/confidence.ts`）

- [ ] **Step 1: 失敗するテストを書く**

`test/confidence.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confidenceFromProbabilities } from '../src/confidence.ts';

test('1点に集中した分布は 1', () => {
  assert.equal(confidenceFromProbabilities([0, 0, 1, 0, 0]), 1);
});

test('一様分布は 0', () => {
  const c = confidenceFromProbabilities([0.25, 0.25, 0.25, 0.25]);
  assert.ok(Math.abs(c) < 1e-9, `expected ~0, got ${c}`);
});

test('偏った分布は期待値どおりの確信度になる', () => {
  // H = -(0.7ln0.7 + 0.2ln0.2 + 0.1ln0.1) = 0.801819
  // 正規化 = H / ln(3) = 0.729847 → confidence = 1 - 0.729847 = 0.270153
  const c = confidenceFromProbabilities([0.7, 0.2, 0.1]);
  assert.ok(Math.abs(c - 0.270153) < 1e-6, `expected ~0.270153, got ${c}`);
});

test('選択肢が1つなら 1', () => {
  assert.equal(confidenceFromProbabilities([1]), 1);
});

test('空の分布は 0', () => {
  assert.equal(confidenceFromProbabilities([]), 0);
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `node --test test/confidence.test.ts`
Expected: FAIL（`../src/confidence.ts` が存在しない）

- [ ] **Step 3: `src/confidence.ts` を実装**

```ts
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
```

- [ ] **Step 4: テストを実行して通過を確認**

Run: `node --test test/confidence.test.ts`
Expected: PASS（5件）

- [ ] **Step 5: commit**

```bash
git add src/confidence.ts test/confidence.test.ts
git commit -m "feat: 確率分布から確信度を算出する関数を追加"
```

---

### Task 4: jev 判定

**Files:**
- Create: `src/judges.ts`, `scripts/probe-jev.ts`
- Modify: `src/constants.ts`（問い文・Score 段階・変換式・単価・モデル名を追加）
- Test: `test/judges-jev.test.ts`

**Interfaces:**
- Consumes: `AXES`, `Axis`, `AxisMap`（`src/constants.ts`）／ `confidenceFromProbabilities()`（`src/confidence.ts`）
- Produces: `AXIS_JA`, `SCORE_LEVELS`, `axisInstruction()`, `scoreToDelta()`, `JEV_MODEL`, `DEFAULT_LLM_MODEL`, `PRICING`（`src/constants.ts`）／ `TurnInput`, `JudgeOutcome`, `EvaluateFn`, `EvaluationResult`, `buildJevQuestions()`, `costUsd()`, `judgeWithJev()`（`src/judges.ts`）

- [ ] **Step 1: `src/constants.ts` に追記**

既存の内容の末尾に加える。

```ts
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

export function axisInstruction(axis: Axis): string {
  return `この会話を受けて、agent の感情のうち「${AXIS_JA[axis]}」はどう動いたか`;
}

export function scoreToDelta(score: number): number {
  const levels = SCORE_LEVELS.length;
  return (score / (levels - 1) - 0.5) * 2;
}

export const JEV_MODEL = 'typesafe-ai/jev';
export const DEFAULT_LLM_MODEL = 'anthropic/claude-haiku-4.5';

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
```

- [ ] **Step 2: 実応答の形を確認するプローブを書いて実行**

`scripts/probe-jev.ts`:

```ts
import { experimental_evaluate as evaluate } from 'ai';

const result = await evaluate({
  model: 'typesafe-ai/jev',
  state: { user: 'だいたい君は前から強引なんだよ。', agent: '……そこは私の勇み足です。' },
  questions: {
    sorrow: {
      type: 'score',
      instructions: 'この会話を受けて、agent の感情のうち「悲しみ」はどう動いたか',
      criteria: ['強く下がった', '下がった', '変化なし', '上がった', '強く上がった'],
    },
  },
});

console.log(JSON.stringify({ answers: result.answers, usage: result.usage }, null, 2));
```

Run: `node --env-file=.env.local scripts/probe-jev.ts`

`answers.sorrow` に `confidence` が含まれるかを目で確認する。含まれていても含まれていなくても実装は変わらない（Step 4 のコードが両方を扱う）。応答が返ること自体が疎通確認になる。

失敗した場合は、`AI_GATEWAY_API_KEY` が読めているか、`ai` のバージョンが 7.0.105 以上かを確認する。

- [ ] **Step 3: 失敗するテストを書く**

`test/judges-jev.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildJevQuestions, costUsd, judgeWithJev, type EvaluationResult } from '../src/judges.ts';
import { AXES } from '../src/constants.ts';

const turn = { user: 'だいたい君は強引だ', agent: '……勇み足でした' };

function fakeResult(overrides: Record<string, unknown> = {}): EvaluationResult {
  const answers: Record<string, unknown> = {};
  for (const axis of AXES) {
    answers[axis] = { type: 'score', score: 2, probabilities: { '0': 0, '1': 0, '2': 1, '3': 0, '4': 0 } };
  }
  return {
    answers: { ...answers, ...overrides } as EvaluationResult['answers'],
    usage: { inputTokens: 300, outputTokens: 24 },
  };
}

test('buildJevQuestions は8軸ぶんの score 問いを作る', () => {
  const questions = buildJevQuestions();
  assert.equal(Object.keys(questions).length, 8);
  assert.equal(questions.sorrow.type, 'score');
  assert.equal(questions.sorrow.criteria.length, 5);
  assert.match(questions.sorrow.instructions, /悲しみ/);
});

test('score 2 は delta 0 になる', async () => {
  const out = await judgeWithJev(turn, async () => fakeResult());
  for (const axis of AXES) assert.equal(out.deltas[axis], 0);
});

test('score 4 は delta +1、score 0 は delta -1 になる', async () => {
  const out = await judgeWithJev(turn, async () =>
    fakeResult({
      sorrow: { type: 'score', score: 4, probabilities: { '0': 0, '1': 0, '2': 0, '3': 0, '4': 1 } },
      joy: { type: 'score', score: 0, probabilities: { '0': 1, '1': 0, '2': 0, '3': 0, '4': 0 } },
    }),
  );
  assert.equal(out.deltas.sorrow, 1);
  assert.equal(out.deltas.joy, -1);
  assert.equal(out.rawScore.sorrow, 4);
});

test('応答の confidence があればそれを使う', async () => {
  const out = await judgeWithJev(turn, async () =>
    fakeResult({ sorrow: { type: 'score', score: 3, probabilities: { '3': 1 }, confidence: 0.42 } }),
  );
  assert.equal(out.confidence.sorrow, 0.42);
});

test('応答に confidence が無ければ probabilities から算出する', async () => {
  const out = await judgeWithJev(turn, async () => fakeResult());
  assert.equal(out.confidence.sorrow, 1);
});

test('usage が欠けていても 0 として扱う', async () => {
  const out = await judgeWithJev(turn, async () => ({ answers: fakeResult().answers }));
  assert.equal(out.usage.inputTokens, 0);
  assert.equal(out.costUsd, 0);
});

test('costUsd は入力のみ課金のモデルで出力を無視する', () => {
  const cost = costUsd('typesafe-ai/jev', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
  assert.equal(cost, 0.042);
});

test('costUsd は入出力とも課金するモデルを合算する', () => {
  const cost = costUsd('anthropic/claude-sonnet-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
  assert.equal(cost, 12);
});

test('latencyMs が数値で返る', async () => {
  const out = await judgeWithJev(turn, async () => fakeResult());
  assert.equal(typeof out.latencyMs, 'number');
  assert.ok(out.latencyMs >= 0);
});

test('jev の provider は typesafe-ai', async () => {
  const out = await judgeWithJev(turn, async () => fakeResult());
  assert.equal(out.provider, 'typesafe-ai');
});
```

- [ ] **Step 4: テストを実行して失敗を確認**

Run: `node --test test/judges-jev.test.ts`
Expected: FAIL（`../src/judges.ts` が存在しない）

- [ ] **Step 5: `src/judges.ts` を実装**

```ts
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
```

- [ ] **Step 6: テストを実行して通過を確認**

Run: `node --test test/judges-jev.test.ts`
Expected: PASS（10件）

- [ ] **Step 7: commit**

```bash
git add src/constants.ts src/judges.ts scripts/probe-jev.ts test/judges-jev.test.ts
git commit -m "feat: jev による8軸判定を追加"
```

---

### Task 5: LLM 判定

**Files:**
- Modify: `src/judges.ts`（末尾に追記）
- Test: `test/judges-llm.test.ts`

**Interfaces:**
- Consumes: `TurnInput`, `JudgeOutcome`, `Usage`, `costUsd()`（`src/judges.ts`）／ `AXES`, `AXIS_JA`, `DEFAULT_LLM_MODEL`（`src/constants.ts`）
- Produces: `DeltaSchema`, `GenerateObjectFn`, `llmInstruction()`, `judgeWithLlm()`（`src/judges.ts`）

- [ ] **Step 1: 失敗するテストを書く**

`test/judges-llm.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeWithLlm, llmInstruction } from '../src/judges.ts';
import { AXES } from '../src/constants.ts';

const turn = { user: 'だいたい君は強引だ', agent: '……勇み足でした' };

function fakeObject(): Record<string, number> {
  const o: Record<string, number> = {};
  for (const axis of AXES) o[axis] = 0;
  o.sorrow = 0.2;
  o.joy = -0.1;
  return o;
}

test('llmInstruction は8軸すべてを列挙する', () => {
  const text = llmInstruction();
  for (const axis of AXES) assert.match(text, new RegExp(axis));
});

test('LLM の出力をそのままデルタとして使う', async () => {
  const out = await judgeWithLlm(turn, async () => ({
    object: fakeObject(),
    usage: { inputTokens: 400, outputTokens: 90 },
  }));
  assert.equal(out.deltas.sorrow, 0.2);
  assert.equal(out.deltas.joy, -0.1);
  assert.equal(out.deltas.anger, 0);
});

test('confidence と rawScore は空になる', async () => {
  const out = await judgeWithLlm(turn, async () => ({
    object: fakeObject(),
    usage: { inputTokens: 400, outputTokens: 90 },
  }));
  assert.deepEqual(out.confidence, {});
  assert.deepEqual(out.rawScore, {});
});

test('コストは入出力の両方を合算する', async () => {
  const out = await judgeWithLlm(turn, async () => ({
    object: fakeObject(),
    usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
  }));
  assert.equal(out.costUsd, 12);
  assert.equal(out.model, 'anthropic/claude-haiku-4.5');
});

test('配信元を anthropic に固定して呼ぶ', async () => {
  let seen;
  await judgeWithLlm(turn, async (options) => {
    seen = options.providerOptions;
    return { object: fakeObject(), usage: { inputTokens: 0, outputTokens: 0 } };
  });
  assert.deepEqual(seen, { gateway: { only: ['anthropic'] } });
});

test('outcome に provider が入る', async () => {
  const out = await judgeWithLlm(turn, async () => ({
    object: fakeObject(),
    usage: { inputTokens: 0, outputTokens: 0 },
  }));
  assert.equal(out.provider, 'anthropic');
});

test('モデル名を指定できる', async () => {
  const out = await judgeWithLlm(
    turn,
    async () => ({ object: fakeObject(), usage: { inputTokens: 0, outputTokens: 0 } }),
    'typesafe-ai/jev',
  );
  assert.equal(out.model, 'typesafe-ai/jev');
});

test('レンジ外の値は -1〜1 に丸められる', async () => {
  const out = await judgeWithLlm(turn, async () => {
    const o = fakeObject();
    o.anger = 5;
    o.fear = -3;
    return { object: o, usage: { inputTokens: 0, outputTokens: 0 } };
  });
  assert.equal(out.deltas.anger, 1);
  assert.equal(out.deltas.fear, -1);
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `node --test test/judges-llm.test.ts`
Expected: FAIL（`judgeWithLlm` が export されていない）

- [ ] **Step 3: `src/judges.ts` に追記**

冒頭の import に `AXIS_JA` / `DEFAULT_LLM_MODEL` / `LLM_PROVIDER` を加え、`zod` を import する。

```ts
import { z } from 'zod';
```

ファイル末尾に加える。

```ts
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
```

- [ ] **Step 4: テストを実行して通過を確認**

Run: `node --test test/judges-llm.test.ts`
Expected: PASS（8件）

- [ ] **Step 5: commit**

```bash
git add src/judges.ts test/judges-llm.test.ts
git commit -m "feat: LLM による8軸判定を追加"
```

---

### Task 6: HTTP サーバー

**Files:**
- Create: `src/server.ts`
- Test: `test/server.test.ts`

**Interfaces:**
- Consumes: `listScenarios()`, `loadScenario()`（`src/transcripts.ts`）／ `judgeWithJev()`, `judgeWithLlm()`（`src/judges.ts`）／ `feel()`, `getAxes()`, `resetState()`（`src/affectus.ts`）／ `TRANSCRIPT_DIR`（`src/constants.ts`）
- Produces: `createServer(deps)`（`src/server.ts`）

- [ ] **Step 1: 失敗するテストを書く**

`test/server.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerDeps } from '../src/server.ts';
import { AXES, type AxisMap } from '../src/constants.ts';

function zeroAxes(): AxisMap {
  const a = {} as AxisMap;
  for (const axis of AXES) a[axis] = 0;
  return a;
}

function deps(overrides: Partial<ServerDeps> = {}): ServerDeps {
  return {
    transcriptDir: '/tmp/does-not-matter',
    llmModels: ['anthropic/claude-haiku-4.5', 'anthropic/claude-sonnet-5'],
    defaultLlmModel: 'anthropic/claude-haiku-4.5',
    listScenarios: async () => [{ id: 'scenario-a', turnCount: 20 }],
    loadScenario: async (_dir, id) => ({ id, turns: [] }),
    judgeJev: async () => ({
      model: 'typesafe-ai/jev', provider: 'typesafe-ai', deltas: zeroAxes(), confidence: { joy: 0.9 },
      rawScore: { joy: 2 }, latencyMs: 238,
      usage: { inputTokens: 310, outputTokens: 24 }, costUsd: 0.000013,
    }),
    judgeLlm: async () => ({
      model: 'anthropic/claude-haiku-4.5', provider: 'anthropic', deltas: zeroAxes(), confidence: {},
      rawScore: {}, latencyMs: 2140,
      usage: { inputTokens: 412, outputTokens: 96 }, costUsd: 0.00178,
    }),
    applyToAffectus: async () => zeroAxes(),
    readAffectus: async () => zeroAxes(),
    resetAffectus: async () => {},
    ...overrides,
  };
}

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

/**
 * Node の global fetch は keep-alive で接続を保持するため、
 * close() だけではテストプロセスが終了しない。先に接続を切る。
 */
function shutdown(server: ReturnType<typeof createServer>): void {
  server.closeAllConnections();
  server.close();
}

test('GET /api/scenarios が一覧を返す', async () => {
  const server = createServer(deps());
  const base = await listen(server);
  const res = await fetch(`${base}/api/scenarios`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), [{ id: 'scenario-a', turnCount: 20 }]);
  shutdown(server);
});

test('POST /api/judge/jev は判定結果に適用後の軸を足して返す', async () => {
  const server = createServer(deps());
  const base = await listen(server);
  const res = await fetch(`${base}/api/judge/jev`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: 'u', agent: 'a' }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.latencyMs, 238);
  assert.equal(body.confidence.joy, 0.9);
  assert.equal(body.axes.joy, 0);
  shutdown(server);
});

test('POST /api/judge/llm は jev とは別の状態に適用する', async () => {
  const seen: string[] = [];
  const server = createServer(deps({
    applyToAffectus: async (side) => { seen.push(side); return zeroAxes(); },
  }));
  const base = await listen(server);
  await fetch(`${base}/api/judge/llm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: 'u', agent: 'a' }),
  });
  assert.deepEqual(seen, ['llm']);
  shutdown(server);
});

test('user が無い POST は 400 を返す', async () => {
  const server = createServer(deps());
  const base = await listen(server);
  const res = await fetch(`${base}/api/judge/jev`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent: 'a' }),
  });
  assert.equal(res.status, 400);
  shutdown(server);
});

test('POST /api/reset は両側をリセットする', async () => {
  const seen: string[] = [];
  const server = createServer(deps({ resetAffectus: async (side) => { seen.push(side); } }));
  const base = await listen(server);
  const res = await fetch(`${base}/api/reset`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.deepEqual(seen.sort(), ['jev', 'llm']);
  shutdown(server);
});

test('GET /api/models は選択肢と既定モデルを返す', async () => {
  const server = createServer(deps());
  const base = await listen(server);
  const body = await (await fetch(`${base}/api/models`)).json();
  assert.ok(body.models.includes(body.default), 'default が models に含まれること');
  assert.equal(body.default, 'anthropic/claude-haiku-4.5');
  shutdown(server);
});

test('未知のパスは 404 を返す', async () => {
  const server = createServer(deps());
  const base = await listen(server);
  const res = await fetch(`${base}/api/nope`);
  assert.equal(res.status, 404);
  shutdown(server);
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `node --test test/server.test.ts`
Expected: FAIL（`../src/server.ts` が存在しない）

- [ ] **Step 3: `src/server.ts` を実装**

```ts
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { experimental_evaluate as evaluate, generateObject } from 'ai';
import { DEFAULT_LLM_MODEL, LLM_MODELS, PROJECT_ROOT, TRANSCRIPT_DIR, type AxisMap } from './constants.ts';
import { listScenarios, loadScenario, type Scenario, type ScenarioSummary } from './transcripts.ts';
import {
  judgeWithJev, judgeWithLlm,
  type EvaluateFn, type GenerateObjectFn, type JudgeOutcome, type TurnInput,
} from './judges.ts';
import { feel, getAxes, resetState, type AffectusEnv } from './affectus.ts';

export type Side = 'jev' | 'llm';

export interface ServerDeps {
  transcriptDir: string;
  llmModels: readonly string[];
  defaultLlmModel: string;
  listScenarios: (dir: string) => Promise<ScenarioSummary[]>;
  loadScenario: (dir: string, id: string) => Promise<Scenario>;
  judgeJev: (turn: TurnInput) => Promise<JudgeOutcome>;
  judgeLlm: (turn: TurnInput, model?: string) => Promise<JudgeOutcome>;
  applyToAffectus: (side: Side, deltas: AxisMap) => Promise<AxisMap>;
  readAffectus: (side: Side) => Promise<AxisMap>;
  resetAffectus: (side: Side) => Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
  const rel = pathname === '/' ? 'index.html' : normalize(pathname).replace(/^(\.\.[/\\])+/, '').replace(/^\//, '');
  try {
    const file = await readFile(join(PROJECT_ROOT, 'public', rel));
    res.writeHead(200, { 'content-type': MIME[extname(rel)] ?? 'application/octet-stream' });
    res.end(file);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}

async function handleJudge(
  deps: ServerDeps,
  side: Side,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readBody(req);
  const user = body.user;
  const agent = body.agent;
  if (typeof user !== 'string' || typeof agent !== 'string') {
    sendJson(res, 400, { error: 'user と agent は必須の文字列です' });
    return;
  }
  const turn: TurnInput = { user, agent };
  const outcome = side === 'jev'
    ? await deps.judgeJev(turn)
    : await deps.judgeLlm(turn, typeof body.model === 'string' ? body.model : undefined);
  const axes = await deps.applyToAffectus(side, outcome.deltas);
  sendJson(res, 200, { ...outcome, axes });
}

export function createServer(deps: ServerDeps) {
  return createHttpServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = url.pathname;

        if (req.method === 'GET' && path === '/api/scenarios') {
          sendJson(res, 200, await deps.listScenarios(deps.transcriptDir));
          return;
        }
        if (req.method === 'GET' && path.startsWith('/api/scenarios/')) {
          const id = decodeURIComponent(path.slice('/api/scenarios/'.length));
          sendJson(res, 200, await deps.loadScenario(deps.transcriptDir, id));
          return;
        }
        if (req.method === 'POST' && path === '/api/judge/jev') {
          await handleJudge(deps, 'jev', req, res);
          return;
        }
        if (req.method === 'POST' && path === '/api/judge/llm') {
          await handleJudge(deps, 'llm', req, res);
          return;
        }
        if (req.method === 'GET' && path === '/api/models') {
          sendJson(res, 200, { models: deps.llmModels, default: deps.defaultLlmModel });
          return;
        }
        if (req.method === 'GET' && path === '/api/state') {
          sendJson(res, 200, { jev: await deps.readAffectus('jev'), llm: await deps.readAffectus('llm') });
          return;
        }
        if (req.method === 'POST' && path === '/api/reset') {
          await deps.resetAffectus('jev');
          await deps.resetAffectus('llm');
          sendJson(res, 200, { ok: true });
          return;
        }
        if (req.method === 'GET' && !path.startsWith('/api/')) {
          await serveStatic(res, path);
          return;
        }
        sendJson(res, 404, { error: 'not found' });
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    })();
  });
}

function envFor(side: Side): AffectusEnv {
  return {
    bin: join(PROJECT_ROOT, 'bin', 'affectus'),
    config: join(PROJECT_ROOT, 'state', 'config.yaml'),
    state: join(PROJECT_ROOT, 'state', `${side}.json`),
  };
}

export function productionDeps(): ServerDeps {
  return {
    transcriptDir: TRANSCRIPT_DIR,
    llmModels: LLM_MODELS,
    defaultLlmModel: DEFAULT_LLM_MODEL,
    listScenarios,
    loadScenario,
    judgeJev: (turn) => judgeWithJev(turn, evaluate as unknown as EvaluateFn),
    judgeLlm: (turn, model) =>
      judgeWithLlm(turn, generateObject as unknown as GenerateObjectFn, model ?? DEFAULT_LLM_MODEL),
    applyToAffectus: (side, deltas) => feel(envFor(side), deltas),
    readAffectus: (side) => getAxes(envFor(side)),
    resetAffectus: (side) => resetState(envFor(side)),
  };
}

if (process.argv[1]?.endsWith('server.ts')) {
  const port = Number(process.env.PORT ?? 8787);
  createServer(productionDeps()).listen(port, () => {
    console.log(`listening on http://localhost:${port}`);
  });
}
```

- [ ] **Step 4: テストを実行して通過を確認**

Run: `node --test test/server.test.ts`
Expected: PASS（7件）

- [ ] **Step 5: 全テストをまとめて実行**

Run: `node --test test/*.test.ts`
Expected: PASS（41件）

- [ ] **Step 6: commit**

```bash
git add src/server.ts test/server.test.ts
git commit -m "feat: HTTP サーバーとルーティングを追加"
```

---

### Task 7: 画面の骨格とプルチックの輪

**Files:**
- Create: `public/index.html`, `public/style.css`, `public/app.js`

**Interfaces:**
- Consumes: `/api/scenarios`, `/api/scenarios/:id`, `/api/judge/jev`, `/api/judge/llm`, `/api/reset`
- Produces: `drawWheel(container, values)`（`public/app.js` 内）

- [ ] **Step 1: `public/index.html` を書く**

```html
<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>jev × LLM 判定対決</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header class="topbar">
  <select id="scenario"></select>
  <span id="progress">turn — / —</span>
  <span class="transport">
    <button id="prev">◀</button>
    <button id="play">▶</button>
    <button id="next">▶❙</button>
    <button id="reset">reset</button>
  </span>
</header>

<main class="cols">
  <section class="panel llm" id="panel-llm">
    <div class="badge"><span class="n">LLM</span><span class="v" id="llm-model">—</span></div>
    <select id="llm-pick" class="pick"></select>
    <div class="wheel" id="wheel-llm"></div>
    <div class="ms" id="llm-ms">—<span>ms</span></div>
    <div class="track"><i id="llm-track"></i></div>
    <div class="meta"><span id="llm-tok">— tok</span><span id="llm-cost">—</span></div>
    <div class="gauges" id="llm-gauges"></div>
    <div class="ghost">confidence に相当する出力なし</div>
  </section>

  <section class="panel mid">
    <div class="turn"><span class="who">user</span><p id="turn-user">シナリオを選んでください</p></div>
    <div class="turn"><span class="who">agent</span><p id="turn-agent">—</p></div>
    <div class="ghost" id="self-report">当時の自己申告：—</div>
    <div class="diverge">L1 距離<br><b id="l1">—</b></div>
    <form class="manual" id="manual">
      <textarea id="manual-user" rows="2" placeholder="user の発言"></textarea>
      <textarea id="manual-agent" rows="2" placeholder="agent の返答"></textarea>
      <button type="submit">この1ターンを判定</button>
    </form>
  </section>

  <section class="panel jev" id="panel-jev">
    <div class="badge"><span class="n">jev</span><span class="v" id="jev-model">—</span></div>
    <div class="wheel" id="wheel-jev"></div>
    <div class="ms" id="jev-ms">—<span>ms</span></div>
    <div class="track"><i id="jev-track"></i></div>
    <div class="meta"><span id="jev-tok">— tok</span><span id="jev-cost">—</span></div>
    <div class="gauges" id="jev-gauges"></div>
    <div class="ghost">点線 = 軸ごとの confidence</div>
  </section>
</main>

<script src="/app.js" type="module"></script>
</body>
</html>
```

- [ ] **Step 2: `public/style.css` を書く**

```css
:root {
  --bg: #07090c;
  --panel: #0d1117;
  --line: #1d2530;
  --text: #c9d4e0;
  --dim: #5b6673;
  --llm: #ffb84d;
  --jev: #4dffb8;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  padding: 16px;
  background: var(--bg);
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}

.topbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 8px 12px;
  margin-bottom: 12px;
}

.topbar select,
.topbar button {
  background: transparent;
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 4px 10px;
  font: inherit;
  cursor: pointer;
}

.topbar button:hover { border-color: var(--dim); }
.topbar button:disabled { opacity: .4; cursor: default; }
.transport { display: flex; gap: 6px; }

.cols { display: flex; gap: 12px; align-items: stretch; }

.panel {
  flex: 1;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 12px;
}

.panel.mid { flex: 1.1; display: flex; flex-direction: column; }
.panel.llm { border-color: #4a3c22; }
.panel.jev { border-color: #1f4a3a; }
.panel.pending { opacity: .45; }

.badge {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: 10px;
  letter-spacing: .12em;
  text-transform: uppercase;
  margin-bottom: 10px;
}

.badge .v { color: var(--dim); font-size: 9px; text-transform: none; }
.llm .badge .n { color: var(--llm); }
.jev .badge .n { color: var(--jev); }

.pick {
  width: 100%;
  background: #0a0f15;
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 4px 6px;
  font: inherit;
  font-size: 10px;
  margin-bottom: 10px;
  cursor: pointer;
}

.wheel { display: flex; justify-content: center; margin-bottom: 10px; }

.ms { font-size: 22px; text-align: center; margin-bottom: 4px; }
.ms span { font-size: 11px; color: var(--dim); margin-left: 4px; }
.llm .ms { color: var(--llm); }
.jev .ms { color: var(--jev); }

.track {
  height: 6px;
  border-radius: 3px;
  background: #131a22;
  overflow: hidden;
  margin-bottom: 10px;
}

.track i {
  display: block;
  height: 100%;
  width: 0;
  border-radius: 3px;
  transition: width .35s ease-out;
}

.llm .track i { background: var(--llm); }
.jev .track i { background: var(--jev); }

.meta {
  display: flex;
  justify-content: space-between;
  color: var(--dim);
  font-size: 10px;
  margin-bottom: 10px;
}

.axis {
  display: grid;
  grid-template-columns: 58px 1fr 38px;
  gap: 6px;
  align-items: center;
  font-size: 9px;
  margin-bottom: 4px;
}

.axis .nm { color: var(--dim); text-align: right; }
.axis .val { color: var(--dim); }

.gauge {
  position: relative;
  height: 9px;
  background: #131a22;
  border-radius: 2px;
}

.gauge::before {
  content: "";
  position: absolute;
  left: 50%;
  top: -1px;
  bottom: -1px;
  width: 1px;
  background: var(--line);
}

.gauge b {
  position: absolute;
  top: 1px;
  bottom: 1px;
  border-radius: 2px;
  transition: width .3s ease-out;
}

.llm .gauge b { background: var(--llm); }
.jev .gauge b { background: var(--jev); }

.gauge .conf {
  position: absolute;
  top: -2px;
  bottom: -2px;
  border-right: 2px dotted #93a1b0;
}

.turn {
  border: 1px dashed var(--line);
  border-radius: 8px;
  padding: 8px;
  margin-bottom: 8px;
}

.turn .who {
  color: var(--dim);
  font-size: 9px;
  letter-spacing: .1em;
  text-transform: uppercase;
}

.turn p { margin: 4px 0 0; line-height: 1.6; }

.ghost {
  color: var(--dim);
  font-size: 9px;
  border-top: 1px solid var(--line);
  padding-top: 8px;
  margin-top: 8px;
}

.diverge { text-align: center; margin: 10px 0; color: var(--dim); font-size: 10px; }
.diverge b { display: block; color: var(--text); font-size: 20px; margin-top: 2px; }

.manual { margin-top: auto; display: flex; flex-direction: column; gap: 6px; }

.manual textarea {
  background: #0a0f15;
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 6px;
  font: inherit;
  resize: vertical;
}

.manual button {
  background: transparent;
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 6px;
  font: inherit;
  cursor: pointer;
}
```

- [ ] **Step 3: `public/app.js` に輪の描画までを書く**

```js
export const AXES = [
  'joy', 'acceptance', 'fear', 'surprise',
  'sorrow', 'disgust', 'anger', 'expectancy',
];

const WHEEL_COLORS = {
  joy: '#ffd93d',
  acceptance: '#a8e05f',
  fear: '#4caf50',
  surprise: '#4fc3f7',
  sorrow: '#3f51b5',
  disgust: '#9c27b0',
  anger: '#e53935',
  expectancy: '#fb8c00',
};

const SIZE = 132;

export function drawWheel(container, values) {
  const c = SIZE / 2;
  const max = c - 8;
  const parts = [
    `<svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
    `<circle cx="${c}" cy="${c}" r="${max}" fill="none" stroke="#1d2530"/>`,
  ];

  AXES.forEach((axis, i) => {
    const v = Math.min(1, Math.max(0, values[axis] ?? 0));
    const r = 7 + max * v;
    const a1 = ((-90 + i * 45 - 21) * Math.PI) / 180;
    const a2 = ((-90 + i * 45 + 21) * Math.PI) / 180;
    const x1 = (c + r * Math.cos(a1)).toFixed(1);
    const y1 = (c + r * Math.sin(a1)).toFixed(1);
    const x2 = (c + r * Math.cos(a2)).toFixed(1);
    const y2 = (c + r * Math.sin(a2)).toFixed(1);
    parts.push(
      `<path d="M${c},${c} L${x1},${y1} A${r.toFixed(1)},${r.toFixed(1)} 0 0,1 ${x2},${y2} Z" ` +
        `fill="${WHEEL_COLORS[axis]}" fill-opacity="${(0.2 + 0.75 * v).toFixed(2)}"/>`,
    );
  });

  parts.push('</svg>');
  container.innerHTML = parts.join('');
}

const zero = Object.fromEntries(AXES.map((a) => [a, 0]));
drawWheel(document.getElementById('wheel-llm'), zero);
drawWheel(document.getElementById('wheel-jev'), zero);
```

- [ ] **Step 4: サーバーを起動して表示を確認**

```bash
node --env-file=.env.local src/server.ts
```

ブラウザで `http://localhost:8787` を開く。確認する内容:

- 背景がほぼ黒（`#07090c`）で、3カラムが横に並んでいる
- 左右のパネルに8方向の輪の外周円が描かれ、花弁は全て最小（値が 0 のため）
- 中央に user / agent の枠と手入力欄がある
- ブラウザのコンソールにエラーが出ていない

- [ ] **Step 5: commit**

```bash
git add public/index.html public/style.css public/app.js
git commit -m "feat: 画面の骨格とプルチックの輪の描画を追加"
```

---

### Task 8: 判定の実行と表示

**Files:**
- Modify: `public/app.js`（Task 7 の末尾 2 行を置き換えて追記）

**Interfaces:**
- Consumes: `drawWheel()`, `AXES`（`public/app.js`）／ サーバーの全エンドポイント
- Produces: なし（最終タスク）

- [ ] **Step 1: `public/app.js` の末尾を置き換える**

Task 7 の末尾にある `const zero = ...` 以降の3行を削除し、以下を追記する。

```js
const state = {
  scenario: null,
  index: 0,
  playing: false,
  maxLatency: 1,
};

const el = (id) => document.getElementById(id);

function renderGauges(container, deltas, confidence) {
  container.innerHTML = AXES.map((axis) => {
    const v = deltas?.[axis] ?? 0;
    const width = Math.abs(v) * 50;
    const bar = v >= 0
      ? `<b style="left:50%;width:${width}%"></b>`
      : `<b style="right:50%;width:${width}%"></b>`;
    const conf = confidence?.[axis] !== undefined
      ? `<span class="conf" style="left:${50 + (v >= 0 ? 1 : -1) * confidence[axis] * 50}%"></span>`
      : '';
    const sign = v > 0 ? '+' : '';
    return `<div class="axis"><span class="nm">${axis.slice(0, 7)}</span>` +
      `<span class="gauge">${bar}${conf}</span>` +
      `<span class="val">${sign}${v.toFixed(2)}</span></div>`;
  }).join('');
}

function renderSide(side, result) {
  el(`panel-${side}`).classList.remove('pending');
  el(`${side}-model`).textContent = `${result.model} · ${result.provider}`;
  el(`${side}-ms`).innerHTML = `${result.latencyMs.toLocaleString()}<span>ms</span>`;
  el(`${side}-tok`).textContent =
    `${result.usage.inputTokens} / ${result.usage.outputTokens} tok`;
  el(`${side}-cost`).textContent = `$${result.costUsd.toFixed(6)}`;
  state.maxLatency = Math.max(state.maxLatency, result.latencyMs);
  el(`${side}-track`).style.width = `${(result.latencyMs / state.maxLatency) * 100}%`;
  renderGauges(el(`${side}-gauges`), result.deltas, result.confidence);
  drawWheel(el(`wheel-${side}`), result.axes);
}

function l1(a, b) {
  return AXES.reduce((sum, axis) => sum + Math.abs((a?.[axis] ?? 0) - (b?.[axis] ?? 0)), 0);
}

async function judge(side, turn) {
  const body = side === 'llm' ? { ...turn, model: el('llm-pick').value } : turn;
  const res = await fetch(`/api/judge/${side}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${side}: ${res.status}`);
  return res.json();
}

async function runTurn(turn) {
  el('turn-user').textContent = turn.user;
  el('turn-agent').textContent = turn.agent;
  el('self-report').textContent = turn.deltas
    ? `当時の自己申告：${Object.entries(turn.deltas)
        .map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${v}`)
        .join(' / ')}`
    : '当時の自己申告：—';
  el('l1').textContent = '—';
  el('panel-llm').classList.add('pending');
  el('panel-jev').classList.add('pending');

  const results = {};
  const both = ['llm', 'jev'].map((side) =>
    judge(side, { user: turn.user, agent: turn.agent })
      .then((result) => {
        results[side] = result;
        renderSide(side, result);
      })
      .catch((error) => {
        el(`panel-${side}`).classList.remove('pending');
        el(`${side}-model`).textContent = `error: ${error.message}`;
      }),
  );

  await Promise.allSettled(both);
  if (results.llm && results.jev) {
    el('l1').textContent = l1(results.llm.deltas, results.jev.deltas).toFixed(2);
  }
}

function updateProgress() {
  const total = state.scenario?.turns.length ?? 0;
  el('progress').textContent = `turn ${total ? state.index + 1 : '—'} / ${total || '—'}`;
  el('prev').disabled = state.index <= 0;
  el('next').disabled = !state.scenario || state.index >= total - 1;
}

async function showTurn(index) {
  if (!state.scenario) return;
  state.index = Math.min(Math.max(0, index), state.scenario.turns.length - 1);
  updateProgress();
  await runTurn(state.scenario.turns[state.index]);
}

async function loadScenario(id) {
  const res = await fetch(`/api/scenarios/${encodeURIComponent(id)}`);
  state.scenario = await res.json();
  state.index = 0;
  updateProgress();
}

async function play() {
  state.playing = !state.playing;
  el('play').textContent = state.playing ? '❙❙' : '▶';
  while (state.playing && state.scenario && state.index < state.scenario.turns.length) {
    await showTurn(state.index);
    if (state.index >= state.scenario.turns.length - 1) break;
    state.index += 1;
  }
  state.playing = false;
  el('play').textContent = '▶';
}

el('prev').addEventListener('click', () => showTurn(state.index - 1));
el('next').addEventListener('click', () => showTurn(state.index + 1));
el('play').addEventListener('click', play);

el('reset').addEventListener('click', async () => {
  await fetch('/api/reset', { method: 'POST' });
  const zero = Object.fromEntries(AXES.map((a) => [a, 0]));
  drawWheel(el('wheel-llm'), zero);
  drawWheel(el('wheel-jev'), zero);
  state.maxLatency = 1;
});

el('scenario').addEventListener('change', (event) => loadScenario(event.target.value));

el('manual').addEventListener('submit', async (event) => {
  event.preventDefault();
  await runTurn({ user: el('manual-user').value, agent: el('manual-agent').value, deltas: null });
});

const initial = Object.fromEntries(AXES.map((a) => [a, 0]));
drawWheel(el('wheel-llm'), initial);
drawWheel(el('wheel-jev'), initial);

const { models, default: defaultModel } = await (await fetch('/api/models')).json();
el('llm-pick').innerHTML = models
  .map((m) => `<option value="${m}">${m.replace('anthropic/', '')}</option>`)
  .join('');
el('llm-pick').value = defaultModel;

const scenarios = await (await fetch('/api/scenarios')).json();
el('scenario').innerHTML = scenarios
  .map((s) => `<option value="${s.id}">${s.id}</option>`)
  .join('');
if (scenarios.length > 0) await loadScenario(scenarios[0].id);
```

- [ ] **Step 2: 実サーバーで1ターン判定して確認**

```bash
node --env-file=.env.local src/server.ts
```

ブラウザで `http://localhost:8787` を開き、`▶❙`（次へ）を1回押す。確認する内容:

- 左右のパネルが薄くなり（`pending`）、**jev 側が先に濃くなる**
- jev のレイテンシが 3桁ms 台、LLM が 4桁ms 台で表示される
- jev のレイテンシバーが LLM より明らかに短い
- 両側の輪の花弁が伸び、左右で形が違う
- jev 側の軸ゲージにだけ点線マーカーが出ている
- 中央の L1 距離に数値が入る
- 中央の「当時の自己申告」に transcripts の記録値が出ている
- LLM パネル上部のモデル選択に4つのモデルが並び、既定が `claude-haiku-4.5` になっている
- 両パネルのモデル名の右に配信元が出ている（LLM 側は `anthropic`、jev 側は `typesafe-ai`）

- [ ] **Step 3: 自動再生とリセットを確認**

`▶` を押して自動再生し、数ターン進むことを確認する。`reset` を押して両方の輪が最小に戻ることを確認する。

- [ ] **Step 4: 手入力を確認**

中央の入力欄に任意の user 発言と agent 返答を入れて送信し、両側が判定されることを確認する。

- [ ] **Step 5: 全テストを実行**

Run: `node --test test/*.test.ts`
Expected: PASS（41件）

- [ ] **Step 6: commit**

```bash
git add public/app.js
git commit -m "feat: 判定の同時実行と結果表示を追加"
```

---

### Task 9: 配布 zip

「これさえあれば他の Mac でも動く」1ファイルを作る。

**Files:**
- Create: `scripts/package.sh`
- Modify: `.gitignore`（`dist/` を追加）

**Interfaces:**
- Consumes: Task 1b の `scripts/setup.sh`（展開先で実行される）
- Produces: `dist/jev-duel-<日付>.zip`

- [ ] **Step 1: `.gitignore` に `dist/` を追加**

```bash
printf 'dist/\n' >> .gitignore
```

- [ ] **Step 2: `scripts/package.sh` を書く**

```bash
#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
AFFECTUS_SRC="${AFFECTUS_SRC:-/Users/Naoki/work/workshop/affectus}"
NAME="jev-duel-$(date +%Y%m%d)"
OUT="$ROOT/dist"
STAGE="$OUT/$NAME"

rm -rf "$STAGE" "$OUT/$NAME.zip"
mkdir -p "$STAGE/bin"

# 1. affectus を arm64 + x86_64 の universal binary にする
if [ -d "$AFFECTUS_SRC" ] && command -v go >/dev/null 2>&1; then
  TMP="$(mktemp -d)"
  (cd "$AFFECTUS_SRC" && GOOS=darwin GOARCH=arm64 go build -o "$TMP/affectus-arm64" ./cmd/affectus)
  (cd "$AFFECTUS_SRC" && GOOS=darwin GOARCH=amd64 go build -o "$TMP/affectus-amd64" ./cmd/affectus)
  lipo -create -output "$STAGE/bin/affectus" "$TMP/affectus-arm64" "$TMP/affectus-amd64"
  rm -rf "$TMP"
  echo "universal binary: $(lipo -archs "$STAGE/bin/affectus")"
else
  echo "affectus のソースか go が無いため、手元の bin/affectus をそのまま同梱します"
  cp bin/affectus "$STAGE/bin/affectus"
fi

# 2. 中身を集める
for item in src public data scripts test docs package.json package-lock.json README.md CLAUDE.md; do
  cp -R "$item" "$STAGE/"
done
cp -R node_modules "$STAGE/node_modules"

# 3. 入ってはいけないものを落とす
rm -f "$STAGE/.env" "$STAGE/.env.local"
rm -rf "$STAGE/state" "$STAGE/dist" "$STAGE/node_modules/.cache"

# 4. 固める
(cd "$OUT" && zip -qr "$NAME.zip" "$NAME")
rm -rf "$STAGE"

echo "できました: dist/$NAME.zip ($(du -h "$OUT/$NAME.zip" | cut -f1))"
```

実行権限を付ける。

```bash
chmod +x scripts/package.sh
```

- [ ] **Step 3: zip を作って中身を確認**

Run: `./scripts/package.sh`

続けて中身を検査する。

```bash
Z=$(ls -t dist/*.zip | head -1)
unzip -l "$Z" | grep -c "node_modules/"     # 0 より大きいこと
unzip -l "$Z" | grep -c "data/transcripts/" # 25 前後（ディレクトリ行を含む）
unzip -l "$Z" | grep "env.local" || echo "OK: .env.local は入っていない"
unzip -l "$Z" | grep "state/"    || echo "OK: state/ は入っていない"
```

Expected: `.env.local` と `state/` が共に「入っていない」と出ること。

- [ ] **Step 4: 別ディレクトリに展開して実際に動かす**

これが可搬性の実証なので、必ず実行する。

```bash
ROOT="$PWD"
Z=$(ls -t "$ROOT"/dist/*.zip | head -1)
NAME=$(basename "$Z" .zip)
KEY_SRC="$ROOT/.env.local"
TMP=$(mktemp -d)
cd "$TMP" && unzip -q "$Z" && cd "$NAME"
./scripts/setup.sh
```

`ROOT` はこの後の後片付けでも使うので、同じシェルのまま Step 4 を通して実行すること。

Expected: `node_modules あり、飛ばします` と `bin/affectus あり、飛ばします` が出て、`state/jev.json` と `state/llm.json` が作られ、`.env.local` が無いので鍵の書き方を案内して終了する。

続けて鍵を置いて起動する。

```bash
cp "$KEY_SRC" .env.local
node --env-file=.env.local src/server.ts &
sleep 2
curl -s localhost:8787/api/scenarios | head -c 120
curl -s -o /dev/null -w '%{http_code}\n' localhost:8787/
kill %1
```

Expected: シナリオの JSON 配列が返り、`/` が `200` を返すこと。

確認できたら後片付けする。

```bash
cd "$ROOT" && rm -rf "$TMP"
```

- [ ] **Step 5: commit**

```bash
git add scripts/package.sh .gitignore
git commit -m "feat: 配布 zip を作るスクリプトを追加"
```

---

## Self-Review

**Spec coverage:**

| 設計書の項目 | 実装タスク |
|---|---|
| 全体構成・ファイル構成 | Task 1 |
| 判定タスク（jev の Score×8 と変換） | Task 4 |
| 判定タスク（LLM の generateObject） | Task 5 |
| 第3の参照値（当時の自己申告） | Task 8（中央パネルに表示） |
| データソース（transcripts） | Task 2 |
| HTTP API の7エンドポイント | Task 6 |
| 計測（レイテンシ・トークン・コスト） | Task 4, 5（算出）／ Task 8（表示） |
| 画面仕様（3カラム・計器配色） | Task 7 |
| プルチックの輪（花弁の長さ） | Task 7 |
| 軸ゲージ（中央線・confidence 点線） | Task 8 |
| レイテンシバー（同一スケール） | Task 8（直近の最大値に追随） |
| L1 距離 | Task 8 |
| 操作（選択・前後・再生・手入力・リセット） | Task 8 |
| 制約「Gateway に confidence が無い可能性」 | Task 3（代替算出）／ Task 4（両対応）／ Task 4 Step 2（実応答の確認） |
| 可搬性（絶対パスの排除・データの取り込み） | Task 1b |
| `scripts/setup.sh`（6手順・冪等） | Task 1b Step 6, 7 |
| README（別マシンでの手順） | Task 1b Step 8 |
| CLAUDE.md（配布先の Claude Code 向け文脈） | Task 1b Step 8b |
| LLM 配信元の固定（`anthropic`） | Task 4（定数）／ Task 5（呼び出し）／ Task 8（表示） |
| 配布 zip の同梱物と除外物 | Task 9 Step 2, 3 |
| universal binary（arm64 + x86_64） | Task 9 Step 2 |
| Gatekeeper の隔離属性の除去 | Task 1b Step 6（`setup.sh` 内） |
| 展開先で実際に動くことの確認 | Task 9 Step 4 |

未カバーの項目なし。

**型の整合:** `AxisMap` は Task 1 で定義し Task 4〜6 で使用。`JudgeOutcome` は Task 4 で定義し Task 5 が同じ型を返し Task 6 が受け取る。`Usage` の欠損は Task 4 の `normalizeUsage()` で 0 に正規化し、Task 5 も同じ関数を使う。`applyToAffectus(side, deltas)` の引数順は Task 6 のテストと実装で一致。

**留意点:** Task 5 は Task 4 が作った `src/judges.ts` に追記するため、Task 4 の完了が前提。Task 8 は Task 7 が作った `public/app.js` の末尾3行を置き換えるため、Task 7 の完了が前提。
