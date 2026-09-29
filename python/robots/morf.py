"""MORF hexapod (public/assets/morf/morf.xml), driven with the gecko's gait.

The CPG from robots/gecko.py adapted to six legs: the same rotating
oscillator (c0, c1), REST/MOVE ramp-in and steering filter, driving a tripod
gait. Legs 0/1/2 are left front/middle/hind, 3/4/5 right front/middle/hind;
each has TC (swings the foot forward/back), CF (lifts it) and FT (tibia).
On every leg TC+ moves the foot forward and CF+ lifts it, so one set of
signs works for all six.
"""

import math

from robots._heading import HeadingHold

TITLE = "MORF"
USER_CONTROL = True  # driven with the keyboard / gamepad / touch joystick
WATCH_INPUT = {"left_y": 1.0}  # Watch mode: walks straight ahead on its own
# Speed slider: scales the gait rate, as for the gecko.
SPEED_RANGE = (0.25, 2.0)
DESCRIPTION = "Six-legged robot walking a tripod gait with the gecko's CPG."
THUMBNAIL = "assets/thumbs/morf.jpg"
MODEL = "assets/morf/morf.xml"  # relative to public/
CAMERA = {"position": [0.5, -0.62, 0.38], "target": [0.04, 0, 0.08]}
HELP = "[ / ]: step height · Gamepad: left stick walk, right stick steer/pitch"

# Tripods: front and hind legs of one side with the middle leg of the other
# move together, half a cycle apart from the other three.
TRIPOD_A = (0, 2, 4)
TRIPOD_B = (1, 3, 5)
LEFT = (0, 1, 2)
FRONT, HIND = (0, 3), (2, 5)

SWING_AMP = math.radians(20)  # TC: foot forward/back
LIFT_AMP = math.radians(25)  # CF: foot up while swinging forward
PITCH_RANGE = math.radians(20)  # CF offset between front and hind legs
GAIT_HZ = 1.5  # at full stick, same as the gecko

RATE = 50  # Hz
DT = 1 / RATE
MOVE_TRANSITION_TIME = 1.0


class MorfGait:
    def __init__(self):
        self.reset()

    def reset(self):
        self.cpg = (1.0, 0.0)
        self.movement_state = "REST"
        self.move_signal = 0.0
        self.steering_signal = 0.0
        self.pitch_signal = 0.0
        self.step_high_signal = 0.0

    def tick(self, left_y, right_x, right_y, step_up=False, step_down=False):
        """One controller tick. left_y +1 = walk forward, right_x +1 = turn
        right, right_y = body pitch. Returns (tc, cf) lists of 6 angles."""
        if step_up:
            self.step_high_signal = min(1.0, self.step_high_signal + 0.01)
        elif step_down:
            self.step_high_signal = max(0.0, self.step_high_signal - 0.01)

        # Oscillator and walk/rest state machine, as in GeckoGait.
        if self.movement_state == "REST":
            self.move_signal = 0.0
            if abs(left_y) > 0.02:
                self.movement_state = "MOVE"
        elif abs(left_y) > 0.02:
            vel = left_y * 2 * math.pi * GAIT_HZ
            if self.move_signal < 1:
                self.move_signal = min(1.0, self.move_signal + (DT / MOVE_TRANSITION_TIME) * abs(vel))
            th = vel * DT
            c0, c1 = self.cpg
            self.cpg = (math.cos(th) * c0 - math.sin(th) * c1, math.sin(th) * c0 + math.cos(th) * c1)
        elif self.move_signal > 0:
            self.move_signal = max(0.0, self.move_signal - DT / MOVE_TRANSITION_TIME)
        else:
            self.movement_state = "REST"

        # Steering: shrink, and at full stick reverse, the swing on the side
        # being turned toward, so MORF can also turn on the spot.
        self.steering_signal = 0.9 * self.steering_signal + 0.1 * right_x
        s = self.steering_signal
        left_scale = 1 - 2 * max(0.0, -s)
        right_scale = 1 - 2 * max(0.0, s)

        self.pitch_signal = 0.1 * right_y + 0.9 * self.pitch_signal
        tilt = PITCH_RANGE * self.pitch_signal  # + = nose down

        c0, c1 = self.cpg
        lift_amp = LIFT_AMP * (1 + self.step_high_signal)
        tc, cf = [0.0] * 6, [0.0] * 6
        for leg in range(6):
            sign = 1 if leg in TRIPOD_A else -1
            # Foot moves forward (c1 rising) while lifted (c0 > 0), back on the ground.
            swing = sign * c1 * SWING_AMP * self.move_signal
            lift = max(0.0, sign * c0) * lift_amp * self.move_signal
            tc[leg] = swing * (left_scale if leg in LEFT else right_scale)
            # CF+ lifts the foot, i.e. lowers the body at that leg.
            cf[leg] = lift + (max(0.0, tilt) if leg in FRONT else 0.0) + (max(0.0, -tilt) if leg in HIND else 0.0)
        return tc, cf


class Controller:
    rate = RATE

    def __init__(self, robot):
        wanted = [f"{j}{leg}" for leg in range(6) for j in ("TC", "CF", "FT")]
        missing = [name for name in wanted if name not in robot.actuators]
        if missing:
            raise ValueError(f"morf model has no actuators {missing}")
        self.gait = MorfGait()
        self.heading = HeadingHold()  # keeps it walking straight, see _heading.py

    def reset(self):
        self.gait.reset()
        self.heading.reset()

    def step(self, obs):
        joy = obs.joy
        walk = joy.left_y * obs.speed
        tc, cf = self.gait.tick(
            walk,
            joy.right_x + self.heading.correction(obs, walk, joy.right_x),
            joy.right_y,
            step_up="BracketRight" in joy.keys,
            step_down="BracketLeft" in joy.keys,
        )
        command = {}
        for leg in range(6):
            command[f"TC{leg}"] = tc[leg]
            command[f"CF{leg}"] = cf[leg]
            command[f"FT{leg}"] = 0.0
        return command
