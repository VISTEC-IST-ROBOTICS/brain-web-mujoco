import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import loadMujoco from '@mujoco/mujoco';
import { availableRobotCards, loadPythonRobot, pythonRobotNames, showError } from './robots/python.js';
import { showLanding } from './landing.js';
import { createTouchControls, isTouchDevice } from './touch.js';

// ?robot=<name> opens a Python robot (python/robots/<name>.py); without it
// (or with an unknown name) the page shows the robot menu.
const robotName = new URLSearchParams(location.search).get('robot');

// Lab logo: a corner badge on the page (index.html) and a sign in the scene.
const LOGO_URL = 'assets/brain_logo_v2.webp';

const mjGEOM = { PLANE: 0, SPHERE: 2, CAPSULE: 3, CYLINDER: 5, BOX: 6, MESH: 7 };
const mjOBJ_BODY = 1;
// MuJoCo convention: geom group 3 = collision-only shapes, hidden by default
// (toggle with C) when a robot supplies separate visual meshes.
const COLLISION_GROUP = 3;

async function main() {
  const robotDef = await loadPythonRobot(robotName);
  const mujoco = await loadMujoco();
  const [model, visuals] = await Promise.all([
    loadModel(mujoco, robotDef.modelUrl),
    robotDef.visualsUrl ? loadVisuals(robotDef.visualsUrl) : null,
  ]);
  const data = new mujoco.MjData(model);
  const robot = robotDef.create(mujoco, model);
  robot.reset(data);
  mujoco.mj_forward(model, data);

  const touch = isTouchDevice();
  document.getElementById('app').classList.toggle('touch', touch); // moves the logo badge clear of the touch controls
  const drive = !!robotDef.controllable; // user drives it, or it only runs on its own (watch mode)
  const switchable = drive && !!robotDef.watchable; // both, with a Drive / Watch switch
  document.getElementById('hud').innerHTML =
    '<a class="back" href="./" title="Back to the robot menu (Esc)">&larr; Robot menu</a>' +
    (switchable
      ? '<span class="mode-switch" role="group" aria-label="Mode">' +
        '<button type="button" class="mode drive" data-mode="drive" title="You steer it (M)">Drive</button>' +
        '<button type="button" class="mode watch" data-mode="watch" title="It walks on its own (M)">Watch</button></span>'
      : drive ? '<span class="mode drive">Drive mode</span>' : '<span class="mode watch">Watch mode</span>') + (touch
    ? (drive ? '<div><span class="drive-only"><b>Joystick</b> walk &amp; steer &nbsp; </span>' : '<div>') + '<b>Drag</b> orbit &nbsp; <b>Pinch</b> zoom</div>'
    : `<div><b>Drag</b> orbit &nbsp; <b>Scroll</b> zoom</div>${robotDef.hud}` +
      `<div><b>R</b> reset${switchable ? ' &nbsp; <b>M</b> drive/watch' : ''}${visuals ? ' &nbsp; <b>C</b> collision shapes' : ''}</div>`);
  const mode = createModeSwitch(drive, switchable);
  const speed = createSpeedControl(robotDef.speedRange);
  // Narrow screens stack the Body button and logo badge under the HUD
  // (index.html), so publish where the HUD ends as it grows or wraps.
  const hudEl = document.getElementById('hud');
  new ResizeObserver(() => {
    document.getElementById('app').style.setProperty('--hud-bottom', `${Math.ceil(hudEl.getBoundingClientRect().bottom)}px`);
  }).observe(hudEl);

  const { scene, camera, renderer, controls, sun } = setupScene(robotDef.camera);
  const geomMeshes = buildGeoms(model, scene);
  if (Array.from(model.geom_type).includes(mjGEOM.PLANE)) addLogoSign(scene, renderer);
  if (visuals) createPaintControl(visuals, robotDef); // before attachVisuals moves the nodes
  document.getElementById('app').classList.toggle('has-paint', !!document.getElementById('paint'));
  const bodyVisuals = visuals ? attachVisuals(mujoco, model, visuals, scene) : [];
  const collisionGeoms = geomMeshes.filter((m, i) => m && model.geom_group[i] === COLLISION_GROUP);
  const showCollision = (on) => collisionGeoms.forEach((m) => (m.visible = on || !visuals));
  if (visuals) {
    // When toggled on, overlay the hulls translucently on the visual meshes.
    collisionGeoms.forEach((m) => {
      Object.assign(m.material, { transparent: true, opacity: 0.45, depthWrite: false });
      m.castShadow = false;
    });
  }
  showCollision(false);

  const toggleCodes = ['KeyC', ...(robotDef.touchButtons ?? []).filter((b) => b.toggle).map((b) => b.code)];
  const input = createInput(toggleCodes, drive, touch && [
    { label: 'Reset', code: 'KeyR' },
    ...(robotDef.touchButtons ?? []),
    ...(visuals ? [{ label: 'Hulls', code: 'KeyC', toggle: true }] : []),
  ]);
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape') location.href = './';
    if (e.code === 'KeyM' && !e.repeat) mode.toggle();
  });
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  const timestep = model.opt.timestep;
  const followed = [camera.position, controls.target, sun.position, sun.target.position];
  const initialView = followed.map((v) => v.clone());
  const follow = createFollow(data, followed);
  let lastReset = false;
  let accumulator = 0;
  let lastTime = performance.now();

  function frame() {
    const now = performance.now();
    accumulator += Math.min(now - lastTime, 1000 / 30) / 1000;
    lastTime = now;

    const joy = input.read();
    joy.speed = speed.value;
    joy.watch = mode.watching;
    const resetHeld = input.keys.has('KeyR');
    if (resetHeld && !lastReset) {
      mujoco.mj_resetData(model, data);
      robot.reset(data);
      mujoco.mj_forward(model, data);
      followed.forEach((v, i) => v.copy(initialView[i])); // back to the starting view
      follow.reset();
      accumulator = 0;
    }
    lastReset = resetHeld;

    if (!resetHeld) {
      while (accumulator >= timestep) {
        robot.control(data, joy, timestep);
        mujoco.mj_step(model, data);
        accumulator -= timestep;
      }
    }

    showCollision(joy.showCollision);
    syncGeoms(model, data, geomMeshes);
    syncBodies(data, bodyVisuals);
    follow.update();
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// Fetches an MJCF file plus any mesh files it references into a MuJoCo
// virtual filesystem, so models with STL/OBJ assets load in the browser.
async function loadModel(mujoco, url) {
  const res = await fetch(url);
  // Dev servers and some hosts answer a missing file with the index page.
  if (!res.ok || (res.headers.get('content-type') ?? '').includes('text/html')) {
    throw new Error(`Model file not found: public/${url}. Check MODEL in the robot's .py file.`);
  }
  const xml = await res.text();
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const meshdir = doc.querySelector('compiler')?.getAttribute('meshdir') ?? '';
  const base = new URL(url, location.href);
  const vfs = new mujoco.MjVFS();
  const files = [...doc.querySelectorAll('mesh[file]')].map((m) => m.getAttribute('file'));
  await Promise.all(files.map(async (file) => {
    const path = meshdir ? `${meshdir}/${file}` : file;
    const res = await fetch(new URL(path, base));
    if (!res.ok) throw new Error(`failed to fetch mesh ${path}: ${res.status}`);
    vfs.addBuffer(file, new Uint8Array(await res.arrayBuffer()));
  }));
  return mujoco.MjModel.from_xml_string(xml, vfs);
}

// Visual-only meshes (GLB, meshopt-compressed) with one node per MuJoCo body,
// named after it and authored in that body's frame. Physics never sees these.
async function loadVisuals(url) {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  return (await loader.loadAsync(url)).scene;
}

function attachVisuals(mujoco, model, gltfScene, scene) {
  const bodies = [];
  for (const node of [...gltfScene.children]) {
    const id = mujoco.mj_name2id(model, mjOBJ_BODY, node.name);
    if (id < 0) continue;
    // The node may carry its own transform (e.g. gltfpack dequantization), so
    // it goes under a group that takes the body pose.
    const group = new THREE.Group();
    group.add(node);
    node.traverse((o) => {
      if (o.isMesh) o.castShadow = o.receiveShadow = true;
    });
    scene.add(group);
    bodies.push({ id, group });
  }
  return bodies;
}

// Body-colour picker: recolours the visual material named 'printed' (the
// robot's printed shell parts, see tools/usd_to_mjcf.py). Collapsed to one
// button showing the current colour; tapping it opens the palette. The choice
// is kept per robot in localStorage; robotDef.bodyColor is the default.
const SWATCHES = ['#2b2b2b', '#4c9a2a', '#e8731a', '#1f6fd1', '#c8262e', '#f2c318', '#7a3fc4', '#e9e9e9'];

// Tolerant compare: the GLB stores linear colours, so round-tripping to sRGB
// hex can be off by one per channel.
function sameColor(a, b) {
  const [x, y] = [new THREE.Color(a), new THREE.Color(b)];
  return Math.max(Math.abs(x.r - y.r), Math.abs(x.g - y.g), Math.abs(x.b - y.b)) < 3 / 255;
}

function createPaintControl(gltfScene, robotDef) {
  const materials = new Set();
  gltfScene.traverse((o) => o.isMesh && o.material.name === 'printed' && materials.add(o.material));
  if (!materials.size) return;

  const storageKey = `bodyColor:${robotDef.modelUrl}`;
  const el = document.createElement('div');
  el.id = 'paint';
  el.innerHTML = `<button class="current" aria-expanded="false"><i></i>Body</button>
    <div class="palette" hidden>
      ${SWATCHES.map((c) => `<button style="background:${c}" data-color="${c}" aria-label="Colour ${c}"></button>`).join('')}
      <input type="color" aria-label="Custom body colour">
    </div>`;
  document.getElementById('app').appendChild(el);
  const toggle = el.querySelector('.current');
  const palette = el.querySelector('.palette');
  const custom = el.querySelector('input');
  const setOpen = (open) => {
    palette.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  };
  toggle.addEventListener('click', () => setOpen(palette.hidden));

  const apply = (hex) => {
    materials.forEach((m) => m.color.set(hex));
    custom.value = hex;
    toggle.querySelector('i').style.background = hex;
    palette.querySelectorAll('button').forEach((b) => b.classList.toggle('on', sameColor(b.dataset.color, hex)));
    try {
      localStorage.setItem(storageKey, hex);
    } catch {
      // storage unavailable (private mode etc.): colour just isn't remembered
    }
  };
  palette.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    apply(b.dataset.color);
    setOpen(false);
  }));
  custom.addEventListener('input', () => apply(custom.value));
  custom.addEventListener('change', () => setOpen(false));

  let saved = null;
  try {
    saved = localStorage.getItem(storageKey);
  } catch {}
  apply(saved ?? robotDef.bodyColor ?? `#${[...materials][0].color.getHexString()}`);
}

