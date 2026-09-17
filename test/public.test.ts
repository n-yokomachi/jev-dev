import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AXES, PERSONA_IDS, PERSONAS } from '../src/constants.ts';

/**
 * public/ はブラウザ向けで Node からは import できない。
 * サーバー側との食い違いは画面にだけ現れるので、テキストとして読んで突き合わせる。
 */
async function read(name: string): Promise<string> {
  return readFile(new URL(`../public/${name}`, import.meta.url), 'utf8');
}

test('public/app.js の AXES は src/constants.ts と同じ並び', async () => {
  const source = await read('app.js');
  const match = source.match(/export const AXES = \[([^\]]*)\]/);
  assert.ok(match, 'app.js に AXES のリテラルが見つからない');
  const axes = [...match[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(axes, [...AXES]);
});

test('ブラウザが送るのは user の発言だけ。現在の状態はサーバーが直前に読む', async () => {
  const source = await read('app.js');
  // 状態をブラウザが持ち回ると、送信までの間に減衰した古い値を判定に渡すことになる。
  // 判定の入力に入る現在の8軸は、サーバーが判定の直前に自分で読む。
  assert.match(source, /judge\(side, \{ user: turn\.user \}\)/);
  // 記録された返答は入力にも画面にも使わない。
  assert.doesNotMatch(source, /turn\.agent/);
  assert.doesNotMatch(source, /manual-agent/);
  assert.doesNotMatch(source, /self-report/);
});

test('判定のあとに /api/reply を叩く', async () => {
  const source = await read('app.js');
  assert.match(source, /'\/api\/reply'/);
  // 生成にも打ち切りを置く。置かないと state.busy が生成で立ち続ける。
  assert.match(source, /REPLY_TIMEOUT_MS/);
  assert.match(source, /signal: AbortSignal\.timeout\(REPLY_TIMEOUT_MS\)/);
});

test('index.html に生成のレイテンシと返答の場所がある', async () => {
  const html = await read('index.html');
  for (const id of ['llm-gen-ms', 'jev-gen-ms', 'llm-reply', 'jev-reply']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} が無い`);
  }
});

test('index.html から記録された返答と自己申告が消えている', async () => {
  const html = await read('index.html');
  assert.doesNotMatch(html, /turn-agent/);
  assert.doesNotMatch(html, /self-report/);
  assert.doesNotMatch(html, /自己申告/);
  // 手入力は user の発言の1欄だけ。
  assert.doesNotMatch(html, /manual-agent/);
});

test('ずれの見出しは「L1 距離」と書かない', async () => {
  const html = await read('index.html');
  assert.doesNotMatch(html, /L1/);
  assert.match(html, /判定のずれ/);
});

test('返答の枠は溢れずに収まる', async () => {
  const css = await read('style.css');
  // 生成文はパネルで一番長い。折り返しと縦スクロールが無いと3カラムを崩す。
  assert.match(css, /\.reply \{[^}]*overflow-y: auto/s);
  assert.match(css, /\.reply \{[^}]*white-space: pre-wrap/s);
  assert.match(css, /@media \(max-width: 900px\)/);
});

test('シナリオ再生の経路は残っていない', async () => {
  const html = await read('index.html');
  const source = await read('app.js');
  // 供給元を消したのに残骸が残ると、undefined を読んで初期化ごと落ちる。
  for (const gone of [/id="scenario"/, /id="prev"/, /id="next"/, /id="progress"/]) {
    assert.doesNotMatch(html, gone);
  }
  assert.doesNotMatch(source, /showTurn|loadTurn|loadScenario|personaForScenario|state\.index/);
  assert.doesNotMatch(source, /'\/api\/scenarios'/);
});

test('送信は中央のテキスト欄の中身を実行する唯一の経路', async () => {
  const source = await read('app.js');
  assert.match(source, /el\('compose'\)\.addEventListener\('submit'/);
  assert.match(source, /el\('turn-user'\)\.value\.trim\(\)/);
});

test('中央の入力欄は1つに統合されている（表示用と手入力用が分かれていない）', async () => {
  const html = await read('index.html');
  assert.doesNotMatch(html, /id="manual"/);
  assert.doesNotMatch(html, /id="manual-user"/);
  assert.doesNotMatch(html, /id="manual-submit"/);
  assert.match(html, /id="turn-user"/);
  assert.match(html, /id="compose"/);
  assert.equal((html.match(/<textarea/g) ?? []).length, 1, 'textarea が1つではない');
});

test('送信ボタンの文言は「メッセージを送信」', async () => {
  const html = await read('index.html');
  assert.match(html, /id="send"[^>]*>メッセージを送信</);
});

test('左右のパネルにゲージを置かない', async () => {
  const html = await read('index.html');
  // 判定の差は中央に集約した。左右に残すと、画面の端から端へ目を往復させることになる。
  assert.doesNotMatch(html, /id="llm-gauges"/);
  assert.doesNotMatch(html, /id="jev-gauges"/);
  assert.doesNotMatch(html, /class="gauges"/);
  assert.doesNotMatch(html, /が返した感情の変動値/);
  const source = await read('app.js');
  assert.doesNotMatch(source, /renderGauges/);
});

test('判定の対比は中央パネルに置く', async () => {
  const html = await read('index.html');
  const mid = html.slice(
    html.indexOf('<section class="panel mid">'),
    html.indexOf('id="panel-jev"'),
  );
  assert.match(mid, /id="duel"/);
  // 見出しは左が LLM、中央が差、右が jev。
  const head = mid.match(/<div class="duel-head">[\s\S]*?<\/div>/);
  assert.ok(head, '対比の見出し行が無い');
  assert.ok(head[0].indexOf('LLM') < head[0].indexOf('差'), '見出しの並びが LLM → 差 でない');
  assert.ok(head[0].indexOf('差') < head[0].indexOf('jev'), '見出しの並びが 差 → jev でない');
});

test('対比は8軸ぶんを固定の順序で、軸名を略さずに出す', async () => {
  const source = await read('app.js');
  const render = source.match(/function renderDuel\([\s\S]*?\n\}\n/);
  assert.ok(render, 'renderDuel の定義が見つからない');
  assert.match(render[0], /AXES\.map/);
  // 切り詰めると、どの軸で割れたのかが読めなくなる。
  assert.doesNotMatch(render[0], /slice\(/);
  const css = await read('style.css');
  assert.match(css, /\.duel \.nm \{[^}]*white-space: nowrap/s);
});

test('見出し行と8行は同じ桁組みで並ぶ', async () => {
  const css = await read('style.css');
  // 縦にも読ませるので、列の定義は1か所。head と row で別々に書くとずれる。
  assert.match(css, /\.duel \{[^}]*--cols:/s);
  assert.match(css, /\.duel-head,\n\.duel \.row \{[^}]*grid-template-columns: var\(--cols\)/s);
});

test('中央が 0、左右の末端が 1.0。棒は中央から外へ伸びる', async () => {
  const css = await read('style.css');
  assert.match(css, /\.duel \.bar\.llm i \{ right: 0; \}/);
  assert.match(css, /\.duel \.bar\.jev i \{ left: 0; \}/);
  const source = await read('app.js');
  // 棒の長さは変動の大きさ。その半分の全幅を 1.0 とする。
  assert.match(source, /Math\.min\(1, Math\.abs\(v\)\) \* 100/);
});

test('符号は色で表す。正はその側の色、負はくすんだ灰', async () => {
  const css = await read('style.css');
  assert.match(css, /\.duel \.llm\.pos \{ color: var\(--llm\); \}/);
  assert.match(css, /\.duel \.jev\.pos \{ color: var\(--jev\); \}/);
  assert.match(css, /\.duel \.neg \{ color: var\(--dim\); \}/);
  const source = await read('app.js');
  const tone = source.match(/function tone\(v\) \{[\s\S]*?\n\}\n/);
  assert.ok(tone, 'tone の定義が見つからない');
  assert.match(tone[0], /' neg'/);
  assert.match(tone[0], /' pos'/);
  // 数値にも符号を付ける。長さだけでは LLM の −0.5 と jev の +0.5 が同じに見える。
  const signed = source.match(/function signed\(v\) \{[\s\S]*?\n\}\n/);
  assert.ok(signed, 'signed の定義が見つからない');
  assert.match(signed[0], /'\+'/);
});

test('確信度は画面に出さない', async () => {
  // jev が返すのは score と probabilities だけ。「確信度」はこちらの算出値であり、
  // 点線で重ねると、モデルが言った値であるかのように見せることになる。
  const css = await read('style.css');
  assert.doesNotMatch(css, /\.conf\b/);
  assert.doesNotMatch(css, /dotted #93a1b0/);
  const source = await read('app.js');
  assert.doesNotMatch(source, /confidence/);
  const html = await read('index.html');
  assert.doesNotMatch(html, /確信度/);
  assert.doesNotMatch(html, /点線/);
});

test('軸名と差は行の中央、左右の棒に挟まれた位置に置く', async () => {
  const source = await read('app.js');
  const render = source.match(/function renderDuel\([\s\S]*?\n\}\n/);
  assert.ok(render, 'renderDuel の定義が見つからない');
  const rows = render[0];
  const llmBar = rows.indexOf('bar llm');
  const jevBar = rows.indexOf('bar jev');
  assert.ok(llmBar < rows.indexOf('class="nm"'), '軸名が LLM の棒より外にある');
  assert.ok(rows.indexOf('class="nm"') < jevBar, '軸名が jev の棒より外にある');
  assert.ok(rows.indexOf('class="d"') < jevBar, '差が jev の棒より外にある');
});

test('差は符号付きの値どうしで取る', async () => {
  const source = await read('app.js');
  const render = source.match(/function renderDuel\([\s\S]*?\n\}\n/);
  assert.ok(render, 'renderDuel の定義が見つからない');
  // 棒の長さ（絶対値）どうしの差にすると、LLM が −0.5 で jev が +0.5 のときに
  // 0.00 となり、この画面が最も見せたい正反対の判断を見逃す。
  assert.match(render[0], /Math\.abs\(l - j\)/);
  assert.doesNotMatch(render[0], /Math\.abs\(l\) - Math\.abs\(j\)/);
});

test('合計は対比の行の下に残る', async () => {
  const html = await read('index.html');
  assert.match(html, /判定のずれ（8軸の差の合計）/);
  assert.ok(html.indexOf('id="duel"') < html.indexOf('id="l1"'), '合計が行より上にある');
});

test('失敗・失効したターンは対比の行を消す', async () => {
  const source = await read('app.js');
  const clear = source.match(/function clearDuel\(\) \{[\s\S]*?\n\}\n/);
  assert.ok(clear, 'clearDuel の定義が見つからない');
  assert.match(clear[0], /renderDuel\(undefined, undefined\)/);
  assert.match(clear[0], /el\('l1'\)\.textContent = '—'/);
  // 前ターンの棒が新しい発言の隣に残らないよう、ターンの頭で消す。
  const inner = source.match(/async function runTurnInner\(turn\) \{[\s\S]*?\n\}\n/);
  assert.ok(inner, 'runTurnInner の定義が見つからない');
  assert.match(inner[0], /clearDuel\(\);/);
  // reset でも消す。消さないと、空にした輪の隣に前ターンの棒が残る。
  const resetHandler = source.match(/el\('reset'\)\.addEventListener[\s\S]*?\n\}\);\n/);
  assert.ok(resetHandler, 'reset のハンドラが見つからない');
  assert.match(resetHandler[0], /clearDuel\(\);/);
});

test('対比は片側が返った時点から描く', async () => {
  const source = await read('app.js');
  const inner = source.match(/async function runTurnInner\(turn\) \{[\s\S]*?\n\}\n/);
  assert.ok(inner, 'runTurnInner の定義が見つからない');
  // 両方揃うまで待つと、どちらが先に返ったかが中央から読めなくなる。
  assert.match(inner[0], /renderDuel\(results\.llm\?\.deltas, results\.jev\?\.deltas\)/);
});

test('中央カラムが一番広い', async () => {
  const css = await read('style.css');
  const mid = css.match(/\.panel\.mid \{[^}]*?flex: ([\d.]+)/);
  assert.ok(mid, '.panel.mid の flex が読めない');
  // 対比が起きるのは中央。左右は flex: 1。
  assert.ok(Number(mid[1]) > 1, `中央が左右より広くない (flex: ${mid[1]})`);
});

test('両パネルの下部に判定の生の入出力を出す場所がある', async () => {
  const html = await read('index.html');
  for (const id of ['llm-raw-req', 'llm-raw-res', 'jev-raw-req', 'jev-raw-res']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} が無い`);
  }
  // 参照用なのでパネルの一番下。返答より前に置くと、主役を押し下げる。
  for (const side of ['llm', 'jev']) {
    const panel = html.slice(html.indexOf(`id="panel-${side}"`));
    assert.ok(
      panel.indexOf(`id="${side}-reply"`) < panel.indexOf(`id="${side}-raw-req"`),
      `${side}: 生の入出力が返答より上にある`,
    );
  }
});

