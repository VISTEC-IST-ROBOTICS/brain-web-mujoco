"""Run a Python robot on the desktop with native MuJoCo, same controller code
as the browser.

    pip install mujoco                                  # once
    python python/run_local.py gecko                    # interactive viewer
    python python/run_local.py gecko --headless --seconds 5 --joy left_y=1
    python python/run_local.py gecko --joy left_y=1 toggled=KeyF   # held/toggled keys: comma-separated codes
    python python/run_local.py gecko --watch            # Watch mode: walks on its own

Viewer keys (MuJoCo's viewer only reports key presses, so these latch):
Up/Down change left_y in steps of 0.5, Left/Right change right_x,
Delete zeroes all axes, Backspace resets. On macOS run it with `mjpython`.
"""

import argparse
import importlib
import math
import sys
import time
from pathlib import Path

import mujoco

HERE = Path(__file__).resolve().parent
PUBLIC = HERE.parent / "public"
sys.path.insert(0, str(HERE))

from simbot import Joy, Runner, native_layout  # noqa: E402

# GLFW key codes
KEY_RIGHT, KEY_LEFT, KEY_DOWN, KEY_UP = 262, 263, 264, 265
KEY_DELETE, KEY_BACKSPACE = 261, 259


def robot_names():
    return sorted(p.stem for p in (HERE / "robots").glob("*.py") if not p.stem.startswith("_"))


class Sim:
    """Model + data + controller, stepping the controller at its own rate in
    simulated time and holding its outputs in between (as the browser does)."""

    def __init__(self, name, speed=None, watch=False):
        self.watch = watch  # as the browser's Watch mode (robots with WATCH_INPUT)
        module = importlib.import_module(f"robots.{name}")
        # As the browser: the speed slider's value in Watch mode (starts at
        # 1), the robot's DRIVE_SPEED when driving.
        self.speed = speed if speed is not None else 1.0 if watch else getattr(module, "DRIVE_SPEED", 1.0)
        self.model = mujoco.MjModel.from_xml_path(str(PUBLIC / module.MODEL))
        self.data = mujoco.MjData(self.model)
        self.runner = Runner(module, native_layout(self.model))
        self.reset()

    def reset(self):
        # The model's first keyframe (a start pose) if it has one, as the web page does.
        if self.model.nkey:
            mujoco.mj_resetDataKeyframe(self.model, self.data, 0)
        else:
            mujoco.mj_resetData(self.model, self.data)
        self.data.ctrl[:] = self.runner.reset(self.data.ctrl.copy())
        mujoco.mj_forward(self.model, self.data)
        self.next_tick = 0.0

    def step(self, joy):
        d = self.data
        if d.time >= self.next_tick:
            d.ctrl[:] = self.runner.step(d.time, joy, d.qpos, d.qvel, d.sensordata, self.speed, self.watch)
            self.next_tick += 1 / self.runner.rate
        mujoco.mj_step(self.model, d)


def parse_joy(items):
    joy = Joy()
    for item in items:
        key, _, value = item.partition("=")
        if key in ("keys", "toggled"):
            setattr(joy, key, frozenset(filter(None, value.split(","))))
        elif key in ("left_y", "right_x", "right_y"):
            setattr(joy, key, float(value))
        else:
            raise SystemExit(f"--joy: unknown field {key!r} (use left_y, right_x, right_y, keys, toggled)")
    return joy


def run_headless(sim, joy, seconds):
    d = sim.data
    base = sim.runner.free[0] if sim.runner.free else None
    start = d.qpos[base : base + 3].copy() if base is not None else None
    while d.time < seconds:
        sim.step(joy)
    if not all(math.isfinite(v) for v in d.qpos):
        raise SystemExit("simulation went unstable (non-finite qpos)")
    if base is not None:
        moved = d.qpos[base : base + 3] - start
        print(f"after {d.time:.2f}s: base moved x={moved[0]:+.3f} y={moved[1]:+.3f} z={moved[2]:+.3f} m")
    print("ctrl:", dict(zip(sim.runner.actuators, (round(float(c), 3) for c in d.ctrl))))


def run_viewer(sim, joy):
    import mujoco.viewer

    pending_reset = False

    def on_key(key):
        nonlocal pending_reset
        step = {KEY_UP: ("left_y", 0.5), KEY_DOWN: ("left_y", -0.5), KEY_RIGHT: ("right_x", 0.5), KEY_LEFT: ("right_x", -0.5)}
        if key in step:
            axis, delta = step[key]
            setattr(joy, axis, max(-1.0, min(1.0, getattr(joy, axis) + delta)))
        elif key == KEY_DELETE:
            joy.left_y = joy.right_x = joy.right_y = 0.0
        elif key == KEY_BACKSPACE:
            pending_reset = True
        else:
            return
        print(f"left_y={joy.left_y:+.1f} right_x={joy.right_x:+.1f}")

    with mujoco.viewer.launch_passive(sim.model, sim.data, key_callback=on_key) as viewer:
        # Show collision geoms (group 3) when the model has nothing else to
        # show: in the browser a robot's looks can come from a VISUALS mesh
        # file, which MuJoCo doesn't read. Models with visual-only geoms (e.g.
        # MORF's CAD meshes) keep them hidden, as the web page does.
        m = sim.model
        has_visual_geoms = any(
            not m.geom_contype[i] and not m.geom_conaffinity[i] and m.geom_group[i] != 3 for i in range(m.ngeom))
        viewer.opt.geomgroup[3] = 0 if has_visual_geoms else 1
        wall_start, sim_start = time.perf_counter(), sim.data.time
        while viewer.is_running():
            with viewer.lock():
                if pending_reset:
                    sim.reset()
                    pending_reset = False
                    wall_start, sim_start = time.perf_counter(), sim.data.time
                # Keep simulated time in step with the wall clock.
                target = sim_start + (time.perf_counter() - wall_start)
                while sim.data.time < target:
                    sim.step(joy)
            viewer.sync()
            time.sleep(1 / 120)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("robot", choices=robot_names())
    parser.add_argument("--headless", action="store_true", help="no window; simulate --seconds and print where the robot ended up")
    parser.add_argument("--seconds", type=float, default=5.0)
    parser.add_argument("--joy", nargs="*", default=[], metavar="FIELD=VALUE", help="constant input, e.g. left_y=1 right_x=-0.5 toggled=KeyF")
    parser.add_argument("--speed", type=float, help="speed multiplier (obs.speed); default: DRIVE_SPEED, or 1 with --watch")
    parser.add_argument("--watch", action="store_true", help="Watch mode, as the web page's Drive / Watch switch (WATCH_INPUT)")
    args = parser.parse_args()

    sim = Sim(args.robot, args.speed, args.watch)
    joy = parse_joy(args.joy)
    if args.headless:
        run_headless(sim, joy, args.seconds)
    else:
        run_viewer(sim, joy)


if __name__ == "__main__":
    main()
