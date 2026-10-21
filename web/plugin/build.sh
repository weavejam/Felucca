#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 weavejam
# The FM-1 plugin for tuttidaw (web/plugin/README.md): the firmware built as the browser emulator's (web/emu/build.sh)
# with FELUCCA_TUTTI (web/plugin/felucca_plugin.c), and the static site that serves it:
#   web/plugin/build.sh   ->  build/plugin-site/{tutti-plugin.json, _headers, plugin/, emu/, credits.html, licenses/}
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
node web/plugin/site.mjs build/plugin-wasm/felucca.wasm build/plugin-site "$VERSION"
