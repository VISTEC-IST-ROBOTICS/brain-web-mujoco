"""Glue between a Python robot controller and the simulator.

A robot is python/robots/<name>.py defining:

    MODEL = "assets/my_robot.xml"   # MJCF file, relative to public/

    class Controller:
        rate = 50                     # control ticks per simulated second (optional, default 50)

        def __init__(self, robot):    # robot: RobotInfo (names of actuators, joints, sensors)
            ...

        def reset(self):              # optional: called on start and when the sim resets
            ...

        def step(self, obs):          # obs: Observation; return {actuator name: control value}
            return {"motor_left": 0.5}

and optionally
    CAMERA = {"position": [x, y, z], "target": [x, y, z]}   # initial browser camera
    HELP = "Up/Down: drive"                                  # extra line for the browser HUD
    USER_CONTROL = True    # the user drives it via obs.joy (default False: a "watch" robot)
    WATCH_INPUT = {"left_y": 1.0}
        # with USER_CONTROL: adds a Drive / Watch switch to the page (and
        # run_local.py --watch). In Watch mode the controller gets these stick
        # values (left_y / right_x / right_y, others 0) instead of the user's,
        # and obs.watching is True; held/toggled keys still come through.
    BUTTONS = [{"label": "Lights", "key": "KeyL", "toggle": True}]
        # keys for the browser's on-screen touch buttons; toggle keys flip
        # obs.joy.toggled (on the keyboard too), others show up in obs.joy.keys
    VISUALS = "assets/my_robot_visual.glb"  # browser-only visual meshes, one node per body
    BODY_COLOR = "#2b2b2b"                   # default Body colour: recolours the 'printed' material
    SPEED_RANGE = (0.25, 2.0)  # adds a speed slider to Watch mode (multiplier, starts at 1) -> obs.speed
    DRIVE_SPEED = 4.0          # obs.speed while the user drives (default 1)

The same file runs in the browser (Pyodide, via src/robots/python.js) and on
the desktop (python/run_local.py). Both go through Runner below, so a
controller only sees names and plain numbers, never MuJoCo itself.
"""

from dataclasses import dataclass, field, replace

DEFAULT_RATE = 50

# mjtJoint
_FREE, _BALL = 0, 1


@dataclass
class Joy:
    """Operator input, the same in the browser and run_local.py."""

    left_y: float = 0.0  # +1 = forward: Up / W, gamepad left stick up
    right_x: float = 0.0  # +1 = right: Right / D, gamepad right stick right
    right_y: float = 0.0  # +1 = up: Q (E = -1), gamepad right stick up
    keys: frozenset = frozenset()  # held browser keys (KeyboardEvent.code), e.g. {"Space", "KeyJ"}
    toggled: frozenset = frozenset()  # toggle keys (BUTTONS with "toggle") currently switched on


@dataclass
class RobotInfo:
    actuators: list  # actuator names, in model order
    joints: list  # hinge/slide joint names (these appear in Observation.qpos/qvel)
    sensors: list  # sensor names
    ctrl_range: dict  # actuator name -> (low, high), for actuators with ctrlrange set


@dataclass
class Observation:
    time: float  # simulated seconds since reset
    joy: Joy
    qpos: dict  # hinge/slide joint name -> position (rad or m)
    qvel: dict  # hinge/slide joint name -> velocity (rad/s or m/s)
    sensors: dict  # sensor name -> float (1-D sensors) or tuple
    base_pos: tuple = None  # free-joint root body position (x, y, z), if the robot has one
    base_quat: tuple = None  # its orientation quaternion (w, x, y, z)
    base_vel: tuple = field(default=None)  # its (vx, vy, vz, wx, wy, wz), world linear / body angular
    speed: float = 1.0  # Watch mode: the speed slider (SPEED_RANGE); driving: DRIVE_SPEED. 1 = normal
    watching: bool = False  # Watch mode: joy's sticks are WATCH_INPUT, not the user's