test('生の入出力は畳まずに常に表示する', async () => {
  const html = await read('index.html');
  // 開いた時点で中身が読める状態にする。
  assert.doesNotMatch(html, /<details/);
  assert.doesNotMatch(html, /<summary/);
  assert.equal((html.match(/<div class="raw">/g) ?? []).length, 2);
  // 入力と出力はどちらがどちらか分かるようにする。
  assert.equal((html.match(/モデルに渡した内容/g) ?? []).length, 2);
  assert.equal((html.match(/返ってきた内容/g) ?? []).length, 2);
});

test('生の入出力の枠は高さ固定で、溢れずに収まる', async () => {
  const css = await read('style.css');
  // JSON は1行が長い。折り返しと縦スクロールが無いと3カラムを崩す。
  assert.match(css, /\.io \{[^}]*white-space: pre-wrap/s);
  assert.match(css, /\.io \{[^}]*overflow-wrap: anywhere/s);
  // 高さを固定しないと、常時表示では中身の長さでパネルの丈が毎ターン変わる。
  assert.match(css, /\.io \{[^}]*\n\s*height: /s);
  assert.match(css, /\.io \{[^}]*overflow: auto/s);
});

test('生表示に出すのは判定の入出力だけ。返答生成の入出力は出さない', async () => {
  const source = await read('app.js');
  assert.match(source, /function renderRaw\(side, result\)/);
  assert.match(source, /result\.request/);
  assert.match(source, /result\.response/);
  // 判定の描画からだけ呼ぶ。
  const renderSide = source.match(/function renderSide\(side, result\) \{[\s\S]*?\n\}\n/);
  assert.ok(renderSide, 'renderSide の定義が見つからない');
  assert.match(renderSide[0], /renderRaw\(side, result\)/);
  // 生成の描画は触らない。
  const renderReply = source.match(/function renderReply\(side, outcome\) \{[\s\S]*?\n\}\n/);
  assert.ok(renderReply, 'renderReply の定義が見つからない');
  assert.doesNotMatch(renderReply[0], /raw/);
});

