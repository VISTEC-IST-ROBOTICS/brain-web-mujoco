"""Gecko quadruped (public/assets/gecko/gecko.xml), controlled from Python.

A port of src/robots/gecko.js, which in turn ports the CPG gait in
my_robot/joy_input.py (MotionControl.publish_continuously). Open with
?robot=gecko_py.
"""

import math

from robots._heading import HeadingHold

TITLE = "Gecko"
USER_CONTROL = True  # driven with the keyboard / gamepad / touch joystick
WATCH_INPUT = {"left_y": 1.0}  # Watch mode: walks straight ahead on its own
# Speed slider: scales the gait rate (and so the top speed). Faster than
# about 1.5x the feet slip and the gecko gets slower again.
SPEED_RANGE = (0.25, 1.5)
DESCRIPTION = "Quadruped with a bending spine, walking with a CPG gait."
THUMBNAIL = "assets/thumbs/gecko_py.jpg"
MODEL = "assets/gecko/gecko.xml"
VISUALS = "assets/gecko/gecko_visual.glb"
BODY_COLOR = "#2b2b2b"  # default for the page's Body colour picker
CAMERA = {"position": [0.55, -0.75, 0.45], "target": [-0.12, 0, 0.1]}
HELP = "F: lock spine · [ / ]: step height · Gamepad: left stick walk, right stick steer/pitch"
BUTTONS = [{"label": "Lock spine", "key": "KeyF", "toggle": True}]

# joy_input.py orders legs Front-Left, Rear-Left, Rear-Right, Front-Right.
LEGS = ["lf", "lh", "rh", "rf"]

# Hardware servo groups -> simulated joints. The script's head servo (id_55)
# has no joint in the USD model; its 4 spine servos all get the same command,
# so each of the USD's 3 spine joints gets that value. joint3_* (no servo
# group in the script) is held at 0.
#
# Signs convert the script's (Dynamixel) angle convention into the USD joint
# convention. Stance/tip are negated: that's the only way the script's ±25°
# stance offsets land inside the USD joint limits (e.g. joint2_lf is
# -10..100°, the script commands FL stance -25°). Swing/spine signs were
# chosen so walk-forward moves the robot forward (see tools/test_gecko.mjs).
JOINT_SIGNS = {"spine": 1, "swing": 1, "stance": -1, "tip": -1}
SPINE_JOINTS = ["joint0_f", "joint0_m", "joint0_h"]

# Standing height: the stance/tip joints' rest bend. joy_input.py uses 25°
# (belly ~10.8 cm off the ground); 0° lowers the body to ~7.5 cm with the
# feet still flat (the tip joints copy the stance joints). Lower stances
# drift more when walking straight (~6° yaw per 8 s at 25°, ~22° at 0°);
# below about -5° the gait hits the stance joints' -10° limit.
STANCE_OFFSET_DEG = 0
PITCH_RANGE = math.radians(50)  # the script's 2 x 25°

RATE = 50  # Hz, same as the ROS node
DT = 1 / RATE
MOVE_TRANSITION_TIME = 1.0


