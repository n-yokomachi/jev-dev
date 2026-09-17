import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Axis, AxisMap } from './constants.ts';

const execFileAsync = promisify(execFile);

export interface AffectusEnv {
  bin: string;
  config: string;
  state: string;
}

export type Runner = (bin: string, args: string[]) => Promise<string>;

export const execRunner: Runner = async (bin, args) => {
  const { stdout } = await execFileAsync(bin, args);
  return stdout;
};

function globalArgs(env: AffectusEnv): string[] {
  return ['--config', env.config, '--state', env.state];
}

export function parseAxes(stdout: string): AxisMap {
  return JSON.parse(stdout.trim()) as AxisMap;
}

export async function init(
  env: AffectusEnv,
  force = false,
  runner: Runner = execRunner,
): Promise<void> {
  const args = [...globalArgs(env), 'init', '--model', 'plutchik'];
  if (force) args.push('--force');
  await runner(env.bin, args);
}

export async function feel(
  env: AffectusEnv,
  deltas: Partial<Record<Axis, number>>,
  runner: Runner = execRunner,
): Promise<AxisMap> {
  const out = await runner(env.bin, [
    ...globalArgs(env), 'feel', JSON.stringify(deltas),
  ]);
  return parseAxes(out);
}

export async function getAxes(
  env: AffectusEnv,
  runner: Runner = execRunner,
): Promise<AxisMap> {
  const out = await runner(env.bin, [...globalArgs(env), 'get']);
  return parseAxes(out);
}

export async function resetState(
  env: AffectusEnv,
  runner: Runner = execRunner,
): Promise<void> {
  await runner(env.bin, [...globalArgs(env), 'reset']);
}
