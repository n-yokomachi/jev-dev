# jev × LLM 判定対決ビューア

同じ会話ターンを TypeSafe の `jev` と LLM の両方に判定させ、判定結果のズレと速度差を1画面で見せるデモ。判定は [affectus](https://github.com/n-yokomachi/affectus) の感情状態として別々に蓄積され、2つの状態が会話の進行につれて分岐していく様子をプルチックの輪で見られる。

## 必要なもの

- macOS（Apple Silicon / Intel のどちらでも）
- Node 24 以上
- Vercel AI Gateway の API キー

配布 zip には affectus のバイナリと `node_modules` が入っているので、Go もネットワーク越しの依存解決も要らない。

## 使い方

```bash
./scripts/setup.sh
# 案内に従って .env.local に API キーを書く
node --env-file=.env.local src/server.ts
```

ブラウザで http://localhost:8787 を開く。

シナリオを選ぶと、会話が1ターンずつ流れる。`▶❙` で1ターン進め、`▶` で自動再生。中央の入力欄から任意のターンを判定させることもできる。

## 画面の読み方

- **左が LLM、右が jev。** 同じ会話ターンを同時に判定させ、先に返ったほうから埋まる
- **プルチックの輪**は花弁の長さが各軸の強さ。左右で形が違えば、判定が食い違っている
- **軸ゲージ**は中央線から右が正、左が負。jev 側の点線は、jev が軸ごとに返す確率分布からこちら側で算出した確信度。LLM 側はその分布を返さないため点線が出ない
- **L1 距離**は両者のデルタがどれだけ離れているかの1数値

## 構成

| ディレクトリ | 内容 |
|---|---|
| `src/` | サーバーと判定ロジック |
| `public/` | 画面 |
| `data/transcripts/` | 再生用の会話ログ 24 シナリオ × 20 ターン |
| `bin/` | affectus バイナリ |
| `state/` | 2つの感情状態（`setup.sh` が生成） |

## テスト

```bash
npm test
```

## 配布 zip を作る

```bash
./scripts/package.sh
```

`dist/` に zip ができる。API キーと感情状態は含まれない。
