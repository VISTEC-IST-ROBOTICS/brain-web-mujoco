import * as THREE from 'three';

// Draws a MuJoCo model's geoms: one Three.js mesh per geom, built generically
// from its type / size / material, so any model using these shapes (or mesh
// assets) can be dropped in.

const mjGEOM = { PLANE: 0, SPHERE: 2, CAPSULE: 3, CYLINDER: 5, BOX: 6, MESH: 7 };
const mjOBJ_MATERIAL = 14;
// MuJoCo convention: geom group 3 = collision-only shapes, hidden when a
// robot has separate visual meshes.
const COLLISION_GROUP = 3;

// Adds the meshes to `scene` and returns them indexed by geom id (null for
// geom types that aren't drawn). Each Three.js material is named after the
// geom's MJCF material, if any (the Body colour picker looks for 'printed').
export function buildGeoms(mujoco, model, scene) {
  const meshes = new Array(model.ngeom).fill(null);
  for (let i = 0; i < model.ngeom; i++) {
    const type = model.geom_type[i];
    const geometry = geomGeometry(model, i);
    if (!geometry) continue;
    const material = type === mjGEOM.PLANE ? floorMaterial(geometry.parameters) : geomMaterial(model, i);
    if (model.geom_matid[i] >= 0) material.name = mujoco.mj_id2name(model, mjOBJ_MATERIAL, model.geom_matid[i]) ?? '';
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    mesh.castShadow = type !== mjGEOM.PLANE;
    scene.add(mesh);
    meshes[i] = mesh;
  }
  return meshes;
}

export function hasFloor(model) {
  return Array.from(model.geom_type).includes(mjGEOM.PLANE);
}

// Whether the model has geoms that are only looks (contype = conaffinity = 0,
// as MORF's CAD meshes), apart from its collision shapes.
export function hasVisualOnlyGeoms(model) {
  return Array.from({ length: model.ngeom }, (_, i) => i)
    .some((i) => !model.geom_contype[i] && !model.geom_conaffinity[i] && model.geom_group[i] !== COLLISION_GROUP);
}

export function hideCollisionGeoms(model, meshes) {
  meshes.forEach((m, i) => m && model.geom_group[i] === COLLISION_GROUP && (m.visible = false));
}

const _m4 = new THREE.Matrix4();

// Copies each geom's world pose from the simulation onto its mesh.
export function syncGeoms(model, data, meshes) {
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

function geomGeometry(model, i) {
  const size = [model.geom_size[3 * i], model.geom_size[3 * i + 1], model.geom_size[3 * i + 2]];
  let geometry;
  switch (model.geom_type[i]) {
    case mjGEOM.PLANE:
      return new THREE.PlaneGeometry(size[0] > 0 ? size[0] * 2 : 40, size[1] > 0 ? size[1] * 2 : 40);
    case mjGEOM.SPHERE:
      return new THREE.SphereGeometry(size[0], 24, 16);
    case mjGEOM.CAPSULE:
      geometry = new THREE.CapsuleGeometry(size[0], size[1] * 2, 6, 12);
      geometry.rotateX(Math.PI / 2); // MuJoCo capsules/cylinders point along local Z, three's along Y
      return geometry;
    case mjGEOM.CYLINDER:
      geometry = new THREE.CylinderGeometry(size[0], size[0], size[1] * 2, 20);
      geometry.rotateX(Math.PI / 2);
      return geometry;
    case mjGEOM.BOX:
      return new THREE.BoxGeometry(size[0] * 2, size[1] * 2, size[2] * 2);
    case mjGEOM.MESH:
      return meshGeometry(model, model.geom_dataid[i]);
    default:
      return null; // heightfields etc. are out of scope for this minimal viewer
  }
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

function geomMaterial(model, i) {
  const matid = model.geom_matid[i];
  const rgba = matid >= 0
    ? [model.mat_rgba[4 * matid], model.mat_rgba[4 * matid + 1], model.mat_rgba[4 * matid + 2], model.mat_rgba[4 * matid + 3]]
    : [model.geom_rgba[4 * i], model.geom_rgba[4 * i + 1], model.geom_rgba[4 * i + 2], model.geom_rgba[4 * i + 3]];
  const isMesh = model.geom_type[i] === mjGEOM.MESH;
  return new THREE.MeshStandardMaterial({
    // MJCF rgba values are display (sRGB) colours, as MuJoCo's own renderer
    // shows them; plain THREE.Color(r, g, b) would read them as linear and
    // wash them out (red 1 0.2 0.2 turns pink).
    color: new THREE.Color().setRGB(rgba[0], rgba[1], rgba[2], THREE.SRGBColorSpace),
    transparent: rgba[3] < 1,
    opacity: rgba[3],
    roughness: isMesh ? 0.4 : 0.7,
    metalness: isMesh ? 0.1 : 0,
  });
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
