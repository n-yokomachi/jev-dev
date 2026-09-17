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
