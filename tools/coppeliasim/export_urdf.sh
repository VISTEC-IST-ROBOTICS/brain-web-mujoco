#!/usr/bin/env bash
# Export a robot model from a CoppeliaSim .ttt scene to URDF, headless.
# Usage: tools/coppeliasim/export_urdf.sh <scene.ttt> <model_path> [out.urdf]
#   model_path: scene path of the model root, e.g. /morf or /body_carbon_rod
#   default out: assets_src/<scene name>/urdf/<scene name>.urdf (meshes as .dae next to it)
# Env:   COPPELIASIM_ROOT  CoppeliaSim install dir
#        URDF_OPTS         simURDF.export options bitmask (default 0)
set -euo pipefail

if [ $# -lt 2 ]; then
    sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
export COPPELIASIM_ROOT="${COPPELIASIM_ROOT:-$HOME/Research/coppelia/CoppeliaSim_Edu_V4_10_0_rev0_Ubuntu24_04}"
export SCENE_FILE="$(realpath "$1")"
SCENE_NAME="$(basename "$SCENE_FILE" .ttt)"
export MODEL_PATH="$2"
export URDF_FILE="$(realpath -m "${3:-$ROOT/assets_src/$SCENE_NAME/urdf/$SCENE_NAME.urdf}")"
export URDF_OPTS="${URDF_OPTS:-0}"

mkdir -p "$(dirname "$URDF_FILE")"
cd "$COPPELIASIM_ROOT"
QT_QPA_PLATFORM=offscreen ./coppeliaSim.sh -H -q -a "$HERE/export_urdf.lua"
