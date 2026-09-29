"""Smoke test for every robot in python/robots/: it loads, the controller
runs, and the simulation stays finite under a few joystick inputs.

    python python/test_robots.py        (or: pytest python/test_robots.py)
"""

import importlib
import math

from run_local import PUBLIC, Sim, robot_names
from simbot import Joy

INPUTS = [Joy(), Joy(left_y=1), Joy(left_y=-1), Joy(left_y=1, right_x=1), Joy(right_y=1)]


def model_missing(name):
    """The MODEL path if that file doesn't exist (the web menu hides such robots too)."""
    model = PUBLIC / importlib.import_module(f"robots.{name}").MODEL
    return None if model.exists() else model


def check(name, seconds=2.0):
    missing = model_missing(name)
    if missing:
        print(f"skip {name}: model {missing.relative_to(PUBLIC.parent)} not found")
        return False
    for joy in INPUTS:
        sim = Sim(name)
        while sim.data.time < seconds:
            sim.step(joy)
        assert all(math.isfinite(v) for v in sim.data.qpos), f"{name}: unstable with {joy}"
    return True


def test_robots():
    for name in robot_names():
        check(name)


if __name__ == "__main__":
    for name in robot_names():
        if check(name):
            print(f"ok  {name}")
