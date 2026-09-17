import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpError } from './http-error.ts';

/**
 * 画面と判定が使うターン。JSONL には記録された返答（agent）と当時の自己申告
 * （deltas / axes）も入っているが、どちらも判定の入力にも画面にも使わないので持たない。
 */
export interface Turn {
  turn: number;
  phase: string;
  user: string;
}

export interface Scenario {
  id: string;
  turns: Turn[];
}

export interface ScenarioSummary {
  id: string;
  turnCount: number;
}

/**
 * 使う項目だけに落とす。読み捨てた項目を API の応答に載せたままにすると、
 * 「画面に出さない」と決めたものを画面がまた拾える状態が残る。
 * data/transcripts のファイル自体には手を入れない。
 */
function parseLines(text: string): Turn[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const row = JSON.parse(line) as Turn;
      return { turn: row.turn, phase: row.phase, user: row.user };
    });
}

export async function listScenarios(dir: string): Promise<ScenarioSummary[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort();
  const out: ScenarioSummary[] = [];
  for (const file of files) {
    const text = await readFile(join(dir, file), 'utf8');
    out.push({ id: file.replace(/\.jsonl$/, ''), turnCount: parseLines(text).length });
  }
  return out;
}

export async function loadScenario(dir: string, id: string): Promise<Scenario> {
  // status の分担: ここが決めるのは不正な id の 400 だけ。ファイルが無い場合は
  // readFile の ENOENT をそのまま投げ、404 への変換は呼び出し側の server.ts が持つ。
  // 受け取った id をそのまま返さない。要求が不正だという事実だけを伝える。
  if (id.includes('/') || id.includes('\\') || id.includes('..')) {
    throw new HttpError(400, 'invalid scenario id');
  }
  const text = await readFile(join(dir, `${id}.jsonl`), 'utf8');
  return { id, turns: parseLines(text) };
}
