#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

say() { printf '%s\n' "$*"; }

# 1. Node のバージョン
if ! command -v node >/dev/null 2>&1; then
  say "node が見つかりません。Node 24 以上を入れてください: https://nodejs.org/"
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 24 ]; then
  say "Node 24 以上が必要です（現在 v$(node -p 'process.versions.node')）"
  exit 1
fi
say "node v$(node -p 'process.versions.node') OK"

# 2. 依存
if [ -d node_modules ]; then
  say "node_modules あり、飛ばします"
else
  say "npm ci を実行します"
  npm ci
fi

# 3. affectus バイナリ
if [ -x bin/affectus ]; then
  say "bin/affectus あり、飛ばします"
elif command -v go >/dev/null 2>&1; then
  say "go install で affectus を取得します"
  mkdir -p bin
  GOBIN="$ROOT/bin" go install github.com/n-yokomachi/affectus/cmd/affectus@v0.4.0
else
  say "bin/affectus が無く、go も入っていません。"
  say "Go を入れるか、リリースのバイナリを bin/affectus に置いてください:"
  say "  https://github.com/n-yokomachi/affectus/releases"
  exit 1
fi

# 4. Gatekeeper の隔離属性を外す
xattr -dr com.apple.quarantine . 2>/dev/null || true

# 5. 感情状態
mkdir -p state
if [ ! -f state/jev.json ]; then
  bin/affectus --config state/config.yaml --state state/jev.json init --model plutchik
  say "state/jev.json を作成しました"
fi
if [ ! -f state/llm.json ]; then
  bin/affectus --config state/config.yaml --state state/llm.json init --model plutchik --force
  say "state/llm.json を作成しました"
fi

# 6. API キー
if [ ! -f .env.local ]; then
  say ""
  say "最後に API キーが要ります。次を実行して、貼り付けてください。"
  say "  read -rs \"KEY?AI_GATEWAY_API_KEY: \" && printf 'AI_GATEWAY_API_KEY=%s\\n' \"\$KEY\" > .env.local && unset KEY"
  say "  chmod 600 .env.local"
  say ""
  say "キーは Vercel の AI Gateway → API Keys で発行できます。"
  exit 0
fi

say ""
say "準備できました。起動するには:"
say "  node --env-file=.env.local src/server.ts"
