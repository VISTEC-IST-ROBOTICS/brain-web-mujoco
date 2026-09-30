#!/usr/bin/env python3
"""Convert a URDF exported by export_urdf.sh into a MuJoCo MJCF model.

MuJoCo cannot read the exported COLLADA (.dae) meshes, so they are converted to STL first.

Usage: tools/coppeliasim/urdf_to_mjcf.py <model.urdf> [out_dir] [--fixed-base] [--kp N] [--kv N] [--no-actuators]
  default out_dir: <model dir>/../mujoco  ->  <scene>/mujoco/<scene>.xml + meshes/*.stl
  Every hinge/slide joint gets a position actuator (ctrlrange = joint range when limited).
  By default the root body gets a free joint; --fixed-base welds it to the world.
Requires: pip install mujoco trimesh pycollada
"""
import argparse
import shutil
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

import mujoco
import numpy as np
import trimesh


def convert_meshes(root, urdf_dir, mesh_dir):
    """Convert every referenced mesh to STL in mesh_dir and point the URDF at it."""
    mesh_dir.mkdir(parents=True, exist_ok=True)
    done = {}
    for mesh in root.iter("mesh"):
        src = urdf_dir / Path(mesh.get("filename").removeprefix("file://")).name
        if src not in done:
            geom = trimesh.load(src, force="mesh")
            dst = mesh_dir / (src.stem + ".stl")
            geom.export(dst)
            done[src] = dst.name
        mesh.set("filename", done[src])
    return len(done)


def add_missing_inertials(root, mass):
    """CoppeliaSim only writes <inertial> for dynamic links; MuJoCo needs one on every moving body."""
    count = 0
    for link in root.iter("link"):
        if link.find("inertial") is None:
            inertial = ET.Element("inertial")
            ET.SubElement(inertial, "origin", xyz="0 0 0", rpy="0 0 0")
            ET.SubElement(inertial, "mass", value=str(mass))
            i = mass * 2e-3  # ~ a 6 cm cube; only a placeholder
            ET.SubElement(inertial, "inertia", ixx=str(i), iyy=str(i), izz=str(i), ixy="0", ixz="0", iyz="0")
            link.insert(0, inertial)
            count += 1
    return count


def add_position_actuators(tree, kp, kv):
    """One position actuator per hinge/slide joint; ctrlrange follows the joint range when limited."""
    root = tree.getroot()
    for old in root.findall("actuator"):
        root.remove(old)
    actuators = ET.SubElement(root, "actuator")
    count = 0
    for joint in root.find("worldbody").iter("joint"):
        if joint.get("type", "hinge") not in ("hinge", "slide") or joint.get("name") is None:
            continue
        attrs = {"name": joint.get("name"), "joint": joint.get("name"), "kp": str(kp)}
        if kv:
            attrs["kv"] = str(kv)
        if joint.get("range"):
            attrs["ctrlrange"] = joint.get("range")
        ET.SubElement(actuators, "position", attrs)
        count += 1
    return count


def geom_bounds(model):
    """Axis-aligned (min, max) of all geoms, meshes included, in the model's initial pose."""
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)
    lo, hi = np.full(3, np.inf), np.full(3, -np.inf)
    for g in range(model.ngeom):
        rot = data.geom_xmat[g].reshape(3, 3)
        if model.geom_type[g] == mujoco.mjtGeom.mjGEOM_MESH:
            m = model.geom_dataid[g]
            start, n = model.mesh_vertadr[m], model.mesh_vertnum[m]
            pts = model.mesh_vert[start:start + n] @ rot.T + data.geom_xpos[g]
            lo, hi = np.minimum(lo, pts.min(0)), np.maximum(hi, pts.max(0))
        else:
            ext = np.abs(rot) @ model.geom_size[g]
            lo, hi = np.minimum(lo, data.geom_xpos[g] - ext), np.maximum(hi, data.geom_xpos[g] + ext)
    return lo, hi


