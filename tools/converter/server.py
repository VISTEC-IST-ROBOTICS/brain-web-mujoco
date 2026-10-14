#!/usr/bin/env python3
"""MJCF converter: a local web page that turns a robot description into a MuJoCo MJCF model,
with a URDF viewer for the source and a MuJoCo (WASM) viewer for the result.

    uv run python tools/converter/server.py [port]      then open http://localhost:8010/

Pick the description type (URDF, CoppeliaSim scene, Isaac Sim USD or MJCF), drop in its files
(a folder, several files or a .zip) and convert. The page runs the command-line converters in
tools/ on this machine, so their requirements apply: the Python packages from `uv sync`, plus
CoppeliaSim itself for CoppeliaSim scenes. Its install folder is set on the page and remembered in
~/.config/mjcf-converter.json; until then $COPPELIASIM_ROOT or the scripts' default is used. Types
whose Python packages are missing are shown disabled.

Uploads and results live in a temporary folder; "Save to assets_src" copies a result to
assets_src/<name>/ (mujoco/, plus urdf/ and scripts/ from a CoppeliaSim scene), the layout the
CoppeliaSim scripts use.
"""
import importlib.util
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
import zipfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
TOOLS = ROOT / "tools"
JOBS = None  # the work folder, a temporary folder made when the server starts
SETTINGS = Path.home() / ".config/mjcf-converter.json"
# Where CoppeliaSim is looked for when the page hasn't set it (the shell scripts' default)
COPPELIASIM_DEFAULT = Path(os.environ.get(
    "COPPELIASIM_ROOT", Path.home() / "Research/coppelia/CoppeliaSim_Edu_V4_10_0_rev0_Ubuntu24_04"))

sys.path.insert(0, str(TOOLS / "coppeliasim"))
from urdf_to_mjcf import resolve_mesh, set_collision_group  # noqa: E402  (shared with the URDF converter)
from paint import set_printed  # noqa: E402

# URL prefix -> folder served from it. /repo/ only exposes the model folders.
STATIC = {
    "/app/": HERE,
    "/src/": ROOT / "src",
    "/node_modules/": ROOT / "node_modules",
    "/repo/public/": ROOT / "public",
    "/assets/": ROOT / "public/assets",  # for src/ code that loads site files by their page path (the logo)
    "/repo/assets_src/": ROOT / "assets_src",
}


def load_settings():
    try:
        return json.loads(SETTINGS.read_text())
    except (OSError, ValueError):
        return {}


def coppeliasim_folder(path):
    """The CoppeliaSim install folder for a path the user gave: the folder itself, or its
    coppeliaSim.sh / coppeliaSim program. None when there is no coppeliaSim.sh there."""
    p = Path(path).expanduser()
    folder = p.parent if p.is_file() else p
    return folder.resolve() if (folder / "coppeliaSim.sh").is_file() else None


def coppeliasim():
    """Where CoppeliaSim is: {path, found, source}; source is "page" when set on the page."""
    saved = load_settings().get("coppeliasim")
    path = Path(saved) if saved else COPPELIASIM_DEFAULT
    return {"path": str(path), "found": coppeliasim_folder(path) is not None,
            "source": "page" if saved else ("COPPELIASIM_ROOT" if "COPPELIASIM_ROOT" in os.environ else "default")}


def set_coppeliasim(path):
    folder = coppeliasim_folder(path) if path.strip() else None
    if folder is None:
        raise ValueError(f"No coppeliaSim.sh in {path!r}. Give CoppeliaSim's install folder, "
                         "the one with coppeliaSim.sh in it.")
    SETTINGS.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS.write_text(json.dumps({**load_settings(), "coppeliasim": str(folder)}, indent=2))
    return coppeliasim()


