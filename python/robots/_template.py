"""Minimal robot template: copy to python/robots/<name>.py, point MODEL at
your MJCF, then pick it in the web page's robot menu or run `uv run python python/run_local.py <name>`.

As written it sends no commands (every actuator stays at 0), so the robot
just stands or falls under gravity: a quick check that a new model loads and
holds together. Files starting with '_' are not robots, so this one is never
loaded itself. Full reference: python/README.md and python/simbot.py.
"""

MODEL = "assets/my_robot.xml"  # relative to public/

# Optional (delete what you don't need):
# TITLE = "My Robot"                       # robot menu card (one-line strings)
# USER_CONTROL = True                      # the user drives it (obs.joy); leave out for robots that run on their own
# WATCH_INPUT = {"left_y": 1.0}            # with USER_CONTROL: a Drive / Watch switch; Watch feeds these sticks
# DESCRIPTION = "What it is and does."
# THUMBNAIL = "assets/thumbs/my_robot.jpg"
# CAMERA = {"position": [0.6, -0.8, 0.5], "target": [0, 0, 0.1]}
# HELP = "Up/Down: ..."
# BUTTONS = [{"label": "Grip", "key": "KeyG", "toggle": True}]
# VISUALS = "assets/my_robot_visual.glb"
# BODY_COLOR = "#2b2b2b"
# SUMMON_SIZE = 1.0                        # summon page: its longest side on the pedestal (set it with the converter's Summon demo)
# SUMMON_POSE = {"joint_name": 0.5}        # summon page: joints posed differently from the start pose (same tool)


class Controller:
    rate = 50  # control ticks per simulated second

    def __init__(self, robot):
        # robot (simbot.RobotInfo), names as written in the XML:
        #   robot.actuators   [name, ...] in model order: the keys step() may return
        #   robot.joints      [name, ...] hinge/slide joints: the keys of obs.qpos / obs.qvel
        #   robot.sensors     [name, ...]: the keys of obs.sensors
        #   robot.ctrl_range  {actuator name: (low, high)} for actuators with a ctrlrange
        self.robot = robot

    def reset(self):
        # Optional: called at start and whenever the simulation resets (R key).
        pass

    def step(self, obs):
        # Called `rate` times per simulated second. obs (simbot.Observation):
        #   obs.time          simulated seconds since reset
        #   obs.joy.left_y    -1..1 forward/back: Up/Down, W/S, gamepad left stick
        #   obs.joy.right_x   -1..1 right/left: Right/Left, D/A, gamepad right stick
        #   obs.joy.right_y   -1..1 up/down: Q/E, gamepad right stick
        #   obs.joy.keys      set of held key codes, e.g. {"Space", "KeyJ", "Digit1"}
        #   obs.joy.toggled   set of BUTTONS toggle keys that are switched on
        #   obs.qpos          {joint name: position} in rad (hinge) or m (slide)
        #   obs.qvel          {joint name: velocity} in rad/s or m/s
        #   obs.sensors       {sensor name: value}: a float, or a tuple for multi-value sensors
        #   obs.base_pos      (x, y, z) of the root body, if it has a free joint (else None)
        #   obs.base_quat     its orientation (w, x, y, z) (else None)
        #   obs.base_vel      its (vx, vy, vz, wx, wy, wz): world linear, body angular (else None)
        #   obs.watching      True in Watch mode (the joy sticks are then WATCH_INPUT)
        #   obs.speed         speed multiplier, 1 = normal (SPEED_RANGE slider / DRIVE_SPEED)
        #
        # Return {actuator name: control value}. The value means whatever the
        # actuator is in the XML (a <position> target in rad/m, a <motor>
        # torque/force, ...). Actuators left out keep their last value; an
        # unknown name raises KeyError. Values aren't clamped here; MuJoCo
        # clamps them to the actuator's ctrlrange if it has one.
        return {}
