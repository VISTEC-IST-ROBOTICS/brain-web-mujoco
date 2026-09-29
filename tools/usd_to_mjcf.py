#!/usr/bin/env python3
"""Convert the Gecko USD articulation (Isaac Sim style) into an MJCF model.

Reads rigid bodies, mass properties, revolute joints (+ limits) and the visual
meshes from the USD stage and writes:

  <out>/gecko.xml          MJCF model (position-servo actuator per revolute joint)
  <out>/meshes/<body>.stl  convex-hull collision mesh per body (MuJoCo physics)
  <out>/gecko_visual.glb   full-resolution visual meshes, one node per body
                           (named after it, in body coordinates) for the viewer

The viewer draws the GLB at each body's simulated pose; the MJCF collision
geoms are in group 3 (MuJoCo's usual "collision only" group).

Requires: usd-core, numpy, scipy, trimesh, fast_simplification
  pip install usd-core numpy scipy trimesh fast_simplification

Usage:
  python tools/usd_to_mjcf.py my_robot/gecko-aug-2026.usd public/assets/gecko
"""
import argparse
import os
import shutil
import subprocess
import tempfile
from xml.sax.saxutils import quoteattr

import fast_simplification
import numpy as np
import trimesh
from pxr import Gf, Usd, UsdGeom, UsdPhysics

# Collision hulls are simplified to at most this many triangles; MuJoCo's
# convex collision only needs the outline.
HULL_FACES = 400

# Visual meshes: faces meeting at more than this angle keep a hard edge.
CREASE_DEG = 35

# Servo model. The USD drives specify maxForce=4.1 Nm (Dynamixel XM430 stall
# torque); stiffness/damping there are PhysX per-degree gains tuned for a
# different solver, so MuJoCo gets its own position-servo gains + armature
# (reflected rotor inertia of a geared servo, keeps the stiff servo stable).
SERVO = dict(kp=12.0, kv=0.25, force=4.1, armature=0.005, damping=0.05)

# Visual materials, one per part class (see classify_part). The USD's own
# materials are near-white CAD defaults, so parts are coloured by what they
# are instead. 'printed' is the body colour the viewer lets users change.
#            name: (sRGB hex, metallic, roughness)
PART_MATERIALS = {
    'printed': ('#4c9a2a', 0.0, 0.55),
    'servo': ('#222326', 0.0, 0.45),
    'horn': ('#c8cacf', 0.85, 0.3),
    'fastener': ('#5a5b60', 0.8, 0.4),
    'rubber': ('#141414', 0.0, 0.9),
}
HULL_RGBA = '0.55 0.75 0.45 1'  # collision hulls (viewer's C toggle)

FOOT_MASS = 0.01  # foot bodies carry no MassAPI in the USD


def gf_to_np(m):
    """Gf.Matrix4d (row-vector convention) -> 4x4 column-vector numpy matrix."""
    return np.array(m, dtype=float).T


def mat_to_pos_quat(T):
    q = Gf.Matrix4d(T.T).ExtractRotationQuat().GetNormalized()
    return T[:3, 3], np.array([q.GetReal(), *q.GetImaginary()])


def fmt(v):
    return ' '.join(f'{x:.6g}' for x in v)


def classify_part(body, extents_mm):
    """Guesses what a CAD part is from its oriented bounding box (mm)."""
    a, b, c = sorted(extents_mm)
    if body.startswith('foot'):
        return 'rubber'
    if 26 <= b <= 31 and 44 <= c <= 49:  # Dynamixel XM430 case, 28.5 x 46.5 mm
        return 'servo'
    if a <= 5.5 and 17 <= b <= 21 and 17 <= c <= 21:  # servo horn / idler disc
        return 'horn'
    if c <= 14:  # screws, nuts, inserts
        return 'fastener'
    return 'printed'


def pca_extents(pts):
    """Box size along the point cloud's principal axes (a cheap oriented
    bounding box; good enough for boxy CAD parts)."""
    if len(pts) < 4:
        return np.zeros(3)
    centred = pts - pts.mean(axis=0)
    axes = np.linalg.svd(centred, full_matrices=False)[2]
    return np.ptp(centred @ axes.T, axis=0)


