import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import URDFLoader from 'urdf-loader';
import loadMujoco from '@mujoco/mujoco';
import { buildGeoms, hasFloor, syncGeoms } from '/src/render/geoms.js';

// A Z-up three.js scene drawn into a pane, only while the pane is visible.
class Stage {
  constructor(pane) {
    this.pane = pane;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x14181e);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.005, 200);
    this.camera.up.set(0, 0, 1); // URDF and MuJoCo are both Z-up
    this.camera.position.set(1, -1.2, 0.8);
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    pane.prepend(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.45;
    this.scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x333333, 0.6));
    const sun = new THREE.DirectionalLight(0xffffff, 2);
    sun.position.set(1.5, -2, 3);
    this.scene.add(sun);
    this.grid = new THREE.GridHelper(10, 100, 0x3a4656, 0x252d38);
    this.grid.rotation.x = Math.PI / 2;
    this.scene.add(this.grid);

    new ResizeObserver(() => this.resize()).observe(pane);
    this.onFrame = () => {};
    let last = performance.now();
    this.renderer.setAnimationLoop((now) => {
      const dt = Math.min((now - last) / 1000, 1 / 30);
      last = now;
      if (pane.hidden) return;
      this.onFrame(dt);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.pane;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // Points the camera at a box, from the front-right and a little above.
  frame(box) {
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = Math.max(box.getSize(new THREE.Vector3()).length(), 0.05);
    this.controls.target.copy(center);
    this.camera.position.copy(center).add(new THREE.Vector3(0.9, -1.1, 0.7).multiplyScalar(size * 0.9));
    this.camera.near = size / 200;
    this.camera.far = size * 200;
    this.camera.updateProjectionMatrix();
  }
}

// Slider rows in a .joints panel. joints: [{ name, lo, hi, value, set(v) }]
function buildSliders(panel, title, joints, onReset) {
  panel.innerHTML = `<h3><span>${title}</span><button class="linkbtn">Reset</button></h3>`;
  panel.querySelector('button').onclick = onReset;
  panel.hidden = joints.length === 0;
  return joints.map((j) => {
    const row = document.createElement('div');
    row.className = 'joint';
    row.innerHTML = `<label><span></span><span class="v"></span></label>
      <input type="range" min="${j.lo}" max="${j.hi}" step="${(j.hi - j.lo) / 400}">`;
    row.querySelector('span').textContent = row.title = j.name;
    const input = row.querySelector('input');
    const v = row.querySelector('.v');
    input.value = j.value;
    input.oninput = () => j.set(+input.value);
    panel.appendChild(row);
    return { input, show: (x) => { v.textContent = x.toFixed(3); } };
  });
}

function disposeTree(obj) {
  obj.traverse((o) => {
    o.geometry?.dispose();
    [o.material].flat().forEach((m) => m?.dispose?.());
  });
}

// ---------------------------------------------------------------- URDF

export function createUrdfViewer(pane, ui) {
  const stage = new Stage(pane);
  const colliderMaterial = new THREE.MeshPhongMaterial({ color: 0xff9a3c, transparent: true, opacity: 0.35, depthWrite: false });
  let robot = null;
  let rows = [];

  const showColliders = () => robot?.traverse((o) => { if (o.isURDFCollider) o.visible = ui.collision.checked; });
  ui.collision.onchange = showColliders;

  function zero() {
    if (!robot) return;
    rows.forEach(({ input, joint }) => { input.value = clampZero(joint); input.oninput(); });
  }
  ui.reset.onclick = zero;
  const clampZero = (j) => Math.min(Math.max(0, j.lo), j.hi);

  return {
    clear() {
      if (robot) { stage.scene.remove(robot); disposeTree(robot); robot = null; }
      ui.joints.hidden = true;
      ui.info.hidden = true;
      ui.empty.classList.remove('err');
      ui.empty.textContent = 'Pick a URDF (or convert a CoppeliaSim scene) to see it here.';
      ui.empty.hidden = false;
    },

    // url: where the server serves the .urdf. Its meshes come through /api/mesh, which finds them
    // the way the converter does (package://, relative paths, or by name).
    async load(url) {
      this.clear();
      ui.empty.textContent = 'Loading URDF…';
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: ${res.status}`);
      const doc = new DOMParser().parseFromString(await res.text(), 'application/xml');
      if (doc.querySelector('parsererror')) throw new Error('The URDF is not valid XML.');
      for (const m of doc.querySelectorAll('mesh[filename]')) {
        m.setAttribute('filename', `/api/mesh?urdf=${encodeURIComponent(url)}&file=${encodeURIComponent(m.getAttribute('filename'))}`);
      }

      const loader = new URDFLoader();
      loader.parseCollision = true;
      const pending = [];
      const failed = new Set();
      loader.loadMeshCb = (path, manager, material, done) => {
        const file = new URLSearchParams(path.split('?')[1]).get('file');
        const ext = file.split('.').pop().toLowerCase();
        pending.push(new Promise((resolve) => {
          const finish = (obj) => { done(obj); resolve(); };
          const fail = () => { failed.add(file.split('/').pop()); finish(null); };
          if (ext === 'stl') {
            new STLLoader(manager).load(path, (g) => finish(new THREE.Mesh(g, material)), undefined, fail);
          } else if (ext === 'dae') {
            new ColladaLoader(manager).load(path, (dae) => finish(dae.scene), undefined, fail);
          } else if (ext === 'obj') {
            new OBJLoader(manager).load(path, (obj) => {
              obj.traverse((o) => { if (o.isMesh) o.material = material; });
              finish(obj);
            }, undefined, fail);
          } else {
            fail();
          }
        }));
      };
      const r = loader.parse(new XMLSerializer().serializeToString(doc), '');
      await Promise.all(pending);
      robot = r;
      robot.traverse((o) => {
        if (o.isURDFCollider) o.traverse((m) => { if (m.isMesh) m.material = colliderMaterial; });
      });
      showColliders();
      stage.scene.add(robot);

      // stand it on the grid
      robot.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(robot, true);
      robot.position.z -= box.min.z;
      box.translate(new THREE.Vector3(0, 0, -box.min.z));
      stage.frame(box);

      const joints = Object.values(robot.joints)
        .filter((j) => j.jointType !== 'fixed' && !j.isURDFMimicJoint)
        .map((j) => {
          const free = j.jointType === 'continuous' || (j.limit.lower === 0 && j.limit.upper === 0);
          const lo = free ? -Math.PI : +j.limit.lower;
          const hi = free ? Math.PI : +j.limit.upper;
          return { name: j.name, lo, hi, joint: j };
        });
      const sliderRows = buildSliders(ui.joints, `${joints.length} joints`, joints.map((j) => ({
        ...j, value: clampZero(j), set: (v) => { robot.setJointValue(j.name, v); sliderRow(j).show(v); },
      })), zero);
      rows = sliderRows.map((row, i) => ({ ...row, joint: joints[i] }));
      const sliderRow = (j) => rows.find((x) => x.joint === j);
      zero();

      ui.empty.hidden = true;
      const links = Object.keys(robot.links).length;
      ui.info.textContent = `${links} links · ${joints.length} movable joints` + (failed.size ? ` · ${failed.size} meshes missing` : '');
      ui.info.title = failed.size ? `Missing: ${[...failed].join(', ')}` : '';
      ui.info.hidden = false;
    },
  };
}

// ---------------------------------------------------------------- MJCF

const mjOBJ = { JOINT: 3, ACTUATOR: 19 };
const mjJNT = { SLIDE: 2, HINGE: 3 };
const mjGEOM_PLANE = 0;
const mjTRN_JOINT = 0;
const mjBIAS_AFFINE = 1;
let mujocoReady = null;

// The model file plus every file it references (meshes, textures, height fields, skins and
// <include>d files), as { path relative to the model's folder: bytes }.
async function fetchModelTree(url) {
  const base = new URL(url, location.href);
  const files = {};
  const errors = [];
  async function visit(rel) {
    const res = await fetch(new URL(rel, base));
    if (!res.ok) { errors.push(rel); return; }
    const bytes = new Uint8Array(await res.arrayBuffer());
    files[rel] = bytes;
    if (!/\.xml$/i.test(rel)) return;
    const doc = new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'application/xml');
    const compiler = doc.querySelector('compiler');
    const dir = (attr) => {
      const d = compiler?.getAttribute(attr) ?? compiler?.getAttribute('assetdir') ?? '';
      return d && !d.endsWith('/') ? d + '/' : d;
    };
    const refs = [];
    for (const el of doc.querySelectorAll('mesh[file], hfield[file], skin[file]')) refs.push(dir('meshdir') + el.getAttribute('file'));
    for (const el of doc.querySelectorAll('texture')) {
      for (const a of ['file', 'fileright', 'fileleft', 'fileup', 'filedown', 'filefront', 'fileback']) {
        if (el.getAttribute(a)) refs.push(dir('texturedir') + el.getAttribute(a));
      }
    }
    const includes = [...doc.querySelectorAll('include[file]')].map((el) => el.getAttribute('file'));
    await Promise.all([...new Set(refs)].filter((r) => !(r in files)).map(async (r) => {
      const res = await fetch(new URL(r, base));
      if (res.ok) files[r] = new Uint8Array(await res.arrayBuffer());
      else errors.push(r);
    }));
    for (const inc of includes) if (!(inc in files)) await visit(inc);
  }
  const main = base.pathname.split('/').pop();
  await visit(main);
  if (errors.length) throw new Error(`Missing files: ${errors.join(', ')}`);
  return { main, files };
}

let compiled = 0;
function compile(mujoco, { main, files }) {
  const { FS } = mujoco;
  const dir = `/converter/${compiled++}`;
  const paths = Object.keys(files).map((rel) => `${dir}/${rel}`);
  Object.entries(files).forEach(([rel, bytes], i) => {
    FS.mkdirTree(paths[i].slice(0, paths[i].lastIndexOf('/')));
    FS.writeFile(paths[i], bytes);
  });
  try {
    return mujoco.MjModel.from_xml_path(`${dir}/${main}`);
  } finally {
    paths.forEach((p) => FS.unlink(p));
  }
}

export function createMjcfViewer(pane, ui) {
  const stage = new Stage(pane);
  let mujoco = null;
  let model = null;
  let data = null;
  let meshes = [];
  let joints = [];
  let rows = [];
  let playing = false;

  const isCollision = (i) => model.geom_group[i] === 3 || model.geom_contype[i] || model.geom_conaffinity[i];
  const isVisualOnly = (i) => model.geom_type[i] !== mjGEOM_PLANE && !isCollision(i);

  function showCollision() {
    const hasVisuals = meshes.some((m, i) => m && isVisualOnly(i));
    ui.collision.disabled = !hasVisuals;
    if (!hasVisuals) ui.collision.checked = true;
    meshes.forEach((m, i) => {
      if (m && model.geom_type[i] !== mjGEOM_PLANE && isCollision(i)) m.visible = ui.collision.checked;
    });
  }
  ui.collision.onchange = showCollision;

  function setPlaying(on) {
    playing = on && !!model;
    ui.play.textContent = playing ? '❚❚ Pause' : '▶ Simulate';
    if (playing) {
      // Position servos start out holding the current pose; other actuators at rest
      for (let a = 0; a < model.nu; a++) {
        const j = model.actuator_trnid[2 * a];
        const servo = model.actuator_trntype[a] === mjTRN_JOINT && model.actuator_biastype[a] === mjBIAS_AFFINE;
        data.ctrl[a] = servo ? clampCtrl(a, data.qpos[model.jnt_qposadr[j]]) : 0;
      }
    }
    joints.forEach((j, k) => {
      rows[k].input.disabled = playing && j.actuator < 0;
      rows[k].input.value = playing && j.actuator >= 0 ? data.ctrl[j.actuator] : data.qpos[j.qadr];
    });
  }
  ui.play.onclick = () => setPlaying(!playing);

  function clampCtrl(a, v) {
    const [lo, hi] = [model.actuator_ctrlrange[2 * a], model.actuator_ctrlrange[2 * a + 1]];
    return lo < hi ? Math.min(Math.max(v, lo), hi) : v;
  }

  function reset() {
    if (!model) return;
    if (model.nkey > 0) mujoco.mj_resetDataKeyframe(model, data, 0);
    else mujoco.mj_resetData(model, data);
    mujoco.mj_forward(model, data);
    setPlaying(playing);
  }
  ui.reset.onclick = reset;

  stage.onFrame = (dt) => {
    if (!model) return;
    if (playing) {
      const steps = Math.max(1, Math.round(dt / model.opt.timestep));
      for (let s = 0; s < steps; s++) mujoco.mj_step(model, data);
    }
    syncGeoms(model, data, meshes);
    joints.forEach((j, k) => rows[k].show(data.qpos[j.qadr]));
  };

  return {
    clear() {
      setPlaying(false);
      meshes.forEach((m) => { if (m) { stage.scene.remove(m); disposeTree(m); } });
      meshes = [];
      data?.delete?.();
      model?.delete?.();
      model = data = null;
      ui.joints.hidden = true;
      ui.info.hidden = true;
      ui.empty.classList.remove('err');
      ui.empty.textContent = 'Convert a robot, or pick an MJCF, to see the MuJoCo model here.';
      ui.empty.hidden = false;
    },

    async load(url) {
      this.clear();
      ui.empty.textContent = 'Loading MuJoCo…';
      mujoco = await (mujocoReady ??= loadMujoco());
      const tree = await fetchModelTree(url);
      try {
        model = compile(mujoco, tree);
      } catch (e) {
        throw new Error(`MuJoCo could not compile the model:\n${e?.message ?? e}`);
      }
      data = new mujoco.MjData(model);
      meshes = buildGeoms(mujoco, model, stage.scene);
      stage.grid.visible = !hasFloor(model);
      showCollision();
      reset();
      syncGeoms(model, data, meshes);

      const box = new THREE.Box3();
      meshes.forEach((m, i) => { if (m && model.geom_type[i] !== mjGEOM_PLANE) box.expandByObject(m, true); });
      stage.frame(box);

      joints = [];
      for (let j = 0; j < model.njnt; j++) {
        const type = model.jnt_type[j];
        if (type !== mjJNT.HINGE && type !== mjJNT.SLIDE) continue;
        const limited = model.jnt_range[2 * j] < model.jnt_range[2 * j + 1];
        const span = type === mjJNT.HINGE ? Math.PI : 0.5;
        let actuator = -1;
        for (let a = 0; a < model.nu; a++) {
          if (model.actuator_trntype[a] === mjTRN_JOINT && model.actuator_trnid[2 * a] === j) actuator = a;
        }
        joints.push({
          name: mujoco.mj_id2name(model, mjOBJ.JOINT, j) || `joint ${j}`,
          qadr: model.jnt_qposadr[j], actuator,
          lo: limited ? model.jnt_range[2 * j] : -span,
          hi: limited ? model.jnt_range[2 * j + 1] : span,
        });
      }
      rows = buildSliders(ui.joints, `${joints.length} joints`, joints.map((j) => ({
        ...j, value: data.qpos[j.qadr],
        set: (v) => {
          if (playing) {
            if (j.actuator >= 0) data.ctrl[j.actuator] = clampCtrl(j.actuator, v);
          } else {
            data.qpos[j.qadr] = v;
            mujoco.mj_forward(model, data);
          }
        },
      })), reset);
      setPlaying(false);

      const mass = Array.from(model.body_mass).reduce((a, b) => a + b, 0);
      ui.info.textContent = `${model.nbody - 1} bodies · ${joints.length} joints · ${model.nu} actuators · ${mass.toPrecision(3)} kg`;
      ui.info.hidden = false;
      ui.empty.hidden = true;
    },
  };
}
