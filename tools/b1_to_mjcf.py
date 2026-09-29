"""Build the Unitree B1 model for the web page from Unitree's URDF.

Source: unitree_ros (BSD-3-Clause), robots/b1_description:
https://github.com/unitreerobotics/unitree_ros/tree/master/robots/b1_description
Download xacro/b1.urdf and the meshes/*.dae it uses, then:

    pip install trimesh pycollada fast-simplification rtree scipy numpy
    python tools/b1_to_mjcf.py path/to/b1.urdf path/to/meshes public/assets/b1

Writes b1.xml plus meshes/*.msh:
- Bodies, joints (with their limits), masses and inertias as in the URDF.
  The motors' rotor links (fixed to their parents) are kept as massive
  child bodies.
- Looks: the CAD meshes (250k triangles for the trunk alone), simplified
  within --tolerance and stored as .msh, visual only (group 1), in one dark
  colour (the URDF paints everything a placeholder orange).
- Physics: simple shapes instead of the CAD meshes, which is what the robot
  needs to walk (and much faster): a box trunk, capsule legs, sphere feet.
  They only collide with the floor.
- A position servo per joint with the URDF's torque limit, and a "stand"
  keyframe the page starts from.
"""

import argparse
import math
import xml.etree.ElementTree as ET
from pathlib import Path

import fast_simplification
import numpy as np
import trimesh

LEGS = ["FR", "FL", "RR", "RL"]
STAND = {"hip": 0.0, "thigh": 0.8, "calf": -1.5}  # rad; ~0.5 m trunk height
STAND_HEIGHT = 0.52  # trunk height at the stand keyframe, feet just on the floor
# Servo stiffness / damping per joint type: Unitree's Gazebo gains
# (config/robot_control.yaml: hip 100/5, thigh and calf 300/8).
GAINS = {"hip": (100.0, 5.0), "thigh": (300.0, 8.0), "calf": (300.0, 8.0)}
COLOR = "0.12 0.12 0.13 1"
MESH_TARGET_FACES = {"trunkb": 30000, "hipb": 5000, "thighb": 6000, "thigh_mirrorb": 6000, "calfb": 4000}


def rpy_to_quat(rpy):
    """URDF roll-pitch-yaw (fixed axes X, Y, Z) -> MuJoCo (w, x, y, z)."""
    r, p, y = rpy
    cr, sr, cp, sp, cy, sy = (math.cos(r / 2), math.sin(r / 2), math.cos(p / 2),
                              math.sin(p / 2), math.cos(y / 2), math.sin(y / 2))
    return (cr * cp * cy + sr * sp * sy, sr * cp * cy - cr * sp * sy,
            cr * sp * cy + sr * cp * sy, cr * cp * sy - sr * sp * cy)


def fmt(values):
    return " ".join(f"{v:.6g}" for v in values)


def floats(text, default="0 0 0"):
    return [float(x) for x in (text or default).split()]


def write_msh(path, vertices, faces):
    with open(path, "wb") as f:
        np.array([len(vertices), 0, 0, len(faces)], np.int32).tofile(f)
        vertices.astype(np.float32).tofile(f)
        faces.astype(np.int32).tofile(f)


