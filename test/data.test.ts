import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROJECT_ROOT } from '../src/constants.ts';

test('PROJECT_ROOT は cwd に依存しない絶対パス', () => {
  assert.ok(PROJECT_ROOT.startsWith('/'), PROJECT_ROOT);
});
