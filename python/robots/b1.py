"""Unitree B1 quadruped (public/assets/b1/b1.xml), trotting.

Model: built by tools/b1_to_mjcf.py from Unitree's b1_description URDF
(unitree_ros, BSD-3-Clause). 62.6 kg, 12 joints: per leg (FR, FL, RR, RL) a
hip (sideways), thigh and calf joint; thigh + moves the foot back, calf is
the knee (negative = bent).

Controller: a trot in joint space. Diagonal legs (FR + RL, FL + RR) swing
together: each foot lifts (knee bends) while it moves forward and pushes back
on the ground. The steps keep a steady 2 Hz rhythm whenever it moves (a trot
needs it to stay balanced); the sticks set each side's stride length instead:
forward stick plus / minus steering, so full steering alone turns it on the
spot. Same walk/stop ramp and heading hold as the other robots.

A 62 kg trotting robot can't balance open-loop (it rolls a bit more each
step and tips over within seconds), so two feedback terms from the body's
orientation and velocity keep it up:
- levelling: legs on the side / end that's sinking extend, the others shorten;
- foot placement (Raibert's rule): the hips swing the legs out toward the
  direction the body drifts sideways, to catch it.
"""

import math

from robots._heading import HeadingHold

TITLE = "Unitree B1"
# Work in progress: trots forward at any speed, but falls over walking
# backward or turning sharply. Hidden from the menu; ?robot=b1 opens it.
HIDDEN = True
USER_CONTROL = True  # driven with the keyboard / gamepad / touch joystick
WATCH_INPUT = {"left_y": 1.0}  # Watch mode: trots straight ahead on its own
SPEED_RANGE = (0.25, 1.5)  # Watch mode's speed slider: scales the stride
DESCRIPTION = "Unitree's 62 kg industrial quadruped, trotting with an open-loop gait."
THUMBNAIL = "assets/thumbs/b1.jpg"
MODEL = "assets/b1/b1.xml"  # relative to public/
CAMERA = {"position": [1.7, -2.1, 1.2], "target": [0, 0, 0.35]}
HELP = "Gamepad: left stick walk, right stick steer"

LEGS = ["FR", "FL", "RR", "RL"]
FRONT = ("FR", "FL")
LEFT = ("FL", "RL")
DIAGONAL_A = ("FR", "RL")  # the other pair moves half a cycle later
RIGHT = ("FR", "RR")
STAND = {"hip": 0.0, "thigh": 0.8, "calf": -1.5}  # rad, as the model's "stand" keyframe

SWING = 0.25  # rad of thigh swing each way at stride 1 (full stick)
MAX_STRIDE = 1.5
LIFT = 0.5  # rad of extra knee bend at the top of a step
GAIT_HZ = 2.0  # steps per second per leg while moving

# Balance feedback gains (see the docstring)
LEVEL_GAIN = 1.0  # rad of leg extension per rad of roll / pitch
PLACE_GAIN = 0.5  # rad of hip swing per m/s of sideways drift
PLACE_LIMIT = 0.35  # rad

RATE = 50  # Hz
DT = 1 / RATE
RAMP_TIME = 0.5  # s for the gait to fade in / out


class Controller:
    rate = RATE

    def __init__(self, robot):
        missing = [f"{leg}_{j}" for leg in LEGS for j in STAND if f"{leg}_{j}" not in robot.actuators]
        if missing:
            raise ValueError(f"b1 model has no actuators {missing}")
        self.heading = HeadingHold()  # keeps it walking straight, see _heading.py
        self.reset()

    def reset(self):
        self.phase = 0.0
        self.amplitude = 0.0  # 0 = standing still, 1 = full trot
        self.steering = 0.0
        self.heading.reset()

    def step(self, obs):
        joy = obs.joy
        walk = joy.left_y * obs.speed
        moving = abs(walk) > 0.02 or abs(joy.right_x) > 0.05
        step = DT / RAMP_TIME
        self.amplitude = min(1.0, self.amplitude + step) if moving else max(0.0, self.amplitude - step)
        if self.amplitude > 0:
            self.phase += 2 * math.pi * GAIT_HZ * DT

        # Turning comes from the left / right stride difference, the same
        # way round walking forward or back, so the heading correction
        # never flips (hence abs(walk)).
        right_x = joy.right_x + self.heading.correction(obs, abs(walk), joy.right_x)
        self.steering = 0.8 * self.steering + 0.2 * right_x
        clamp = lambda v: max(-MAX_STRIDE, min(MAX_STRIDE, v))
        stride = {"left": clamp(walk + self.steering), "right": clamp(walk - self.steering)}

        roll, pitch, drift = self.balance_state(obs)
        place = max(-PLACE_LIMIT, min(PLACE_LIMIT, PLACE_GAIN * drift))

        command = {}
        for leg in LEGS:
            offset = 0.0 if leg in DIAGONAL_A else math.pi
            up = max(0.0, math.cos(self.phase + offset)) * LIFT * self.amplitude  # lifted half of the cycle
            fore = math.sin(self.phase + offset) * SWING * self.amplitude  # -1 back .. +1 forward
            fore *= stride["right" if leg in RIGHT else "left"]
            # Levelling: roll + = left side up, pitch + = nose down.
            side = 1 if leg in LEFT else -1
            end = 1 if leg in FRONT else -1
            extend = LEVEL_GAIN * (-roll * side + pitch * end)
            # Hip + swings the foot toward +y (left) on every leg.
            command[f"{leg}_hip"] = STAND["hip"] + place
            # Thigh -: foot forward. Bending the knee lifts the foot but also
            # pulls it back, so the thigh leans forward by half as much; the
            # same pairing extends / shortens the leg for levelling.
            command[f"{leg}_thigh"] = STAND["thigh"] - fore - 0.5 * (up - extend)
            command[f"{leg}_calf"] = STAND["calf"] - (up - extend)
        return command

    @staticmethod
    def balance_state(obs):
        """Body roll and pitch (rad) and sideways velocity (m/s, + = to the
        body's left)."""
        if obs.base_quat is None:
            return 0.0, 0.0, 0.0
        w, x, y, z = obs.base_quat
        roll = math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y))
        pitch = math.asin(max(-1.0, min(1.0, 2 * (w * y - z * x))))
        yaw = math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))
        vx, vy = obs.base_vel[0], obs.base_vel[1]  # world frame
        drift = -math.sin(yaw) * vx + math.cos(yaw) * vy
        return roll, pitch, drift
