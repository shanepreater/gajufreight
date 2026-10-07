#!/bin/sh
# Runs the tx-builder's tests (no network): builds match Hakuzaru's, hashes match the
# chain's, events decode, HTTP routes. Needs the zx packages GajuDesk installs.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
. "$HERE/paths.sh"
OUT="$HERE/_build/test"
mkdir -p "$OUT"
erlc -Wall -Werror -o "$OUT" "$HERE"/src/*.erl "$HERE"/test/*.erl
cp "$HERE/src/tx_builder.app.src" "$OUT/tx_builder.app"
TX_BUILDER_CONTRACTS="$ROOT/contracts/spike" erl -noshell -pa "$OUT" $(zx_paths) \
  -eval 'case eunit:test(tx_builder_tests, [verbose]) of ok -> halt(0); _ -> halt(1) end.'
