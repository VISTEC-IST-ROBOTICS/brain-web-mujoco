"""MILLIS 8-segment millipede robot controller (public/assets/millis8seg/millis8seg.xml).

The gait is the MILLIS project's own: an SO(2) CPG (a pair of coupled tanh
neurons) feeds a PCPG that turns it into a hip (BC) sawtooth and a knee (CF)
lift pulse, and each segment and each side reads that signal from a delay
buffer, so a wave of steps runs down the body and the left and right legs are
half a wave apart. Ported from MILLIS/ros2_ws/src/millis_controller/src
(CPG.py, PCPG.py, maincontroller_sim_v2.py); the controller ran at 10 Hz and the
CPG here still steps at 10 Hz of simulated time (scaled by the speed slider).

Commands are the project's -1..1 values mapped to joint angles the way its
CoppeliaSim script did: L0/R0 (hip) +-90 deg, L1/R1 (knee) 0..90 deg, positive
only. The bend joints (BBH, BBV) stay at 0; the pitch/LSTM reflex isn't ported.
+x is forward. Up/Down walks, Left/Right steers by shortening the strides of
one side (the project's bbh_control_leg) and bending the body: the front bend
joint follows the stick and each one behind it repeats that BEND_DELAY later.
"""

import math

import numpy as np

TITLE = "MILLIS 8-Segment"
USER_CONTROL = True  # driven with the keyboard / gamepad / touch joystick
WATCH_INPUT = {"left_y": 1.0}  # Watch mode: walks straight ahead on its own
SPEED_RANGE = (0.25, 2.0)  # scales the CPG rate
DESCRIPTION = "Eight-segment millipede robot walking a CPG-driven wave gait."
THUMBNAIL = "assets/thumbs/millis8seg.png"
MODEL = "assets/millis8seg/millis8seg.xml"  # relative to public/
CAMERA = {"position": [1.0, -1.0, 0.7], "target": [0.3, 0, 0.05]}
HELP = "Up/Down: walk · Left/Right: steer · [ / ]: CPG frequency · Gamepad: left stick walk, right stick steer"

SEGMENTS = 8
CPG_HZ = 10  # the project's controller rate: one CPG step every 0.1 s
MI = 0.07  # CPG control input (frequency); [ / ] change it as the joypad bumpers did
MI_STEP = 0.005
TAU_SEGMENT = 10  # delay between neighbouring segments, in CPG steps
TAU_JOINT = 5  # delay of the hip behind the knee
TAU_LR = 20  # delay of the right legs behind the left
STEER_SCALE = 0.75  # how much of a stride the inner side loses at full stick
WARMUP_STEPS = 150  # CPG steps run before the first start, so every segment's delay buffer already holds the wave
HIP_RANGE = math.pi / 2  # command 1 = 90 deg
KNEE_RANGE = math.pi / 2
BEND = 0.5  # rad per bend joint at full steering (curves the body into the turn)
BEND_DELAY = 0.5  # s each bend joint lags the one in front of it, so the bend runs from front to back


class CPG:
    """Two coupled tanh neurons, a discrete rotating oscillator."""

    def __init__(self):
        self.mi = MI
        self.reset()

    def reset(self):
        self.out = np.array([0.1, 0.1])

    def step(self):
        w = np.array([[1.4, 0.18 + self.mi], [-0.18 - self.mi, 1.4]])
        self.out = np.tanh(w @ self.out)


class DCE:
    """Turns the CPG's first output into a sawtooth / pulse by timing how long it is above and below mu0."""

    def __init__(self, mu0, mu1):
        self.mu0, self.mu1 = mu0, mu1
        self.reset()

    def reset(self):
        self.up = self.down = 0
        self.up_max = self.down_max = 0
        self.out = 0.0

    def update(self, cpg):
        if cpg >= self.mu0:
            self.up += 1
            if self.down_max <= self.down:
                self.down_max = self.down
            self.down = 0
        else:
            self.down += 1
            if self.up_max <= self.up:
                self.up_max = self.up
            self.up = 0
        if self.up_max > 0 and self.down_max > 0:
            if cpg >= self.mu0:
                self.out = 2 * self.up / self.up_max - 1
            else:
                self.out = -2 * self.mu1 * self.down / self.down_max + 1
            self.out = max(-1.0, min(1.0, self.out))
        return self.out


