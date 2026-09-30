# How Python controllers drive MuJoCo in the browser

The robot controllers in this repo are written in Python, but in the web page
**MuJoCo is not run from Python**. The physics engine is the official MuJoCo
WebAssembly build, [`@mujoco/mujoco`](https://github.com/google-deepmind/mujoco/tree/main/wasm),
called from JavaScript. Python runs next to it in a separate WebAssembly
runtime, [Pyodide](https://pyodide.org), and never touches MuJoCo: it only
receives numbers and returns numbers. This page explains how the two are
connected.

## Two runtimes in one page

| | MuJoCo | Python controller |
| --- | --- | --- |
| What runs | MuJoCo's C library compiled to WASM (`@mujoco/mujoco`, npm) | CPython compiled to WASM (Pyodide, from a CDN) |
| Called from | JavaScript: [src/main.js](../src/main.js) | JavaScript: [src/robots/python.js](../src/robots/python.js) |
| Owns | `MjModel`, `MjData`, `mj_step`, the simulation loop | `simbot.Runner` and your `Controller` |
| Knows about the other? | No | No: the `mujoco` Python package is not loaded in the browser |

The two runtimes have separate memory. JavaScript sits between them, and
[src/robots/python.js](../src/robots/python.js) together with
[python/simbot.py](../python/simbot.py) form the bridge: JS reads MuJoCo's
arrays, hands them to Python, and writes Python's answer back into MuJoCo.

```
 JavaScript (src/main.js)                     Python in Pyodide (simbot.py + robots/<name>.py)
 ────────────────────────                     ─────────────────────────────────────────────────
 mujoco = await loadMujoco()       (WASM)
 model  = MjModel.from_xml_string(xml, vfs)
 data   = new MjData(model)

 every animation frame:
   for each physics step (model timestep):
     robot.control(data, joy)
       if a control tick is due ────────────> Runner.step_js(time, sticks, keys,
                                                               qpos, qvel, sensordata, ...)
                                                 builds an Observation, by name
                                                 calls Controller.step(obs)
                                                 -> {actuator name: value}
       data.ctrl.set(ctrl) <─────────────────── returns the full ctrl list
     mujoco.mj_step(model, data)
   copy geom poses into Three.js meshes, render
```

## Step by step

### 1. Loading the robot

When a robot is opened ([src/main.js](../src/main.js) and
`loadPythonRobot` in [src/robots/python.js](../src/robots/python.js)):

1. **MuJoCo**: JS loads the WASM module (`loadMujoco()`), fetches the MJCF
   and every `<mesh file=...>` into MuJoCo's virtual filesystem (`MjVFS`),
   compiles the model with `MjModel.from_xml_string` and creates `MjData`.
2. **Python**, in parallel: JS loads Pyodide from the CDN. The Python
   sources were bundled into the page by Vite at build time
   (`import.meta.glob('../../python/robots/*.py', { query: '?raw' })` and
   `simbot.py?raw`), so JS writes them into Pyodide's virtual filesystem
   (`/robot/simbot.py`, `/robot/robots/*.py`), loads any packages they
   import (numpy, scipy) and imports `robots.<name>`.
3. JS reads the module's settings (`MODEL`, `CAMERA`, `BUTTONS`, `VISUALS`,
   `USER_CONTROL`, ...) to set up the page.

### 2. Describing the model to Python: the layout

Python can't look inside `MjModel`, so JS describes it once. `modelLayout()`
in [python.js](../src/robots/python.js) walks the compiled model and records,
for each item, its name and where its values live in MuJoCo's flat arrays:

```js
{
  actuators:  ["TC0", "CF0", ...],        // position = index in data.ctrl
  ctrl_range: [[-1.5, 1.5], null, ...],   // per actuator, null if unlimited
  joints:     [["TC0", qposadr, dofadr], ...],  // hinge/slide joints
  sensors:    [["imu", adr, dim], ...],
  free:       [qposadr, dofadr],          // the root's free joint, or null
}
```

It creates `simbot.Runner(module, layout)`. The Runner keeps the layout,
builds a `RobotInfo` (the lists of names) and constructs your
`Controller(info)`.

### 3. Each control tick

The loop in [src/main.js](../src/main.js) steps physics at the model's
fixed timestep to keep up with real time, and calls `robot.control(data, joy)`
before every `mj_step`. That function only calls Python when the next
control tick is due in **simulated** time (every `1 / rate` seconds,
`rate = 50` by default), so the controller behaves the same whatever the
frame rate. Between ticks `data.ctrl` is left alone, so the actuators hold
their last command.

On a tick, JS calls `Runner.step_js(...)` with:

- the simulated time and the user input (sticks, held keys, toggled keys,
  speed, Watch mode), taken from the keyboard, gamepad or touch joystick;
- `data.qpos`, `data.qvel` and `data.sensordata`: typed arrays that view
  MuJoCo's WASM memory directly.

In Python, `step_js` copies the JS values into Python objects (`.to_py()`)
and passes them to `Runner.step`, which:

1. builds an `Observation` using the layout: `qpos[qposadr]` becomes
   `obs.qpos["TC0"]`, the sensor slices become `obs.sensors`, and the free
   joint's slices become `obs.base_pos`, `obs.base_quat`, `obs.base_vel`.
   In Watch mode the sticks are replaced by the robot's `WATCH_INPUT`;
2. calls `Controller.step(obs)`, which returns `{actuator name: value}`;
3. writes those values into its own control list at each actuator's index.
   Actuators the controller leaves out keep their previous value; an
   unknown name raises an error that lists the real ones;
4. returns the full list.

Back in JS, `call()` converts the list (`.toJs()`), copies it into MuJoCo
with `data.ctrl.set(...)` and frees the Pyodide proxy. The next `mj_step`
applies it: MuJoCo's actuators (usually position servos) turn the targets
into joint torques.

### 4. Reset and errors

- **Reset (R)**: JS resets `MjData` (to the model's first keyframe if it has
  one) and calls `Runner.reset_js(data.ctrl)`. The Runner starts again from
  those controls and calls the controller's `reset()`.
- **Errors**: if Python raises, `call()` catches it, shows the Python
  traceback on the page and stops calling the controller. Physics keeps
  running with the last controls, so the page doesn't freeze.

## The same controller on the desktop

[python/run_local.py](../python/run_local.py) runs the same controller file
with the native `mujoco` Python package. There the roles are the same, just
all in one process:

| | Browser | Desktop (`run_local.py`) |
| --- | --- | --- |
| Physics | MuJoCo WASM, from JavaScript | native `mujoco` package, from Python |
| Layout built by | `modelLayout()` in python.js | `native_layout()` in simbot.py (same format) |
| Calls the controller | `Runner.step_js` (converts JS proxies) | `Runner.step` directly |
| Applies the result | `data.ctrl.set(...)` in JS | `data.ctrl[:] = ...` in Python |

Everything from `Runner.step` down, including your controller, is the same
code in both places. That's the reason for the design: a controller only
sees actuator, joint and sensor **names** and plain floats, never MuJoCo
objects, so it can't come to depend on one environment.

## Consequences for controller code

- **You can't call MuJoCo from a controller** (no `mj_forward`, no reading
  `data.xpos` or contacts). Everything it needs must come through `obs`. To
  give it more information, add a sensor to the MJCF (e.g. `framepos`,
  `framequat`, `touch`, `gyro`): sensors arrive in `obs.sensors` by name.
- **Only the standard library and Pyodide's packages** (numpy, scipy, ...)
  are available in the browser; no files, networking or threads.
- **Cost**: one JS↔Python crossing per control tick, not per physics step,
  copying a few arrays of a few dozen numbers. At 50 Hz this is small next
  to the physics and rendering. A very high `rate` or large sensor arrays
  make the crossing more expensive.
- **Python loads only when needed.** Pyodide (~10 MB) is downloaded when a
  robot is opened, not for the menu: the menu reads `TITLE`, `DESCRIPTION`
  and the other card settings from the files' text.

## Where to look in the code

| File | What it does |
| --- | --- |
| [src/main.js](../src/main.js) | Loads MuJoCo WASM and the model, runs the physics/render loop, calls `robot.control` / `robot.reset` |
| [src/robots/python.js](../src/robots/python.js) | Loads Pyodide and the Python files, `modelLayout()`, the `control`/`reset` bridge, error display |
| [python/simbot.py](../python/simbot.py) | `Runner` (layout → `Observation` → controller → ctrl list), `Joy`, `Observation`, `native_layout()` |
| [python/run_local.py](../python/run_local.py) | The desktop runner using native MuJoCo |
| [python/README.md](../python/README.md) | The controller API: every `obs` field and module setting |
