"""Red Mirror hexapod (public/assets/red_mirror/red_mirror.xml).

Red Mirror model by Thirawat Chuthong [thirawat.c_s21[at]vistec.ac.th].
See the paper: https://advanced.onlinelibrary.wiley.com/doi/10.1002/aisy.202500270

    @article{https://doi.org/10.1002/aisy.202500270,
      author = {Chuthong, Thirawat and Büscher, Thies H. and Gorb, Stanislav N. and Manoonpong, Poramate},
      title = {Insect-Inspired Resilient Machines},
      journal = {Advanced Intelligent Systems},
      volume = {8}, number = {1}, pages = {2500270},
      keywords = {central pattern generators, decentralized control, leg amputation, neural control,
                  resilient locomotion, stick insects, walking robots},
      doi = {https://doi.org/10.1002/aisy.202500270}
    }

Controller: the model's CoppeliaSim script (sysCall_actuation), an open-loop
CPG walk, made drivable. Two oscillator outputs, o1 = 0.2 sin(phase) and
o2 = 0.4 cos(phase), drive each leg's coxa (T*), femur (C*) and tibia (F*)
joints as in the script. Here the stick sets how fast (and which way) the
phase runs, and steering scales the coxa swing on one side, reversing it at
full stick to turn on the spot. Watch mode walks it straight ahead, as the
script does. (The model's leg-mount slide joints L1..L3 / R1..R3 were removed:
the legs are fixed to the body.)
"""

import math

from robots._heading import HeadingHold

TITLE = "Red Mirror"
USER_CONTROL = True  # driven with the keyboard / gamepad / touch joystick
WATCH_INPUT = {"left_y": 1.0}  # Watch mode: walks straight ahead at the script's pace
DESCRIPTION = "Stick-insect-inspired hexapod walking with an open-loop CPG gait."
THUMBNAIL = "assets/thumbs/red_mirror.jpg"
MODEL = "assets/red_mirror/red_mirror.xml"  # relative to public/
CAMERA = {"position": [1.0, -1.35, 0.8], "target": [0, 0, 0.08]}  # wider view: the robot is ~0.8 m long
HELP = "Gamepad: left stick walk, right stick steer"
SPEED_RANGE = (0.25, 4.0)  # Watch mode's speed slider: scales how fast the CPG phase advances
DRIVE_SPEED = 4.0  # speed when driving: the script's own pace (1x) is only ~4 cm/s

# CoppeliaSim calls sysCall_actuation once per simulation step and the script
# advances the phase by 0.05 each call, so the gait speed depends on the step
# length. 20 Hz = CoppeliaSim's default 50 ms step (one gait cycle ~6.3 s).
RATE = 20
PHASE_STEP = 0.05

# Legs as the script orders them: its L1/L2/L3 and R1/R2/R3 joint groups are
# the model's legs 0/1/2 (front, middle, hind).
LEFT = ["L0", "L1", "L2"]
RIGHT = ["R0", "R1", "R2"]


def gait_targets(o1, o2, left_swing=1.0, right_swing=1.0):
    """Joint targets (rad) for one tick, {actuator name: angle}; the script's
    L1_joints[1..3] = TL0 / CL0 / FL0 and so on. left_swing / right_swing
    scale each side's coxa swing (1 = the script's gait)."""
    ol, or_ = o2 * left_swing, o2 * right_swing
    coxa = {"L0": ol - 0.8, "L1": -ol, "L2": ol + 0.8, "R0": or_ + 0.8, "R1": -or_, "R2": or_ - 0.8}
    femur = {"L0": -o1 - 0.5, "L1": o1 - 0.5, "L2": -o1 - 0.5, "R0": o1 - 0.5, "R1": -o1 - 0.5, "R2": o1 - 0.5}
    tibia = {"L0": 1.7 + o2, "L1": 1.7 - o2, "L2": 1.7 + o2, "R0": 1.7 - o2, "R1": 1.7 + o2, "R2": 1.7 - o2}
    targets = {}
    for leg in LEFT + RIGHT:
        targets[f"T{leg}"] = coxa[leg]
        targets[f"C{leg}"] = femur[leg]
        targets[f"F{leg}"] = tibia[leg]
    return targets


STEER_DEADZONE = 0.02
RAMP_TIME = 0.5  # s for the gait to fade in when walking starts / out when it stops


class Controller:
    rate = RATE

    def __init__(self, robot):
        missing = [name for name in gait_targets(0, 0) if name not in robot.actuators]
        if missing:
            raise ValueError(f"red_mirror model has no actuators {missing}")
        self.heading = HeadingHold()  # keeps it walking straight, see _heading.py
        self.reset()

    def reset(self):
        self.count = 0.0
        self.amplitude = 0.0  # 0 = standing in the neutral pose, 1 = full gait
        self.steering = 0.0
        self.heading.reset()

    def walk(self, obs, left_y, right_x):
        """One tick: left_y +1 = forward at the script's pace (times the speed
        slider), -1 = backward; right_x +1 = turn right."""
        walking = abs(left_y) > STEER_DEADZONE
        step = 1 / (RATE * RAMP_TIME)
        self.amplitude = min(1.0, self.amplitude + step) if walking else max(0.0, self.amplitude - step)
        # Running the phase backward plays every leg's cycle in reverse:
        # feet lift while moving back, so the robot walks backward.
        self.count += PHASE_STEP * obs.speed * left_y

        if walking:  # average the heading over one gait cycle (the body sways ±5° each)
            self.heading.smoothing_time = min(10.0, 2 * math.pi / (PHASE_STEP * RATE * obs.speed * abs(left_y)))
        right_x += self.heading.correction(obs, left_y, right_x)
        self.steering = 0.8 * self.steering + 0.2 * right_x
        s = self.steering
        left_swing = 1 - 2 * max(0.0, -s)
        right_swing = 1 - 2 * max(0.0, s)

        o1 = math.sin(self.count) * 0.2 * self.amplitude
        o2 = math.cos(self.count) * 0.4 * self.amplitude
        return gait_targets(o1, o2, left_swing, right_swing)

    def step(self, obs):
        return self.walk(obs, obs.joy.left_y, obs.joy.right_x)
