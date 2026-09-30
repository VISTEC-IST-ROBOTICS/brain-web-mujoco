import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

// A robot's VISUALS file: visual-only meshes (GLB, meshopt-compressed) with
// one node per MuJoCo body, named after it and authored in that body's frame.
// Physics never sees these.

const mjOBJ_BODY = 1;

export async function loadVisuals(url, onProgress = () => {}) {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  return (await loader.loadAsync(url, (e) => e.total && onProgress(e.loaded / e.total))).scene;
}

// Moves each node named after a body into `scene`; returns [{ id, group }]
// for syncBodies. Nodes with no matching body are left out.
export function attachVisuals(mujoco, model, gltfScene, scene) {
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

export function syncBodies(data, bodies) {
  for (const { id, group } of bodies) {
    group.position.set(data.xpos[3 * id], data.xpos[3 * id + 1], data.xpos[3 * id + 2]);
    // MuJoCo quats are (w, x, y, z)
    group.quaternion.set(data.xquat[4 * id + 1], data.xquat[4 * id + 2], data.xquat[4 * id + 3], data.xquat[4 * id]);
  }
}