function syncBodies(data, bodies) {
  for (const { id, group } of bodies) {
    group.position.set(data.xpos[3 * id], data.xpos[3 * id + 1], data.xpos[3 * id + 2]);
    // MuJoCo quats are (w, x, y, z)
    group.quaternion.set(data.xquat[4 * id + 1], data.xquat[4 * id + 2], data.xquat[4 * id + 3], data.xquat[4 * id]);
  }
}

function setupScene(view) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1f26);

  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.01, 100);
  camera.up.set(0, 0, 1); // MuJoCo worlds are Z-up; three's default camera up is Y
  camera.position.set(...view.position);
  // Portrait (phone) screens are narrow: back the camera off so the robot fits.
  const zoomOut = Math.min(Math.max(1 / camera.aspect, 1), 2.2);
  camera.position.sub(new THREE.Vector3(...view.target)).multiplyScalar(zoomOut).add(new THREE.Vector3(...view.target));

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  // Neutral keeps model colours close to their rgba (ACES filmic desaturates
  // and shifts saturated colours).
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.getElementById('app').appendChild(renderer.domElement);

  // Soft studio reflections so metal/plastic parts read as 3D shapes.
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.45;

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(...view.target);
  controls.enableDamping = true;

  scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x333333, 0.5));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2); // strong key light for MuJoCo-like shading
  sun.position.set(1.5, -2, 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -1;
  sun.shadow.camera.right = sun.shadow.camera.top = 1;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 8;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.01;
  scene.add(sun, sun.target);

  return { scene, camera, renderer, controls, sun };
}

