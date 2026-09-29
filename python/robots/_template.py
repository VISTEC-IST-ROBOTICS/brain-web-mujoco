"""Minimal robot template: copy to python/robots/<name>.py, point MODEL at
your MJCF, then pick it in the web page's robot menu or run `python python/run_local.py <name>`.

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


class Controller:
    rate = 50  # control ticks per simulated second

    def __init__(self, robot):
        # robot.actuators / robot.joints / robot.sensors: names from the XML
        pass

    def reset(self):
        pass

    def step(self, obs):
        # obs.joy.left_y / right_x / right_y, obs.qpos, obs.qvel, obs.sensors, ...
        return {}  # {actuator name: control value}
