// Headless check of the gecko model + gait using the same WASM MuJoCo and
// controller code as the browser app.
//   node tools/test_gecko.mjs
import { readFileSync } from 'node:fs';
import loadMujoco from '@mujoco/mujoco';
import { createGeckoRobot, JOINT_SIGNS } from '../src/robots/gecko.js';

const DIR = new URL('../public/assets/gecko/', import.meta.url);
const mujoco = await loadMujoco();
const xml = readFileSync(new URL('gecko.xml', DIR), 'utf8');
const vfs = new mujoco.MjVFS();
for (const [, file] of xml.matchAll(/<mesh [^>]*file="([^"]+)"/g)) {
  vfs.addBuffer(file, new Uint8Array(readFileSync(new URL(`meshes/${file}`, DIR))));
}
const model = mujoco.MjModel.from_xml_string(xml, vfs);

// Sets JOINT_SIGNS from `signs`, simulates `seconds` with a constant joystick
// and returns base displacement (x, y), heading change, min/max base height.
function run(joy, seconds, signs = {}) {
  Object.assign(JOINT_SIGNS, signs);
  const data = new mujoco.MjData(model);
  const robot = createGeckoRobot(mujoco, model);
  robot.reset(data);
  const dt = model.opt.timestep;
  const idle = { leftY: 0, rightX: 0, rightY: 0 };
  for (let t = 0; t < 2; t += dt) { robot.control(data, idle, dt); mujoco.mj_step(model, data); } // settle
  const q = data.qpos;
  const yaw = () => Math.atan2(2 * (q[3] * q[6] + q[4] * q[5]), 1 - 2 * (q[5] ** 2 + q[6] ** 2));
  const x0 = q[0], y0 = q[1], yaw0 = yaw();
  let zmin = Infinity, zmax = -Infinity, upright = true;
  for (let t = 0; t < seconds; t += dt) {
    robot.control(data, joy, dt);
    mujoco.mj_step(model, data);
    zmin = Math.min(zmin, q[2]); zmax = Math.max(zmax, q[2]);
    // body z-axis world z component = 1 - 2(qx^2 + qy^2)
    if (1 - 2 * (q[4] ** 2 + q[5] ** 2) < 0.5) upright = false;
  }
  // body pitch (+ = nose down, base_link x axis pointing below horizontal)
  const pitchDeg = (Math.asin(-2 * (q[4] * q[6] - q[3] * q[5])) * 180) / Math.PI;
  const r = {
    pitchDeg: +pitchDeg.toFixed(1),
    dx: +(q[0] - x0).toFixed(3), dy: +(q[1] - y0).toFixed(3),
    dyawDeg: +(((yaw() - yaw0) * 180) / Math.PI).toFixed(1),
    z: [+zmin.toFixed(3), +zmax.toFixed(3)], upright,
    finite: Array.from(q).every(Number.isFinite),
  };
  data.delete();
  return r;
}

const fwd = { leftY: 1, rightX: 0, rightY: 0 };
if (process.argv[2] === 'signs') {
  for (const swing of [1, -1]) for (const spine of [1, -1]) {
    console.log({ swing, spine }, run(fwd, 8, { swing, spine }));
  }
} else {
  console.log('idle          ', run({ leftY: 0, rightX: 0, rightY: 0 }, 3));
  console.log('forward       ', run(fwd, 8));
  console.log('backward      ', run({ leftY: -1, rightX: 0, rightY: 0 }, 8));
  console.log('fwd + left    ', run({ leftY: 1, rightX: -1, rightY: 0 }, 8));
  console.log('fwd + right   ', run({ leftY: 1, rightX: 1, rightY: 0 }, 8));
  console.log('fwd fixedspine', run({ ...fwd, fixedSpine: true }, 8));
  console.log('pitch stick up  ', run({ leftY: 0, rightX: 0, rightY: 1 }, 3));
  console.log('pitch stick down', run({ leftY: 0, rightX: 0, rightY: -1 }, 3));
}