def split_by_part(body, welded):
    """{part class: face indices}, classifying each connected CAD part."""
    labels = trimesh.graph.connected_component_labels(welded.face_adjacency, node_count=len(welded.faces))
    classes = {}
    for label in np.unique(labels):
        faces = np.flatnonzero(labels == label)
        pts = welded.vertices[np.unique(welded.faces[faces])]
        extents = pca_extents(pts) * 1000
        classes.setdefault(classify_part(body, extents), []).append(faces)
    return {k: np.concatenate(v) for k, v in classes.items()}


def collect_mesh(stage, body_prim, body_world, xc):
    """All visual meshes under body_prim at full resolution, in the body
    frame, welded by position (the USD meshes are unwelded STL-style triangle
    soups with flat per-face normals)."""
    verts, faces = [], []
    inv_body = np.linalg.inv(body_world)
    for p in Usd.PrimRange(body_prim.GetChild('visuals'), Usd.TraverseInstanceProxies()):
        if not p.IsA(UsdGeom.Mesh):
            continue
        m = UsdGeom.Mesh(p)
        pts = np.array(m.GetPointsAttr().Get(), dtype=float)
        counts = np.array(m.GetFaceVertexCountsAttr().Get())
        idx = np.array(m.GetFaceVertexIndicesAttr().Get())
        # fan-triangulate any non-triangle faces
        tris, off = [], 0
        for c in counts:
            for k in range(1, c - 1):
                tris.append((idx[off], idx[off + k], idx[off + k + 1]))
            off += c
        T = inv_body @ gf_to_np(xc.GetLocalToWorldTransform(p))
        pts = pts @ T[:3, :3].T + T[:3, 3]
        base = sum(len(v) for v in verts)
        verts.append(pts)
        faces.append(np.array(tris) + base)
    if not verts:
        return None
    return trimesh.Trimesh(np.vstack(verts), np.vstack(faces), process=True)


def srgb_to_linear(hexcolor):
    c = np.array([int(hexcolor[i:i + 2], 16) / 255 for i in (1, 3, 5)])
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4).tolist()


def visual_part(welded, faces, part):
    """Sub-mesh with crease-angle normals (smooth curves, sharp CAD edges)."""
    sub = welded.submesh([faces], append=True, repair=False)
    tm = trimesh.graph.smooth_shade(sub, angle=np.radians(CREASE_DEG))
    tm.vertex_normals  # computed from the split vertices; cached for export
    hexcolor, metal, rough = PART_MATERIALS[part]
    rgba = [*srgb_to_linear(hexcolor), 1.0]  # glTF colour factors are linear
    tm.visual = trimesh.visual.TextureVisuals(material=trimesh.visual.material.PBRMaterial(
        name=part, baseColorFactor=rgba, metallicFactor=metal, roughnessFactor=rough))
    return tm


def collision_hull(tm):
    """Convex hull for MuJoCo (the USD colliders use convexHull too)."""
    hull = trimesh.Trimesh(tm.vertices, tm.faces, process=True).convex_hull
    if len(hull.faces) > HULL_FACES:
        v, f = fast_simplification.simplify(
            hull.vertices.astype(np.float32), hull.faces.astype(np.int64),
            target_reduction=1 - HULL_FACES / len(hull.faces))
        hull = trimesh.Trimesh(v, f, process=True).convex_hull
    return hull


