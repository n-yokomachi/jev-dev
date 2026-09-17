import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerDeps } from '../src/server.ts';
import { loadScenario } from '../src/transcripts.ts';
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
    generateReply: async () => ({
      model: 'anthropic/claude-haiku-4.5', provider: 'anthropic',
      reply: '……少し、言葉を選ばせてください。', latencyMs: 1180,
      usage: { inputTokens: 520, outputTokens: 64 }, costUsd: 0.00084,
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
    body: JSON.stringify({ user: 'u' }),
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
    body: JSON.stringify({ user: 'u' }),
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

test('判定は user だけで通る。agent は要らない', async () => {
  let seen: unknown;
  const server = createServer(deps({
    judgeJev: async (turn) => {
      seen = turn;
      return {
        model: 'typesafe-ai/jev', provider: 'typesafe-ai', deltas: zeroAxes(), confidence: {},
        rawScore: {}, latencyMs: 1, usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0,
      };
    },
  }));
  const base = await listen(server);
  const res = await fetch(`${base}/api/judge/jev`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: 'u' }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(seen, { user: 'u' });
  shutdown(server);
});

test('POST /api/reply は返答と生成のレイテンシを返す', async () => {
  let seen: unknown;
  const server = createServer(deps({
    generateReply: async (input) => {
      seen = input;
      return {
        model: 'anthropic/claude-haiku-4.5', provider: 'anthropic',
        reply: 'そう、ですか。', latencyMs: 1180,
        usage: { inputTokens: 520, outputTokens: 64 }, costUsd: 0.00084,
      };
    },
  }));
  const base = await listen(server);
  const res = await fetch(`${base}/api/reply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: 'u', axes: { ...zeroAxes(), sorrow: 0.4 } }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.reply, 'そう、ですか。');
  // 生成の時間は判定とは別の数字として返る。
  assert.equal(body.latencyMs, 1180);
  assert.deepEqual(seen, { user: 'u', axes: { ...zeroAxes(), sorrow: 0.4 } });
  shutdown(server);
});

test('POST /api/reply は axes が無ければ 400 で、生成を呼ばない', async () => {
  let called = 0;
  const server = createServer(deps({
    generateReply: async () => { called += 1; throw new Error('呼ばれてはいけない'); },
  }));
  const base = await listen(server);
  const res = await fetch(`${base}/api/reply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: 'u' }),
  });
  assert.equal(res.status, 400);
  assert.equal(called, 0, '生成は呼ばれないこと');
  shutdown(server);
});

test('POST /api/reply は欠けた軸を 0 で埋めずに 400 を返す', async () => {
  const server = createServer(deps());
  const base = await listen(server);
  const partial = { ...zeroAxes() } as Record<string, number>;
  delete partial.disgust;
  const res = await fetch(`${base}/api/reply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: 'u', axes: partial }),
  });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.match(body.error, /disgust/);
  shutdown(server);
});

test('POST /api/reply は axes が配列なら 400 を返す', async () => {
  const server = createServer(deps());
  const base = await listen(server);
  const res = await fetch(`${base}/api/reply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: 'u', axes: [0, 0, 0, 0, 0, 0, 0, 0] }),
  });
  assert.equal(res.status, 400);
  shutdown(server);
});

test('POST /api/reply は user が無ければ 400 を返す', async () => {
  const server = createServer(deps());
  const base = await listen(server);
  const res = await fetch(`${base}/api/reply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ axes: zeroAxes() }),
  });
  assert.equal(res.status, 400);
  shutdown(server);
});

test('POST /api/reply の想定外の失敗は 500 で、内部の詳細を漏らさない', async () => {
  const server = createServer(deps({
    generateReply: async () => {
      throw new Error("ENOENT: no such file or directory, open '/Users/someone/jev-dev/state/jev.json'");
    },
  }));
  const base = await listen(server);
  const res = await quiet(() => fetch(`${base}/api/reply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: 'u', axes: zeroAxes() }),
  }));
  const body = await res.json();
  assert.equal(res.status, 500);
  assert.ok(!body.error.includes('/Users'), `パスが漏れている: ${body.error}`);
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

