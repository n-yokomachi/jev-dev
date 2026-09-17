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
