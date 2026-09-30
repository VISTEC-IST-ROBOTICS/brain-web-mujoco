import * as THREE from 'three';

// Lab logo: a corner badge on the page (index.html) and a sign in the scene.
const LOGO_URL = 'assets/brain_logo_v2.webp';

// The lab logo on a white sign standing on the floor behind the start
// position, facing the default camera, printed on both faces so it reads
// correctly from either side. Visual only: physics never sees it, so robots
// pass through it.
export function addLogoSign(scene, renderer) {
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
