"""Convert a robot's STL meshes to MuJoCo's binary .msh format, for faster
page loads with exactly the same geometry.

STL stores every triangle's three corners separately (50 bytes a triangle);
.msh stores each vertex once plus 3 indices per triangle, about a third of
the size. MuJoCo reads both the same way, natively and in the browser.

    pip install trimesh
    python tools/stl_to_msh.py public/assets/red_mirror/red_mirror.xml assets_src/red_mirror/meshes

Converts every <mesh file="*.stl"> the model uses, reading the STLs from
SRC_DIR (keep the originals there) and writing the .msh files into the
model's meshdir, then points the XML at the .msh files and deletes the STLs
from the meshdir.
"""

import argparse
import re
from pathlib import Path

import numpy as np
import trimesh


def write_msh(path, vertices, faces):
    # .msh layout: int32 counts (vertices, normals, texcoords, faces), then
    # float32 vertices and int32 faces. No normals: MuJoCo computes them.
    with open(path, "wb") as f:
        np.array([len(vertices), 0, 0, len(faces)], np.int32).tofile(f)
        vertices.astype(np.float32).tofile(f)
        faces.astype(np.int32).tofile(f)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("xml", type=Path, help="the model's MJCF file (edited in place)")
    parser.add_argument("src_dir", type=Path, help="folder with the original .stl files")
    args = parser.parse_args()

    text = args.xml.read_text()
    meshdir = args.xml.parent / (re.search(r'meshdir="([^"]*)"', text) or [None, ""])[1]
    before = after = 0
    for name in sorted(set(re.findall(r'file="([^"]+\.stl)"', text, re.IGNORECASE))):
        src = args.src_dir / name
        mesh = trimesh.load_mesh(src)  # merges the corners STL repeats per triangle
        out = meshdir / (Path(name).stem + ".msh")
        write_msh(out, mesh.vertices, mesh.faces)
        (meshdir / name).unlink(missing_ok=True)
        before += src.stat().st_size
        after += out.stat().st_size
        print(f"{name}: {len(mesh.faces)} faces, {src.stat().st_size // 1000} kB -> {out.stat().st_size // 1000} kB")
    # Point the XML at the .msh files (dropping any STL content_type).
    text = re.sub(r'\s*content_type="model/stl"', "", text)
    text = re.sub(r'file="([^"]+)\.stl"', r'file="\1.msh"', text, flags=re.IGNORECASE)
    args.xml.write_text(text)
    print(f"total {before / 1e6:.1f} MB -> {after / 1e6:.1f} MB; updated {args.xml}")


if __name__ == "__main__":
    main()
