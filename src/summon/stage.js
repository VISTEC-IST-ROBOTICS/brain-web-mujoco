import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { buildGeoms, hasVisualOnlyGeoms, hideCollisionGeoms, syncGeoms } from '../render/geoms.js';
import { attachVisuals, loadVisuals, syncBodies } from '../render/visuals.js';
import { compileModel, fetchModelFiles } from '../simulation.js';
import { animateFinish, applyFinish } from './variants.js';

// The summon stage: one robot at a time standing on a turntable pedestal,
// in its start pose (no physics or controller runs here). Each robot's
// model is compiled once and kept; a summon only swaps which one is shown
// and repaints its 'printed' material (the same parts the robot page's
// Body colour picker recolours).

// Every robot is scaled so its longest side is this long (the pedestal is
// 1.3 across), unless its robot file sets SUMMON_SIZE.
export const DEFAULT_SIZE = 1;
const mjGEOM_PLANE = 0;

export function createStage(canvasParent) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 50);
  camera.up.set(0, 0, 1); // MuJoCo worlds are Z-up

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  canvasParent.appendChild(renderer.domElement);

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.7; // stronger than the robot page: the metal finishes need something to reflect

  scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x222222, 0.6));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(1.2, -1.6, 2.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -1, right: 1, top: 1, bottom: -1, near: 0.5, far: 6 });
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.01;
  scene.add(sun);
  const rim = new THREE.PointLight(0xffffff, 0, 4); // rarity-coloured light from behind
  rim.position.set(-0.6, 0.9, 0.9);
  scene.add(rim);

  // Pedestal: a dark disc with a glowing ring in the rarity colour.
  const pedestal = new THREE.Group();
  const disc = new THREE.Mesh(
    new THREE.CylinderGeometry(0.62, 0.68, 0.08, 64),
    new THREE.MeshStandardMaterial({ color: 0x1b222b, roughness: 0.55, metalness: 0.3 }),
  );
  disc.rotation.x = Math.PI / 2;
  disc.position.z = -0.04;
  disc.receiveShadow = true;
  const ringMaterial = new THREE.MeshBasicMaterial({ color: 0x7fd0ff });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.65, 0.008, 8, 96), ringMaterial);
  ring.position.z = 0.001;
  pedestal.add(disc, ring);
  scene.add(pedestal);

  camera.position.set(0, -2.2, 0.95);
  camera.lookAt(0, 0, 0.2);

  const turntable = new THREE.Group();
  scene.add(turntable);

  const fitCamera = (aspect) => {
    camera.aspect = aspect;
    // Narrow (phone) screens: back off so the robot still fits.
    camera.zoom = Math.min(1, aspect / 1.5);
    camera.updateProjectionMatrix();
  };
  const resize = () => {
    const { clientWidth: w, clientHeight: h } = canvasParent;
    renderer.setSize(w, h);
    fitCamera(w / h);
  };
  new ResizeObserver(resize).observe(canvasParent);
  resize();

  let shown = null; // { root, printed, variant }
  let spin = 0;
  let turning = true;

  renderer.setAnimationLoop((ms) => {
    const t = ms / 1000;
    if (turning) turntable.rotation.z = (turntable.rotation.z + 0.006 + spin) % (2 * Math.PI);
    spin *= 0.94; // the reveal starts with a fast spin that settles
    if (shown?.variant) animateFinish(shown.printed, shown.variant, t);
    renderer.render(scene, camera);
  });

  return {
    camera,
    renderer,
    turntable, // what turns: the shown robot (and anything else put on it)
    // Whether the turntable turns by itself (the summon page always does)
    setTurning(on) { turning = on; },
    // The current view drawn into a new 2D canvas of width x height pixels
    // (transparent background), whatever the window's size, for screenshots.
    // Renders and copies in one go, so the WebGL canvas needs no
    // preserveDrawingBuffer, and is back to normal before the next frame.
    snapshot(width, height) {
      const ratio = renderer.getPixelRatio();
      renderer.setPixelRatio(1);
      renderer.setSize(width, height, false);
      fitCamera(width / height);
      renderer.render(scene, camera);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(renderer.domElement, 0, 0);
      renderer.setPixelRatio(ratio);
      resize();
      return canvas;
    },
    // Compiles the shaders `robot` needs before it's first shown.
    // (Compiled against the stage's lights, without being added to it.)
    precompile(robot) {
      return renderer.compileAsync(robot.root, camera, scene);
    },
    // Shows `robot` (a prepared robot from prepareRobot) painted as `variant`.
    // reveal: turn it in with a fast spin, as a summon does.
    show(robot, variant, tierColor, { reveal = true } = {}) {
      if (shown) turntable.remove(shown.root);
      shown = { ...robot, variant };
      turntable.add(robot.root);
      this.setFinish(robot.printed, variant, tierColor);
      if (reveal) {
        turntable.rotation.z = -0.9;
        spin = 0.25;
      }
    },
    // Repaints the shown robot: `printed` materials as `variant` (null: as
    // they are), with the ring and rim light in tierColor.
    setFinish(printed, variant, tierColor) {
      if (shown) Object.assign(shown, { printed, variant });
      if (variant) applyFinish(printed, variant);
      ringMaterial.color.set(tierColor);
      rim.color.set(tierColor);
      rim.intensity = 3;
    },
    clear() {
      if (shown) turntable.remove(shown.root);
      shown = null;
      ringMaterial.color.set(0x7fd0ff);
      rim.intensity = 0;
    },
  };
}

