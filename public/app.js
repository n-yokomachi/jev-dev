export const AXES = [
  'joy', 'acceptance', 'fear', 'surprise',
  'sorrow', 'disgust', 'anger', 'expectancy',
];

const WHEEL_COLORS = {
  joy: '#ffd93d',
  acceptance: '#a8e05f',
  fear: '#4caf50',
  surprise: '#4fc3f7',
  sorrow: '#3f51b5',
  disgust: '#9c27b0',
  anger: '#e53935',
  expectancy: '#fb8c00',
};

const SIZE = 132;

export function drawWheel(container, values) {
  const c = SIZE / 2;
  const max = c - 8;
  const parts = [
    `<svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
    `<circle cx="${c}" cy="${c}" r="${max}" fill="none" stroke="#1d2530"/>`,
  ];

  AXES.forEach((axis, i) => {
    const v = Math.min(1, Math.max(0, values[axis] ?? 0));
    const r = 7 + max * v;
    const a1 = ((-90 + i * 45 - 21) * Math.PI) / 180;
    const a2 = ((-90 + i * 45 + 21) * Math.PI) / 180;
    const x1 = (c + r * Math.cos(a1)).toFixed(1);
    const y1 = (c + r * Math.sin(a1)).toFixed(1);
    const x2 = (c + r * Math.cos(a2)).toFixed(1);
    const y2 = (c + r * Math.sin(a2)).toFixed(1);
    parts.push(
      `<path d="M${c},${c} L${x1},${y1} A${r.toFixed(1)},${r.toFixed(1)} 0 0,1 ${x2},${y2} Z" ` +
        `fill="${WHEEL_COLORS[axis]}" fill-opacity="${(0.2 + 0.75 * v).toFixed(2)}"/>`,
    );
  });

  parts.push('</svg>');
  container.innerHTML = parts.join('');
}

const zero = Object.fromEntries(AXES.map((a) => [a, 0]));
drawWheel(document.getElementById('wheel-llm'), zero);
drawWheel(document.getElementById('wheel-jev'), zero);