class GeckoGait:
    def __init__(self, stance_offset_deg=STANCE_OFFSET_DEG):
        self.stance_offset = math.radians(stance_offset_deg)
        self.reset()

    def reset(self):
        self.cpg = (1.0, 0.0)
        self.movement_state = "REST"
        self.move_signal = 0.0
        self.steering_signal = 0.0
        self.pitch_signal = 0.0
        self.step_high_signal = 0.0

    def tick(self, left_y, right_x, right_y, fixed_spine=False, step_up=False, step_down=False, trim=0.0):
        """One 50 Hz controller tick, reading the /joy axes the script reads:
        left_y +1 = walk forward, right_x +1 = turn right (the script's
        steering turns toward +right_x), right_y = body pitch. Returns joint
        targets (script convention, radians) keyed by group. trim +1 = turn
        right by lengthening the left legs' strides and shortening the right
        ones' (the steering above does little until about right_x 0.8, too
        coarse for small corrections)."""
        if step_up:
            self.step_high_signal = min(1.0, self.step_high_signal + 0.01)
        elif step_down:
            self.step_high_signal = max(0.0, self.step_high_signal - 0.01)

        if self.movement_state == "REST":
            self.move_signal = 0.0
            if abs(left_y) > 0.02:
                self.movement_state = "MOVE"
        elif abs(left_y) > 0.02:
            vel = -left_y * 2 * math.pi * 1.5
            if self.move_signal < 1:
                self.move_signal += (DT / MOVE_TRANSITION_TIME) * abs(vel)
            else:
                th = vel * DT
                c0, c1 = self.cpg
                self.cpg = (math.cos(th) * c0 - math.sin(th) * c1, math.sin(th) * c0 + math.cos(th) * c1)
        elif self.move_signal > 0:
            self.move_signal -= DT / MOVE_TRANSITION_TIME
        else:
            self.movement_state = "REST"

        c0, c1 = self.cpg
        spine_amp = 0.0 if fixed_spine else math.radians(12)
        spine_forward = c1 * spine_amp
        spine_left = -spine_amp / 2 + c1 * spine_amp / 2
        spine_right = spine_amp / 2 + c1 * spine_amp / 2

        self.steering_signal = 0.9 * self.steering_signal + 0.1 * right_x
        s = self.steering_signal
        forward_w = 1 - abs(s)
        left_w = s if s >= 0 else 0.0
        right_w = -s if s < 0 else 0.0
        spine = forward_w * spine_forward + left_w * spine_left + right_w * spine_right

        swing_amp = math.radians(16)
        left_stride, right_stride = 1 + trim, 1 - trim
        swing = [
            -c1 * swing_amp * (1 - right_w) * left_stride,
            c1 * swing_amp * (1 - right_w) * left_stride,
            c1 * swing_amp * (1 - left_w) * right_stride,
            -c1 * swing_amp * (1 - left_w) * right_stride,
        ]

        stance_amp = math.radians(15) * self.move_signal * (1 + self.step_high_signal)
        self.pitch_signal = 0.1 * right_y + 0.9 * self.pitch_signal
        # The script tilts by lowering one end by up to 2 x its 25° offset; with
        # a lower stance there's no room below, so tilt the same way by raising
        # the opposite end instead (nose-down = rear up, nose-up = front up).
        tilt = PITCH_RANGE * self.pitch_signal
        front = self.stance_offset + max(0.0, -tilt)
        rear = self.stance_offset + max(0.0, tilt)
        stance = [
            -front + c0 * stance_amp,
            rear + c0 * stance_amp,
            -rear + c0 * stance_amp,
            front + c0 * stance_amp,
        ]
        return {"spine": spine, "swing": swing, "stance": stance, "tip": list(stance)}


class Controller:
    rate = RATE

    def __init__(self, robot, stance_offset_deg=STANCE_OFFSET_DEG):
        wanted = SPINE_JOINTS + [f"joint{k}_{leg}" for k in (1, 2, 3, 4) for leg in LEGS]
        missing = [name for name in wanted if name not in robot.actuators]
        if missing:
            raise ValueError(f"gecko model has no actuators {missing}")
        self.gait = GeckoGait(stance_offset_deg)
        self.heading = HeadingHold()  # keeps it walking straight, see _heading.py

    def reset(self):
        self.gait.reset()
        self.heading.reset()

    def step(self, obs):
        joy = obs.joy
        walk = joy.left_y * obs.speed
        t = self.gait.tick(
            walk,
            joy.right_x,
            joy.right_y,
            trim=self.heading.correction(obs, walk, joy.right_x),
            fixed_spine="KeyF" in joy.toggled,
            step_up="BracketRight" in joy.keys,
            step_down="BracketLeft" in joy.keys,
        )
        command = {name: JOINT_SIGNS["spine"] * t["spine"] for name in SPINE_JOINTS}
        for i, leg in enumerate(LEGS):
            command[f"joint1_{leg}"] = JOINT_SIGNS["swing"] * t["swing"][i]
            command[f"joint2_{leg}"] = JOINT_SIGNS["stance"] * t["stance"][i]
            command[f"joint3_{leg}"] = 0.0
            command[f"joint4_{leg}"] = JOINT_SIGNS["tip"] * t["tip"][i]
        return command
