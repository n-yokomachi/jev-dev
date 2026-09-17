import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AXES, PERSONA_IDS, PERSONAS } from '../src/constants.ts';

/**
 * public/ はブラウザ向けで Node からは import できない。
 * サーバー側との食い違いは画面にだけ現れるので、テキストとして読んで突き合わせる。
 */
async function read(name: string): Promise<string> {
  return readFile(new URL(`../public/${name}`, import.meta.url), 'utf8');
}

test('public/app.js の AXES は src/constants.ts と同じ並び', async () => {
  const source = await read('app.js');
  const match = source.match(/export const AXES = \[([^\]]*)\]/);
  assert.ok(match, 'app.js に AXES のリテラルが見つからない');
  const axes = [...match[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(axes, [...AXES]);
});

test('ブラウザが送るのは user の発言だけ。現在の状態はサーバーが直前に読む', async () => {
  const source = await read('app.js');
  // 状態をブラウザが持ち回ると、送信までの間に減衰した古い値を判定に渡すことになる。
  // 判定の入力に入る現在の8軸は、サーバーが判定の直前に自分で読む。
  assert.match(source, /judge\(side, \{ user: turn\.user \}\)/);
  // 記録された返答は入力にも画面にも使わない。
  assert.doesNotMatch(source, /turn\.agent/);
  assert.doesNotMatch(source, /manual-agent/);
  assert.doesNotMatch(source, /self-report/);
});

test('判定のあとに /api/reply を叩く', async () => {
  const source = await read('app.js');
  assert.match(source, /'\/api\/reply'/);
  // 生成にも打ち切りを置く。置かないと state.busy が生成で立ち続ける。
  assert.match(source, /REPLY_TIMEOUT_MS/);
  assert.match(source, /signal: AbortSignal\.timeout\(REPLY_TIMEOUT_MS\)/);
});

test('index.html に生成のレイテンシと返答の場所がある', async () => {
  const html = await read('index.html');
  for (const id of ['llm-gen-ms', 'jev-gen-ms', 'llm-reply', 'jev-reply']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} が無い`);
  }
});

test('index.html から記録された返答と自己申告が消えている', async () => {
  const html = await read('index.html');
  assert.doesNotMatch(html, /turn-agent/);
  assert.doesNotMatch(html, /self-report/);
  assert.doesNotMatch(html, /自己申告/);
  // 手入力は user の発言の1欄だけ。
  assert.doesNotMatch(html, /manual-agent/);
});

test('ずれの見出しは「L1 距離」と書かない', async () => {
  const html = await read('index.html');
  assert.doesNotMatch(html, /L1/);
  assert.match(html, /判定のずれ/);
});

test('返答の枠は溢れずに収まる', async () => {
  const css = await read('style.css');
  // 生成文はパネルで一番長い。折り返しと縦スクロールが無いと3カラムを崩す。
  assert.match(css, /\.reply \{[^}]*overflow-y: auto/s);
  assert.match(css, /\.reply \{[^}]*white-space: pre-wrap/s);
  assert.match(css, /@media \(max-width: 900px\)/);
});

test('ターン移動 (prev/next) は判定を実行しない', async () => {
  const source = await read('app.js');
  // 実行系だった旧関数名が残っていれば、ボタンがまだそれを呼んでいる可能性がある。
  assert.doesNotMatch(source, /showTurn/);
  assert.match(source, /loadTurn\(state\.index - 1\)/);
  assert.match(source, /loadTurn\(state\.index \+ 1\)/);

  const match = source.match(/function loadTurn\(index\) \{[\s\S]*?\n\}\n/);
  assert.ok(match, 'loadTurn の定義が見つからない');
  // 読み込むだけなので、この関数の中に fetch や実行系の呼び出しがあってはならない。
  assert.doesNotMatch(match[0], /fetch\(|runTurn\(/);
});

test('送信は中央のテキスト欄の中身を実行する唯一の経路', async () => {
  const source = await read('app.js');
  assert.match(source, /el\('compose'\)\.addEventListener\('submit'/);
  assert.match(source, /el\('turn-user'\)\.value\.trim\(\)/);
});

test('中央の入力欄は1つに統合されている（表示用と手入力用が分かれていない）', async () => {
  const html = await read('index.html');
  assert.doesNotMatch(html, /id="manual"/);
  assert.doesNotMatch(html, /id="manual-user"/);
  assert.doesNotMatch(html, /id="manual-submit"/);
  assert.match(html, /id="turn-user"/);
  assert.match(html, /id="compose"/);
  assert.equal((html.match(/<textarea/g) ?? []).length, 1, 'textarea が1つではない');
});

test('送信ボタンの文言は「メッセージを送信」', async () => {
  const html = await read('index.html');
  assert.match(html, /id="send"[^>]*>メッセージを送信</);
});

test('軸ゲージの見出しは「◯◯ が返した感情の変動値」の形式', async () => {
  const html = await read('index.html');
  assert.match(html, /LLM が返した感情の変動値/);
  assert.match(html, /jev が返した感情の変動値/);
});

test('両パネルの下部に判定の生の入出力を出す場所がある', async () => {
  const html = await read('index.html');
  for (const id of ['llm-raw-req', 'llm-raw-res', 'jev-raw-req', 'jev-raw-res']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} が無い`);
  }
  // 参照用なのでパネルの一番下。返答より前に置くと、主役を押し下げる。
  for (const side of ['llm', 'jev']) {
    const panel = html.slice(html.indexOf(`id="panel-${side}"`));
    assert.ok(
      panel.indexOf(`id="${side}-reply"`) < panel.indexOf(`id="${side}-raw-req"`),
      `${side}: 生の入出力が返答より上にある`,
    );
  }
});

