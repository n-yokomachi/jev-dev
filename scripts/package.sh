#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
AFFECTUS_SRC="${AFFECTUS_SRC:-/Users/Naoki/work/workshop/affectus}"
NAME="jev-duel-$(date +%Y%m%d)"
OUT="$ROOT/dist"
STAGE="$OUT/$NAME"

rm -rf "$STAGE" "$OUT/$NAME.zip"
mkdir -p "$STAGE/bin"

# 1. affectus を arm64 + x86_64 の universal binary にする
if [ -d "$AFFECTUS_SRC" ] && command -v go >/dev/null 2>&1; then
  TMP="$(mktemp -d)"
  (cd "$AFFECTUS_SRC" && GOOS=darwin GOARCH=arm64 go build -o "$TMP/affectus-arm64" ./cmd/affectus)
  (cd "$AFFECTUS_SRC" && GOOS=darwin GOARCH=amd64 go build -o "$TMP/affectus-amd64" ./cmd/affectus)
  lipo -create -output "$STAGE/bin/affectus" "$TMP/affectus-arm64" "$TMP/affectus-amd64"
  rm -rf "$TMP"
  echo "universal binary: $(lipo -archs "$STAGE/bin/affectus")"
else
  echo "警告: affectus のソースか go が無いため、手元の bin/affectus をそのまま同梱します。"
  echo "警告: このバイナリは $(lipo -archs bin/affectus 2>/dev/null || uname -m) 専用です。"
  echo "警告: 他のアーキテクチャの Mac では動きません。可搬な zip が要るなら Go を入れて再実行してください。"
  cp bin/affectus "$STAGE/bin/affectus"
fi

# 2. 中身を集める
for item in src public data scripts test docs package.json package-lock.json README.md CLAUDE.md; do
  cp -R "$item" "$STAGE/"
done
cp -R node_modules "$STAGE/node_modules"

# 3. 入ってはいけないものを落とす
rm -f "$STAGE/.env" "$STAGE/.env.local"
rm -rf "$STAGE/state" "$STAGE/dist" "$STAGE/node_modules/.cache"

# 4. 固める
(cd "$OUT" && zip -qr "$NAME.zip" "$NAME")
rm -rf "$STAGE"

echo "できました: dist/$NAME.zip ($(du -h "$OUT/$NAME.zip" | cut -f1))"
