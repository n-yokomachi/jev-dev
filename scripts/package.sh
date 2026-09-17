#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
# 既定は隣に置かれた affectus リポジトリ。このスクリプトは zip に同梱されて
# 配布先でも実行されうるので、作者のマシン固有の絶対パスを既定にしない。
AFFECTUS_SRC="${AFFECTUS_SRC:-$ROOT/../affectus}"

# --with-key を付けたときだけ .env.local を同梱する。既定は同梱しない。
# 同梱した zip は API キーそのものを持つので、渡した相手はそのキーで課金できる。
# 受け取り手を限れる場合にだけ使う。ファイル名でも区別が付くようにする。
WITH_KEY=0
for arg in "$@"; do
  case "$arg" in
    --with-key) WITH_KEY=1 ;;
    *) echo "不明な引数: $arg（使えるのは --with-key だけです）" >&2; exit 2 ;;
  esac
done

NAME="jev-duel-$(date +%Y%m%d)"
[ "$WITH_KEY" = 1 ] && NAME="$NAME-withkey"
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
  if [ ! -f bin/affectus ]; then
    echo "エラー: affectus のソース（${AFFECTUS_SRC}）か go が無く、bin/affectus もありません。" >&2
    echo "AFFECTUS_SRC に affectus リポジトリのパスを渡すか、bin/affectus を置いてください。" >&2
    exit 1
  fi
  echo "警告: affectus のソースか go が無いため、手元の bin/affectus をそのまま同梱します。"
  echo "警告: このバイナリは $(lipo -archs bin/affectus 2>/dev/null || uname -m) 専用です。"
  echo "警告: 他のアーキテクチャの Mac では動きません。可搬な zip が要るなら Go を入れて再実行してください。"
  cp bin/affectus "$STAGE/bin/affectus"
fi

# 2. 中身を集める
for item in src public scripts test docs package.json package-lock.json README.md CLAUDE.md HANDOFF.html; do
  cp -R "$item" "$STAGE/"
done
cp -R node_modules "$STAGE/node_modules"

# 3. 入ってはいけないものを落とす
#    probe-jev.ts は動作確認用の使い捨てで、実行すると無条件に Gateway を叩く。
rm -f "$STAGE/.env" "$STAGE/.env.local" "$STAGE/scripts/probe-jev.ts"
rm -rf "$STAGE/state" "$STAGE/dist" "$STAGE/node_modules/.cache"

# 4. 要求されたときだけ API キーを積む。上の掃除の後に置くこと。
#    先に置くと rm に消される。
if [ "$WITH_KEY" = 1 ]; then
  if [ ! -f "$ROOT/.env.local" ]; then
    echo "エラー: --with-key ですが .env.local がありません。" >&2
    exit 1
  fi
  cp "$ROOT/.env.local" "$STAGE/.env.local"
  chmod 600 "$STAGE/.env.local"
  echo "警告: この zip は API キーを含みます。渡した相手はそのキーで課金できます。"
fi

# 5. 固める。隠しファイルも拾うよう明示する。
(cd "$OUT" && zip -qr "$NAME.zip" "$NAME")
rm -rf "$STAGE"

echo "できました: dist/$NAME.zip ($(du -h "$OUT/$NAME.zip" | cut -f1))"
