import { fileURLToPath } from 'node:url';

export const AXES = [
  'joy', 'acceptance', 'fear', 'surprise',
  'sorrow', 'disgust', 'anger', 'expectancy',
] as const;

export type Axis = (typeof AXES)[number];
export type AxisMap = Record<Axis, number>;

export const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

export const TRANSCRIPT_DIR =
  process.env.TRANSCRIPT_DIR ?? fileURLToPath(new URL('../data/transcripts', import.meta.url));