def robot_files():
    """{robot name: its python/robots/<name>.py settings}: MODEL, VISUALS (as served URLs),
    SUMMON_SIZE, SUMMON_POSE, THUMBNAIL, BODY_COLOR and HIDDEN, read from the source the way the web page reads them."""
    robots = {}
    for py in sorted((ROOT / "python/robots").glob("[!_]*.py")):
        src = py.read_text()
        const = lambda key: (m := re.search(rf"^{key}\s*=\s*([\"'])(.*?)\1", src, re.M)) and m.group(2)  # noqa: E731
        size = re.search(r"^SUMMON_SIZE\s*=\s*([0-9.]+)", src, re.M)
        pose = re.search(r"^SUMMON_POSE\s*=\s*(\{.*\})", src, re.M)
        try:
            pose = json.loads(pose.group(1)) if pose else None
        except ValueError:
            pose = None
        robots[py.stem] = {
            "name": py.stem, "file": f"python/robots/{py.name}",
            "title": const("TITLE") or py.stem,
            "model": const("MODEL") and "/repo/public/" + const("MODEL"),
            "visuals": const("VISUALS") and "/repo/public/" + const("VISUALS"),
            "summonSize": float(size.group(1)) if size else None,
            "summonPose": pose,
            "thumbnail": const("THUMBNAIL") and "/repo/public/" + const("THUMBNAIL"),
            "bodyColor": const("BODY_COLOR"),
            "hidden": bool(re.search(r"^HIDDEN\s*=\s*True\b", src, re.M)),
        }
    return robots


def robot_for(url):
    """What the page knows about the MJCF at url: the robot file using it (if any), and its
    VISUALS, from that file or else a <name>_visual.glb next to the model (tools/usd_to_mjcf.py)."""
    robot = next((r for r in robot_files().values() if r["model"] == url), None)
    glb = url.rsplit(".", 1)[0] + "_visual.glb"
    try:
        glb_found = local_path(glb).is_file()
    except PermissionError:
        glb_found = False
    return {"robot": robot, "visuals": (robot and robot["visuals"]) or (glb if glb_found else None)}


def robot_file_for(url):
    """The python/robots file whose MODEL is the MJCF at url, or a ValueError saying there is none."""
    robot = robot_for(url)["robot"]
    if not robot:
        raise ValueError("No python/robots/*.py uses this model, so there is nowhere to keep this. "
                         "Add the robot to the project first.")
    return robot


def set_setting(src, key, value, comment, after=("MODEL", "VISUALS", "BODY_COLOR", "SUMMON_SIZE")):
    """A robot file's source with the line `KEY = value` set: replaced where it is, else added after
    the last of the `after` settings. value None removes the line."""
    line = f"{key} = {value}"
    found = re.search(rf"^{key}\s*=.*$", src, re.M)
    if value is None:
        return src[:found.start()] + src[found.end() + 1:] if found else src
    if found:
        # keep a comment the line already has
        old_comment = re.search(r"\s+#.*$", found.group(0))
        return src[:found.start()] + line + (old_comment.group(0) if old_comment else "") + src[found.end():]
    anchors = list(re.finditer(rf"^({'|'.join(after)})\s*=.*$", src, re.M))
    at = anchors[-1].end() if anchors else 0
    return src[:at] + ("\n" if at else "") + line + (f"  # {comment}" if comment else "") + ("" if at else "\n") + src[at:]


def set_summon(url, size=None, pose=None):
    """Writes the summon page's settings into the robot file using the MJCF at url:
    SUMMON_SIZE (its longest side on the pedestal) and SUMMON_POSE ({joint name: value} over its
    start pose; an empty one removes the line). None leaves a setting as it is."""
    robot = robot_file_for(url)
    py = ROOT / robot["file"]
    src = py.read_text()
    if size is not None:
        size = float(size)
        if not 0.05 <= size <= 5:
            raise ValueError("the size must be between 0.05 and 5")
        src = set_setting(src, "SUMMON_SIZE", f"{size:.3g}",
                          "the summon page's size for it: its longest side on the pedestal (default 1)")
    if pose is not None:
        pose = {str(k): round(float(v), 4) for k, v in pose.items()}
        src = set_setting(src, "SUMMON_POSE", json.dumps(pose) if pose else None,
                          "the summon page's pose: joint values over its start pose")
    py.write_text(src)
    return {"file": robot["file"], **robot_files()[robot["name"]]}


