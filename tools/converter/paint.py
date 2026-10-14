"""Chooses which parts of an MJCF model the web page recolours: the geoms using the material
named "printed" (the Body colour picker, src/paint.js, and the summon page's variants).

set_printed() gives the chosen geoms material="printed" and takes it off the others, by editing
their start tags in place, so the file keeps its comments, <default> classes and formatting.
Geoms are numbered as MuJoCo numbers them (the web viewer's geom ids); which tag is which geom
is checked against the compiled model before anything is written.
"""
import re
import xml.parsers.expat
from pathlib import Path

import mujoco

DEFAULT_RGBA = (0.5, 0.5, 0.5, 1.0)  # MuJoCo's geom rgba; any other value overrides the material


class Element:
    def __init__(self, tag, attrs, start, parent):
        self.tag, self.attrs, self.start, self.parent = tag, attrs, start, parent
        self.children = []


def parse(data):
    """The element tree of an XML file, with each element's byte offset in it."""
    parser = xml.parsers.expat.ParserCreate()
    root = Element("#document", {}, 0, None)
    stack = [root]

    def start(tag, attrs):
        el = Element(tag, attrs, parser.CurrentByteIndex, stack[-1])
        stack[-1].children.append(el)
        stack.append(el)

    parser.StartElementHandler = start
    parser.EndElementHandler = lambda tag: stack.pop()
    parser.Parse(data, True)
    return root


def find(el, tag):
    return next((c for c in el.children if c.tag == tag), None)


def geom_elements(mujoco_el):
    """[(geom element, body index)] in MuJoCo's geom order: bodies depth first (the world is 0),
    each body's own geoms, including those in its <frame>s, in file order."""
    found, bodies = [], 0

    def body(el, index):
        nonlocal bodies
        own(el, index)
        for child in children_bodies(el):
            bodies += 1
            body(child, bodies)

    def own(el, index):
        for c in el.children:
            if c.tag == "geom":
                found.append((c, index))
            elif c.tag == "frame":
                own(c, index)

    def children_bodies(el):
        for c in el.children:
            if c.tag == "body":
                yield c
            elif c.tag == "frame":
                yield from children_bodies(c)

    for world in (c for c in mujoco_el.children if c.tag == "worldbody"):
        body(world, 0)
    return found


def tag_end(data, start):
    """Offset of the '>' closing the start tag at start (skipping quoted attribute values)."""
    quote = None
    for i in range(start, len(data)):
        ch = data[i:i + 1]
        if quote:
            if ch == quote:
                quote = None
        elif ch in (b'"', b"'"):
            quote = ch
        elif ch == b">":
            return i
    raise ValueError("unterminated tag")


def set_attr(tag, name, value):
    """A start tag (bytes) with attribute name set to value, or removed when value is None."""
    pattern = re.compile(rb'\s' + name.encode() + rb'\s*=\s*("[^"]*"|\'[^\']*\')')
    if value is None:
        return pattern.sub(b"", tag, count=1)
    new = f' {name}="{value}"'.encode()
    if pattern.search(tag):
        return pattern.sub(lambda m: new, tag, count=1)
    end = len(tag) - (2 if tag.endswith(b"/>") else 1)
    body = tag[:end].rstrip()
    return body + new + (b" " if tag[:end] != body and tag.endswith(b"/>") else b"") + tag[end:]


def fmt_rgba(rgba):
    return " ".join(f"{v:.4g}" for v in rgba)


def hex_to_rgba(color):
    if not re.fullmatch(r"#[0-9a-fA-F]{6}", color or ""):
        raise ValueError(f"not a colour: {color!r}")
    return [int(color[i:i + 2], 16) / 255 for i in (1, 3, 5)] + [1.0]


class Model:
    """An MJCF file's text, its compiled model and the <geom> tag of every geom id."""

    def __init__(self, path):
        self.path = Path(path)
        self.data = self.path.read_bytes()
        self.model = mujoco.MjModel.from_xml_path(str(self.path))
        doc = parse(self.data)
        self.root = find(doc, "mujoco")
        self.geoms = geom_elements(self.root)
        self.check()

    def check(self):
        m = self.model
        ok = len(self.geoms) == m.ngeom
        for i, (el, body) in enumerate(self.geoms if ok else []):
            name = el.attrs.get("name")
            if m.geom_bodyid[i] != body or (name and mujoco.mj_id2name(m, mujoco.mjtObj.mjOBJ_GEOM, i) != name):
                ok = False
                break
        if not ok:
            raise ValueError(f"Can't match {self.path.name}'s <geom> tags to MuJoCo's geoms "
                             "(models using <include>, <replicate> or <attach> aren't supported).")

    def printed_id(self):
        return mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_MATERIAL, "printed")