/** 想定外の失敗は console.error に出る。テスト出力を汚さないよう黙らせる。 */
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

function enoent(path: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(
    `ENOENT: no such file or directory, open '${path}'`,
  );
  error.code = 'ENOENT';
  return error;
}

test('存在しないシナリオは 404 を返し、パスを漏らさない', async () => {
  const server = createServer(deps({
    loadScenario: async () => { throw enoent('/Users/someone/jev-dev/data/transcripts/nope.jsonl'); },
  }));
  const base = await listen(server);
  const res = await fetch(`${base}/api/scenarios/nope`);
  const body = await res.json();
  assert.equal(res.status, 404);
  assert.ok(!body.error.includes('/'), `パスが漏れている: ${body.error}`);
  shutdown(server);
});

test('壊れたシナリオ ID は 400 を返す', async () => {
  const server = createServer(deps({
    loadScenario: async () => { throw new Error('ここには来ないはず'); },
  }));
  const base = await listen(server);
  const res = await fetch(`${base}/api/scenarios/%`);
  assert.equal(res.status, 400);
  shutdown(server);
});

test('パス区切りを含むシナリオ ID は 400 を返す', async () => {
  const server = createServer(deps({ loadScenario }));
  const base = await listen(server);
  const res = await fetch(`${base}/api/scenarios/..%2Fsecret`);
  assert.equal(res.status, 400);
  shutdown(server);
});

test('壊れた JSON ボディは 400 を返す', async () => {
  const server = createServer(deps());
  const base = await listen(server);
  const res = await fetch(`${base}/api/judge/jev`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"user":',
  });
  assert.equal(res.status, 400);
  shutdown(server);
});

test('JSON の null ボディは 400 を返す', async () => {
  const server = createServer(deps());
  const base = await listen(server);
  const res = await fetch(`${base}/api/judge/jev`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'null',
  });
  assert.equal(res.status, 400);
  shutdown(server);
});

test('想定外の失敗は 500 を返し、パスを漏らさない', async () => {
  const server = createServer(deps({
    listScenarios: async () => {
      throw new Error("EACCES: permission denied, scandir '/Users/someone/jev-dev/data/transcripts'");
    },
  }));
  const base = await listen(server);
  const res = await quiet(() => fetch(`${base}/api/scenarios`));
  const body = await res.json();
  assert.equal(res.status, 500);
  assert.ok(!body.error.includes('/Users'), `パスが漏れている: ${body.error}`);
  assert.ok(!body.error.includes('EACCES'), `内部の詳細が漏れている: ${body.error}`);
  shutdown(server);
});

test('llmModels に無いモデルは 400 で、判定を呼ばない', async () => {
  let called = 0;
  const server = createServer(deps({
    judgeLlm: async () => { called += 1; throw new Error('呼ばれてはいけない'); },
  }));
  const base = await listen(server);
  const res = await fetch(`${base}/api/judge/llm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: 'u', model: 'anthropic/claude-opus-5' }),
  });
  assert.equal(res.status, 400);
  assert.equal(called, 0, '判定は呼ばれないこと');
  shutdown(server);
});

test('llmModels にあるモデルはそのまま判定に渡る', async () => {
  let seen: string | undefined = 'まだ';
  const server = createServer(deps({
    judgeLlm: async (_turn, model) => {
      seen = model;
      return {
        model: model ?? '', provider: 'anthropic', deltas: zeroAxes(), confidence: {},
        rawScore: {}, latencyMs: 1, usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0,
      };
    },
  }));
  const base = await listen(server);
  const res = await fetch(`${base}/api/judge/llm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: 'u', model: 'anthropic/claude-sonnet-5' }),
  });
  assert.equal(res.status, 200);
  assert.equal(seen, 'anthropic/claude-sonnet-5');
  shutdown(server);
});