// Keeps the robot in view: translates the given points (camera, orbit target,
// shadow light) by the root body's horizontal motion, leaving the user's
// orbit angle/zoom alone.
function createFollow(data, points) {
  const ROOT = 1; // body 0 is the world
  const last = new THREE.Vector2();
  const read = () => last.set(data.xpos[3 * ROOT], data.xpos[3 * ROOT + 1]);
  read();
  const delta = new THREE.Vector3();
  return {
    reset: read,
    update() {
      const px = last.x;
      const py = last.y;
      read();
      delta.set(last.x - px, last.y - py, 0);
      points.forEach((p) => p.add(delta));
    },
  };
}

// Drive / Watch mode. Robots with WATCH_INPUT can switch (HUD buttons, M, or
// ?mode=watch in the URL, kept up to date so a link opens the same mode);
// others are fixed by USER_CONTROL. #app gets .watching, which the CSS uses
// to show the HUD's .drive-only / .watch-only lines and hide the joystick.
function createModeSwitch(drive, switchable) {
  const app = document.getElementById('app');
  const buttons = [...document.querySelectorAll('#hud .mode-switch button')];
  const state = {
    watching: !drive || (switchable && new URLSearchParams(location.search).get('mode') === 'watch'),
    set(watching) {
      state.watching = watching;
      app.classList.toggle('watching', watching);
      buttons.forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.mode === 'watch') === watching)));
      if (!switchable) return;
      const url = new URL(location.href);
      if (watching) url.searchParams.set('mode', 'watch');
      else url.searchParams.delete('mode');
      history.replaceState(null, '', url);
    },
    toggle() {
      if (switchable) state.set(!state.watching);
    },
  };
  buttons.forEach((b) => b.addEventListener('click', () => {
    state.set(b.dataset.mode === 'watch');
    b.blur(); // hand the arrow keys back to driving
  }));
  state.set(state.watching);
  return state;
}