def write_visual_glb(scene, path):
    """Writes the visual scene, meshopt-compressed with gltfpack (a
    devDependency, run via npx) when available: ~8x smaller at full
    resolution. Falls back to the uncompressed GLB."""
    with tempfile.TemporaryDirectory() as tmp:
        raw = os.path.join(tmp, 'raw.glb')
        with open(raw, 'wb') as f:
            f.write(trimesh.exchange.gltf.export_glb(scene, include_normals=True))
        try:
            # -cc: meshopt compression, -kn/-km: keep named nodes + materials
            subprocess.run(['npx', '--no-install', 'gltfpack', '-i', raw, '-o', path, '-cc', '-kn', '-km'],
                           check=True, capture_output=True)
        except (OSError, subprocess.CalledProcessError) as e:
            print(f'warning: gltfpack unavailable ({e}); writing uncompressed GLB')
            shutil.copy(raw, path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('usd')
    ap.add_argument('out_dir')
    ap.add_argument('--root', default='/Gecko')
    ap.add_argument('--name', default='gecko')
    args = ap.parse_args()

    stage = Usd.Stage.Open(args.usd)
    assert UsdGeom.GetStageUpAxis(stage) == 'Z'
    scale = UsdGeom.GetStageMetersPerUnit(stage)
    assert abs(scale - 1.0) < 1e-9, 'only metre-scale stages supported'
    xc = UsdGeom.XformCache()
    root = stage.GetPrimAtPath(args.root)

    bodies = {}
    for p in root.GetChildren():
        if p.HasAPI(UsdPhysics.RigidBodyAPI):
            bodies[str(p.GetPath())] = p
    world = {k: gf_to_np(xc.GetLocalToWorldTransform(p)) for k, p in bodies.items()}

    # joint tree: child path -> (parent path, joint prim or None for fixed)
    parent_of = {}
    for j in Usd.PrimRange(root):
        if not j.IsA(UsdPhysics.Joint):
            continue
        J = UsdPhysics.Joint(j)
        b0 = str(J.GetBody0Rel().GetTargets()[0])
        b1 = str(J.GetBody1Rel().GetTargets()[0])
        parent_of[b1] = (b0, j if j.IsA(UsdPhysics.RevoluteJoint) else None)

        # Sanity: at q=0 the child frame must coincide with joint frame0.
        lp0, lr0 = J.GetLocalPos0Attr().Get(), J.GetLocalRot0Attr().Get()
        F0 = Gf.Matrix4d().SetRotate(Gf.Rotation(Gf.Quatd(lr0))).SetTranslateOnly(Gf.Vec3d(lp0))
        expected = gf_to_np(F0)  # frame0 is expressed in body0 coords
        rel = np.linalg.inv(world[b0]) @ world[b1]
        err_p = np.abs(rel[:3, 3] - expected[:3, 3]).max()
        err_r = np.abs(rel[:3, :3] - expected[:3, :3]).max()
        if err_p > 1e-4 or err_r > 1e-3:
            print(f'warning: {j.GetName()} child frame off joint frame '
                  f'(dpos={err_p:.2e}, drot={err_r:.2e}); body transform wins')
        lp1, lr1 = J.GetLocalPos1Attr().Get(), J.GetLocalRot1Attr().Get()
        if Gf.Vec3d(lp1).GetLength() > 1e-6 or abs(abs(lr1.GetReal()) - 1) > 1e-6:
            raise SystemExit(f'{j.GetName()}: non-identity localPos1/Rot1 not supported')
        if j.IsA(UsdPhysics.RevoluteJoint) and UsdPhysics.RevoluteJoint(j).GetAxisAttr().Get() != 'Z':
            raise SystemExit(f'{j.GetName()}: only Z-axis revolute joints supported')

    roots = [k for k in bodies if k not in parent_of]
    assert len(roots) == 1, f'expected a single root body, got {roots}'
    children = {}
    for c, (p, _) in parent_of.items():
        children.setdefault(p, []).append(c)

    mesh_dir = os.path.join(args.out_dir, 'meshes')
    os.makedirs(mesh_dir, exist_ok=True)

    assets, actuators = [], []
    visual = trimesh.Scene()

    def emit_body(path, indent):
        prim = bodies[path]
        name = prim.GetName()
        pad = '  ' * indent
        out = []
        if path in parent_of:
            rel = np.linalg.inv(world[parent_of[path][0]]) @ world[path]
        else:
            rel = world[path].copy()
            rel[2, 3] += 0.2  # drop the robot onto the floor from a safe height
        pos, quat = mat_to_pos_quat(rel)
        out.append(f'{pad}<body name="{name}" pos="{fmt(pos)}" quat="{fmt(quat)}">')
        if path not in parent_of:
            out.append(f'{pad}  <freejoint name="root"/>')

        if prim.HasAPI(UsdPhysics.MassAPI):
            M = UsdPhysics.MassAPI(prim)
            pa = M.GetPrincipalAxesAttr().Get()
            out.append(f'{pad}  <inertial pos="{fmt(M.GetCenterOfMassAttr().Get())}" '
                       f'quat="{fmt([pa.GetReal(), *pa.GetImaginary()])}" '
                       f'mass="{M.GetMassAttr().Get():.6g}" '
                       f'diaginertia="{fmt(M.GetDiagonalInertiaAttr().Get())}"/>')
        else:
            out.append(f'{pad}  <inertial pos="0 0 0" mass="{FOOT_MASS}" '
                       f'diaginertia="1e-6 1e-6 1e-6"/>')

        joint = parent_of.get(path, (None, None))[1]
        if joint is not None:
            R = UsdPhysics.RevoluteJoint(joint)
            lo, hi = np.deg2rad(R.GetLowerLimitAttr().Get()), np.deg2rad(R.GetUpperLimitAttr().Get())
            jn = joint.GetName()
            out.append(f'{pad}  <joint name="{jn}" axis="0 0 1" range="{lo:.5f} {hi:.5f}"/>')
            actuators.append(f'    <position name="{jn}" joint="{jn}" ctrlrange="{lo:.5f} {hi:.5f}"/>')

        welded = collect_mesh(stage, prim, world[path], xc)
        if welded is not None:
            # body node (named after the body) with one child mesh per part class
            visual.graph.update(frame_from=visual.graph.base_frame, frame_to=name)
            parts = split_by_part(name, welded)
            for part, faces in sorted(parts.items()):
                visual.add_geometry(visual_part(welded, faces, part), node_name=f'{name}_{part}',
                                    geom_name=f'{name}_{part}', parent_node_name=name)
            hull = collision_hull(welded)
            hull.export(os.path.join(mesh_dir, f'{name}.stl'))
            assets.append(f'    <mesh name="{name}" file="{name}.stl"/>')
            out.append(f'{pad}  <geom name="{name}" mesh="{name}" material="hull" group="3"/>')
            summary = ' '.join(f'{k}={len(v)}' for k, v in sorted(parts.items()))
            print(f'{name:10s} hull {len(hull.faces):4d} tris  faces: {summary}')

        for c in sorted(children.get(path, []), key=lambda k: bodies[k].GetName()):
            out.extend(emit_body(c, indent + 1))
        out.append(f'{pad}</body>')
        return out

    body_xml = emit_body(roots[0], 2)
    mat_xml = [f'    <material name="hull" rgba="{HULL_RGBA}"/>']

    s = SERVO
    xml = f'''<!-- Generated by tools/usd_to_mjcf.py from {os.path.basename(args.usd)}; do not edit by hand. -->
<mujoco model={quoteattr(args.name)}>
  <compiler angle="radian" meshdir="meshes" inertiafromgeom="false"/>
  <option timestep="0.002" integrator="implicitfast"/>

  <visual>
    <global elevation="-20" azimuth="120"/>
  </visual>

  <default>
    <joint armature="{s['armature']}" damping="{s['damping']}" limited="true"/>
    <!-- Robot geoms collide with the floor only (contype/conaffinity bits),
         like the USD's robot collision group, so the chunky convex hulls of
         neighbouring links don't fight each other. -->
    <geom type="mesh" contype="1" conaffinity="0" condim="3" friction="1.0 0.005 0.0001"/>
    <position kp="{s['kp']}" kv="{s['kv']}" forcerange="-{s['force']} {s['force']}" ctrllimited="true"/>
  </default>

  <asset>
    <texture name="grid" type="2d" builtin="checker" width="512" height="512" rgb1=".1 .2 .3" rgb2=".2 .3 .4"/>
    <material name="grid" texture="grid" texrepeat="1 1" texuniform="true" reflectance=".2"/>
{chr(10).join(mat_xml)}
{chr(10).join(assets)}
  </asset>

  <worldbody>
    <geom name="floor" type="plane" size="0 0 .05" material="grid" contype="1" conaffinity="1"/>
    <light name="top" pos="0 0 2" mode="trackcom"/>
{chr(10).join(body_xml)}
  </worldbody>

  <actuator>
{chr(10).join(actuators)}
  </actuator>
</mujoco>
'''
    with open(os.path.join(args.out_dir, f'{args.name}.xml'), 'w') as f:
        f.write(xml)
    glb = os.path.join(args.out_dir, f'{args.name}_visual.glb')
    write_visual_glb(visual, glb)
    print(f'wrote {args.out_dir}/{args.name}.xml ({len(actuators)} actuators), {glb}')


if __name__ == '__main__':
    main()