def add_floor(tree, model, clearance):
    """Add a ground plane at z=0; move the root body so the robot is centred in x/y and rests on it."""
    root = tree.getroot()
    world = root.find("worldbody")
    asset = root.find("asset")
    if asset is None:
        asset = ET.Element("asset")
        root.insert(list(root).index(world), asset)
    ET.SubElement(asset, "texture", name="grid", type="2d", builtin="checker", rgb1="0.35 0.4 0.45",
                  rgb2="0.25 0.3 0.35", width="512", height="512")
    ET.SubElement(asset, "material", name="grid", texture="grid", texrepeat="8 8", reflectance="0.1")
    floor = ET.Element("geom", name="floor", type="plane", size="0 0 0.05", material="grid")
    light = ET.Element("light", name="sun", pos="0 0 3", dir="0 0 -1", directional="true")
    world.insert(0, floor)
    world.insert(0, light)
    base = world.find("body")
    x, y, z = (float(v) for v in base.get("pos", "0 0 0").split())
    lo, hi = geom_bounds(model)
    cx, cy = (lo[:2] + hi[:2]) / 2
    base.set("pos", f"{x - cx:.5f} {y - cy:.5f} {z - lo[2] + clearance:.5f}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("urdf", type=Path)
    ap.add_argument("out_dir", type=Path, nargs="?")
    ap.add_argument("--default-mass", type=float, default=0.05, help="mass (kg) for links without inertial data")
    ap.add_argument("--kp", type=float, default=10.0, help="position actuator gain (default 10)")
    ap.add_argument("--kv", type=float, default=0.5, help="position actuator velocity gain (default 0.5)")
    ap.add_argument("--no-actuators", action="store_true", help="do not add position actuators")
    ap.add_argument("--no-floor", action="store_true", help="do not add a ground plane")
    ap.add_argument("--fixed-base", action="store_true", help="do not add a free joint to the root body")
    args = ap.parse_args()

    urdf = args.urdf.resolve()
    out_dir = (args.out_dir or urdf.parent.parent / "mujoco").resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    mesh_dir = out_dir / "meshes"

    tree = ET.parse(urdf)
    root = tree.getroot()
    n = convert_meshes(root, urdf.parent, mesh_dir)
    filled = add_missing_inertials(root, args.default_mass)

    # MuJoCo reads its compiler options from a <mujoco> element inside the URDF
    mj = ET.SubElement(root, "mujoco")
    ET.SubElement(mj, "compiler", meshdir="meshes", balanceinertia="true", discardvisual="false", fusestatic="false")

    with tempfile.TemporaryDirectory() as tmp:
        tmp_urdf = Path(tmp) / urdf.name
        tree.write(tmp_urdf)
        shutil.copytree(mesh_dir, Path(tmp) / "meshes")
        model = mujoco.MjModel.from_xml_path(str(tmp_urdf))
        out_xml = out_dir / (urdf.stem + ".xml")
        mujoco.mj_saveLastXML(str(out_xml), model)

    out_tree = ET.parse(out_xml)
    world = out_tree.getroot().find("worldbody")
    model_no_floor = None
    if not args.no_floor:
        model_no_floor = mujoco.MjModel.from_xml_path(str(out_xml))
    if not args.fixed_base:
        base = world.find("body")
        if base is not None and base.find("freejoint") is None and base.find("joint[@type='free']") is None:
            base.insert(0, ET.Element("freejoint"))
    if not args.no_actuators:
        add_position_actuators(out_tree, args.kp, args.kv)
        # kv is only stable on light links with an implicit integrator
        option = out_tree.getroot().find("option")
        if option is None:
            option = ET.Element("option")
            out_tree.getroot().insert(1, option)
        option.set("integrator", "implicitfast")
    if not args.no_floor:
        add_floor(out_tree, model_no_floor, 0.002)
    ET.indent(out_tree)
    out_tree.write(out_xml)

    check = mujoco.MjModel.from_xml_path(str(out_xml))
    print(f"wrote {out_xml} ({n} meshes -> STL; {check.nbody} bodies, {check.njnt} joints; placeholder inertia on {filled} links; {check.nu} actuators)")


if __name__ == "__main__":
    main()