// Speed slider in the HUD for robots that declare SPEED_RANGE = (low, high):
// a multiplier starting at 1, passed to the controller as obs.speed.
function createSpeedControl(range) {
  const state = { value: 1 };
  if (!range) return state;
  const [lo, hi] = range;
  state.value = Math.min(Math.max(1, lo), hi);
  const row = document.createElement('div');
  row.className = 'speed';
  row.innerHTML = `<b>Speed</b>
    <input type="range" min="${lo}" max="${hi}" step="0.05" value="${state.value}" aria-label="Robot speed">
    <output>${state.value.toFixed(2)}&times;</output>`;
  const slider = row.querySelector('input');
  const label = row.querySelector('output');
  slider.addEventListener('input', () => {
    state.value = Number(slider.value);
    label.textContent = `${state.value.toFixed(2)}×`;
  });
  // Hand the arrow keys back to driving once the slider is let go.
  slider.addEventListener('change', () => slider.blur());
  document.getElementById('hud').appendChild(row);
  return state;
}

// Keyboard + Gamepad API (+ on-screen joystick/buttons when `touchButtons` is
// given) -> the joystick axes the robot controllers read (leftY +1 = forward,
// rightX +1 = right, rightY +1 = stick up; the on-screen joystick only when
// `drive`). Pressing a key in `toggleCodes`
// flips it in `toggles` instead of only holding it.
function createInput(toggleCodes, drive, touchButtons) {
  const keys = new Set();
  const toggles = new Set();
  const stick = touchButtons ? createTouchControls({ keys, toggles, buttons: touchButtons, joystick: drive }) : null;
  window.addEventListener('keydown', (e) => {
    if (!e.repeat && toggleCodes.includes(e.code)) {
      toggles.has(e.code) ? toggles.delete(e.code) : toggles.add(e.code);
    }
    keys.add(e.code);
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  const axis = (pos, neg) => (pos.some((k) => keys.has(k)) ? 1 : 0) - (neg.some((k) => keys.has(k)) ? 1 : 0);
  const dead = (v) => (Math.abs(v) < 0.1 ? 0 : v);
  const clamp = (v) => Math.max(-1, Math.min(1, v));

  return {
    keys,
    read() {
      let leftY = axis(['ArrowUp', 'KeyW'], ['ArrowDown', 'KeyS']);
      let rightX = axis(['ArrowRight', 'KeyD'], ['ArrowLeft', 'KeyA']);
      let rightY = axis(['KeyQ'], ['KeyE']);
      const pad = navigator.getGamepads?.().find((g) => g);
      if (pad) {
        // Standard mapping: axes 0/1 left stick, 2/3 right stick, +Y is down.
        leftY = clamp(leftY - dead(pad.axes[1] ?? 0));
        rightX = clamp(rightX + dead(pad.axes[2] ?? 0));
        rightY = clamp(rightY - dead(pad.axes[3] ?? 0));
      }
      if (stick) {
        leftY = clamp(leftY + stick.y);
        rightX = clamp(rightX + stick.x);
      }
      return {
        leftY,
        rightX,
        rightY,
        fixedSpine: toggles.has('KeyF'),
        showCollision: toggles.has('KeyC'),
        stepUp: keys.has('BracketRight'),
        stepDown: keys.has('BracketLeft'),
        keys,
        toggles,
      };
    },
  };
}

// Builds one Three.js mesh per MuJoCo geom, generically from geom type/size/
// material, so any model using these shapes (or mesh assets) can be dropped in.
function buildGeoms(model, scene) {
  const meshes = new Array(model.ngeom).fill(null);
  for (let i = 0; i < model.ngeom; i++) {
    const type = model.geom_type[i];
    const size = [model.geom_size[3 * i], model.geom_size[3 * i + 1], model.geom_size[3 * i + 2]];
    const matid = model.geom_matid[i];
    const rgba = matid >= 0
      ? [model.mat_rgba[4 * matid], model.mat_rgba[4 * matid + 1], model.mat_rgba[4 * matid + 2], model.mat_rgba[4 * matid + 3]]
      : [model.geom_rgba[4 * i], model.geom_rgba[4 * i + 1], model.geom_rgba[4 * i + 2], model.geom_rgba[4 * i + 3]];

    let geometry;
    switch (type) {
      case mjGEOM.PLANE:
        geometry = new THREE.PlaneGeometry(size[0] > 0 ? size[0] * 2 : 40, size[1] > 0 ? size[1] * 2 : 40);
        break;
      case mjGEOM.SPHERE:
        geometry = new THREE.SphereGeometry(size[0], 24, 16);
        break;
      case mjGEOM.CAPSULE:
        geometry = new THREE.CapsuleGeometry(size[0], size[1] * 2, 6, 12);
        geometry.rotateX(Math.PI / 2); // MuJoCo capsules/cylinders point along local Z, three's along Y
        break;
      case mjGEOM.CYLINDER:
        geometry = new THREE.CylinderGeometry(size[0], size[0], size[1] * 2, 20);
        geometry.rotateX(Math.PI / 2);
        break;
      case mjGEOM.BOX:
        geometry = new THREE.BoxGeometry(size[0] * 2, size[1] * 2, size[2] * 2);
        break;
      case mjGEOM.MESH:
        geometry = meshGeometry(model, model.geom_dataid[i]);
        break;
      default:
        continue; // heightfields etc. are out of scope for this minimal viewer
    }

    if (type === mjGEOM.PLANE) {
      const mesh = new THREE.Mesh(geometry, floorMaterial(geometry.parameters));
      mesh.receiveShadow = true;
      scene.add(mesh);
      meshes[i] = mesh;
      continue;
    }

    const material = new THREE.MeshStandardMaterial({
      // MJCF rgba values are display (sRGB) colours, as MuJoCo's own renderer
      // shows them; plain THREE.Color(r, g, b) would read them as linear and
      // wash them out (red 1 0.2 0.2 turns pink).
      color: new THREE.Color().setRGB(rgba[0], rgba[1], rgba[2], THREE.SRGBColorSpace),
      transparent: rgba[3] < 1,
      opacity: rgba[3],
      roughness: type === mjGEOM.MESH ? 0.4 : 0.7,
      metalness: type === mjGEOM.MESH ? 0.1 : 0,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    scene.add(mesh);
    meshes[i] = mesh;
  }
  return meshes;
}

// The lab logo on a white sign standing on the floor behind the start
// position, facing the default camera, printed on both faces so it reads
// correctly from either side. Visual only: physics never sees it, so robots
// pass through it.
function addLogoSign(scene, renderer) {
  const WIDTH = 2.0; // metres (height follows the logo's shape: ~0.37 m)
  const CENTER = [-0.2, 1.5]; // x, y of the sign's base
  const THICKNESS = 0.03;
  const image = new Image();
  image.onload = () => {
    const pad = 0.08 * image.width;
    const canvas = document.createElement('canvas');
    canvas.width = 2048;
    canvas.height = Math.round(canvas.width * (image.height + 2 * pad) / (image.width + 2 * pad));
    const scale = canvas.width / (image.width + 2 * pad);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, pad * scale, pad * scale, image.width * scale, image.height * scale);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy(); // stays sharp at an angle
    const height = WIDTH * canvas.height / canvas.width;

    // A white board, with the logo on a plane just off each face. Built in
    // the XY plane, then stood up: local +Z (the front) faces world -Y.
    const sign = new THREE.Group();
    const board = new THREE.Mesh(
      new THREE.BoxGeometry(WIDTH, height, THICKNESS),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 }),
    );
    board.castShadow = board.receiveShadow = true;
    sign.add(board);
    const faceMaterial = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 });
    for (const side of [1, -1]) {
      const face = new THREE.Mesh(new THREE.PlaneGeometry(WIDTH, height), faceMaterial);
      face.position.z = side * (THICKNESS / 2 + 0.001);
      if (side < 0) face.rotation.y = Math.PI; // back face, text reads left to right from behind too
      face.receiveShadow = true;
      sign.add(face);
    }
    sign.rotation.x = Math.PI / 2;
    sign.position.set(CENTER[0], CENTER[1], height / 2);
    scene.add(sign);
  };
  image.src = LOGO_URL;
}

