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

const state = {
  scenario: null,
  index: 0,
  playing: false,
  maxLatency: 1,
  // 直近のレイテンシを両側ぶん保持する。最大値が更新されたとき、
  // 先に描き終えたバーも描き直さないと比率が嘘になるため。
  latency: { llm: null, jev: null },
};

const el = (id) => document.getElementById(id);

function renderGauges(container, deltas, confidence) {
  container.innerHTML = AXES.map((axis) => {
    const v = deltas?.[axis] ?? 0;
    const width = Math.abs(v) * 50;
    const bar = v >= 0
      ? `<b style="left:50%;width:${width}%"></b>`
      : `<b style="right:50%;width:${width}%"></b>`;
    const conf = confidence?.[axis] !== undefined
      ? `<span class="conf" style="left:${50 + (v >= 0 ? 1 : -1) * confidence[axis] * 50}%"></span>`
      : '';
    const sign = v > 0 ? '+' : '';
    return `<div class="axis"><span class="nm">${axis.slice(0, 7)}</span>` +
      `<span class="gauge">${bar}${conf}</span>` +
      `<span class="val">${sign}${v.toFixed(2)}</span></div>`;
  }).join('');
}

function renderSide(side, result) {
  el(`panel-${side}`).classList.remove('pending');
  el(`${side}-model`).textContent = `${result.model} · ${result.provider}`;
  el(`${side}-ms`).innerHTML = `${result.latencyMs.toLocaleString()}<span>ms</span>`;
  el(`${side}-tok`).textContent =
    `${result.usage.inputTokens} / ${result.usage.outputTokens} tok`;
  el(`${side}-cost`).textContent = `$${result.costUsd.toFixed(6)}`;
  state.latency[side] = result.latencyMs;
  state.maxLatency = Math.max(state.maxLatency, result.latencyMs);
  redrawTracks();
  renderGauges(el(`${side}-gauges`), result.deltas, result.confidence);
  drawWheel(el(`wheel-${side}`), result.axes);
}

/** 両側のバーを現在の最大値で描き直す。片側だけ更新すると比率がずれる。 */
function redrawTracks() {
  for (const side of ['llm', 'jev']) {
    const ms = state.latency[side];
    el(`${side}-track`).style.width =
      ms === null ? '0%' : `${(ms / state.maxLatency) * 100}%`;
  }
}

/** ターンごとの表示だけを消す。輪は affectus の蓄積状態なので残す。 */
function clearSide(side) {
  state.latency[side] = null;
  el(`${side}-model`).textContent = '—';
  el(`${side}-ms`).innerHTML = '—<span>ms</span>';
  el(`${side}-tok`).textContent = '— tok';
  el(`${side}-cost`).textContent = '—';
  el(`${side}-gauges`).innerHTML = '';
  redrawTracks();
}

function l1(a, b) {
  return AXES.reduce((sum, axis) => sum + Math.abs((a?.[axis] ?? 0) - (b?.[axis] ?? 0)), 0);
}