def save_thumbnail(url, jpeg):
    """Writes a robot card's thumbnail: to the file its robot file's THUMBNAIL names, else to
    public/assets/thumbs/<robot>.jpg, setting THUMBNAIL. Returns the files written."""
    if not jpeg.startswith(b"\xff\xd8"):
        raise ValueError("not a JPEG image")
    robot = robot_file_for(url)
    py = ROOT / robot["file"]
    src = py.read_text()
    current = re.search(r"^THUMBNAIL\s*=\s*([\"'])(.*?)\1", src, re.M)
    rel = current.group(2) if current else f"assets/thumbs/{robot['name']}.jpg"
    path = safe_join(ROOT / "public", rel)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(jpeg)
    files = [f"public/{rel}"]
    if not current:
        py.write_text(set_setting(src, "THUMBNAIL", json.dumps(rel), "",
                                  after=("TITLE", "DESCRIPTION", "MODEL")))
        files.append(robot["file"])
    return {"thumbnail": f"/repo/public/{rel}", "files": files}


def missing_modules(*names):
    return [n for n in names if importlib.util.find_spec(n) is None]


def description_types():
    """The description types and, for those that can't run here, why not."""
    urdf_missing = missing_modules("mujoco", "trimesh", "collada")
    need = lambda mods: f"needs {', '.join(mods)}: run uv sync" if mods else None  # noqa: E731
    usd = missing_modules("pxr", "trimesh", "scipy", "fast_simplification")
    usd_pip = {"pxr": "usd-core", "fast_simplification": "fast_simplification"}
    return [
        {"id": "urdf", "label": "URDF", "ext": [".urdf"], "unavailable": need(urdf_missing),
         "hint": "The .urdf plus its meshes (.dae, .stl, .obj). Drop the whole package folder so package:// paths resolve."},
        {"id": "coppeliasim", "label": "CoppeliaSim scene", "ext": [".ttt"], "unavailable": need(urdf_missing),
         "hint": "A .ttt scene. CoppeliaSim exports the robot to URDF headless, then it converts like a URDF."},
        {"id": "usd", "label": "Isaac Sim USD", "ext": [".usd", ".usda", ".usdc"],
         "unavailable": need([usd_pip.get(m, m) for m in usd]),
         "hint": "An Isaac Sim style articulation (rigid bodies + revolute joints), like the Gecko."},
        {"id": "mjcf", "label": "MJCF", "ext": [".xml"], "unavailable": need(missing_modules("mujoco")),
         "hint": "Already MuJoCo: checks that it compiles, and can shrink its STL meshes."},
    ]


def safe_join(base, rel):
    """base/rel, refusing anything that would land outside base."""
    path = (base / rel.lstrip("/")).resolve()
    if not path.is_relative_to(base.resolve()):
        raise PermissionError(rel)
    return path


def local_path(url_path):
    """The file a served URL path is."""
    for prefix, base in STATIC.items():
        if url_path.startswith(prefix):
            return safe_join(base, url_path[len(prefix):])
    raise PermissionError(url_path)


def job_dir(job_id):
    if not re.fullmatch(r"[0-9a-f]{12}", job_id or ""):
        raise PermissionError(job_id)
    return JOBS / job_id


def run(cmd, log, cwd=None, env=None):
    """Runs a converter, appending its command line and output to log. True when it succeeded."""
    log.append("$ " + " ".join(str(c) for c in cmd))
    try:
        p = subprocess.run([str(c) for c in cmd], cwd=cwd, env=env, capture_output=True, text=True, timeout=900)
    except subprocess.TimeoutExpired:
        log.append("timed out after 15 minutes")
        return False
    log.append((p.stdout + p.stderr).rstrip())
    if p.returncode:
        log.append(f"exit code {p.returncode}")
    return p.returncode == 0


def urdf_args(opts):
    args = ["--kp", float(opts.get("kp", 10)), "--kv", float(opts.get("kv", 0.5)),
            "--default-mass", float(opts.get("default_mass", 0.05))]
    for flag in ("fixed_base", "no_actuators", "no_floor"):
        if opts.get(flag):
            args.append("--" + flag.replace("_", "-"))
    return args