test('ターンの開始で前ターンの生の入出力を消す', async () => {
  const source = await read('app.js');
  const clearSide = source.match(/function clearSide\(side\) \{[\s\S]*?\n\}\n/);
  assert.ok(clearSide, 'clearSide の定義が見つからない');
  // 残すと、失敗したターンで前ターンの JSON がこのターンの入出力として読める。
  assert.match(clearSide[0], /raw-req/);
  assert.match(clearSide[0], /raw-res/);
});

test('自動遷移・自動送信の経路は存在しない', async () => {
  const html = await read('index.html');
  const source = await read('app.js');
  // 再生ボタンが残っていれば、ターンを勝手に送りながら課金する経路も残っている。
  assert.doesNotMatch(html, /id="play"/);
  assert.doesNotMatch(source, /playTurn|state\.playing|playRun/);
  // 送信は submit ハンドラだけ。ここ以外から runTurn を呼ぶと自動送信に戻る。
  const calls = [...source.matchAll(/runTurn\(/g)];
  assert.equal(calls.length, 2, 'runTurn の定義と呼び出しは1つずつのはず');
});

test('人格の選択肢は src/constants.ts の PERSONAS と一致する', async () => {
  const html = await read('index.html');
  const select = html.match(/<select id="persona"[\s\S]*?<\/select>/);
  assert.ok(select, 'index.html に人格の選択欄が無い');
  const options = [...select[0].matchAll(/<option value="([^"]+)">([^<]*)<\/option>/g)];
  assert.deepEqual(options.map((m) => m[1]), [...PERSONA_IDS]);
  // 表記もサーバー側の定義に揃える。ずれると、画面の名前と指示文の中身が食い違う。
  assert.deepEqual(options.map((m) => m[2]), PERSONA_IDS.map((id) => PERSONAS[id].label));
});

test('人格の選択は topbar に置く', async () => {
  const html = await read('index.html');
  const topbar = html.slice(html.indexOf('<header class="topbar">'), html.indexOf('</header>'));
  assert.match(topbar, /id="persona"/);
  assert.match(topbar, /id="reset"/);
});

test('返答生成に人格を送る。両側とも同じ人格', async () => {
  const source = await read('app.js');
  assert.match(source, /body: JSON\.stringify\(\{ user, axes, persona \}\)/);
  // ターンの頭で一度だけ読み、両側の生成に同じ値を渡す。
  const inner = source.match(/async function runTurnInner\(turn\) \{[\s\S]*?\n\}\n/);
  assert.ok(inner, 'runTurnInner の定義が見つからない');
  assert.match(inner[0], /const persona = el\('persona'\)\.value;/);
  assert.equal((inner[0].match(/requestReply\(turn\.user, result\.axes, persona\)/g) ?? []).length, 1);
});

test('判定には人格を送らない', async () => {
  const source = await read('app.js');
  const judge = source.match(/async function judge\(side, turn\) \{[\s\S]*?\n\}\n/);
  assert.ok(judge, 'judge の定義が見つからない');
  assert.doesNotMatch(judge[0], /persona/);
});

test('判定が飛行中は人格も凍らせる', async () => {
  const source = await read('app.js');
  const update = source.match(/function syncControls\(\) \{[\s\S]*?\n\}\n/);
  assert.ok(update, 'syncControls の定義が見つからない');
  // 途中で変えられると、画面の選択と実際に生成に渡った人格が食い違う。
  assert.match(update[0], /el\('persona'\)\.disabled = state\.busy;/);
});