def convert_mesh(src, out, target_faces, tolerance_mm):
    """Simplify a .dae toward target_faces, as far as tolerance allows; write .msh."""
    mesh = trimesh.load(src, force="mesh")
    mesh.merge_vertices()
    best = mesh
    for keep in (target_faces / len(mesh.faces), 0.2, 0.3, 0.5):
        if keep >= 1:
            break
        points, faces = fast_simplification.simplify(
            mesh.vertices.astype(np.float32), mesh.faces, target_reduction=1 - keep)
        small = trimesh.Trimesh(points, faces)
        samples, _ = trimesh.sample.sample_surface(mesh, 4000, seed=0)
        _, dist, _ = trimesh.proximity.closest_point(small, samples)
        if dist.max() * 1000 <= tolerance_mm:
            best = small
            print(f"  {src.name}: {len(mesh.faces)} -> {len(small.faces)} faces, max deviation {dist.max() * 1000:.2f} mm")
            break
    else:
        print(f"  {src.name}: {len(mesh.faces)} faces kept (can't simplify within {tolerance_mm} mm)")
    write_msh(out, best.vertices, best.faces)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("urdf", type=Path)
    parser.add_argument("meshes", type=Path, help="folder with the URDF's .dae meshes")
    parser.add_argument("out", type=Path, help="output folder, e.g. public/assets/b1")
    parser.add_argument("--tolerance", type=float, default=5.0, help="mesh simplification limit, mm (default 5; the robot is 1 m long)")
    args = parser.parse_args()

    urdf = ET.parse(args.urdf).getroot()
    links = {l.get("name"): l for l in urdf.findall("link")}
    children = {}
    for j in urdf.findall("joint"):
        children.setdefault(j.find("parent").get("link"), []).append(j)

    (args.out / "meshes").mkdir(parents=True, exist_ok=True)
    used_meshes = set()
    print("meshes:")

    def inertial(link):
        i = link.find("inertial")
        if i is None:
            return ""
        o = i.find("origin")
        pos = floats(o.get("xyz") if o is not None else None)
        t = i.find("inertia").attrib
        full = [float(t[k]) for k in ("ixx", "iyy", "izz", "ixy", "ixz", "iyz")]
        return (f'<inertial pos="{fmt(pos)}" mass="{float(i.find("mass").get("value")):.6g}" '
                f'fullinertia="{fmt(full)}"/>')

    def visuals(link):
        out = []
        for v in link.findall("visual"):
            g = v.find("geometry")[0]
            if g.tag != "mesh":
                continue  # rotor discs and the IMU marker sit inside the shell
            name = Path(g.get("filename")).stem
            used_meshes.add(name)
            o = v.find("origin")
            quat = rpy_to_quat(floats(o.get("rpy") if o is not None else None))
            out.append(f'<geom type="mesh" mesh="{name}" quat="{fmt(quat)}" class="visual"/>')
        return out

    def collisions(name):
        # Hand-fitted to the meshes (trunk box from its bounds, links along -z).
        if name == "trunk":
            return ['<geom type="box" size="0.44 0.13 0.085" pos="0 0 -0.01" class="collision"/>']
        if name.endswith("_thigh"):
            return ['<geom type="capsule" fromto="0 0 -0.04 0 0 -0.3" size="0.045" class="collision"/>']
        if name.endswith("_calf"):
            return ['<geom type="capsule" fromto="0 0 0 0 0 -0.3" size="0.03" class="collision"/>']
        if name.endswith("_foot"):
            return ['<geom type="sphere" size="0.04" class="foot"/>']
        return []

    def body(joint, indent):
        """MJCF for the child link of `joint` (and its subtree)."""
        name = joint.find("child").get("link")
        link = links[name]
        o = joint.find("origin")
        pos = floats(o.get("xyz") if o is not None else None)
        quat = rpy_to_quat(floats(o.get("rpy") if o is not None else None))
        pad = "  " * indent
        attrs = f'name="{name}" pos="{fmt(pos)}"' + ("" if quat == (1, 0, 0, 0) else f' quat="{fmt(quat)}"')
        lines = [f"{pad}<body {attrs}>"]
        if (i := inertial(link)):
            lines.append(f"{pad}  {i}")
        if joint.get("type") == "revolute":
            lim = joint.find("limit")
            kind = joint.get("name").split("_")[1]
            lines.append(f'{pad}  <joint name="{joint.get("name")}" axis="{fmt(floats(joint.find("axis").get("xyz")))}" '
                         f'range="{lim.get("lower")} {lim.get("upper")}" class="{kind}"/>')
        lines += [f"{pad}  {g}" for g in visuals(link) + collisions(name)]
        for child in children.get(name, []):
            if "camera" in child.get("name") or child.get("name") == "imu_joint":
                continue  # massless markers
            lines += body(child, indent + 1)
        lines.append(f"{pad}</body>")
        return lines

    trunk_joint = next(j for j in urdf.findall("joint") if j.find("child").get("link") == "trunk")
    tree = body(trunk_joint, 2)
    tree[0] = tree[0].replace('pos="0 0 0"', f'pos="0 0 {STAND_HEIGHT}"')
    tree.insert(1, "      <freejoint/>")

    for name in sorted(used_meshes):
        convert_mesh(args.meshes / f"{name}.dae", args.out / "meshes" / f"{name}.msh",
                     MESH_TARGET_FACES.get(name, 5000), args.tolerance)

    joints = [j for j in urdf.findall("joint") if j.get("type") == "revolute"]
    effort = {j.get("name"): float(j.find("limit").get("effort")) for j in joints}
    kinds = ["hip", "thigh", "calf"]
    actuators = [f'    <position name="{leg}_{k}" joint="{leg}_{k}_joint" class="{k}" '
                 f'forcerange="{-effort[f"{leg}_{k}_joint"]:.6g} {effort[f"{leg}_{k}_joint"]:.6g}"/>'
                 for leg in LEGS for k in kinds]
    stand = [STAND[k] for leg in LEGS for k in kinds]

    xml = f"""<mujoco model="unitree_b1">
  <!-- Generated by tools/b1_to_mjcf.py from Unitree's b1_description URDF
       (unitree_ros, BSD-3-Clause). Edit the script, not this file. -->
  <compiler angle="radian" meshdir="meshes/" autolimits="true"/>
  <!-- Elliptic friction cones with a high impratio (as MuJoCo Menagerie's
       quadrupeds): stiff friction, so loaded feet don't creep and splay. -->
  <option timestep="0.002" integrator="implicitfast" cone="elliptic" impratio="100"/>

  <default>
    <joint damping="1" armature="0.02" frictionloss="0.2"/>
    <default class="hip"><joint/><position kp="{GAINS['hip'][0]}" kv="{GAINS['hip'][1]}"/></default>
    <default class="thigh"><joint/><position kp="{GAINS['thigh'][0]}" kv="{GAINS['thigh'][1]}"/></default>
    <default class="calf"><joint/><position kp="{GAINS['calf'][0]}" kv="{GAINS['calf'][1]}"/></default>
    <default class="visual">
      <geom contype="0" conaffinity="0" group="1" density="0" rgba="{COLOR}"/>
    </default>
    <default class="collision">
      <!-- collide with the floor only (contype 1 / conaffinity 0) -->
      <geom group="3" contype="1" conaffinity="0" density="0"/>
      <default class="foot">
        <geom friction="0.9 0.02 0.01" condim="3" priority="1" rgba="0.2 0.2 0.2 1" group="1"/>
      </default>
    </default>
  </default>

  <asset>
{chr(10).join(f'    <mesh name="{n}" file="{n}.msh"/>' for n in sorted(used_meshes))}
  </asset>

  <worldbody>
    <geom name="floor" type="plane" size="0 0 0.05" rgba="0.2 0.3 0.4 1" condim="3"/>
{chr(10).join(tree)}
  </worldbody>

  <actuator>
{chr(10).join(actuators)}
  </actuator>

  <keyframe>
    <key name="stand" qpos="0 0 {STAND_HEIGHT} 1 0 0 0 {fmt(stand)}" ctrl="{fmt(stand)}"/>
  </keyframe>
</mujoco>
"""
    (args.out / "b1.xml").write_text(xml)
    print(f"wrote {args.out / 'b1.xml'}")


if __name__ == "__main__":
    main()