class Pcpg:
    """Per-leg commands, each a delayed copy of the hip (BC) and knee (CF) signals."""

    def __init__(self):
        self.reset()

    def reset(self):
        self.bc = DCE(0.86, 1)  # hip: sawtooth
        self.cf = DCE(0.86, 3)  # knee: lift pulse
        self.buffer = np.zeros((2, 300))
        self.left = np.zeros((SEGMENTS, 2))  # [segment] -> (BC, CF), -1..1
        self.right = np.zeros((SEGMENTS, 2))

    def step(self, cpg, direction, steer):
        self.buffer = np.roll(self.buffer, -1, axis=1)
        self.buffer[0, -1] = self.bc.update(cpg[0])
        self.buffer[1, -1] = self.cf.update(cpg[0])
        # steer > 0 turns right: the right side takes shorter strides
        left_scale = 1 - max(0.0, -steer) * STEER_SCALE
        right_scale = 1 - max(0.0, steer) * STEER_SCALE
        for i in range(SEGMENTS):
            lag = TAU_SEGMENT * i
            self.left[i] = (left_scale * direction * self.buffer[0, -1 - TAU_JOINT - lag], self.buffer[1, -1 - lag])
            self.right[i] = (
                right_scale * direction * self.buffer[0, -1 - TAU_JOINT - TAU_LR - lag],
                self.buffer[1, -1 - TAU_LR - lag],
            )


class Controller:
    rate = 50

    def __init__(self, robot):
        wanted = [f"Joint_{j}_s{i}" for i in range(1, SEGMENTS + 1) for j in ("L0", "L1", "R0", "R1")]
        missing = [name for name in wanted if name not in robot.actuators]
        if missing:
            raise ValueError(f"millis8seg model has no actuators {missing}")
        self.cpg = CPG()
        self.pcpg = Pcpg()
        self.reset()

    def reset(self):
        self.cpg.reset()
        self.pcpg.reset()
        for _ in range(WARMUP_STEPS):
            self.cpg.step()
            self.pcpg.step(self.cpg.out, 1, 0.0)
        self.pcpg.left.fill(0)  # parked until the first walk command
        self.pcpg.right.fill(0)
        self.clock = 0.0  # CPG steps owed
        self.steer = 0.0
        self.direction = 0.0
        self.bend_lag = round(BEND_DELAY * self.rate)  # control ticks
        self.steer_history = [0.0] * (self.bend_lag * SEGMENTS + 1)

    def step(self, obs):
        joy = obs.joy
        if "BracketRight" in joy.keys:
            self.cpg.mi = min(0.9, self.cpg.mi + MI_STEP / self.rate)
        elif "BracketLeft" in joy.keys:
            self.cpg.mi = max(0.005, self.cpg.mi - MI_STEP / self.rate)

        walk = joy.left_y
        self.direction = 0.0 if abs(walk) < 0.02 else math.copysign(1.0, walk)
        self.steer = 0.9 * self.steer + 0.1 * joy.right_x

        # The CPG runs at CPG_HZ of simulated time, faster or slower with the speed slider
        if self.direction:
            self.clock += CPG_HZ * obs.speed / self.rate
        while self.clock >= 1.0:
            self.clock -= 1.0
            self.cpg.step()
            self.pcpg.step(self.cpg.out, self.direction, self.steer)
        if not self.direction:
            self.clock = 0.0  # stopped: the CPG and the legs hold their last values, as in the project

        command = {}
        for i in range(SEGMENTS):
            n = i + 1
            lbc, lcf = self.pcpg.left[i]
            rbc, rcf = self.pcpg.right[i]
            command[f"Joint_L0_s{n}"] = lbc * HIP_RANGE
            command[f"Joint_L1_s{n}"] = max(0.0, lcf) * KNEE_RANGE
            command[f"Joint_R0_s{n}"] = -rbc * HIP_RANGE
            command[f"Joint_R1_s{n}"] = -max(0.0, rcf) * KNEE_RANGE
        # The front bend joint (s2) follows the stick at once; each one behind it
        # repeats that after a fixed extra delay.
        self.steer_history.append(self.steer)
        del self.steer_history[0]
        for n in range(2, SEGMENTS + 1):
            command[f"Joint_BBH_s{n}"] = BEND * self.steer_history[-1 - (n - 2) * self.bend_lag]
        return command
