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
    // 中心の最小半径 7 から、値 1.0 でちょうど目安の円（半径 max）に届く。
    // 7 + max * v にすると 1.0 で円を 7px はみ出し、円が「満杯」を意味しなくなる。
    const r = 7 + (max - 7) * v;
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
  // 判定が飛行中かどうか。飛行中に別のターンを始めさせない。
  // 捨てた判定のデルタもサーバー側では affectus に適用済みで、
  // 見ていないターンのぶんが輪に積み上がり、課金も重複するため。
  busy: false,
  maxLatency: 1,
  // 直近のレイテンシを両側ぶん保持する。最大値が更新されたとき、
  // 先に描き終えたバーも描き直さないと比率が嘘になるため。
  latency: { llm: null, jev: null },
};

const el = (id) => document.getElementById(id);

/** 画面に出す失敗の通知。console だけだと何も起きていないように見えるため。 */
function showError(message) {
  const box = el('notice');
  box.textContent = message;
  box.hidden = false;
}

function clearNotice() {
  el('notice').hidden = true;
}

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
  renderRaw(side, result);
  drawWheel(el(`wheel-${side}`), result.axes);
}

/** 応答に入っていなければ、空の JSON ではなく欠落と分かる表示にする。 */
function formatJson(value) {
  return value === undefined ? '—' : JSON.stringify(value, null, 2);
}

/**
 * 判定の生の入出力。何を渡して何が返ったかを画面で確かめられるようにする。
 * 対象は判定だけで、返答生成の入出力は出さない。
 */
function renderRaw(side, result) {
  el(`${side}-raw-req`).textContent = formatJson(result.request);
  el(`${side}-raw-res`).textContent = formatJson(result.response);
}

/** 両側のバーを現在の最大値で描き直す。片側だけ更新すると比率がずれる。 */
function redrawTracks() {
  for (const side of ['llm', 'jev']) {
    const ms = state.latency[side];
    el(`${side}-track`).style.width =
      ms === null ? '0%' : `${(ms / state.maxLatency) * 100}%`;
  }
}

/** 生成された返答を出す。判定とは別の数字として、生成のレイテンシも並べる。 */
function renderReply(side, outcome) {
  el(`${side}-gen-ms`).innerHTML = `${outcome.latencyMs.toLocaleString()}<span>ms</span>`;
  const box = el(`${side}-reply`);
  box.classList.remove('empty', 'failed');
  box.textContent = outcome.reply;
}

/** 生成の失敗はパネルに出す。出さないと、生成待ちのまま止まったのと区別が付かない。 */
function showReplyFailure(side, message) {
  const box = el(`${side}-reply`);
  box.classList.remove('empty');
  box.classList.add('failed');
  box.textContent = `生成に失敗しました: ${message}`;
}

/** ターンごとの表示だけを消す。輪は affectus の蓄積状態なので残す。 */
function clearSide(side) {
  state.latency[side] = null;
  el(`${side}-model`).textContent = '—';
  el(`${side}-ms`).innerHTML = '—<span>ms</span>';
  el(`${side}-tok`).textContent = '— tok';
  el(`${side}-cost`).textContent = '—';
  el(`${side}-gauges`).innerHTML = '';
  // 生の入出力も消す。残すと、失敗したターンで前ターンの JSON が
  // このターンの入出力として読める。開閉の状態は触らない。
  el(`${side}-raw-req`).textContent = '—';
  el(`${side}-raw-res`).textContent = '—';
  el(`${side}-gen-ms`).innerHTML = '—<span>ms</span>';
  const reply = el(`${side}-reply`);
  reply.classList.remove('failed');
  reply.classList.add('empty');
  reply.textContent = '—';
  redrawTracks();
}

function l1(a, b) {
  return AXES.reduce((sum, axis) => sum + Math.abs((a?.[axis] ?? 0) - (b?.[axis] ?? 0)), 0);
}

