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
