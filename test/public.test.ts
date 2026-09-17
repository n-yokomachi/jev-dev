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
