export const AXES = [
  'joy', 'acceptance', 'fear', 'surprise',
  'sorrow', 'disgust', 'anger', 'expectancy',
] as const;

export type Axis = (typeof AXES)[number];
export type AxisMap = Record<Axis, number>;

export const AFFECTUS_REPO =
  process.env.AFFECTUS_REPO ?? '/Users/Naoki/work/workshop/affectus';

export const TRANSCRIPT_DIR =
  `${AFFECTUS_REPO}/examples/evaluation/_archive/plutchik-direct-20260810/transcripts`;