def convert(job, kind, main, opts):
    """Runs the converter for one description type. Returns (MJCF path or None, log lines)."""
    log = []
    inp = job / "input"
    src = safe_join(inp, main)
    name = re.sub(r"[^\w.-]", "_", opts.get("name") or src.stem)
    for d in ("mujoco", "urdf", "scripts"):
        shutil.rmtree(job / d, ignore_errors=True)
    out = job / "mujoco"
    py = sys.executable

    if kind == "urdf":
        ok = run([py, TOOLS / "coppeliasim/urdf_to_mjcf.py", src, out, "--mesh-search", inp, *urdf_args(opts)], log)
        xml = out / f"{src.stem}.xml"
    elif kind == "coppeliasim":
        model_path = opts.get("model_path", "").strip()
        if not model_path.startswith("/"):
            return None, ["The model path must be the scene path of the robot's root, e.g. /morf"]
        folder = coppeliasim_folder(coppeliasim()["path"])
        if folder is None:
            return None, [f"CoppeliaSim not found at {coppeliasim()['path']}. Set its folder under Options."]
        urdf = job / "urdf" / f"{name}.urdf"
        env = {**os.environ, "COPPELIASIM_ROOT": str(folder)}
        ok = run(["bash", TOOLS / "coppeliasim/export_urdf.sh", src, model_path, urdf], log, env=env)
        if ok and not urdf.is_file():
            log.append(f"CoppeliaSim wrote no URDF. Is {model_path} the robot's root in the scene?")
            ok = False
        if ok and opts.get("scripts"):
            run(["bash", TOOLS / "coppeliasim/extract_scripts.sh", src, job / "scripts"], log, env=env)
            if not any((job / "scripts").glob("*.lua")):
                log.append("No embedded scripts found in the scene.")
        ok = ok and run([py, TOOLS / "coppeliasim/urdf_to_mjcf.py", urdf, out, *urdf_args(opts)], log)
        xml = out / f"{name}.xml"
    elif kind == "usd":
        root = opts.get("usd_root", "").strip() or "/Gecko"
        ok = run([py, TOOLS / "usd_to_mjcf.py", src, out, "--root", root, "--name", name], log, cwd=ROOT)
        xml = out / f"{name}.xml"
    elif kind == "mjcf":
        # Keep the model's folder as it is (meshes, includes, textures), just checked
        shutil.copytree(src.parent, out)
        xml = out / src.name
        ok = True
    else:
        return None, [f"unknown description type {kind!r}"]

    if ok:
        ok = group_collisions(xml, log)
    if ok and opts.get("msh"):
        meshdir = mesh_dir_of(xml)
        stls = list(meshdir.glob("*.stl")) + list(meshdir.glob("*.STL"))
        if stls:
            originals = job / "stl"
            shutil.rmtree(originals, ignore_errors=True)
            originals.mkdir()
            for f in stls:
                shutil.copy(f, originals)
            ok = run([py, TOOLS / "stl_to_msh.py", xml, originals], log)
        else:
            log.append("No STL meshes to shrink.")
    if ok:
        ok = check_model(xml, log)
    return (xml if ok else None), log


def group_collisions(xml, log):
    """Every type's result gets the same collision group rule as urdf_to_mjcf.py: colliding geoms
    in group 3 when there are visual meshes. (A no-op for its own results and for USD's.)"""
    try:
        moved = set_collision_group(xml)
    except Exception as e:  # noqa: BLE001  (a model MuJoCo can't parse fails in check_model too)
        log.append(f"Could not set the collision group: {e}")
        return False
    if moved:
        log.append(f"Put {moved} collision geoms in group 3, so viewers show the visual meshes.")
    return True


def mesh_dir_of(xml):
    m = re.search(r'<compiler[^>]*\smeshdir="([^"]*)"', xml.read_text())
    return xml.parent / (m.group(1) if m else "")


