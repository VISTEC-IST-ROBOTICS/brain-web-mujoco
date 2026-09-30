# Model tools

Scripts that turn a robot description from another tool into an MJCF model
for `public/assets/`. For the full process of adding a robot, see
[adding-a-robot.md](adding-a-robot.md).

| Tool | Input | Used for |
| --- | --- | --- |
| [tools/coppeliasim/](../tools/coppeliasim/) | CoppeliaSim `.ttt` scene | MORF, Red Mirror |
| [tools/usd_to_mjcf.py](../tools/usd_to_mjcf.py) | Isaac Sim USD | Gecko (see [gecko.md](gecko.md)) |
| [tools/b1_to_mjcf.py](../tools/b1_to_mjcf.py) | Unitree URDF + COLLADA meshes | Unitree B1 |
| [tools/stl_to_msh.py](../tools/stl_to_msh.py) | an MJCF using STL meshes | shrinking any model's meshes |

## CoppeliaSim scenes

[tools/coppeliasim/](../tools/coppeliasim/) extracts a robot from a
CoppeliaSim `.ttt` scene. The shell scripts run CoppeliaSim headless; set
`COPPELIASIM_ROOT` to its install directory. Python dependencies:
`pip install -r tools/coppeliasim/requirements.txt`.

| Script | Does |
| --- | --- |
| `export_urdf.sh <scene.ttt> <model_path>` | Exports one model to URDF + COLLADA meshes (`assets_src/<scene>/urdf/`). Flattens each link first, since CoppeliaSim's URDF exporter only handles a joint's first child shape. |
| `extract_scripts.sh <scene.ttt>` | Dumps every Lua script embedded in the scene (`assets_src/<scene>/scripts/`), e.g. the gait to port to Python. |
| `urdf_viewer/server.py` | Browser viewer with joint sliders for the exported URDFs, to check the export. |
| `urdf_to_mjcf.py <model.urdf>` | URDF → MJCF: meshes to STL, placeholder inertia where missing, free joint, a position actuator per joint, floor (`assets_src/<scene>/mujoco/`). |

The step-by-step walkthrough, including the hand clean-up the generated MJCF
needs, is [path A in adding-a-robot.md](adding-a-robot.md#path-a-from-a-coppeliasim-scene).

## Unitree B1

[tools/b1_to_mjcf.py](../tools/b1_to_mjcf.py) builds the B1 from Unitree's
`b1_description` URDF ([unitree_ros](https://github.com/unitreerobotics/unitree_ros/tree/master/robots/b1_description),
BSD-3-Clause). It keeps the URDF's bodies, joints, masses and inertias, but
replaces the CAD meshes for physics with simple shapes (box trunk, capsule
legs, sphere feet) and uses simplified CAD meshes for looks only. That's a
good pattern for any heavy robot with detailed CAD.

```sh
pip install trimesh pycollada fast-simplification rtree scipy numpy
python tools/b1_to_mjcf.py path/to/b1.urdf path/to/meshes public/assets/b1
```

## Smaller mesh files

STL repeats every shared vertex (about 50 bytes per triangle), which slows
the page down. [tools/stl_to_msh.py](../tools/stl_to_msh.py) converts a
model's STLs to MuJoCo's binary `.msh` (each vertex stored once): about a
third of the size, exactly the same geometry. Red Mirror's meshes went from
11.9 MB to 4.3 MB this way.

```sh
pip install trimesh
python tools/stl_to_msh.py public/assets/red_mirror/red_mirror.xml assets_src/red_mirror/meshes
```

The second argument is where the original STLs are kept, to convert from
again; the `.msh` files are written into the model's mesh directory and the
XML is updated to use them.
