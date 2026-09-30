# The Gecko model

The Gecko is a quadruped with a bending spine. Its model
([public/assets/gecko/](../public/assets/gecko/)) is converted from the Isaac
Sim USD in [my_robot/gecko-aug-2026.usd](../my_robot/gecko-aug-2026.usd), and
its controller ([python/robots/gecko.py](../python/robots/gecko.py)) is a port
of the CPG gait in the robot's ROS joystick script,
[my_robot/joy_input.py](../my_robot/joy_input.py).

## Converting the USD

[tools/usd_to_mjcf.py](../tools/usd_to_mjcf.py) converts the Isaac-style USD
articulation into MJCF: rigid bodies and mass properties, revolute joints
with their limits, fixed foot joints, and a position servo per joint capped
at the USD's 4.1 Nm max force. Visuals and physics use separate meshes:

- **Physics** (`meshes/*.stl`, geom group 3): a ≤400-triangle convex hull
  per link, which is what the USD colliders (`convexHull`) and MuJoCo's
  convex collision use anyway.
- **Visuals** (`gecko_visual.glb`): the full 374k-triangle CAD, welded, with
  35° crease-angle normals, meshopt-compressed by `gltfpack` (14 MB → 1.7 MB).
  The page places each node at its MuJoCo body's pose; physics never sees it.
- **Colours**: the converter splits each link into its CAD parts and
  classifies them by size (servo cases, horns, fasteners, rubber feet,
  printed parts; see `PART_MATERIALS`). The page's **Body** button recolours
  the printed parts live and remembers the choice per browser.

Re-run it after changing the USD (`npm install` first, for `gltfpack`):

```sh
pip install usd-core numpy scipy trimesh fast_simplification
python tools/usd_to_mjcf.py my_robot/gecko-aug-2026.usd public/assets/gecko
```

## The gait

The gait maps the script's servo groups onto the model's joints:

| joy_input.py group | USD joints | sign |
| --- | --- | --- |
| spine (id_15/25/35/45, one shared command) | `joint0_f/m/h` | + |
| shoulder swing (id_11–14) | `joint1_*` | + |
| shoulder stance (id_21–24) | `joint2_*` | − |
| tip (id_41–44) | `joint4_*` | − |
| head (id_55) | — (no head joint in the USD) | |
| — | `joint3_*`, held at 0 | |

Leg order in the script is FL, RL, RR, FR = `lf`, `lh`, `rh`, `rf`. The
stance and tip signs are forced by the USD joint limits; the swing and spine
signs were picked so that forward stick walks forward.

Two deliberate differences from the script:

- **Lower body**: the stance offset is 0° instead of the script's 25°, so
  the belly sits ~7.5 cm off the ground instead of ~10.8 cm, feet still flat.
- **Pitch** tilts by raising the opposite end instead of lowering one (same
  ±50° range and direction), so it still works at the low stance.

LEDs and ROS I/O are not simulated.

The original JavaScript version of the gait,
[src/robots/gecko.js](../src/robots/gecko.js), is no longer loaded by the
page; `node tools/test_gecko.mjs` still runs it headlessly with the same
WASM MuJoCo build as a reference.
