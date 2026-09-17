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

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
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
    sendJson(res, 400, { error: 'user と agent は必須の文字列です' });
    return;
  }
  const turn: TurnInput = { user, agent };
  const outcome = side === 'jev'
    ? await deps.judgeJev(turn)
    : await deps.judgeLlm(turn, typeof body.model === 'string' ? body.model : undefined);
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
          const id = decodeURIComponent(path.slice('/api/scenarios/'.length));
          sendJson(res, 200, await deps.loadScenario(deps.transcriptDir, id));
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
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
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
