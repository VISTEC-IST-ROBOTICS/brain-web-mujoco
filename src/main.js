import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import loadMujoco from '@mujoco/mujoco';

const MODEL_URL = 'assets/humanoid.xml';

// Actuator order matches the <actuator> block in the MJCF file (MuJoCo assigns
// ids in declaration order).
const ACTUATORS = [
  'abdomen_z', 'abdomen_y', 'abdomen_x',
  'hip_x_right', 'hip_z_right', 'hip_y_right', 'knee_right', 'ankle_y_right', 'ankle_x_right',
  'hip_x_left', 'hip_z_left', 'hip_y_left', 'knee_left', 'ankle_y_left', 'ankle_x_left',
  'shoulder1_right', 'shoulder2_right', 'elbow_right',
  'shoulder1_left', 'shoulder2_left', 'elbow_left',
];
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
  camera.position.set(2.2, -2.6, 1.8);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  document.getElementById('app').appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 1);
  controls.enableDamping = true;

  scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x333333, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(3, -4, 6);
  scene.add(sun);

  return { scene, camera, renderer, controls };
}

// Builds one Three.js mesh per MuJoCo geom. Only the primitive shapes used by
// the stock humanoid model are handled (plane, sphere, capsule); box/cylinder
// are included for reuse with other MuJoCo Menagerie models.
function buildGeoms(model, scene) {
  const meshes = new Array(model.ngeom).fill(null);
  for (let i = 0; i < model.ngeom; i++) {
    const type = model.geom_type[i];
    const size = [model.geom_size[3 * i], model.geom_size[3 * i + 1], model.geom_size[3 * i + 2]];
    const rgba = [model.geom_rgba[4 * i], model.geom_rgba[4 * i + 1], model.geom_rgba[4 * i + 2], model.geom_rgba[4 * i + 3]];

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

const TORQUE = 0.7;

function applyControls(data, keys) {
  data.ctrl.fill(0);
  const set = (name, value) => {
    data.ctrl[ctrlIndex(name)] = value;
  };
  if (keys.has('ArrowUp') || keys.has('KeyW')) {
    set('hip_y_right', TORQUE);
    set('hip_y_left', TORQUE);
  }
  if (keys.has('ArrowDown') || keys.has('KeyS')) {
    set('hip_y_right', -TORQUE);
    set('hip_y_left', -TORQUE);
  }
  if (keys.has('ArrowLeft') || keys.has('KeyA')) {
    set('abdomen_z', -TORQUE);
  }
  if (keys.has('ArrowRight') || keys.has('KeyD')) {
    set('abdomen_z', TORQUE);
  }
  if (keys.has('Space')) {
    set('knee_right', -TORQUE);
    set('knee_left', -TORQUE);
  }
}

main();
