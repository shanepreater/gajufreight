#!/bin/sh
# Builds the Sophia 9.0.0 compiler and its dependencies from pinned public sources, so CI
# compiles contracts without GajuDesk (ADR 0014). Each commit's content matches the zx
# package GajuDesk installs; zx only rewrites include paths and stamps -vsn lines, and the
# result compiles to byte-identical bytecode.
#
# Usage: contracts/tools/build-sophia.sh <work-dir>
# Then:  ERL_LIBS=<work-dir>/lib erl ...   (so_compiler, gmb_*, gmser_*, eblake2, zj)
set -eu

WORK=$1
mkdir -p "$WORK/lib"
cd "$WORK/lib"

# app, repository, full commit. A full commit hash pins the exact content.
fetch() {
  [ -d "$1/.git" ] || git clone --quiet "$2" "$1"
  git -C "$1" -c advice.detachedHead=false checkout --quiet "$3"
  [ "$(git -C "$1" rev-parse HEAD)" = "$3" ] || { echo "$1: not at $3" >&2; exit 1; }
}

fetch eblake2         https://github.com/aeternity/eblake2.git    60a079f00d72d1bfcc25de8e6996d28f912db3fd
fetch base58          https://gitlab.com/zxq9/erl-base58.git      e6aa62eeae3d4388311401f06e4b939bf4e94b9c
fetch zj              https://gitlab.com/zxq9/zj.git              6f83e4e8d0becf0fac39404e20e1285988841f91
fetch gmserialization https://gitlab.com/zxq9/gmserialization.git ac64e01b0f675c1a34c70a827062f381920742db
fetch gmbytecode      https://gitlab.com/zxq9/gmbytecode.git      691b9742bf7e4aa6a4e8e209397916be5abe1763
fetch sophia          https://gitlab.com/zxq9/sophia.git          b551a84cdc4933c6d23dbf0ab9b67891dd6d1143

export ERL_LIBS="$WORK/lib"

build() {
  app=$1
  mkdir -p "$app/ebin"
  for scanner in "$app"/src/*.xrl; do
    [ -e "$scanner" ] && erlc -o "$app/src" "$scanner"
  done
  erlc -o "$app/ebin" -I "$app/include" -I "$app/src" "$app"/src/*.erl
  for spec in "$app"/src/*.app.src; do
    [ -e "$spec" ] && cp "$spec" "$app/ebin/$(basename "$spec" .src)"
  done
  return 0
}

build eblake2
build base58
build zj
build gmserialization

# gmbytecode generates its opcode modules and scanner from a template first. The generator
# writes its arguments into the include paths it generates, so it runs from inside.
mkdir -p gmbytecode/ebin
erlc -o gmbytecode/ebin -I gmbytecode/include gmbytecode/src/gmb_fate_generate_ops.erl
(cd gmbytecode && erl -pa ebin -noshell -s gmb_fate_generate_ops gen_and_halt src/ include/)
build gmbytecode

build sophia
echo "Sophia 9.0.0 built in $WORK/lib"
