# Adding a robot in Python

You can add a robot to the simulator without writing any JavaScript. A robot
is two files:

1. **The model**: a MuJoCo MJCF file in `public/assets/`, for example
   `public/assets/arm.xml` (put any mesh files next to it or in a subfolder).
2. **The controller**: a Python file in `python/robots/`, for example
   `python/robots/arm.py`.

The same controller file runs in two places:

- **In the web page**, through [Pyodide](https://pyodide.org) (Python compiled
  to WebAssembly). It appears in the page's robot menu automatically, and
  also has its own link: `?robot=arm`.
- **On your computer**, through the normal `mujoco` Python package, with
  MuJoCo's viewer, `print()`, a debugger, matplotlib and so on.

Start from [robots/_template.py](robots/_template.py), the minimal file that
works (it loads the model and sends no commands). Two complete examples:
- [robots/rover_py.py](robots/rover_py.py): wheels plus feedback (heading hold);
- [robots/gecko_py.py](robots/gecko_py.py): a quadruped walking gait (CPG), with
  a visual mesh file, a toggle key and a touch button.

## Controller file

```python
MODEL = "assets/arm.xml"   # relative to public/

# Optional:
TITLE = "Robot Arm"                         # robot menu card: name (default: file name)
DESCRIPTION = "Two-joint arm."               # ...one line (default: the docstring's first paragraph)
THUMBNAIL = "assets/thumbs/arm.jpg"          # ...picture, e.g. an 800x500 screenshot (default: a coloured letter)
USER_CONTROL = True                          # the user drives it with obs.joy (default: False = watch only)
WATCH_INPUT = {"left_y": 1.0}                # with USER_CONTROL: adds a Drive / Watch switch; Watch feeds these stick values
HIDDEN = True                                # leave it out of the menu (work in progress); ?robot=<name> still opens it
SPEED_RANGE = (0.25, 2.0)                    # adds a speed slider to Watch mode (multiplier, starts at 1) -> obs.speed
DRIVE_SPEED = 2.0                            # obs.speed while the user drives (default 1)
CAMERA = {"position": [0.6, -0.8, 0.5], "target": [0, 0, 0.1]}  # starting web camera
HELP = "Up/Down: shoulder, Left/Right: elbow"                     # extra line in the web page's help box
BUTTONS = [{"label": "Grip", "key": "KeyG", "toggle": True}]       # on-screen buttons on phones/tablets
VISUALS = "assets/arm_visual.glb"   # web-only nicer meshes, one node per body name (see tools/usd_to_mjcf.py)
BODY_COLOR = "#2b2b2b"              # default colour for the GLB's 'printed' material


class Controller:
    rate = 50  # control ticks per simulated second (optional, default 50)

    def __init__(self, robot):
        # robot.actuators, robot.joints, robot.sensors: lists of names from the XML
        # robot.ctrl_range: {actuator name: (low, high)}
        self.robot = robot

    def reset(self):  # optional: called at start and when the simulation resets (R)
        pass

    def step(self, obs):
        # Return {actuator name: control value}. Actuators you leave out keep
        # their last value.
        return {"shoulder": 0.5 * obs.joy.left_y}
```

`step()` receives an `obs` with:

| field | meaning |
| --- | --- |
| `obs.time` | simulated seconds since reset |
| `obs.joy.left_y` | forward/back: Up/Down or W/S, gamepad left stick (-1..1) |
| `obs.joy.right_x` | right/left: Right/Left or D/A, gamepad right stick (-1..1) |
| `obs.joy.right_y` | up/down: Q/E, gamepad right stick (-1..1) |
| `obs.joy.keys` | set of held keys in the web page, e.g. `"Space"`, `"KeyJ"`, `"Digit1"` |
| `obs.joy.toggled` | set of toggle keys (`BUTTONS` entries with `"toggle": True`) that are switched on; each key press, or tap on the touch button, flips it |
| `obs.qpos`, `obs.qvel` | `{joint name: position / velocity}` for hinge and slide joints |
| `obs.sensors` | `{sensor name: value}`: a float, or a tuple for multi-value sensors |
| `obs.watching` | `True` in Watch mode (then the `obs.joy` sticks are `WATCH_INPUT`, not the user's) |
| `obs.speed` | a speed multiplier (1 = normal): in Watch mode the speed slider's value (robots with `SPEED_RANGE`), while driving the robot's `DRIVE_SPEED`. What it scales is up to the controller |
| `obs.base_pos`, `obs.base_quat`, `obs.base_vel` | position, (w, x, y, z) orientation and velocity of a free-floating robot's root body (`None` if it has no free joint) |

`TITLE`, `DESCRIPTION` and `THUMBNAIL` must be plain one-line strings, and
`USER_CONTROL` a plain `True`: the menu reads them from the file's text, so it
doesn't have to load Python first.

`USER_CONTROL = True` marks a robot the user drives. Its menu card says
**Drive**, its page says *Drive mode* and lists the driving keys, and phones
get the on-screen joystick. Without it the robot is **Watch** only: no
driving keys or joystick, just its own `BUTTONS` (like a pause toggle).

A robot that can do both also sets `WATCH_INPUT`, the stick values to use
when nobody is driving (e.g. `{"left_y": 1.0}` = walk straight ahead). Its
card says **Drive · Watch**, and the page starts in Drive with a
Drive / Watch switch (or the M key; `?robot=gecko&mode=watch` opens in Watch).
In Watch the controller gets `WATCH_INPUT` as `obs.joy`'s sticks, so it
needs no extra code; held and toggled keys still come through, and
`obs.watching` tells it which mode it's in if it wants to behave differently.

The controller only works with names and numbers. It never touches MuJoCo
directly, which is why the same file runs in both places. The details are in
[simbot.py](simbot.py).

**Limits in the browser:** use the standard library, plus packages Pyodide
ships (numpy and scipy work; they're downloaded the first time a robot
imports them). Other files in `python/robots/` whose names start with `_`,
such as `_gait.py`, can hold shared helpers: `from robots._gait import ...`.
For example [robots/_heading.py](robots/_heading.py) keeps a walking robot
on a straight line; the gecko, MORF and Red Mirror use it. No file access, networking or threads.

## Working locally

```sh
pip install mujoco
python python/run_local.py arm                     # viewer window
python python/run_local.py arm --headless --seconds 5 --joy left_y=1
python python/run_local.py gecko --joy left_y=1 toggled=KeyF   # keys=/toggled= take comma-separated codes
python python/run_local.py red_mirror --watch --speed 2        # like the page's speed slider
python python/run_local.py gecko --watch                       # Watch mode (WATCH_INPUT)
python python/test_robots.py                       # smoke test for every robot
```

In the viewer, MuJoCo only reports key presses (not releases), so the keys
latch: Up/Down change `left_y` by 0.5 per press, Left/Right change `right_x`,
Delete zeroes them, Backspace resets. For held or toggled keys, pass them
with `--joy` (see above). The viewer also shows collision shapes (geom group
3) for robots whose only looks are a `VISUALS` file, which it can't read. On macOS use `mjpython` instead of `python`.

To try it in the web page (this needs [Node.js](https://nodejs.org), but no JavaScript):

```sh
npm install        # once
npm run dev        # then open http://localhost:5173 and pick your robot
```

The page reloads when you save a `.py` file. Python errors appear as a red box
with the traceback, and `print()` output goes to the browser console (F12).
