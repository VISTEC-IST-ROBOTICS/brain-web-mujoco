import * as THREE from 'three';

// Body-colour picker: recolours the materials named 'printed', the robot's
// shell parts: a VISUALS file's (see tools/usd_to_mjcf.py) or an MJCF
// <material name="printed"> (MORF, Red Mirror). Robots without one get no
// picker. Collapsed to one button showing the current colour; tapping it
// opens the palette, whose first entry, Original, is the robot's own colour
// (robotDef.bodyColor, else the model's). Another choice is kept per robot
// in localStorage; Original clears it.
const SWATCHES = ['#2b2b2b', '#4c9a2a', '#e8731a', '#1f6fd1', '#c8262e', '#f2c318', '#7a3fc4', '#e9e9e9'];

// Tolerant compare: Three.js stores colours linear, so round-tripping to
// sRGB hex can be off by one per channel.
function sameColor(a, b) {
  const [x, y] = [new THREE.Color(a), new THREE.Color(b)];
  return Math.max(Math.abs(x.r - y.r), Math.abs(x.g - y.g), Math.abs(x.b - y.b)) < 3 / 255;
}

// root: the Three.js scene with the robot in it.
export function createPaintControl(root, robotDef) {
  const materials = new Set();
  root.traverse((o) => o.isMesh && o.material.name === 'printed' && materials.add(o.material));
  if (!materials.size) return;

  const storageKey = `bodyColor:${robotDef.modelUrl}`;
  const original = robotDef.bodyColor ?? `#${[...materials][0].color.getHexString()}`;
  const swatches = SWATCHES.filter((c) => !sameColor(c, original)); // no second button for the same colour
  const app = document.getElementById('app');
  const el = document.createElement('div');
  el.id = 'paint';
  el.innerHTML = `<button class="current" aria-expanded="false"><i></i>Body</button>
    <div class="palette" hidden>
      <button class="original" data-color="${original}"><i style="background:${original}"></i>Original</button>
      ${swatches.map((c) => `<button style="background:${c}" data-color="${c}" aria-label="Colour ${c}"></button>`).join('')}
      <input type="color" aria-label="Custom body colour">
    </div>`;
  app.appendChild(el);
  app.classList.add('has-paint');
  const toggle = el.querySelector('.current');
  const palette = el.querySelector('.palette');
  const custom = el.querySelector('input');
  const setOpen = (open) => {
    palette.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  };
  toggle.addEventListener('click', () => setOpen(palette.hidden));

  const apply = (hex, remember = true) => {
    materials.forEach((m) => m.color.set(hex));
    custom.value = hex;
    toggle.querySelector('i').style.background = hex;
    palette.querySelectorAll('button').forEach((b) => b.classList.toggle('on', sameColor(b.dataset.color, hex)));
    try {
      if (remember) localStorage.setItem(storageKey, hex);
      else localStorage.removeItem(storageKey);
    } catch {
      // storage unavailable (private mode etc.): colour just isn't remembered
    }
  };
  palette.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    apply(b.dataset.color, !b.classList.contains('original'));
    setOpen(false);
  }));
  custom.addEventListener('input', () => apply(custom.value));
  custom.addEventListener('change', () => setOpen(false));

  let saved = null;
  try {
    saved = localStorage.getItem(storageKey);
  } catch {}
  if (saved) apply(saved);
  else apply(original, false);
}