async function judge(side, turn) {
  const body = side === 'llm' ? { ...turn, model: el('llm-pick').value } : turn;
  const res = await fetch(`/api/judge/${side}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * 表示中のターンの世代。next 連打などで runTurn が重なったとき、
 * 古い方の結果が新しいターンの会話文の隣に描かれるのを防ぐ。
 */
let generation = 0;

async function runTurn(turn) {
  const gen = ++generation;
  el('turn-user').textContent = turn.user;
  el('turn-agent').textContent = turn.agent;
  el('self-report').textContent = turn.deltas
    ? `当時の自己申告：${Object.entries(turn.deltas)
        .map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${v}`)
        .join(' / ')}`
    : '当時の自己申告：—';
  el('l1').textContent = '—';
  for (const side of ['llm', 'jev']) {
    el(`panel-${side}`).classList.add('pending');
    clearSide(side);
  }

  const results = {};
  const both = ['llm', 'jev'].map((side) =>
    judge(side, { user: turn.user, agent: turn.agent })
      .then((result) => {
        if (gen !== generation) return; // 古いターンの結果は捨てる
        results[side] = result;
        renderSide(side, result);
      })
      .catch((error) => {
        if (gen !== generation) return;
        el(`panel-${side}`).classList.remove('pending');
        el(`${side}-model`).textContent = `error: ${error.message}`;
        // 数値はターン開始時に消してあるので、失敗しても前ターンの値は残らない
      }),
  );

  await Promise.allSettled(both);
  if (gen !== generation) return;
  if (results.llm && results.jev) {
    el('l1').textContent = l1(results.llm.deltas, results.jev.deltas).toFixed(2);
  }
}

function updateProgress() {
  const total = state.scenario?.turns.length ?? 0;
  el('progress').textContent = `turn ${total ? state.index + 1 : '—'} / ${total || '—'}`;
  el('prev').disabled = state.index <= 0;
  el('next').disabled = !state.scenario || state.index >= total - 1;
}

async function showTurn(index) {
  if (!state.scenario) return;
  state.index = Math.min(Math.max(0, index), state.scenario.turns.length - 1);
  updateProgress();
  await runTurn(state.scenario.turns[state.index]);
}

async function loadScenario(id) {
  const res = await fetch(`/api/scenarios/${encodeURIComponent(id)}`);
  state.scenario = await res.json();
  state.index = 0;
  updateProgress();
}

/**
 * 再生の世代。await 中のループが復帰したとき、自分がまだ現役かを判断するのに使う。
 * これが無いと、シナリオ切替で止めた直後に再生を押し直したとき、
 * 中断中だった古いループが state.playing の true を見て生き返り、二重に進む。
 */
let playRun = 0;

async function play() {
  if (state.playing) {
    // 走行中なら止めるだけ。世代を進めて、await 中のループを失効させる。
    state.playing = false;
    playRun += 1;
    el('play').textContent = '▶';
    return;
  }

  const run = ++playRun;
  state.playing = true;
  el('play').textContent = '❙❙';

  while (
    run === playRun &&
    state.playing &&
    state.scenario &&
    state.index < state.scenario.turns.length
  ) {
    await showTurn(state.index);
    if (run !== playRun || !state.playing) break;
    if (state.index >= state.scenario.turns.length - 1) break;
    state.index += 1;
  }

  // 自分が現役のときだけ後片付けする。失効した古いループが
  // 現役のループの状態やボタン表示を壊さないようにするため。
  if (run === playRun) {
    state.playing = false;
    el('play').textContent = '▶';
  }
}

el('prev').addEventListener('click', () => showTurn(state.index - 1));
el('next').addEventListener('click', () => showTurn(state.index + 1));
el('play').addEventListener('click', play);

el('reset').addEventListener('click', async () => {
  await fetch('/api/reset', { method: 'POST' });
  const zero = Object.fromEntries(AXES.map((a) => [a, 0]));
  drawWheel(el('wheel-llm'), zero);
  drawWheel(el('wheel-jev'), zero);
  state.maxLatency = 1;
  for (const side of ['llm', 'jev']) clearSide(side);
});

el('scenario').addEventListener('change', async (event) => {
  // 再生中にシナリオを変えられたら止める。止めないと古い index のまま
  // 新シナリオを勝手に進み続け、再生ボタンの表示とも食い違う。
  state.playing = false;
  playRun += 1; // await 中の再生ループを失効させる
  el('play').textContent = '▶';
  await loadScenario(event.target.value);
});

el('manual').addEventListener('submit', async (event) => {
  event.preventDefault();
  await runTurn({ user: el('manual-user').value, agent: el('manual-agent').value, deltas: null });
});

const initial = Object.fromEntries(AXES.map((a) => [a, 0]));
drawWheel(el('wheel-llm'), initial);
drawWheel(el('wheel-jev'), initial);

const { models, default: defaultModel } = await (await fetch('/api/models')).json();
el('llm-pick').innerHTML = models
  .map((m) => `<option value="${m}">${m.replace('anthropic/', '')}</option>`)
  .join('');
el('llm-pick').value = defaultModel;

const scenarios = await (await fetch('/api/scenarios')).json();
el('scenario').innerHTML = scenarios
  .map((s) => `<option value="${s.id}">${s.id}</option>`)
  .join('');
if (scenarios.length > 0) await loadScenario(scenarios[0].id);