test('生の入出力は畳まずに常に表示する', async () => {
  const html = await read('index.html');
  // 開いた時点で中身が読める状態にする。
  assert.doesNotMatch(html, /<details/);
  assert.doesNotMatch(html, /<summary/);
  assert.equal((html.match(/<div class="raw">/g) ?? []).length, 2);
  // 入力と出力はどちらがどちらか分かるようにする。
  assert.equal((html.match(/モデルに渡した内容/g) ?? []).length, 2);
  assert.equal((html.match(/返ってきた内容/g) ?? []).length, 2);
});

test('生の入出力の枠は高さ固定で、溢れずに収まる', async () => {
  const css = await read('style.css');
  // JSON は1行が長い。折り返しと縦スクロールが無いと3カラムを崩す。
  assert.match(css, /\.io \{[^}]*white-space: pre-wrap/s);
  assert.match(css, /\.io \{[^}]*overflow-wrap: anywhere/s);
  // 高さを固定しないと、常時表示では中身の長さでパネルの丈が毎ターン変わる。
  assert.match(css, /\.io \{[^}]*\n\s*height: /s);
  assert.match(css, /\.io \{[^}]*overflow: auto/s);
});

test('生表示に出すのは判定の入出力だけ。返答生成の入出力は出さない', async () => {
  const source = await read('app.js');
  assert.match(source, /function renderRaw\(side, result\)/);
  assert.match(source, /result\.request/);
  assert.match(source, /result\.response/);
  // 判定の描画からだけ呼ぶ。
  const renderSide = source.match(/function renderSide\(side, result\) \{[\s\S]*?\n\}\n/);
  assert.ok(renderSide, 'renderSide の定義が見つからない');
  assert.match(renderSide[0], /renderRaw\(side, result\)/);
  // 生成の描画は触らない。
  const renderReply = source.match(/function renderReply\(side, outcome\) \{[\s\S]*?\n\}\n/);
  assert.ok(renderReply, 'renderReply の定義が見つからない');
  assert.doesNotMatch(renderReply[0], /raw/);
});

test('ターンの開始で前ターンの生の入出力を消す', async () => {
  const source = await read('app.js');
  const clearSide = source.match(/function clearSide\(side\) \{[\s\S]*?\n\}\n/);
  assert.ok(clearSide, 'clearSide の定義が見つからない');
  // 残すと、失敗したターンで前ターンの JSON がこのターンの入出力として読める。
  assert.match(clearSide[0], /raw-req/);
  assert.match(clearSide[0], /raw-res/);
});

