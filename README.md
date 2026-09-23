# MuJoCo Web Simulator

A minimal browser-based MuJoCo physics viewer, in the same spirit as
[pollen-robotics/microduck-simulator](https://huggingface.co/spaces/pollen-robotics/microduck-simulator):
MuJoCo compiled to WebAssembly runs the physics entirely client-side, rendered
with Three.js — no backend.

Currently loads a small 4-wheel skid-steer rover
([public/assets/rover.xml](public/assets/rover.xml)) — a custom, self-contained
MJCF (box chassis, cylinder wheels) chosen so it's inherently stable and needs
no mesh assets. A capsule/sphere-only stock MuJoCo humanoid is also included
at [public/assets/humanoid.xml](public/assets/humanoid.xml) for reference.

## Stack

- [`@mujoco/mujoco`](https://github.com/google-deepmind/mujoco/tree/main/wasm) — official Google DeepMind MuJoCo WASM bindings
- [Three.js](https://threejs.org/) for rendering
- Vite as a plain dev server/bundler (no UI framework)

## Run

```sh
npm install
npm run dev
```

Open the printed local URL in a browser.

## Controls

- Drag: orbit camera · Scroll: zoom
- Up/Down or W/S: drive forward/backward
- Left/Right or A/D: skid-steer turn
- R (hold): reset the simulation

## How it works

[src/main.js](src/main.js) loads the WASM module, compiles the MJCF model with
`MjModel.from_xml_string`, and each frame:

1. Sub-steps `mj_step` to catch up to real time at the model's fixed timestep
2. Reads `data.geom_xpos` / `data.geom_xmat` (world-space transforms MuJoCo
   already computes for every geom) and applies them to a matching Three.js
   mesh built per geom type (plane / sphere / capsule / cylinder / box)

Swap in another model by pointing `MODEL_URL` in `src/main.js` at a different
self-contained MJCF file under `public/assets/`. Models that reference `.stl`/
mesh assets aren't supported yet — only primitive geoms are rendered.

## Known limitations

- No mesh/heightfield geom rendering (primitives only)
