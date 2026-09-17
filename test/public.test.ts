import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AXES } from '../src/constants.ts';

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

test('判定に送るのは user の発言だけ', async () => {
  const source = await read('app.js');
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

test('自動再生ボタンは自動で送信することが分かる表記になっている', async () => {
  const html = await read('index.html');
  assert.match(html, /id="play"[^>]*>[^<]*自動送信/);
});