class Runner:
    """Drives one Controller. `layout` describes where things live in the
    MuJoCo arrays (built by native_layout() or the browser bridge):

        actuators:  [name, ...]
        ctrl_range: [[low, high] or None, ...]   (one per actuator)
        joints:     [[name, qposadr, dofadr], ...]   hinge/slide only
        sensors:    [[name, adr, dim], ...]
        free:       [qposadr, dofadr] of the root free joint, or None
    """

    def __init__(self, module, layout):
        self.actuators = list(layout["actuators"])
        self.index = {name: i for i, name in enumerate(self.actuators)}
        self.joints = [tuple(j) for j in layout["joints"]]
        self.sensors = [tuple(s) for s in layout["sensors"]]
        self.free = layout["free"]
        ranges = {n: tuple(r) for n, r in zip(self.actuators, layout["ctrl_range"]) if r}
        info = RobotInfo(self.actuators, [j[0] for j in self.joints], [s[0] for s in self.sensors], ranges)
        self.watch_input = dict(getattr(module, "WATCH_INPUT", None) or {})
        unknown = set(self.watch_input) - {"left_y", "right_x", "right_y"}
        if unknown:
            raise ValueError(f"WATCH_INPUT: unknown fields {sorted(unknown)} (use left_y, right_x, right_y)")
        self.controller = module.Controller(info)
        self.rate = getattr(self.controller, "rate", DEFAULT_RATE)
        self.ctrl = [0.0] * len(self.actuators)

    def reset(self, ctrl=None):
        """Returns the control vector to start from: `ctrl` (the model's start
        keyframe's, if it has one) or all zeros."""
        self.ctrl = [float(c) for c in ctrl] if ctrl is not None else [0.0] * len(self.actuators)
        if hasattr(self.controller, "reset"):
            self.controller.reset()
        return self.ctrl

    def reset_js(self, ctrl):
        """Browser entry point for reset(): ctrl arrives as a JS typed array."""
        return self.reset(list(ctrl.to_py()))

    def step(self, time, joy, qpos, qvel, sensordata, speed=1.0, watch=False):
        """One control tick. Returns the full control vector; actuators the
        controller leaves out keep their previous value. watch: Watch mode
        (the sticks come from WATCH_INPUT)."""
        if watch and self.watch_input:
            joy = replace(joy, **{"left_y": 0.0, "right_x": 0.0, "right_y": 0.0, **self.watch_input})
        obs = Observation(
            time=time,
            joy=joy,
            speed=float(speed),
            watching=bool(watch),
            qpos={name: float(qpos[a]) for name, a, _ in self.joints},
            qvel={name: float(qvel[d]) for name, _, d in self.joints},
            sensors={
                name: float(sensordata[a]) if dim == 1 else tuple(float(sensordata[a + k]) for k in range(dim))
                for name, a, dim in self.sensors
            },
        )
        if self.free:
            a, d = self.free
            obs.base_pos = tuple(float(qpos[a + k]) for k in range(3))
            obs.base_quat = tuple(float(qpos[a + 3 + k]) for k in range(4))
            obs.base_vel = tuple(float(qvel[d + k]) for k in range(6))

        command = self.controller.step(obs) or {}
        for name, value in command.items():
            if name not in self.index:
                raise KeyError(f"step() returned unknown actuator {name!r}; this robot has {self.actuators}")
            self.ctrl[self.index[name]] = float(value)
        return self.ctrl

    def step_js(self, time, left_y, right_x, right_y, keys, toggled, speed, watch, qpos, qvel, sensordata):
        """Browser entry point: arguments arrive as Pyodide JS proxies."""
        joy = Joy(left_y, right_x, right_y, frozenset(keys.to_py()), frozenset(toggled.to_py()))
        return self.step(time, joy, qpos.to_py(), qvel.to_py(), sensordata.to_py(), speed, watch)


def native_layout(model):
    """Runner layout from a native `mujoco.MjModel`."""
    import mujoco

    def name(obj, i, prefix):
        return mujoco.mj_id2name(model, obj, i) or f"{prefix}{i}"

    joints, free = [], None
    for j in range(model.njnt):
        kind = int(model.jnt_type[j])
        qadr, dadr = int(model.jnt_qposadr[j]), int(model.jnt_dofadr[j])
        if kind == _FREE:
            free = free or [qadr, dadr]  # the first free joint is the robot's root
        elif kind != _BALL:
            joints.append([name(mujoco.mjtObj.mjOBJ_JOINT, j, "joint"), qadr, dadr])
    return {
        "actuators": [name(mujoco.mjtObj.mjOBJ_ACTUATOR, i, "actuator") for i in range(model.nu)],
        # Unlimited actuators compile to ctrlrange 0 0 (same test as the browser).
        "ctrl_range": [[float(lo), float(hi)] if lo < hi else None for lo, hi in model.actuator_ctrlrange],
        "joints": joints,
        "sensors": [
            [name(mujoco.mjtObj.mjOBJ_SENSOR, i, "sensor"), int(model.sensor_adr[i]), int(model.sensor_dim[i])]
            for i in range(model.nsensor)
        ],
        "free": free,
    }
