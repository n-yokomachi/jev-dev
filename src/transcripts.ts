import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Axis, AxisMap } from './constants.ts';

export interface Turn {
  turn: number;
  phase: string;
  user: string;
  agent: string;
  deltas: Partial<Record<Axis, number>>;
  axes: AxisMap;
}

export interface Scenario {
  id: string;
  turns: Turn[];
}

export interface ScenarioSummary {
  id: string;
  turnCount: number;
}

function parseLines(text: string): Turn[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Turn);
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
  if (id.includes('/') || id.includes('\\') || id.includes('..')) {
    throw new Error(`invalid scenario id: ${id}`);
  }
  const text = await readFile(join(dir, `${id}.jsonl`), 'utf8');
  return { id, turns: parseLines(text) };
}