def printed_geoms(path):
    """Geom ids currently using the 'printed' material."""
    m = mujoco.MjModel.from_xml_path(str(path))
    mat = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_MATERIAL, "printed")
    return [i for i in range(m.ngeom) if mat >= 0 and m.geom_matid[i] == mat]


def set_printed(path, geom_ids, color):
    """Makes exactly geom_ids use material "printed", coloured color (#rrggbb). Geoms that drop
    out keep their look as a plain rgba. Writes the file only if MuJoCo compiles the result.
    Returns (number of printed geoms, number of tags changed)."""
    rgba = hex_to_rgba(color)
    current = Model(path)
    m = current.model
    wanted = set(int(i) for i in geom_ids)
    if not wanted <= set(range(m.ngeom)):
        raise ValueError("unknown geom id")
    mat = current.printed_id()
    old_rgba = m.mat_rgba[mat] if mat >= 0 else rgba

    edits = {}  # tag start offset -> {attr: value or None}
    for i, (el, _) in enumerate(current.geoms):
        is_printed = mat >= 0 and m.geom_matid[i] == mat
        if i in wanted and not is_printed:
            edits[el.start] = {"material": "printed", "rgba": None}
        elif i not in wanted and is_printed:
            edits[el.start] = {"material": None, "rgba": fmt_rgba(old_rgba)}
    data = apply(current.data, edits)
    data = set_material(data, rgba)

    # A rgba from a <default> class would still override the material: pin those to the default
    for _ in range(2):
        check = compile_bytes(current.path, data)
        mat = mujoco.mj_name2id(check, mujoco.mjtObj.mjOBJ_MATERIAL, "printed")
        geoms = geom_elements(find(parse(data), "mujoco"))
        override = {geoms[i][0].start: {"rgba": fmt_rgba(DEFAULT_RGBA)} for i in wanted
                    if tuple(round(float(v), 4) for v in check.geom_rgba[i]) != DEFAULT_RGBA}
        if not override:
            break
        data = apply(data, override)
    now = [i for i in range(check.ngeom) if check.geom_matid[i] == mat]
    if set(now) != wanted:
        raise ValueError("Some parts kept or lost the printed material through a <default> class; "
                         "edit those by hand.")
    current.path.write_bytes(data)
    return len(now), len(edits)


def apply(data, edits):
    """data with the attribute changes in edits made to the tags starting at those offsets."""
    out, pos = [], 0
    for start in sorted(edits):
        end = tag_end(data, start) + 1
        tag = data[start:end]
        for name, value in edits[start].items():
            tag = set_attr(tag, name, value)
        out += [data[pos:start], tag]
        pos = end
    return b"".join(out + [data[pos:]])


def set_material(data, rgba):
    """data with <material name="printed"> coloured rgba, added to <asset> if it isn't there."""
    root = find(parse(data), "mujoco")
    assets = [c for c in root.children if c.tag == "asset"]
    for asset in assets:
        for el in asset.children:
            if el.tag == "material" and el.attrs.get("name") == "printed":
                old = [float(v) for v in el.attrs.get("rgba", "").split()] or list(DEFAULT_RGBA)
                if [int(v * 255 + 0.5) for v in old] == [int(v * 255 + 0.5) for v in rgba]:
                    return data  # the same colour as a #rrggbb: keep its exact numbers
                return apply(data, {el.start: {"rgba": fmt_rgba(rgba)}})
    line = f'<material name="printed" rgba="{fmt_rgba(rgba)}"/>'
    if assets:
        asset = assets[0]
        end = tag_end(data, asset.start) + 1
        indent = line_indent(data, asset.start) + b"  "
        return data[:end] + b"\n" + indent + line.encode() + data[end:]
    world = find(root, "worldbody")
    indent = line_indent(data, world.start)
    block = b"<asset>\n" + indent + b"  " + line.encode() + b"\n" + indent + b"</asset>\n" + indent
    return data[:world.start] + block + data[world.start:]


def line_indent(data, offset):
    line_start = data.rfind(b"\n", 0, offset) + 1
    return re.match(rb"[ \t]*", data[line_start:offset]).group(0)


def compile_bytes(path, data):
    """Compiles data as if it were the file at path (so meshdir etc. resolve)."""
    tmp = path.with_name(f".{path.stem}.paint-check.xml")
    tmp.write_bytes(data)
    try:
        return mujoco.MjModel.from_xml_path(str(tmp))
    finally:
        tmp.unlink(missing_ok=True)
