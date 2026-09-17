import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { experimental_evaluate as evaluate, generateObject } from 'ai';
import { DEFAULT_LLM_MODEL, LLM_MODELS, PROJECT_ROOT, TRANSCRIPT_DIR, type AxisMap } from './constants.ts';
import { listScenarios, loadScenario, type Scenario, type ScenarioSummary } from './transcripts.ts';
import {
  judgeWithJev, judgeWithLlm,
  type EvaluateFn, type GenerateObjectFn, type JudgeOutcome, type TurnInput,
} from './judges.ts';
import { feel, getAxes, resetState, type AffectusEnv } from './affectus.ts';
import { HttpError } from './http-error.ts';

export type Side = 'jev' | 'llm';

export interface ServerDeps {
  transcriptDir: string;
  llmModels: readonly string[];
  defaultLlmModel: string;
  listScenarios: (dir: string) => Promise<ScenarioSummary[]>;
  loadScenario: (dir: string, id: string) => Promise<Scenario>;
  judgeJev: (turn: TurnInput) => Promise<JudgeOutcome>;
  judgeLlm: (turn: TurnInput, model?: string) => Promise<JudgeOutcome>;
  applyToAffectus: (side: Side, deltas: AxisMap) => Promise<AxisMap>;
  readAffectus: (side: Side) => Promise<AxisMap>;
  resetAffectus: (side: Side) => Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'リクエストボディの JSON が不正です');
  }
}

async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
  const rel = pathname === '/' ? 'index.html' : normalize(pathname).replace(/^(\.\.[/\\])+/, '').replace(/^\//, '');
  try {
    const file = await readFile(join(PROJECT_ROOT, 'public', rel));
    res.writeHead(200, { 'content-type': MIME[extname(rel)] ?? 'application/octet-stream' });
    res.end(file);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}

async function loadScenarioOrFail(deps: ServerDeps, encodedId: string): Promise<Scenario> {
  let id: string;
  try {
    id = decodeURIComponent(encodedId);
  } catch {
    throw new HttpError(400, 'シナリオ ID が不正です');
  }
  try {
    return await deps.loadScenario(deps.transcriptDir, id);
  } catch (error) {
    // ファイルが無いのは「見つからない」であってサーバーの故障ではない。
    // ENOENT の message には絶対パスが載るので、そのままでは返さない。
    if (errnoCode(error) === 'ENOENT') throw new HttpError(404, 'シナリオが見つかりません');
    throw error;
  }
}

async function handleJudge(
  deps: ServerDeps,
  side: Side,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readBody(req);
  const user = body.user;
  const agent = body.agent;
  if (typeof user !== 'string' || typeof agent !== 'string') {
    throw new HttpError(400, 'user と agent は必須の文字列です');
  }

  let model: string | undefined;
  if (side === 'llm' && body.model !== undefined) {
    // 未知のモデル名を Gateway に素通しすると、課金される呼び出しを終えたあとで
    // costUsd が単価表に無いと言って落ちる。呼ぶ前に弾く。
    if (typeof body.model !== 'string' || !deps.llmModels.includes(body.model)) {
      throw new HttpError(400, '未知のモデルです');
    }
    model = body.model;
  }

  const turn: TurnInput = { user, agent };
  const outcome = side === 'jev'
    ? await deps.judgeJev(turn)
    : await deps.judgeLlm(turn, model);
  const axes = await deps.applyToAffectus(side, outcome.deltas);
  sendJson(res, 200, { ...outcome, axes });
}

export function createServer(deps: ServerDeps) {
  return createHttpServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = url.pathname;

        if (req.method === 'GET' && path === '/api/scenarios') {
          sendJson(res, 200, await deps.listScenarios(deps.transcriptDir));
          return;
        }
        if (req.method === 'GET' && path.startsWith('/api/scenarios/')) {
          sendJson(res, 200, await loadScenarioOrFail(deps, path.slice('/api/scenarios/'.length)));
          return;
        }
        if (req.method === 'POST' && path === '/api/judge/jev') {
          await handleJudge(deps, 'jev', req, res);
          return;
        }
        if (req.method === 'POST' && path === '/api/judge/llm') {
          await handleJudge(deps, 'llm', req, res);
          return;
        }
        if (req.method === 'GET' && path === '/api/models') {
          sendJson(res, 200, { models: deps.llmModels, default: deps.defaultLlmModel });
          return;
        }
        if (req.method === 'GET' && path === '/api/state') {
          sendJson(res, 200, { jev: await deps.readAffectus('jev'), llm: await deps.readAffectus('llm') });
          return;
        }
        if (req.method === 'POST' && path === '/api/reset') {
          await deps.resetAffectus('jev');
          await deps.resetAffectus('llm');
          sendJson(res, 200, { ok: true });
          return;
        }
        if (req.method === 'GET' && !path.startsWith('/api/')) {
          await serveStatic(res, path);
          return;
        }
        sendJson(res, 404, { error: 'not found' });
      } catch (error) {
        if (error instanceof HttpError) {
          sendJson(res, error.status, { error: error.message });
          return;
        }
        // 想定外の失敗。message には絶対パスなどの内部情報が入りうるため、
        // クライアントには固定文言だけを返し、実体はサーバー側のログに残す。
        console.error(error);
        sendJson(res, 500, { error: 'サーバー内部でエラーが発生しました' });
      }
    })();
  });
}

function envFor(side: Side): AffectusEnv {
  return {
    bin: join(PROJECT_ROOT, 'bin', 'affectus'),
    config: join(PROJECT_ROOT, 'state', 'config.yaml'),
    state: join(PROJECT_ROOT, 'state', `${side}.json`),
  };
}

export function productionDeps(): ServerDeps {
  return {
    transcriptDir: TRANSCRIPT_DIR,
    llmModels: LLM_MODELS,
    defaultLlmModel: DEFAULT_LLM_MODEL,
    listScenarios,
    loadScenario,
    judgeJev: (turn) => judgeWithJev(turn, evaluate as unknown as EvaluateFn),
    judgeLlm: (turn, model) =>
      judgeWithLlm(turn, generateObject as unknown as GenerateObjectFn, model ?? DEFAULT_LLM_MODEL),
    applyToAffectus: (side, deltas) => feel(envFor(side), deltas),
    readAffectus: (side) => getAxes(envFor(side)),
    resetAffectus: (side) => resetState(envFor(side)),
  };
}

if (process.argv[1]?.endsWith('server.ts')) {
  const port = Number(process.env.PORT ?? 8787);
  createServer(productionDeps()).listen(port, () => {
    console.log(`listening on http://localhost:${port}`);
  });
}