// Blue-grey 0.5 m checker (the MJCF "grid" colours; MuJoCo textures aren't
// read) so the floor gives a sense of scale and motion.
function floorMaterial({ width, height }) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 2;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1a3350';
  ctx.fillRect(0, 0, 2, 2);
  ctx.fillStyle = '#2a4460';
  ctx.fillRect(0, 0, 1, 1);
  ctx.fillRect(1, 1, 1, 1);
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(width, height); // 2 texels per repeat -> 0.5 m squares
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 });
}

// Mesh vertices in the compiled model are already expressed in the geom
// frame (MuJoCo re-centres meshes), so they pair directly with geom_xpos/xmat.
function meshGeometry(model, meshId) {
  const vadr = model.mesh_vertadr[meshId];
  const vnum = model.mesh_vertnum[meshId];
  const fadr = model.mesh_faceadr[meshId];
  const fnum = model.mesh_facenum[meshId];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(
    Float32Array.from(model.mesh_vert.subarray(3 * vadr, 3 * (vadr + vnum))), 3));
  geometry.setIndex(Array.from(model.mesh_face.subarray(3 * fadr, 3 * (fadr + fnum))));
  // Flat shading suits CAD parts better than smoothing across hard edges.
  const flat = geometry.toNonIndexed();
  flat.computeVertexNormals();
  return flat;
}

const _m4 = new THREE.Matrix4();

function syncGeoms(model, data, meshes) {
  for (let i = 0; i < model.ngeom; i++) {
    const mesh = meshes[i];
    if (!mesh) continue;

    mesh.position.set(data.geom_xpos[3 * i], data.geom_xpos[3 * i + 1], data.geom_xpos[3 * i + 2]);

    const o = 9 * i;
    const m = data.geom_xmat;
    _m4.set(
      m[o + 0], m[o + 1], m[o + 2], 0,
      m[o + 3], m[o + 4], m[o + 5], 0,
      m[o + 6], m[o + 7], m[o + 8], 0,
      0, 0, 0, 1,
    );
    mesh.quaternion.setFromRotationMatrix(_m4);
  }
}

if (pythonRobotNames.includes(robotName)) {
  main().catch(showError);
} else {
  availableRobotCards().then((cards) => showLanding(cards, robotName));
}