def check_model(xml, log):
    """Compiles the result with MuJoCo and logs a summary."""
    try:
        import mujoco
        model = mujoco.MjModel.from_xml_path(str(xml))
    except Exception as e:  # noqa: BLE001  (any compile error goes to the log)
        log.append(f"MuJoCo could not load {xml.name}: {e}")
        return False
    mass = sum(model.body_mass)
    log.append(f"OK: {xml.name} compiles: {model.nbody - 1} bodies, {model.njnt} joints, "
               f"{model.nu} actuators, {model.ngeom} geoms, {model.nmesh} meshes, {mass:.3g} kg")
    return True


def result_dirs(job):
    return [d for d in (job / "mujoco", job / "urdf", job / "scripts") if d.is_dir()]


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        if not self.path.startswith(("/node_modules/", "/jobs/", "/api/mesh")):
            super().log_message(fmt, *args)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def guarded(fn):  # noqa: N805  (turns bad paths and errors into HTTP errors)
        def wrapper(self):
            try:
                fn(self)
            except (PermissionError, FileNotFoundError, KeyError) as e:
                self.send_json({"error": f"not found: {e}"}, 404)
            except (ValueError, json.JSONDecodeError) as e:
                self.send_json({"error": str(e)}, 400)
        return wrapper

    @guarded
    def do_GET(self):
        url = urlparse(self.path)
        path, query = unquote(url.path), parse_qs(url.query)
        if path in ("/", "/index.html"):
            return self.send_file(HERE / "index.html")
        if path == "/api/types":
            return self.send_json(description_types())
        if path == "/api/library":
            return self.send_json(self.library())
        if path == "/api/coppeliasim":
            return self.send_json(coppeliasim())
        if path == "/api/robots":
            return self.send_json(list(robot_files().values()))
        if path == "/api/robot":
            return self.send_json(robot_for(query["url"][0]))
        if path == "/api/mesh":
            # A URDF's mesh, found the way urdf_to_mjcf.py finds it (package://, relative, by name)
            urdf = self.local_path(query["urdf"][0])
            search = JOBS / urdf.relative_to(JOBS).parts[0] if urdf.is_relative_to(JOBS) else urdf.parent.parent
            return self.send_file(resolve_mesh(query["file"][0], urdf.parent, search))
        m = re.fullmatch(r"/api/jobs/(\w+)/download", path)
        if m:
            return self.send_zip(job_dir(m.group(1)))
        return self.send_file(self.local_path(path))

    @guarded
    def do_PUT(self):
        # /api/jobs/<id>/input/<relative path>: one uploaded file (a .zip is unpacked)
        m = re.fullmatch(r"/api/jobs/(\w+)/input/(.+)", unquote(urlparse(self.path).path))
        if not m:
            raise PermissionError(self.path)
        inp = job_dir(m.group(1)) / "input"
        body = self.rfile.read(int(self.headers["Content-Length"]))
        dest = safe_join(inp, m.group(2))
        if dest.suffix.lower() == ".zip":
            with zipfile.ZipFile(io.BytesIO(body)) as z:
                for info in z.infolist():
                    if not info.is_dir():
                        target = safe_join(inp, info.filename)
                        target.parent.mkdir(parents=True, exist_ok=True)
                        target.write_bytes(z.read(info))
        else:
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(body)
        self.send_json({"ok": True})

    @guarded
    def do_POST(self):
        url = urlparse(self.path)
        path = url.path
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if path == "/api/thumbnail":
            # The JPEG itself is the body; ?url= the model the robot file uses
            return self.send_json(save_thumbnail(parse_qs(url.query)["url"][0], body))
        req = json.loads(body or b"{}")
        if path == "/api/coppeliasim":
            return self.send_json(set_coppeliasim(req.get("path", "")))
        if path == "/api/summon":
            return self.send_json(set_summon(req["url"], req.get("size"), req.get("pose")))
        if path == "/api/paint":
            # The parts the page recolours: {url of an MJCF shown in the viewer, geom ids, #rrggbb}
            url = req["url"]
            if not url.startswith(("/jobs/", "/repo/")) or not url.endswith(".xml"):
                raise PermissionError(url)
            count, changed = set_printed(self.local_path(url), req["geoms"], req["color"])
            return self.send_json({"printed": count, "changed": changed})
        if path == "/api/jobs":
            job_id = uuid.uuid4().hex[:12]
            (JOBS / job_id / "input").mkdir(parents=True)
            return self.send_json({"id": job_id})
        m = re.fullmatch(r"/api/jobs/(\w+)/(files|convert|save)", path)
        if not m:
            raise PermissionError(path)
        job = job_dir(m.group(1))
        if m.group(2) == "files":
            inp = job / "input"
            files = sorted(p.relative_to(inp).as_posix() for p in inp.rglob("*") if p.is_file())
            return self.send_json({"files": files})
        if m.group(2) == "convert":
            xml, log = convert(job, req["type"], req["main"], req.get("options", {}))
            urdf = next((job / "urdf").glob("*.urdf"), None) if (job / "urdf").is_dir() else None
            return self.send_json({
                "ok": xml is not None, "log": "\n".join(log),
                "mjcf": xml and f"/jobs/{job.name}/{xml.relative_to(job).as_posix()}",
                "urdf": urdf and f"/jobs/{job.name}/{urdf.relative_to(job).as_posix()}"})
        # save: copy the result to assets_src/<name>/
        name = req.get("name", "")
        if not re.fullmatch(r"[\w.-]+", name):
            raise ValueError("name may only use letters, digits, _ . and -")
        dest = ROOT / "assets_src" / name
        dirs = result_dirs(job)
        clash = [str((dest / d.name).relative_to(ROOT)) for d in dirs if (dest / d.name).exists()]
        if clash and not req.get("overwrite"):
            return self.send_json({"exists": clash}, 409)
        for d in dirs:
            shutil.rmtree(dest / d.name, ignore_errors=True)
            shutil.copytree(d, dest / d.name)
        self.send_json({"saved": str(dest.relative_to(ROOT))})

    def library(self):
        """Models already in the project: the page's MJCFs and anything under assets_src/."""
        found = []
        for xml in sorted((ROOT / "public/assets").glob("*/*.xml")):
            found.append({"type": "mjcf", "label": f"public/assets/{xml.parent.name}/{xml.name}"})
        for f in sorted((ROOT / "assets_src").glob("*/*/*")):
            if (f.parent.name, f.suffix) in (("urdf", ".urdf"), ("mujoco", ".xml")):
                found.append({"type": "urdf" if f.suffix == ".urdf" else "mjcf",
                              "label": f.relative_to(ROOT).as_posix()})
        for item in found:
            item["url"] = "/repo/" + item["label"]
        return found

    def local_path(self, url_path):
        return local_path(url_path)

    def send_file(self, path):
        if not path.is_file():
            raise FileNotFoundError(path.name)
        types = {".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm",
                 ".html": "text/html", ".css": "text/css", ".json": "application/json", ".xml": "text/xml",
                 ".urdf": "text/xml", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
                 ".webp": "image/webp", ".glb": "model/gltf-binary"}
        self.send_bytes(path.read_bytes(), types.get(path.suffix.lower(), "application/octet-stream"))

    def send_zip(self, job):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            for d in result_dirs(job):
                for f in d.rglob("*"):
                    if f.is_file():
                        z.write(f, f.relative_to(job))
        self.send_bytes(buf.getvalue(), "application/zip")

    def send_json(self, obj, status=200):
        self.send_bytes(json.dumps(obj).encode(), "application/json", status)

    def send_bytes(self, body, content_type, status=200):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8010
    if not (ROOT / "node_modules/@mujoco/mujoco").is_dir():
        sys.exit("node_modules missing: run npm install in the repository first")
    JOBS = Path(tempfile.mkdtemp(prefix="mjcf-converter-"))
    STATIC["/jobs/"] = JOBS
    print(f"MJCF converter on http://localhost:{port}/   (work folder {JOBS})")
    try:
        ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        shutil.rmtree(JOBS, ignore_errors=True)
