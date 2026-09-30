# Tutorial: adding a new robot

A robot in this simulator is two files:

1. **A MuJoCo model**: `public/assets/<name>/<name>.xml` plus its meshes.
2. **A Python controller**: `python/robots/<name>.py`.

Once both exist, the robot appears in the web page's menu and opens at
`?robot=<name>`. No JavaScript is needed. The controller also runs on the
desktop with native MuJoCo, which is where you'll do most of the debugging.

```
 CoppeliaSim .ttt ──export_urdf.sh──> URDF + .dae ──urdf_to_mjcf.py──┐
 other URDF ─────────────────────────────────────────urdf_to_mjcf.py─┤
 Isaac USD ──────────────────────────────────────────usd_to_mjcf.py──┤
 existing MJCF ──────────────────────────────────────────────────────┤
                                                                     v
                                   hand clean-up, stl_to_msh.py ─> public/assets/<name>/<name>.xml
                                                                     │
                   python/robots/_template.py ─> python/robots/<name>.py (controller)
                                                                     │
                            run_local.py, test_robots.py, npm run dev (test)
```

The steps:

1. [Get an MJCF model](#1-get-an-mjcf-model), from a CoppeliaSim scene
   (path A), a URDF (path B) or an MJCF you already have (path C)
2. [Clean up the model](#2-clean-up-the-model)
3. [Check that it stands](#3-check-that-it-stands)
4. [Write the controller](#4-write-the-controller)
5. [Give it a menu card](#5-give-it-a-menu-card)
6. [Test and ship](#6-test-and-ship)

Throughout, the example robot is called `hexbot`. Use your robot's name in
lowercase with underscores: it becomes the file names and the URL.

## Setup

```sh
npm install                                        # web page (needs Node.js)
python -m venv .venv && source .venv/bin/activate
pip install -r tools/coppeliasim/requirements.txt  # mujoco, trimesh, pycollada, numpy
```

For path A you also need [CoppeliaSim](https://www.coppeliarobotics.com/)
(the scripts were written against CoppeliaSim Edu 4.10 on Ubuntu 24.04).
Point `COPPELIASIM_ROOT` at the install directory, the one containing
`coppeliaSim.sh`:

```sh
export COPPELIASIM_ROOT=~/Research/coppelia/CoppeliaSim_Edu_V4_10_0_rev0_Ubuntu24_04
```

---

## 1. Get an MJCF model

### Path A: from a CoppeliaSim scene

This is how MORF and Red Mirror were brought in. The scripts in
[tools/coppeliasim/](../tools/coppeliasim/) run CoppeliaSim headless (no
window), so they also work over SSH.

**A1. Find the model's root in the scene.** Open the `.ttt` in CoppeliaSim
and look at the scene hierarchy: the robot's top object (usually the body)
is the model root. Its scene path is `/` plus its alias, for example `/morf`
in `MORF_BasicLocomotionLearning.ttt` or `/body_carbon_rod` in
`Red_mirror_model_walking.ttt`.

**A2. Export it to URDF.**

```sh
tools/coppeliasim/export_urdf.sh path/to/HexBot.ttt /hexbot_body
# -> assets_src/HexBot/urdf/HexBot.urdf plus one .dae mesh per visual shape
```

Look for `URDF exported to ...` in the output. Lines about a missing Python
module `cbor2` come from CoppeliaSim's optional Python interpreter and can
be ignored.

CoppeliaSim's own URDF exporter only picks up a joint's *first* child shape
and only joints that are *direct* children of it. Real scenes nest shapes
(visual meshes under dynamic shapes, sensors, sub-parts), so
[export_urdf.lua](../tools/coppeliasim/export_urdf.lua) first flattens each
link in the loaded copy of the scene: every shape, joint and force sensor
under a link is reparented onto the link's first shape, keeping its pose.
The `.ttt` file itself is not modified. Set `URDF_OPTS` to pass
`simURDF.export` option bits if you need them.

**A3. Check the export in the URDF viewer.**

```sh
python tools/coppeliasim/urdf_viewer/server.py     # open http://localhost:8000/viewer/
```

It lists every `assets_src/*/urdf/*.urdf`, draws it with its meshes and has
a slider per joint. Check that the legs are all there, that each joint turns
the part you expect around the right axis, and that the limits look right.
Problems here mean the scene hierarchy needs fixing in CoppeliaSim before
exporting again.

**A4. Extract the scene's scripts** (optional, but usually wanted: this is
where the robot's existing controller lives).

```sh
tools/coppeliasim/extract_scripts.sh path/to/HexBot.ttt
# -> assets_src/HexBot/scripts/HexBot_<script object>.lua
```

**A5. Convert the URDF to MJCF.**

```sh
python tools/coppeliasim/urdf_to_mjcf.py assets_src/HexBot/urdf/HexBot.urdf
# -> assets_src/HexBot/mujoco/HexBot.xml + meshes/*.stl
```

It prints a summary such as `57 meshes -> STL; 32 bodies, 19 joints;
placeholder inertia on 0 links; 18 actuators`. What the converter does:

- Converts the COLLADA meshes to STL (MuJoCo can't read `.dae`).
- Adds a placeholder `<inertial>` (`--default-mass`, 0.05 kg) to links
  CoppeliaSim wrote without one (non-dynamic shapes). If the summary reports
  any, check those links: they need real masses.
- Keeps visual meshes and collision shapes apart: meshes become visual-only
  geoms (`group="1"`, no contacts), CoppeliaSim's pure (primitive) shapes do
  the colliding.
- Gives the root body a free joint (`--fixed-base` for a robot bolted to the
  world, like an arm).
- Adds a position actuator per hinge/slide joint, named after the joint,
  with `kp=10`, `kv=0.5` (`--kp`, `--kv`, or `--no-actuators`), its control
  range set to the joint's limits, and the `implicitfast` integrator.
- Adds a floor and lights, and places the robot centred on the floor with
  2 mm clearance (`--no-floor` to skip).

Now go to [step 2](#2-clean-up-the-model).

### Path B: from a URDF

`urdf_to_mjcf.py` is written for CoppeliaSim's URDF but works with most
URDFs whose meshes sit next to the `.urdf` file:

```sh
python tools/coppeliasim/urdf_to_mjcf.py path/to/robot.urdf assets_src/hexbot/mujoco
```

If the URDF uses `package://` paths or xacro, resolve those first (run
`xacro`, copy the meshes next to the URDF). For large CAD meshes, see
[tools/b1_to_mjcf.py](../tools/b1_to_mjcf.py): it builds the Unitree B1 from
its URDF with simplified visual meshes and simple collision shapes (box
trunk, capsule legs, sphere feet), which is what a heavy robot needs to walk
fast and stably.

### Path C: you already have an MJCF

For example from [MuJoCo Menagerie](https://github.com/google-deepmind/mujoco_menagerie).
Copy it with its meshes into `public/assets/hexbot/`, make sure it has a
floor, and that its actuators are what your controller will command
(position servos are the easiest to start with). Then go to step 2.

(An Isaac Sim USD is also possible: see [tools/usd_to_mjcf.py](../tools/usd_to_mjcf.py),
which built the gecko.)

---

## 2. Clean up the model

A converted model loads, but rarely behaves right straight away. Move it
into the served folder first:

```sh
mkdir -p public/assets/hexbot
cp assets_src/HexBot/mujoco/HexBot.xml public/assets/hexbot/hexbot.xml
cp -r assets_src/HexBot/mujoco/meshes public/assets/hexbot/
```

Then go through this checklist with the XML open. Each item is something
the MORF or Red Mirror models needed.

- [ ] **Model name**: `<mujoco model="hexbot">`.
- [ ] **Masses.** Compare the total with the real robot:
  `python -c "import mujoco; m = mujoco.MjModel.from_xml_path('public/assets/hexbot/hexbot.xml'); print(m.body_mass.sum())"`.
  Scene values can be wrong: MORF's scene had 0.82 kg on each leg's first
  link where 0.082 kg was meant. Wrong masses make the robot sag, tip over,
  or blow up.
- [ ] **Unwanted joints and actuators.** Scenes can contain joints the robot
  doesn't use: Red Mirror had leg-mount slide joints (`L1..L3`, `R1..R3`)
  that let the legs slide off the body. Delete such a `<joint>` (the body
  is then welded to its parent) and its `<position>` actuator.
- [ ] **Feet touch the ground.** CoppeliaSim often marks small foot shapes as
  non-colliding, which the converter keeps as `contype="0" conaffinity="0"`.
  Red Mirror's `FOOT_*` spheres had this and its legs sank through the
  floor. Remove those two attributes from the foot geoms.
- [ ] **Hide the collision shapes in the web page.** If the robot has visual
  meshes, add `group="3"` to the collision geoms (the primitive boxes,
  cylinders and spheres). The page hides group 3 when a model has visual
  geoms, so you see the meshes and not the boxes. MuJoCo's desktop viewer
  still shows group 3 (toggle it with the `3` key), which helps debugging.
- [ ] **Body colour (optional).** To get the page's **Body** colour picker,
  give the shell parts one shared material named `printed`, in place of
  their `rgba`. Add `<material name="printed" rgba="0.3 0 0 1"/>` to
  `<asset>`, and use `material="printed"` on those geoms. MORF's leg
  shells and Red Mirror's red links are done this way. The material's
  colour is the default; `BODY_COLOR` in the `.py` overrides it.
- [ ] **Floor.** The converter's floor is fine; a simple coloured one also
  works: `<geom name="floor" type="plane" size="0 0 0.05" condim="3" rgba="0.2 0.3 0.4 1"/>`.
- [ ] **Actuator strength.** The default `kp=10` suits robots of about 1 kg
  with light legs. A heavier robot needs stronger servos: raise `kp` until
  it holds its pose (step 3), and add `forcerange="-T T"` to the actuator
  to cap the torque at the real motor's stall torque `T` (N·m).
- [ ] **Smaller meshes.** Convert the STLs to `.msh` (a third of the size, the
  same geometry), keeping the STLs in `assets_src/` to convert from again:

  ```sh
  python tools/stl_to_msh.py public/assets/hexbot/hexbot.xml assets_src/HexBot/mujoco/meshes
  ```

  Try to keep a robot's files under ~5 MB; the page downloads them on every
  visit.

## 3. Check that it stands

Start a controller from the template:

```sh
cp python/robots/_template.py python/robots/hexbot.py
```

and set `MODEL` in it:

```python
MODEL = "assets/hexbot/hexbot.xml"  # relative to public/
HIDDEN = True                       # keep it out of the menu until it works
```

The template sends no commands, so every position actuator holds its joint
at 0. Run it:

```sh
python python/run_local.py hexbot
```

The robot should drop onto the floor and stand (or fold up, if 0 isn't a
standing pose) without jittering, drifting or flying away. If it blows up
(`Nan, Inf or huge value in QACC` in `MUJOCO_LOG.TXT`), look at masses and
inertias first, then at `kp`/`kv` on very light links, then try a smaller
`<option timestep="0.001"/>`. See [Troubleshooting](#troubleshooting).

Print the names your controller will use:

```sh
python -c "
import mujoco; m = mujoco.MjModel.from_xml_path('public/assets/hexbot/hexbot.xml')
print('actuators:', [m.actuator(i).name for i in range(m.nu)])
print('joints:', [m.joint(i).name for i in range(m.njnt)])"
```

## 4. Write the controller

A controller is a class with a `step(obs)` method that returns
`{actuator name: target}`. The complete API (every `obs` field and module
constant) is in [python/README.md](../python/README.md). A minimal standing
pose with a walk command:

```python
import math

MODEL = "assets/hexbot/hexbot.xml"
TITLE = "HexBot"
USER_CONTROL = True              # driven with keyboard / gamepad / touch joystick
WATCH_INPUT = {"left_y": 1.0}    # Watch mode: walks forward on its own

STAND = {"CF0": -0.5, "FT0": 1.7}  # ... one entry per actuator


class Controller:
    rate = 50  # control ticks per simulated second

    def __init__(self, robot):
        # Fail early with a clear message if the model's names don't match.
        missing = [n for n in STAND if n not in robot.actuators]
        if missing:
            raise ValueError(f"hexbot model has no actuators {missing}")
        self.reset()

    def reset(self):  # at start and when the user resets (R)
        self.phase = 0.0

    def step(self, obs):
        self.phase += 2 * math.pi * 1.0 / self.rate * obs.joy.left_y * obs.speed
        targets = dict(STAND)
        targets["TC0"] = 0.3 * math.sin(self.phase)
        return targets
```

### Porting a CoppeliaSim script

The Lua script from step A4 usually has the gait in `sysCall_actuation`.
Red Mirror's is a good example; its port is
[python/robots/red_mirror.py](../python/robots/red_mirror.py):

```lua
function sysCall_actuation()
    o1 = math.sin(count)*0.2
    o2 = math.cos(count)*0.4
    count = count + 0.05
    sim.setJointTargetPosition(L1_joints[1], o2-0.8)   -- /TL0
    ...
```

Translating it:

- **Joint handles become actuator names.** `sim.getObject('/TL0')` is the
  joint `TL0`, and the converter named its actuator `TL0` too, so
  `sim.setJointTargetPosition(h, x)` becomes `targets["TL0"] = x`.
- **Match the rate.** `sysCall_actuation` runs once per CoppeliaSim step,
  50 ms by default, so a script that advances its phase by a fixed amount
  per call walks at a speed tied to that step. Set `rate = 20` (1 / 0.05 s)
  and keep the script's increment, as `red_mirror.py` does, or scale the
  increment to your `rate`.
- **Joint angle conventions** normally survive the URDF export, since the
  joint axes come from the scene. Check the direction of each joint anyway
  with the URDF viewer's sliders.
- **Make it drivable.** An open-loop script walks forward only. Scale the
  phase speed with `obs.joy.left_y` (negative runs the gait backward), and
  steer by shrinking one side's swing with `obs.joy.right_x`, reversing it at
  full stick to turn on the spot. MORF, Red Mirror and the gecko all do this.
- **Walk straight.** Open-loop gaits drift. `robots._heading.HeadingHold`
  adds a steering correction from the base orientation so the robot keeps
  its heading when the user isn't steering:
  `right_x += self.heading.correction(obs, left_y, right_x)`.
- **Ramp in.** Starting a gait at full amplitude from standing often makes
  the robot stumble; fade the amplitude in over about a second.

Debug on the desktop, where `print()`, breakpoints and plots all work:

```sh
python python/run_local.py hexbot                               # viewer; Up/Down latch left_y
python python/run_local.py hexbot --headless --seconds 10 --joy left_y=1
python python/run_local.py hexbot --watch --speed 2
```

In the browser, controllers can import the standard library plus packages
Pyodide ships (numpy and scipy are fine). Shared helpers go in
`python/robots/_<something>.py` (a leading underscore means "not a robot").

## 5. Give it a menu card

The menu reads these constants from the file's text before Python starts,
so they must be plain one-line literals:

```python
TITLE = "HexBot"
DESCRIPTION = "Six-legged robot walking a tripod gait."
THUMBNAIL = "assets/thumbs/hexbot.jpg"
USER_CONTROL = True
```

For the thumbnail, open the robot in the page, frame it nicely, take a
screenshot, and save it as an ~800×500 JPEG in `public/assets/thumbs/`.

Other optional settings, all described in [python/README.md](../python/README.md#controller-file):
`CAMERA` (starting view; set it for robots much bigger or smaller than
~30 cm), `HELP` (extra line in the help box), `BUTTONS` (on-screen buttons
for phones), `SPEED_RANGE` / `DRIVE_SPEED` (speed slider and driving speed),
`VISUALS` (a glTF with nicer meshes than the physics ones).

When the robot works, delete `HIDDEN = True` so it shows in the menu.

## 6. Test and ship

```sh
python python/test_robots.py    # every robot loads and stays stable under a few inputs
npm run dev                     # open http://localhost:5173/?robot=hexbot
```

The page reloads when you save the `.py` file. Python errors show up as a
red box with the traceback; `print()` goes to the browser console (F12).
Try it on a phone too (or add `?touch`): the on-screen joystick drives
`obs.joy` like the keyboard.

Commit `public/assets/hexbot/`, `public/assets/thumbs/hexbot.jpg` and
`python/robots/hexbot.py`. Pushing to `main` deploys the site to GitHub
Pages ([.github/workflows/deploy.yml](../.github/workflows/deploy.yml)).
`assets_src/` holds the conversion inputs and outputs; commit them if you
want the conversion to be reproducible, but the page doesn't need them.

---

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| `export_urdf.sh` prints `URDF export failed` or `object does not exist` | Wrong model path: check the root object's alias in the scene hierarchy (it starts with `/`). |
| Parts or whole legs missing from the URDF | Shapes nested in an unusual way. Check the hierarchy in the URDF viewer; make each moving part a shape under its joint in the scene. |
| `ModuleNotFoundError: cbor2` during export | CoppeliaSim's optional Python interpreter; harmless. |
| Robot explodes at t ≈ 0, `Nan, Inf or huge value in QACC` | Bad mass/inertia (placeholder or typo), or the robot starts inside the floor. Check masses; make sure the root body starts above the floor. |
| Robot sags or can't stand up | Actuators too weak for its mass: raise `kp`, check `forcerange`. |
| Legs pass through the floor | Foot geoms have `contype="0" conaffinity="0"`, or there are no collision shapes on the legs. |
| Legs jitter | `kv` too high for very light links, or `kp` too high for the timestep. Keep `integrator="implicitfast"`, lower `kv`/`kp`, or lower the timestep. |
| Robot walks in circles | Open-loop drift or unequal friction: use `HeadingHold`, check the gait is symmetric. |
| Gait much faster or slower than in CoppeliaSim | Controller `rate` doesn't match CoppeliaSim's step (default 20 Hz). |
| Boxes drawn over the meshes in the page | Collision geoms not in `group="3"`. |
| Robot missing from the menu | `HIDDEN = True`, file name starts with `_`, or `MODEL` points to a file that isn't in `public/` (the browser console says which). |
| Page is slow to load the robot | Meshes too big: run `tools/stl_to_msh.py`, and simplify very dense meshes. |
