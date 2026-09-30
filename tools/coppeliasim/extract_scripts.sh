#!/usr/bin/env bash
# Dump all scripts embedded in a CoppeliaSim .ttt scene, headless.
# Usage: tools/coppeliasim/extract_scripts.sh <scene.ttt> [out_dir]
#   default out: assets_src/<scene name>/scripts/, files named <scene name>_<script object>.lua
# Env:   COPPELIASIM_ROOT  CoppeliaSim install dir
set -euo pipefail

if [ $# -lt 1 ]; then
    sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
export COPPELIASIM_ROOT="${COPPELIASIM_ROOT:-$HOME/Research/coppelia/CoppeliaSim_Edu_V4_10_0_rev0_Ubuntu24_04}"
export SCENE_FILE="$(realpath "$1")"
export OUT_DIR="$(realpath -m "${2:-$ROOT/assets_src/$(basename "$SCENE_FILE" .ttt)/scripts}")"

mkdir -p "$OUT_DIR"
cd "$COPPELIASIM_ROOT"
QT_QPA_PLATFORM=offscreen ./coppeliaSim.sh -H -q -a "$HERE/extract_scripts.lua"
