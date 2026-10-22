#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 weavejam
# The Felucca plugin for tuttidaw (web/plugin/README.md): the firmware built as the browser emulator's (web/emu/build.sh)
# with FELUCCA_TUTTI (web/plugin/felucca_plugin.c), and the static site that serves it, per deployment channel:
#   PLUGIN_CHANNEL=production web/plugin/build.sh  ->  build/plugin-site/{tutti-plugin.json, _headers, plugin/, emu/, ...}
#   PLUGIN_CHANNEL=preview    web/plugin/build.sh  ->  build/plugin-site-preview/ (the default; also embeddable from
#                                                      http://localhost:<port>)
#   PLUGIN_CHANNEL="production preview"            ->  both (one wasm)
# The wasm alone: build/plugin-wasm/felucca.wasm. The site links its source to the commit built: the tree must be clean
# (PLUGIN_ALLOW_DIRTY=1: a preview anyway, marked; see site.mjs).
# Run after the generated headers exist (./build.sh, or tools/build.py --gen-only: no JieLi toolchain needed).
# PLUGIN_OPT replaces -O2, as EMU_OPT does for the emulator.
set -e
cd "$(dirname "$0")/../.."
[ -f build/gen/felucca_tables.h ] || { echo "plugin: run tools/build.py --gen-only (or ./build.sh) once first (build/gen)"; exit 1; }
command -v emcc >/dev/null 2>&1 || { echo "plugin: no emcc (Emscripten)"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "plugin: no node"; exit 1; }
VERSION=$(sed -n 's/^#define FELUCCA_VERSION "\([^"]*\)".*/\1/p' firmware/src/felucca.c | head -n 1)
mkdir -p build/plugin-wasm
# shellcheck disable=SC2086
emcc ${PLUGIN_OPT:--O2} -ffp-contract=off -std=gnu99 -w \
    "-DFELUCCA_VERSION=\"$VERSION\"" -Ibuild/gen -Ifirmware/src \
    --no-entry -sSTANDALONE_WASM -sSTACK_SIZE=1048576 -sINITIAL_MEMORY=33554432 -sFILESYSTEM=0 \
    -o build/plugin-wasm/felucca.wasm web/plugin/felucca_plugin.c
for CHANNEL in ${PLUGIN_CHANNEL:-preview}; do
    case "$CHANNEL" in
        production) OUT=build/plugin-site ;;
        preview) OUT=build/plugin-site-preview ;;
        *) echo "plugin: PLUGIN_CHANNEL: production and/or preview (not $CHANNEL)"; exit 1 ;;
    esac
    PLUGIN_CHANNEL=$CHANNEL node web/plugin/site.mjs build/plugin-wasm/felucca.wasm "$OUT" "$VERSION"
done
