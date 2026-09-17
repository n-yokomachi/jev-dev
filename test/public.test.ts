import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AXES } from '../src/constants.ts';

/**
 * public/app.js はブラウザ向けのモジュールで Node からは import できない。
 * 軸の定義がサーバー側と食い違うと、順序違いのゲージや欠けた花弁として
 * 画面にだけ現れる。テキストとして読み、リテラルを突き合わせる。
 */
test('public/app.js の AXES は src/constants.ts と同じ並び', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const match = source.match(/export const AXES = \[([^\]]*)\]/);
  assert.ok(match, 'app.js に AXES のリテラルが見つからない');
  const axes = [...match[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(axes, [...AXES]);
});
