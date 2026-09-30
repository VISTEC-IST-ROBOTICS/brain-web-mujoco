import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { buildGeoms, hasFloor, hasVisualOnlyGeoms, hideCollisionGeoms, syncGeoms } from './geoms.js';
import { attachVisuals, syncBodies } from './visuals.js';
import { addLogoSign } from './logo.js';

// Everything on screen for a simulation: its geoms, the robot's VISUALS
// meshes (gltfScene, or null), the logo sign, lights, and an orbit camera
// that follows the robot. `cameraView` = { position, target } to start from.
export function createView(mujoco, { model, data }, gltfScene, cameraView) {
  const { scene, camera, renderer, controls, sun } = setupScene(cameraView);
  const geomMeshes = buildGeoms(mujoco, model, scene);
  if (hasFloor(model)) addLogoSign(scene, renderer);
  const bodyVisuals = gltfScene ? attachVisuals(mujoco, model, gltfScene, scene) : [];
  // With separate looks (a VISUALS file, or visual-only geoms in the MJCF),
  // the collision shapes aren't drawn.
  if (gltfScene || hasVisualOnlyGeoms(model)) hideCollisionGeoms(model, geomMeshes);

  const followed = [camera.position, controls.target, sun.position, sun.target.position];
  const initialView = followed.map((v) => v.clone());
  const follow = createFollow(data, followed);

  return {
    scene,
    render() {
      syncGeoms(model, data, geomMeshes);
      syncBodies(data, bodyVisuals);
      follow.update();
      controls.update();
      renderer.render(scene, camera);
    },
    // Back to the starting view (after the simulation resets).
    reset() {
      followed.forEach((v, i) => v.copy(initialView[i]));
      follow.reset();
    },
  };
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
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

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
  // Follow the robot's centre of mass, not the root body's origin: a model's
  // origin can sit far from the robot (Red Mirror's is 1.4 m off, from its
  // CAD export), and would then swing round in a wide circle as it turns.
  const read = () => last.set(data.subtree_com[3 * ROOT], data.subtree_com[3 * ROOT + 1]);
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
