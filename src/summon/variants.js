// The summon pool: colour variants in four rarity tiers, the roll, and the
// player's collection (kept in localStorage, so it's per browser).
import * as THREE from 'three';

export const TIERS = {
  common: { label: 'Common', stars: 1, weight: 60, color: '#aab4c0' },
  rare: { label: 'Rare', stars: 2, weight: 28, color: '#4fc3ff' },
  epic: { label: 'Epic', stars: 3, weight: 10, color: '#c77dff' },
  legendary: { label: 'Legendary', stars: 4, weight: 2, color: '#ffcc33' },
};

// finish: how the robot's 'printed' material looks (see stage.js).
//   roughness / metalness: MeshStandardMaterial values
//   glow: emissive colour that pulses; prism: hue cycles over time
const MATTE = { roughness: 0.75, metalness: 0 };
const GLOSS = { roughness: 0.18, metalness: 0.05 };
export const VARIANTS = [
  { id: 'crimson', name: 'Crimson', tier: 'common', color: '#c8262e', ...MATTE },
  { id: 'tangerine', name: 'Tangerine', tier: 'common', color: '#e8731a', ...MATTE },
  { id: 'lemon', name: 'Lemon', tier: 'common', color: '#f2c318', ...MATTE },
  { id: 'leaf', name: 'Leaf', tier: 'common', color: '#4c9a2a', ...MATTE },
  { id: 'sky', name: 'Sky', tier: 'common', color: '#3aa0e8', ...MATTE },
  { id: 'graphite', name: 'Graphite', tier: 'common', color: '#2b2b2b', ...MATTE },
  { id: 'sakura', name: 'Sakura', tier: 'rare', color: '#f48fb1', ...GLOSS },
  { id: 'mint', name: 'Mint', tier: 'rare', color: '#5ee6b0', ...GLOSS },
  { id: 'lavender', name: 'Lavender', tier: 'rare', color: '#a98bf0', ...GLOSS },
  { id: 'ocean', name: 'Ocean', tier: 'rare', color: '#1f6fd1', ...GLOSS },
  { id: 'chrome', name: 'Chrome', tier: 'epic', color: '#d9dde3', roughness: 0.12, metalness: 1 },
  { id: 'rose_gold', name: 'Rose Gold', tier: 'epic', color: '#e0a088', roughness: 0.25, metalness: 1 },
  { id: 'cobalt', name: 'Cobalt', tier: 'epic', color: '#3355ff', roughness: 0.3, metalness: 0.9 },
  { id: 'solar', name: 'Solar Gold', tier: 'legendary', color: '#ffc93c', roughness: 0.18, metalness: 1, glow: '#ff9d00' },
  { id: 'prism', name: 'Prism', tier: 'legendary', color: '#ff4fd8', roughness: 0.15, metalness: 0.4, prism: true },
  { id: 'void', name: 'Void', tier: 'legendary', color: '#111318', roughness: 0.35, metalness: 0.6, glow: '#00e5ff' },
];

// Puts a variant's finish on a robot's 'printed' materials, on the summon
// pedestal and on the robot page (?variant=<id>, see paint.js).
export function applyFinish(materials, v) {
  for (const m of materials) {
    m.color.set(v.color);
    m.roughness = v.roughness;
    m.metalness = v.metalness;
    m.emissive.set(v.glow ?? 0x000000);
    m.emissiveIntensity = 0;
  }
}

// Legendary finishes move, every frame: a pulsing glow, or a hue that cycles.
// t: seconds.
const _color = new THREE.Color();
export function animateFinish(materials, v, t) {
  if (v.glow) {
    const pulse = 0.25 + 0.2 * Math.sin(t * 2.4);
    materials.forEach((m) => (m.emissiveIntensity = pulse));
  }
  if (v.prism) {
    _color.setHSL((t * 0.08) % 1, 0.85, 0.6, THREE.SRGBColorSpace);
    materials.forEach((m) => m.color.copy(_color));
  }
}

// Every PITY-th summon without an Epic or better is guaranteed one.
export const PITY = 10;

const pick = (items, weight) => {
  let r = Math.random() * items.reduce((sum, x) => sum + weight(x), 0);
  return items.find((x) => (r -= weight(x)) < 0) ?? items[items.length - 1];
};

// One summon: a random robot (uniform) in a random variant (tier by weight,
// then uniform within the tier). Updates the pity counter.
export function roll(robots) {
  const state = load();
  const guaranteed = state.sinceEpic >= PITY - 1;
  const tiers = Object.keys(TIERS).filter((t) => !guaranteed || TIERS[t].stars >= TIERS.epic.stars);
  const tier = pick(tiers, (t) => TIERS[t].weight);
  const variant = pick(VARIANTS.filter((v) => v.tier === tier), () => 1);
  const robot = robots[Math.floor(Math.random() * robots.length)];

  const key = `${robot.name}/${variant.id}`;
  const isNew = !state.caught[key];
  state.caught[key] = (state.caught[key] ?? 0) + 1;
  state.total++;
  state.sinceEpic = TIERS[tier].stars >= TIERS.epic.stars ? 0 : state.sinceEpic + 1;
  save();
  return { robot, variant, isNew, count: state.caught[key] };
}

// { caught: { 'robot/variant': times }, total, sinceEpic }
let state = null; // kept in memory too, for when storage is unavailable
export function load() {
  return (state ??= read());
}

function read() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (s && typeof s.caught === 'object') return { total: 0, sinceEpic: 0, ...s };
  } catch {
    // storage unavailable or corrupt: start fresh
  }
  return { caught: {}, total: 0, sinceEpic: 0 };
}

const STORAGE_KEY = 'summon:collection';

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // private mode etc.: the collection lasts until the page closes
  }
}