// Downloads and compiles a robot's model (plus its VISUALS file), poses it
// at its start pose and returns { root, printed }: a group scaled to the
// card's summonSize (else DEFAULT_SIZE), centred on the origin and standing
// on z = 0, and its 'printed' materials.
export async function prepareRobot(mujoco, card) {
  const [files, gltf] = await Promise.all([fetchModelFiles(card.model), card.visuals && loadVisuals(card.visuals)]);
  const model = compileModel(mujoco, files);
  try {
    const { root, printed } = buildRobot(mujoco, model, gltf, card.summonSize, card.summonPose);
    return { root, printed };
  } finally {
    model.delete();
  }
}

// The robot as the stage shows it, from a compiled model (kept by the caller)
// and its VISUALS scene (or null; its nodes move into the robot), posed and
// scaled by poseRobot: { root, printed, meshes: the geoms' meshes by geom
// id, bodies, longest }. The converter page's summon demo uses this too, so
// its preview matches this page.
export function buildRobot(mujoco, model, gltf, size = DEFAULT_SIZE, pose = {}) {
  const robot = new THREE.Group();
  const meshes = buildGeoms(mujoco, model, robot);
  const bodies = gltf ? attachVisuals(mujoco, model, gltf, robot) : [];
  if (gltf || hasVisualOnlyGeoms(model)) hideCollisionGeoms(model, meshes);
  meshes.forEach((m, i) => m && model.geom_type[i] === mjGEOM_PLANE && robot.remove(m)); // the pedestal is the floor
  const printed = new Set();
  robot.traverseVisible((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    if (o.material.name === 'printed') printed.add(o.material);
  });
  const root = new THREE.Group();
  root.add(robot);
  const built = { root, robot, printed: [...printed], meshes, bodies, longest: 1 };
  poseRobot(mujoco, model, built, pose, size);
  return built;
}

// Puts a built robot in its summon pose and size: the model's start pose
// (its first keyframe, else its default pose) with the joints in `pose`
// ({ joint name: angle in rad, or m for a slide }, SUMMON_POSE in its robot
// file) set, scaled so its longest side is `size`, centred on the origin and
// standing on z = 0.
const mjOBJ_JOINT = 3;
export function poseRobot(mujoco, model, built, pose = {}, size = DEFAULT_SIZE) {
  const data = new mujoco.MjData(model);
  if (model.nkey > 0) mujoco.mj_resetDataKeyframe(model, data, 0);
  for (const [name, value] of Object.entries(pose ?? {})) {
    const j = mujoco.mj_name2id(model, mjOBJ_JOINT, name);
    if (j >= 0 && model.jnt_type[j] >= 2) data.qpos[model.jnt_qposadr[j]] = value; // hinge and slide joints only
  }
  mujoco.mj_forward(model, data);
  syncGeoms(model, data, built.meshes);
  syncBodies(data, built.bodies);
  data.delete();

  // Frame it from the visible meshes only (hidden collision shapes would
  // throw off the box), in the robot's own frame (the turntable may be turned).
  const { robot, root } = built;
  robot.updateMatrixWorld(true);
  const toRobot = robot.matrixWorld.clone().invert();
  const box = new THREE.Box3();
  const part = new THREE.Box3();
  const m = new THREE.Matrix4();
  robot.traverseVisible((o) => {
    if (!o.isMesh) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    box.union(part.copy(o.geometry.boundingBox).applyMatrix4(m.multiplyMatrices(toRobot, o.matrixWorld)));
  });
  const extent = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  built.longest = Math.max(extent.x, extent.y, extent.z, 1e-6);
  root.scale.setScalar((size ?? DEFAULT_SIZE) / built.longest);
  robot.position.set(-center.x, -center.y, -box.min.z);
}
