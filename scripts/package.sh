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

# 2. 中身を集める。dist（自分の出力）以外は全部入れる。
#    隠しファイルも拾うので .gitignore / .git / .superpowers もここで入る。
for item in "$ROOT"/* "$ROOT"/.[!.]*; do
  base="$(basename "$item")"
  case "$base" in
    # 自分自身の出力。入れると zip の中に zip が入って際限なく膨らむ。
    dist) continue ;;
    # 手順1が universal binary を置いた後。ここで上書きすると、
    # 手元のアーキテクチャ専用に退化して Intel Mac で動かなくなる。
    bin) continue ;;
    # 既定では入れない。--with-key のときだけ手順4で積む。
    .env|.env.local) continue ;;
  esac
  cp -R "$item" "$STAGE/"
done

# 3. 実行に邪魔なものだけ落とす
#    state は同梱するが、こちらの手元で育った値をそのまま渡すと、
#    受け取った側の輪が最初から埋まっていて比較の出発点にならない。
#    ファイルは残したうえで、初期値に作り直す。
rm -rf "$STAGE/node_modules/.cache"
rm -f "$STAGE/state/jev.json" "$STAGE/state/llm.json" \
      "$STAGE/state/jev.json.lock" "$STAGE/state/llm.json.lock"
(cd "$STAGE" && ./bin/affectus --config state/config.yaml --state state/jev.json \
   init --model plutchik --force >/dev/null)
(cd "$STAGE" && ./bin/affectus --config state/config.yaml --state state/llm.json \
   init --model plutchik --force >/dev/null)

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