test('自動再生ボタンは自動で送信することが分かる表記になっている', async () => {
  const html = await read('index.html');
  assert.match(html, /id="play"[^>]*>[^<]*自動送信/);
});

test('人格の選択肢は src/constants.ts の PERSONAS と一致する', async () => {
  const html = await read('index.html');
  const select = html.match(/<select id="persona"[\s\S]*?<\/select>/);
  assert.ok(select, 'index.html に人格の選択欄が無い');
  const options = [...select[0].matchAll(/<option value="([^"]+)">([^<]*)<\/option>/g)];
  assert.deepEqual(options.map((m) => m[1]), [...PERSONA_IDS]);
  // 表記もサーバー側の定義に揃える。ずれると、画面の名前と指示文の中身が食い違う。
  assert.deepEqual(options.map((m) => m[2]), PERSONA_IDS.map((id) => PERSONAS[id].label));
});

test('人格の選択はシナリオ選択と同じ場所（topbar）に置く', async () => {
  const html = await read('index.html');
  const topbar = html.slice(html.indexOf('<header class="topbar">'), html.indexOf('</header>'));
  assert.match(topbar, /id="scenario"/);
  assert.match(topbar, /id="persona"/);
});

test('返答生成に人格を送る。両側とも同じ人格', async () => {
  const source = await read('app.js');
  assert.match(source, /body: JSON\.stringify\(\{ user, axes, persona \}\)/);
  // ターンの頭で一度だけ読み、両側の生成に同じ値を渡す。
  const inner = source.match(/async function runTurnInner\(turn\) \{[\s\S]*?\n\}\n/);
  assert.ok(inner, 'runTurnInner の定義が見つからない');
  assert.match(inner[0], /const persona = el\('persona'\)\.value;/);
  assert.equal((inner[0].match(/requestReply\(turn\.user, result\.axes, persona\)/g) ?? []).length, 1);
});

test('判定には人格を送らない', async () => {
  const source = await read('app.js');
  const judge = source.match(/async function judge\(side, turn\) \{[\s\S]*?\n\}\n/);
  assert.ok(judge, 'judge の定義が見つからない');
  assert.doesNotMatch(judge[0], /persona/);
});

test('シナリオを選ぶと、記録時の人格が選ばれる', async () => {
  const source = await read('app.js');
  // ファイル名に friendly / contrarian が入っている。記録時と違う人格で再生すると噛み合わない。
  const pick = source.match(/export function personaForScenario\(id\) \{[\s\S]*?\n\}\n/);
  assert.ok(pick, 'personaForScenario の定義が見つからない');
  assert.match(pick[0], /contrarian/);
  assert.match(pick[0], /friendly/);
  const loader = source.match(/async function loadScenario\(id\) \{[\s\S]*?\n\}\n/);
  assert.ok(loader, 'loadScenario の定義が見つからない');
  assert.match(loader[0], /el\('persona'\)\.value = personaForScenario\(id\)/);
  // 選ぶだけ。ここで実行してはいけない。
  assert.doesNotMatch(loader[0], /runTurn\(/);
});

test('実データのシナリオ名はすべて人格に対応づく', async () => {
  const { readdir } = await import('node:fs/promises');
  const files = (await readdir(new URL('../data/transcripts', import.meta.url)))
    .filter((f) => f.endsWith('.jsonl'));
  assert.ok(files.length > 0);
  for (const file of files) {
    const hit = PERSONA_IDS.filter((id) => file.includes(id));
    assert.equal(hit.length, 1, `${file}: 人格が一意に決まらない`);
  }
});

test('判定が飛行中は人格も凍らせる', async () => {
  const source = await read('app.js');
  const update = source.match(/function updateProgress\(\) \{[\s\S]*?\n\}\n/);
  assert.ok(update, 'updateProgress の定義が見つからない');
  // 途中で変えられると、画面の選択と実際に生成に渡った人格が食い違う。
  assert.match(update[0], /el\('persona'\)\.disabled = state\.busy;/);
});
