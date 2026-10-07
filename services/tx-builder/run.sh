#!/bin/sh
# Starts the tx-builder on 127.0.0.1 (ADR 0012). Set TX_BUILDER_CONTRACTS to the
# network's built contracts (contracts/build/<network>, from contracts/tools/build.escript)
# and TX_BUILDER_NODE to host:port; see the README for the rest.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/paths.sh"
OUT="$HERE/_build/default"
mkdir -p "$OUT"
erlc -Wall -o "$OUT" "$HERE"/src/*.erl
cp "$HERE/src/tx_builder.app.src" "$OUT/tx_builder.app"
exec erl -noshell -pa "$OUT" $(zx_paths) -eval 'application:ensure_all_started(tx_builder)'
