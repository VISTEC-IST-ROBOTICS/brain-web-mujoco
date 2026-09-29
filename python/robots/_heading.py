"""Heading hold shared by the walking robots (files starting with '_' are
helpers, not robots).

Open-loop gaits drift a little (uneven feet, slipping, the first steps), so
while the user walks without steering this remembers the robot's heading and
asks for a small turn back toward it. Steering by hand, or stopping, takes a
new heading. Each robot decides how to turn by the amount asked (MORF adds it
to its steering, the gecko lengthens the strides on one side).
"""

import math

GAIN = 3.0  # correction per radian of heading error
MAX_CORRECTION = 0.5
STEER_DEADZONE = 0.05
WALK_DEADZONE = 0.02
# The body swings from side to side with every stride (the gecko by ±20°),
# so the heading is averaged over about a stride before it's compared. A
# robot with a slower gait sets HeadingHold.smoothing_time to its cycle time.
SMOOTHING_TIME = 0.5  # s


def yaw(quat):
    """Heading (rad, counter-clockwise from +x) of a (w, x, y, z) quaternion."""
    w, x, y, z = quat
    return math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))


def wrap(angle):
    return (angle + math.pi) % (2 * math.pi) - math.pi


class HeadingHold:
    def __init__(self, smoothing_time=SMOOTHING_TIME):
        self.smoothing_time = smoothing_time
        self.reset()

    def reset(self):
        self.target = None
        self.heading = None  # smoothed
        self.time = None

    def correction(self, obs, left_y, right_x):
        """How much to turn right (+) or left (-), in steering units. left_y
        is the walk input: walking backward, the correction flips so it
        still turns the robot back toward its heading."""
        if obs.base_quat is None:
            return 0.0
        raw = yaw(obs.base_quat)
        if self.heading is None or obs.time < self.time:
            self.heading = raw
        else:
            self.heading = wrap(self.heading + min(1.0, (obs.time - self.time) / self.smoothing_time) * wrap(raw - self.heading))
        self.time = obs.time
        if abs(right_x) > STEER_DEADZONE or abs(left_y) <= WALK_DEADZONE or self.target is None:
            self.target = self.heading
            return 0.0
        error = wrap(self.heading - self.target)  # + = turned left of the target
        correction = max(-MAX_CORRECTION, min(MAX_CORRECTION, GAIN * error))
        return correction if left_y > 0 else -correction
