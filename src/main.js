import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import loadMujoco from '@mujoco/mujoco';

const MODEL_URL = 'assets/rover.xml';

// Actuator order matches the <actuator> block in the MJCF file (MuJoCo assigns
// ids in declaration order).
const ACTUATORS = ['wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr'];
const ctrlIndex = (name) => ACTUATORS.indexOf(name);

const mjGEOM = { PLANE: 0, SPHERE: 2, CAPSULE: 3, CYLINDER: 5, BOX: 6 };

async function main() {
  const mujoco = await loadMujoco();
  const xml = await (await fetch(MODEL_URL)).text();
  const model = mujoco.MjModel.from_xml_string(xml);
  const data = new mujoco.MjData(model);
  mujoco.mj_forward(model, data);

  const { scene, camera, renderer, controls } = setupScene();
  const geomMeshes = buildGeoms(model, scene);

  const keys = new Set();
  window.addEventListener('keydown', (e) => keys.add(e.code));
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  applyControls(data, keys);
  const timestep = model.opt.timestep;
  let lastReset = false;
  let accumulator = 0;
  let lastTime = performance.now();

  function frame() {
    const now = performance.now();
    accumulator += Math.min(now - lastTime, 1000 / 30) / 1000;
    lastTime = now;

    const resetHeld = keys.has('KeyR');
    if (resetHeld && !lastReset) {
      mujoco.mj_resetData(model, data);
      mujoco.mj_forward(model, data);
      accumulator = 0;
    }
    lastReset = resetHeld;

    if (!resetHeld) {
      applyControls(data, keys);
      while (accumulator >= timestep) {
        mujoco.mj_step(model, data);
        accumulator -= timestep;
      }
    }

    syncGeoms(model, data, geomMeshes);
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function setupScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1f26);

  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.01, 100);
  camera.up.set(0, 0, 1); // MuJoCo worlds are Z-up; three's default camera up is Y
  camera.position.set(0.38, -0.45, 0.3);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  document.getElementById('app').appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0.06);
  controls.enableDamping = true;

  scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x333333, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(3, -4, 6);
  scene.add(sun);

  return { scene, camera, renderer, controls };
}

// Builds one Three.js mesh per MuJoCo geom, generically from geom type/size/
// material, so any model using only these primitive shapes can be dropped in
// via MODEL_URL. Meshes/heightfields are out of scope for this minimal viewer.
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
      default:
        continue; // meshes/hfields/etc. are out of scope for this minimal viewer
    }

    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(rgba[0], rgba[1], rgba[2]),
      transparent: rgba[3] < 1,
      opacity: rgba[3],
      roughness: 0.85,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = type === mjGEOM.PLANE;
    scene.add(mesh);
    meshes[i] = mesh;
  }
  return meshes;
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

const DRIVE = 0.8;
const TURN = 0.5;

// Tank/skid-steer control: throttle drives all wheels together, turn biases
// the left and right pairs in opposite directions.
function applyControls(data, keys) {
  let throttle = 0;
  let turn = 0;
  if (keys.has('ArrowUp') || keys.has('KeyW')) throttle += 1;
  if (keys.has('ArrowDown') || keys.has('KeyS')) throttle -= 1;
  if (keys.has('ArrowLeft') || keys.has('KeyA')) turn += 1;
  if (keys.has('ArrowRight') || keys.has('KeyD')) turn -= 1;

  const left = DRIVE * throttle + TURN * turn;
  const right = DRIVE * throttle - TURN * turn;
  data.ctrl[ctrlIndex('wheel_fl')] = left;
  data.ctrl[ctrlIndex('wheel_rl')] = left;
  data.ctrl[ctrlIndex('wheel_fr')] = right;
  data.ctrl[ctrlIndex('wheel_rr')] = right;
}

main();