/** 輪に渡せる形か。null も配列も軸の値として読めない。 */
function isAxisMap(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * サーバーの感情状態を読んで両方の輪を描く。
 * 状態はファイルに永続するので、ゼロから描き始めると次の判定が返った瞬間に
 * 蓄積値へ飛び、初期表示が状態を偽ることになる。
 *
 * gen は呼び出した時点の世代。既定は呼び出し時の generation。
 * 読んでいる間に新しいターンが輪を描いていたら、古い値で描き直さない。
 */
async function drawStateWheels(gen = generation) {
  const res = await fetch('/api/state');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const current = await res.json();
  // 形も見る。欠けたまま drawWheel に渡すと values[axis] の読み出しで例外になり、
  // 何が足りなかったのか分からない失敗として上がる。
  // ここで投げれば、呼び出し側が通知に理由を出し、輪はゼロのまま残る。
  if (!isAxisMap(current?.jev) || !isAxisMap(current?.llm)) {
    throw new Error('応答に jev と llm の感情状態が入っていません');
  }
  if (gen !== generation) return;
  drawWheel(el('wheel-llm'), current.llm);
  drawWheel(el('wheel-jev'), current.jev);
}

/**
 * 判定1本を待つ上限。これを超えたら失敗として扱う。
 * 上限が無いと、応答が返らないまま state.busy が立ち続け、
 * prev / next / 手入力がリロードするまで戻らなくなる。
 * 比較する両モデルは数百ミリ秒から数秒で返るので、正常に遅い判定がここに掛かることはない。
 */
const JUDGE_TIMEOUT_MS = 60_000;

/**
 * 生成1本を待つ上限。判定と同じ理由で置く。
 * 生成は判定のあとに走るので、上限が無ければ state.busy が生成で立ち続ける。
 */
const REPLY_TIMEOUT_MS = 60_000;

/** タイムアウトの message は "signal timed out" で、そのままでは何が起きたか伝わらない。 */
function describeFailure(error, limitMs) {
  if (error.name === 'TimeoutError') {
    return new Error(`${limitMs / 1000}秒待っても応答がありません`);
  }
  return error;
}

async function judge(side, turn) {
  // 選択肢の取得に失敗していれば model を送らず、サーバーの既定に任せる。
  // 空文字を送るとサーバーが未知のモデルとして 400 で弾く。
  const model = el('llm-pick').value;
  const body = side === 'llm' && model ? { ...turn, model } : turn;
  try {
    const res = await fetch(`/api/judge/${side}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (error) {
    throw describeFailure(error, JUDGE_TIMEOUT_MS);
  }
}

/**
 * 判定を適用したあとの感情状態で返答を生成する。
 * 判定が返ってから呼ぶ別フェーズであり、判定のレイテンシには入らない。
 */
async function requestReply(user, axes) {
  try {
    const res = await fetch('/api/reply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user, axes }),
      signal: AbortSignal.timeout(REPLY_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (error) {
    throw describeFailure(error, REPLY_TIMEOUT_MS);
  }
}

/**
 * 表示中のターンの世代。自動再生や送信の連続実行で runTurn が重なったとき、
 * 古い方の結果が新しいターンの会話文の隣に描かれるのを防ぐ。
 */
let generation = 0;

async function runTurn(turn) {
  setBusy(true);
  try {
    await runTurnInner(turn);
  } finally {
    // 失敗しても必ず解除する。解除し損ねると操作が二度と戻らない。
    setBusy(false);
  }
}

async function runTurnInner(turn) {
  const gen = ++generation;
  clearNotice();
  // 発言は入力欄の中身がそのまま入力になる。ここでは書き戻さない。
  el('l1').textContent = '—';
  for (const side of ['llm', 'jev']) {
    el(`panel-${side}`).classList.add('pending');
    clearSide(side);
  }

  const results = {};
  // 送るのは user の発言だけ。判定の入力に入る現在の8軸は、サーバーが判定の直前に
  // その側の状態から読む。ブラウザが持ち回ると、送信までの間に減衰した古い値を渡すことになる。
  const both = ['llm', 'jev'].map(async (side) => {
    let result;
    try {
      result = await judge(side, { user: turn.user });
    } catch (error) {
      if (gen !== generation) return;
      el(`panel-${side}`).classList.remove('pending');
      el(`${side}-model`).textContent = `error: ${error.message}`;
      // 数値はターン開始時に消してあるので、失敗しても前ターンの値は残らない
      return;
    }
    if (gen !== generation) return; // 古いターンの結果は捨てる
    results[side] = result;
    renderSide(side, result);
    // ずれは判定が出揃った時点で出す。生成の完了まで待たせると、
    // 判定の比較が生成の分だけ遅れて出ることになる。
    if (results.llm && results.jev) {
      el('l1').textContent = l1(results.llm.deltas, results.jev.deltas).toFixed(2);
    }

    // 判定を適用したあとの感情状態で返答を作る。ここから先は別フェーズ。
    try {
      const outcome = await requestReply(turn.user, result.axes);
      if (gen !== generation) return;
      renderReply(side, outcome);
    } catch (error) {
      if (gen !== generation) return;
      showReplyFailure(side, error.message);
    }
  });

  // 生成まで含めて待つ。待たないと state.busy が判定だけで解除され、
  // 生成の最中に次のターンが始まる。
  await Promise.allSettled(both);
}

function updateProgress() {
  const total = state.scenario?.turns.length ?? 0;
  el('progress').textContent = `turn ${total ? state.index + 1 : '—'} / ${total || '—'}`;
  el('prev').disabled = state.busy || state.index <= 0;
  el('next').disabled = state.busy || !state.scenario || state.index >= total - 1;
  el('send').disabled = state.busy;
  // 飛行中は入力欄も凍らせる。書き換えても、走っているのは押した時点の中身であり、
  // 画面の文と実際に判定された文が食い違う。
  el('turn-user').disabled = state.busy;
  // reset とシナリオ切替も飛行中は殺す。世代を進めて結果を捨てても、
  // サーバー側では affectus に適用済みで、見ていないターンのぶんが輪に積み上がるため。
  el('reset').disabled = state.busy;
  el('scenario').disabled = state.busy;
  // 走行中の再生を止める操作だけは飛行中でも受け付けるので、そのときは殺さない。
  el('play').disabled = state.busy && !state.playing;
}

/** 飛行中かどうかを更新し、ボタンの活殺に反映する。黙ってクリックを無視しないため。 */
function setBusy(value) {
  state.busy = value;
  updateProgress();
}

/**
 * ターン移動。そのターンの user 発言をテキスト欄に読み込むだけで、API は叩かない。
 * 実行の起点は送信ボタンだけなので、ここでは affectus にも課金にも触れない。
 */
function loadTurn(index) {
  if (!state.scenario) return;
  state.index = Math.min(Math.max(0, index), state.scenario.turns.length - 1);
  el('turn-user').value = state.scenario.turns[state.index].user;
  updateProgress();
}

/**
 * 自動再生専用。ターンを読み込んだうえでそのつど送信する。
 * ナビゲーションが実行しなくなった後、唯一の自動課金経路はここだけになる。
 */
async function playTurn(index) {
  loadTurn(index);
  if (!state.scenario) return;
  await runTurn({ user: state.scenario.turns[state.index].user });
}

async function loadScenario(id) {
  const res = await fetch(`/api/scenarios/${encodeURIComponent(id)}`);
  // ok を見ないと、エラー応答の JSON がそのままシナリオとして state に入り、
  // loadTurn が turns を読んだところで初めて落ちる。
  if (!res.ok) throw new Error(`シナリオ ${id} を読み込めません（HTTP ${res.status}）`);
  state.scenario = await res.json();
  state.index = 0;
  // 切替前のターンが飛行中なら、その結果は捨てる。
  generation += 1;
  el('l1').textContent = '—';
  for (const side of ['llm', 'jev']) {
    // 破棄された実行は pending を外す処理まで到達しないので、ここで外す。
    el(`panel-${side}`).classList.remove('pending');
    clearSide(side);
  }
  // 先頭ターンの発言をテキスト欄に読み込む。残した前シナリオの発言は上書きされる。送信はしない。
  loadTurn(0);
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
    // 飛行中に止めたなら、ここで再生ボタンを殺す。生かしたままだと
    // 押しても state.busy で黙って無視される。
    updateProgress();
    return;
  }

  // 止めるほうは飛行中でも受け付ける。始めるほうだけを止める。
  if (state.busy) return;

  const run = ++playRun;
  state.playing = true;
  el('play').textContent = '❙❙';

  while (
    run === playRun &&
    state.playing &&
    state.scenario &&
    state.index < state.scenario.turns.length
  ) {
    await playTurn(state.index);
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

el('prev').addEventListener('click', () => {
  if (state.busy) return;
  loadTurn(state.index - 1);
});
el('next').addEventListener('click', () => {
  if (state.busy) return;
  loadTurn(state.index + 1);
});
el('play').addEventListener('click', play);

el('reset').addEventListener('click', async () => {
  if (state.busy) return;
  // 再生中なら止める。止めないと、消した直後の輪を再生ループが描き直す。
  state.playing = false;
  playRun += 1;
  el('play').textContent = '▶';
  // 飛行中のターンは上の guard で弾いているが、世代は念のため進めておく。
  // 取りこぼしがあると、そのターンが reset 後に解決してパネルを埋め直す。
  generation += 1;
  // 走っている間は操作を止める。この await の途中で始まったターンは、
  // resetAffectus と同じ state ファイルに対して二つ目の affectus を走らせる。
  setBusy(true);
  try {
    try {
      // ok を見ないと、リセットできていないのに輪だけ描き替えて成功したように見せる。
      const res = await fetch('/api/reset', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (error) {
      showError(`リセットに失敗しました: ${error.message}`);
      return;
    }
    state.maxLatency = 1;
    for (const side of ['llm', 'jev']) {
      // 破棄された実行は pending を外す処理まで到達しないので、ここで外す。
      el(`panel-${side}`).classList.remove('pending');
      clearSide(side);
    }
    // ゼロを描かず、リセット後の実際の状態を読み戻す。
    try {
      await drawStateWheels();
    } catch (error) {
      showError(`感情状態を読み戻せません: ${error.message}`);
    }
  } finally {
    setBusy(false);
  }
});

el('scenario').addEventListener('change', async (event) => {
  // 飛行中の切替は、サーバーが affectus に適用済みのデルタを見ないまま捨てることになる。
  if (state.busy) {
    // 選択だけ先に動いているので、読み込み済みのシナリオに戻す。
    event.target.value = state.scenario?.id ?? '';
    return;
  }
  // 再生中にシナリオを変えられたら止める。止めないと古い index のまま
  // 新シナリオを勝手に進み続け、再生ボタンの表示とも食い違う。
  state.playing = false;
  playRun += 1; // await 中の再生ループを失効させる
  el('play').textContent = '▶';
  try {
    await loadScenario(event.target.value);
  } catch (error) {
    showError(error.message);
  }
});

el('compose').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.busy) return;
  const user = el('turn-user').value.trim();
  // 空のまま送ると、中身の無い発言で課金される判定を2本叩くことになる。
  if (user === '') {
    showError('user の発言を入力してください');
    return;
  }
  await runTurn({ user });
});

// 状態を取りに行くまでの間だけゼロの輪を出す。すぐ実際の値で描き直す。
const initial = Object.fromEntries(AXES.map((a) => [a, 0]));
drawWheel(el('wheel-llm'), initial);
drawWheel(el('wheel-jev'), initial);
updateProgress();

// 初期化の失敗は画面に出す。出さないと真っ白なまま理由が分からない。
// 状態の取得とシナリオ一覧の取得は独立なので、片方が落ちても他方は進める。
try {
  await drawStateWheels();
} catch (error) {
  showError(`感情状態を取得できません: ${error.message}`);
}

try {
  const modelsRes = await fetch('/api/models');
  if (!modelsRes.ok) throw new Error(`/api/models が HTTP ${modelsRes.status}`);
  const { models, default: defaultModel } = await modelsRes.json();
  el('llm-pick').innerHTML = models
    .map((m) => `<option value="${m}">${m.replace('anthropic/', '')}</option>`)
    .join('');
  el('llm-pick').value = defaultModel;

  const scenariosRes = await fetch('/api/scenarios');
  if (!scenariosRes.ok) throw new Error(`/api/scenarios が HTTP ${scenariosRes.status}`);
  const scenarios = await scenariosRes.json();
  el('scenario').innerHTML = scenarios
    .map((s) => `<option value="${s.id}">${s.id}</option>`)
    .join('');
  if (scenarios.length > 0) await loadScenario(scenarios[0].id);
} catch (error) {
  showError(`初期化に失敗しました: ${error.message}`);
}
