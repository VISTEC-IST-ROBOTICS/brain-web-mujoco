# MuJoCo Web Simulator

A minimal browser-based MuJoCo physics viewer, in the same spirit as
[pollen-robotics/microduck-simulator](https://huggingface.co/spaces/pollen-robotics/microduck-simulator):
MuJoCo compiled to WebAssembly runs the physics entirely client-side, rendered
with Three.js — no backend.

The page opens on a menu of the Python robots ([src/landing.js](src/landing.js),
see [Python robots](#python-robots)); each robot also has its own link,
`?robot=<name>`. The main one is the **Gecko** quadruped
([public/assets/gecko/gecko.xml](public/assets/gecko/gecko.xml)), converted
from [my_robot/gecko-aug-2026.usd](my_robot/gecko-aug-2026.usd) and walked by
a port of the CPG gait in [my_robot/joy_input.py](my_robot/joy_input.py)
(`?robot=gecko_py`). There's also a 4-wheel skid-steer rover, `?robot=rover_py`
([public/assets/rover.xml](public/assets/rover.xml)). The original JS
controllers, [src/robots/gecko.js](src/robots/gecko.js) and
[src/robots/rover.js](src/robots/rover.js), are no longer loaded by the page;
gecko.js is kept as the reference that `tools/test_gecko.mjs` checks. A capsule/sphere-only
stock MuJoCo humanoid is also included at
[public/assets/humanoid.xml](public/assets/humanoid.xml) for reference.

## Stack

- [`@mujoco/mujoco`](https://github.com/google-deepmind/mujoco/tree/main/wasm) — official Google DeepMind MuJoCo WASM bindings
- [Three.js](https://threejs.org/) for rendering
- Vite as a plain dev server/bundler (no UI framework)

## Run

```sh
npm install
npm run dev
```

Open the printed local URL in a browser and pick a robot.

## Python robots

Robot controllers can also be written in Python, with no JavaScript needed:
put the MJCF in `public/assets/` and a controller in
`python/robots/<name>.py`, and it appears in the robot menu. The page runs the
controller with [Pyodide](https://pyodide.org), which is only downloaded for
Python robots. The same file also runs on the desktop with native MuJoCo
(`python python/run_local.py <name>`). See [python/README.md](python/README.md);
The examples are [python/robots/rover_py.py](python/robots/rover_py.py)
(`?robot=rover_py`: the rover plus heading hold) and
[python/robots/gecko_py.py](python/robots/gecko_py.py) (`?robot=gecko_py`: a
port of the gecko gait that behaves the same as the JS version).

## Controls

- Drag: orbit camera · Scroll: zoom (the camera follows the robot)
- Up/Down or W/S: walk (gecko) / drive (rover) forward/backward
- Left/Right or A/D: steer
- Gecko only: Q/E pitch the body, F toggles a locked spine (the script's green
  button), `[` / `]` lower/raise step height
- Gamepad (standard mapping): left stick walk, right stick steer (X) / pitch (Y)
- R (hold): reset the simulation and the camera view
- Touch devices (phones/tablets) get an on-screen joystick (up/down walk or
  drive, left/right steer) plus Reset / Lock spine / Hulls buttons; drag the
  scene to orbit, pinch to zoom. Add `?touch` to the URL to force it on desktop.
  Pitch and step height are keyboard/gamepad only.

## The Gecko model

[tools/usd_to_mjcf.py](tools/usd_to_mjcf.py) converts the Isaac-style USD
articulation into MJCF: rigid bodies + mass properties, revolute joints with
their limits and fixed foot joints. Each revolute joint gets a position servo
capped at the USD's 4.1 Nm max force.

Visuals and physics use separate meshes:

- **Physics** (`meshes/*.stl`, geom group 3): a ≤400-triangle convex hull per
  link, which is what the USD colliders (`convexHull`) and MuJoCo's convex
  collision use anyway. Press **C** in the viewer to see them.
- **Visuals** (`gecko_visual.glb`): the full 374k-triangle CAD, welded, with
  35° crease-angle normals (the USD only has flat per-face normals), and
  meshopt-compressed by `gltfpack` (14 MB → 1.7 MB). The viewer places each
  node at its MuJoCo body's pose; physics never sees it.
- **Colours**: the USD's materials are near-white CAD defaults, so the
  converter splits each link into its CAD parts and classifies them by size
  (Dynamixel XM430 cases → `servo`, 19 mm discs → `horn`, <14 mm → `fastener`,
  feet → `rubber`, everything else → `printed`). Colours live in
  `PART_MATERIALS`; the page's **Body** button (top right) opens a palette that
  recolours `printed` live (default black, `bodyColor` in gecko.js) and
  remembers the choice per browser.

Re-run the converter after changing the USD (`npm install` first, for
`gltfpack`):

```sh
pip install usd-core numpy scipy trimesh fast_simplification
python tools/usd_to_mjcf.py my_robot/gecko-aug-2026.usd public/assets/gecko
```

[src/robots/gecko.js](src/robots/gecko.js) runs the gait at 50 Hz simulated
time, mapping the script's servo groups onto the model:

| joy_input.py group | USD joints | sign |
| --- | --- | --- |
| spine (id_15/25/35/45, one shared command) | `joint0_f/m/h` | + |
| shoulder swing (id_11–14) | `joint1_*` | + |
| shoulder stance (id_21–24) | `joint2_*` | − |
| tip (id_41–44) | `joint4_*` | − |
| head (id_55) | — (no head joint in the USD) | |
| — | `joint3_*`, held at 0 | |

Leg order in the script is FL, RL, RR, FR = `lf`, `lh`, `rh`, `rf`. Stance/tip
signs are forced by the USD joint limits; swing/spine signs were picked so
forward stick walks forward. `node tools/test_gecko.mjs` runs the model + gait
headlessly (same WASM build) and prints displacement/heading for walk, turn,
pitch and locked-spine inputs. LEDs and ROS I/O are not simulated.

Two deliberate differences from the script:

- **Lower body**: `STANCE_OFFSET_DEG` is 0° instead of the script's 25°, so the
  belly sits ~7.5 cm off the ground instead of ~10.8 cm, feet still flat.
  Lower stances drift more when walking straight (yaw over 8 s: ~6° at 25°,
  ~22° at 0°); below about −5° the gait hits the stance joints' −10° limit.
- **Pitch** tilts by raising the opposite end (same ±50° range and direction
  as the script, which lowers one end) so it still works at a low stance.

## How it works

[src/main.js](src/main.js) loads the WASM module, fetches the MJCF plus any
`<mesh file=...>` assets into a MuJoCo virtual filesystem, compiles it with
`MjModel.from_xml_string`, and each frame:

1. Sub-steps `mj_step` to catch up to real time at the model's fixed timestep,
   calling the robot's controller before every step
2. Reads `data.geom_xpos` / `data.geom_xmat` (world-space transforms MuJoCo
   already computes for every geom) and applies them to a matching Three.js
   mesh built per geom type (plane / sphere / capsule / cylinder / box / mesh)

Add another robot as a module under [src/robots/](src/robots/) and register it
in `ROBOTS` in `src/main.js`.

## Known limitations

- No heightfield geom rendering; MJCF textures are ignored (planes get a fixed checker)
