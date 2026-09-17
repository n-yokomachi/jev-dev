import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { experimental_evaluate as evaluate, generateObject, generateText } from 'ai';
import {
  AXES, DEFAULT_LLM_MODEL, DEFAULT_PERSONA, LLM_MODELS, PROJECT_ROOT,
  isPersonaId, type AxisMap, type PersonaId,
} from './constants.ts';
import {
  judgeWithJev, judgeWithLlm,
  type EvaluateFn, type GenerateObjectFn, type JudgeOutcome, type TurnInput,
} from './judges.ts';
import {
  generateReply,
  type GenerateTextFn, type ReplyInput, type ReplyOutcome,
} from './reply.ts';
import { feel, getAxes, resetState, type AffectusEnv } from './affectus.ts';
import { HttpError } from './http-error.ts';

export type Side = 'jev' | 'llm';

export interface ServerDeps {
  llmModels: readonly string[];
  defaultLlmModel: string;
  judgeJev: (turn: TurnInput) => Promise<JudgeOutcome>;
  judgeLlm: (turn: TurnInput, model?: string) => Promise<JudgeOutcome>;
  generateReply: (input: ReplyInput) => Promise<ReplyOutcome>;
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'リクエストボディの JSON が不正です');
  }
  // JSON.parse は null もリテラルとして通す。そのまま返すと呼び出し側の
  // プロパティ読み出しが投げ、クライアントの誤りがサーバーの故障として 500 になる。
  if (typeof parsed !== 'object' || parsed === null) {
    throw new HttpError(400, 'リクエストボディは JSON オブジェクトである必要があります');
  }
  return parsed as Record<string, unknown>;
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
  if (typeof user !== 'string') {
    throw new HttpError(400, 'user は必須の文字列です');
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

  // 判定の直前に、その側の現在の感情状態を読む。affectus の agent は毎ターン
  // 自分の状態を読んでから感情の動きを申告するので、入力にも現在値が要る。
  // 読むのは判定の直前でなければならない。読み出し時に減衰が適用されるため、
  // 古い値を使うと実際に適用される状態とずれる。
  const currentAxes = await deps.readAffectus(side);
  const turn: TurnInput = { user, axes: currentAxes };
  const outcome = side === 'jev'
    ? await deps.judgeJev(turn)
    : await deps.judgeLlm(turn, model);
  const axes = await deps.applyToAffectus(side, outcome.deltas);
  // outcome には request / response が入っており、そのまま画面の生表示になる。
  sendJson(res, 200, { ...outcome, axes });
}

/**
 * 生成に渡す感情状態を検証する。欠けた軸を 0 で埋めない。
 * 0 は「その次元の不在」という別の状態であり、黙って埋めると生成側が
 * 実際とは違う感情を読んだ返答を返す。
 */
function parseAxesBody(value: unknown): AxisMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'axes は8軸の数値を持つオブジェクトです');
  }
  const record = value as Record<string, unknown>;
  const axes = {} as AxisMap;
  for (const axis of AXES) {
    const v = record[axis];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new HttpError(400, `axes に軸 ${axis} の数値がありません`);
    }
    axes[axis] = v;
  }
  return axes;
}

/**
 * 使う人格を選ぶ。未知の名前を黙って既定に落とすと、画面が選んだつもりの人格と
 * 実際に生成に渡った人格が食い違い、返答の差がどこから来たのか読めなくなる。
 * 省略時だけ既定を使う。
 */
function parsePersonaBody(value: unknown): PersonaId {
  if (value === undefined) return DEFAULT_PERSONA;
  if (!isPersonaId(value)) throw new HttpError(400, '未知の人格です');
  return value;
}

/**
 * 返答の生成。判定が返ったあとに走る別フェーズなので、
 * 判定の latencyMs には入らず、自分の latencyMs を持つ。
 */
async function handleReply(
  deps: ServerDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readBody(req);
  const user = body.user;
  if (typeof user !== 'string') {
    throw new HttpError(400, 'user は必須の文字列です');
  }
  const axes = parseAxesBody(body.axes);
  const persona = parsePersonaBody(body.persona);
  sendJson(res, 200, await deps.generateReply({ user, axes, persona }));
}

export function createServer(deps: ServerDeps) {
  return createHttpServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = url.pathname;

        if (req.method === 'POST' && path === '/api/judge/jev') {
          await handleJudge(deps, 'jev', req, res);
          return;
        }
        if (req.method === 'POST' && path === '/api/judge/llm') {
          await handleJudge(deps, 'llm', req, res);
          return;
        }
        if (req.method === 'POST' && path === '/api/reply') {
          await handleReply(deps, req, res);
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
    llmModels: LLM_MODELS,
    defaultLlmModel: DEFAULT_LLM_MODEL,
    judgeJev: (turn) => judgeWithJev(turn, evaluate as unknown as EvaluateFn),
    judgeLlm: (turn, model) =>
      judgeWithLlm(turn, generateObject as unknown as GenerateObjectFn, model ?? DEFAULT_LLM_MODEL),
    generateReply: (input) => generateReply(input, generateText as unknown as GenerateTextFn),
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
