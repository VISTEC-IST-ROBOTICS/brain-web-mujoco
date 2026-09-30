# Architecture

## Repository layout

```
index.html, src/          the web page
  main.js                 loads MuJoCo WASM + the model, steps physics, renders with Three.js
  robots/python.js        finds python/robots/*.py, runs the chosen one in Pyodide
  landing.js              the robot menu
  loading.js, touch.js    loading screen, on-screen joystick
  robots/gecko.js         original JS gecko gait (not loaded; reference for tools/test_gecko.mjs)
python/
  robots/<name>.py        one controller per robot; files starting with _ are helpers
  robots/_template.py     starting point for a new robot
  simbot.py               the controller API (obs, joy, actuators), shared by web and desktop
  run_local.py            desktop runner with native MuJoCo
  test_robots.py          smoke test for every robot
  README.md               controller API reference
public/assets/<robot>/    MJCF models and meshes, served as static files
public/assets/thumbs/     menu card pictures
tools/
  coppeliasim/            CoppeliaSim .ttt -> URDF -> MJCF pipeline (+ URDF viewer)
  usd_to_mjcf.py          Isaac USD -> MJCF (the gecko)
  b1_to_mjcf.py           Unitree URDF -> MJCF (the B1)
  stl_to_msh.py           shrink STL meshes to MuJoCo's binary .msh
  test_gecko.mjs          headless check of the JS gecko gait
my_robot/                 gecko sources: the USD and the original ROS joystick script
docs/                     these documents
```

## Stack

- [`@mujoco/mujoco`](https://github.com/google-deepmind/mujoco/tree/main/wasm):
  Google DeepMind's official MuJoCo WebAssembly build, for the physics
- [Three.js](https://threejs.org/) for rendering
- [Pyodide](https://pyodide.org) (Python compiled to WebAssembly) for the
  robot controllers, loaded from a CDN only when a robot is opened
- [Vite](https://vite.dev/) as dev server and bundler; no UI framework

## How the page works

1. [src/robots/python.js](../src/robots/python.js) collects every
   `python/robots/*.py` at build time (Vite `import.meta.glob`) and reads the
   menu metadata (`TITLE`, `DESCRIPTION`, `THUMBNAIL`, `USER_CONTROL`,
   `HIDDEN`) from the file text, so the menu shows without starting Python.
   Robots whose `MODEL` file is missing are left out.
2. When a robot is opened, [src/main.js](../src/main.js) loads the MuJoCo
   WASM module, fetches the MJCF plus every `<mesh file=...>` into MuJoCo's
   virtual filesystem and compiles it. In parallel, Pyodide starts and
   imports the controller.
3. Every frame, `mj_step` is sub-stepped to catch up with real time at the
   model's timestep. The controller is called at its own `rate` (50 Hz by
   default) through [python/simbot.py](../python/simbot.py): it receives an
   `obs` (joystick, joint positions and velocities, sensors, base pose) and
   returns `{actuator name: target}`.
4. Each geom's world transform (`geom_xpos` / `geom_xmat`) is copied onto a
   matching Three.js mesh. Geoms in **group 3** are collision-only and hidden
   when the model has separate visual geoms. A robot can also supply a
   `VISUALS` glTF file (one node per body) for nicer looks than the physics
   meshes, as the gecko does.

In the browser MuJoCo is the WebAssembly build driven from JavaScript, not
the `mujoco` Python package. Python runs separately in Pyodide and only
exchanges numbers with it, which is also why the same controller file runs
unchanged on the desktop. How the two are connected is explained in
[python-js-bridge.md](python-js-bridge.md).

## Known limitations

- No heightfield rendering; MJCF textures are ignored (planes get a fixed checker).
- In the browser, controllers can only use the standard library plus
  packages Pyodide ships (numpy, scipy); no files, networking or threads.
