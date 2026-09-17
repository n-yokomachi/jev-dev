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
