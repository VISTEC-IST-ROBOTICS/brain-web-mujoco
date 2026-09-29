// Robots whose controller is written in Python (python/robots/<name>.py),
// run in the browser with Pyodide. Pyodide (~10 MB) is only downloaded when
// one of these robots is selected. See python/simbot.py for the robot file
// format; the same files run natively with python/run_local.py.
import simbotSource from '../../python/simbot.py?raw';
import { onDownload } from '../loading.js';

const PYODIDE_URL = 'https://cdn.jsdelivr.net/pyodide/v314.0.7/full/';

const mjOBJ = { JOINT: 3, ACTUATOR: 19, SENSOR: 20 };
const mjJNT_FREE = 0;
const mjJNT_BALL = 1;

// Every .py under python/robots/ (as source text); files starting with '_'
// are helpers robots can import, not robots themselves.
const sources = Object.fromEntries(
  Object.entries(import.meta.glob('../../python/robots/*.py', { query: '?raw', import: 'default', eager: true }))
    .map(([path, src]) => [path.match(/([^/]+)\.py$/)[1], src]),
);
export const pythonRobotNames = Object.keys(sources).filter((n) => !n.startsWith('_'));

// Menu cards, read from the source text so listing robots doesn't need
// Pyodide: TITLE / DESCRIPTION / THUMBNAIL (one-line strings), falling back
// to the file name and the docstring's first paragraph.
export const pythonRobotCards = pythonRobotNames.map((name) => {
  const src = sources[name];
  const constant = (key) => src.match(new RegExp(`^${key}\\s*=\\s*(["'])(.*?)\\1`, 'm'))?.[2];
  const flag = (key) => new RegExp(`^${key}\\s*=\\s*True\\b`, 'm').test(src);
  const defined = (key) => new RegExp(`^${key}\\s*=\\s*[^N\\s]`, 'm').test(src); // set, and not to None
  const doc = src.match(/^\s*(?:"{3}|'{3})([\s\S]*?)(?:\n\s*\n|"{3}|'{3})/)?.[1].replace(/\s+/g, ' ').trim();
  return {
    name,
    title: constant('TITLE') ?? name,
    description: constant('DESCRIPTION') ?? doc,
    thumbnail: constant('THUMBNAIL'),
    model: constant('MODEL'),
    visuals: constant('VISUALS'),
    controllable: flag('USER_CONTROL'),
    watchable: flag('USER_CONTROL') && defined('WATCH_INPUT'),
    hidden: flag('HIDDEN'), // work in progress: left out of the menu, ?robot=<name> still opens it
  };
});

// The cards whose MODEL file is actually there, so the menu only offers
// robots that can load (e.g. not one whose XML was deleted or mistyped).
// Some static hosts answer a missing file with the index page (200,
// text/html), so an HTML answer counts as missing too.
export async function availableRobotCards() {
  const cards = pythonRobotCards.filter((c) => !c.hidden);
  const found = await Promise.all(cards.map(async ({ name, model }) => {
    try {
      const res = model && await fetch(model, { method: 'HEAD' });
      if (res?.ok && !(res.headers.get('content-type') ?? '').includes('text/html')) return true;
    } catch {
      // network error: treat as missing
    }
    console.warn(`Robot "${name}" left out of the menu: python/robots/${name}.py sets MODEL = ${JSON.stringify(model)}, `
      + 'but that file is not in public/.');
    return false;
  }));
  return cards.filter((_, i) => found[i]);
}

// Uncompressed sizes of the files Pyodide fetches at start-up (for the
// loading bar: the CDN compresses them, so its size headers don't match the
// bytes that arrive). Update them with PYODIDE_URL.
const PYODIDE_FILE_SIZES = { 'pyodide.asm.wasm': 9598218, 'python_stdlib.zip': 2545637, 'pyodide-lock.json': 119077 };

// onProgress(fraction): Pyodide's downloads, byte by byte (up to 70%), then
// its start-up (85%) and the robot's packages (95%).
export async function loadPythonRobot(name, onProgress = () => {}) {
  const received = {};
  const expected = Object.values(PYODIDE_FILE_SIZES).reduce((a, b) => a + b, 0);
  const stopWatching = onDownload((url) => url.startsWith(PYODIDE_URL), (url, bytes) => {
    const file = url.slice(PYODIDE_URL.length);
    if (!(file in PYODIDE_FILE_SIZES)) return;
    received[file] = Math.min(bytes, PYODIDE_FILE_SIZES[file]);
    onProgress(0.7 * Object.values(received).reduce((a, b) => a + b, 0) / expected);
  });
  const { loadPyodide } = await import(/* @vite-ignore */ `${PYODIDE_URL}pyodide.mjs`);
  const py = await loadPyodide({ indexURL: PYODIDE_URL });
  stopWatching();
  onProgress(0.85);

  py.FS.mkdirTree('/robot/robots');
  py.FS.writeFile('/robot/simbot.py', simbotSource);
  for (const [file, src] of Object.entries(sources)) py.FS.writeFile(`/robot/robots/${file}.py`, src);
  // Fetch packages (numpy etc.) the robot and its helpers import.
  const imported = [name, ...Object.keys(sources).filter((n) => n.startsWith('_'))];
  await py.loadPackagesFromImports(imported.map((n) => sources[n]).join('\n'));
  onProgress(0.95);

  const meta = JSON.parse(py.runPython(`
import importlib, json, sys
sys.path.insert(0, "/robot")
robot_module = importlib.import_module("robots.${name}")
json.dumps({
    "model": robot_module.MODEL,
    "camera": getattr(robot_module, "CAMERA", None),
    "help": getattr(robot_module, "HELP", ""),
    "buttons": getattr(robot_module, "BUTTONS", []),
    "visuals": getattr(robot_module, "VISUALS", None),
    "body_color": getattr(robot_module, "BODY_COLOR", None),
    "controllable": bool(getattr(robot_module, "USER_CONTROL", False)),
    "watchable": bool(getattr(robot_module, "USER_CONTROL", False) and getattr(robot_module, "WATCH_INPUT", None)),
    "speed_range": list(robot_module.SPEED_RANGE) if hasattr(robot_module, "SPEED_RANGE") else None,
    "drive_speed": float(getattr(robot_module, "DRIVE_SPEED", 1.0)),
})
`));
  const module = py.globals.get('robot_module');
  const Runner = py.pyimport('simbot').Runner;

  return {
    modelUrl: meta.model,
    visualsUrl: meta.visuals,
    bodyColor: meta.body_color,
    touchButtons: meta.buttons.map(({ label, key, toggle }) => ({ label, code: key, toggle: !!toggle })),
    camera: meta.camera ?? { position: [0.6, -0.8, 0.5], target: [0, 0, 0.1] },
    controllable: meta.controllable,
    // Also has a Watch mode (WATCH_INPUT), switchable on the page.
    watchable: meta.watchable,
    speedRange: meta.speed_range, // Watch mode's slider
    driveSpeed: meta.drive_speed, // obs.speed while driving
    // Driving keys only while the user drives (main.js shows .drive-only
    // or .watch-only lines by mode).
    hud: (meta.controllable
      ? '<div class="drive-only"><b>&uarr;/&darr;/W/S</b> forward/back &nbsp; <b>&larr;/&rarr;/A/D</b> turn &nbsp; <b>Q/E</b> up/down</div>'
      : '') +
      '<div class="watch-only">This robot moves on its own: just watch.</div>' +
      (meta.help ? `<div>${escapeHtml(meta.help)}</div>` : '') +
      `<div>Controller: python/robots/${name}.py</div>`,
    create(mujoco, model) {
      const runner = Runner(module, py.toPy(modelLayout(mujoco, model)));
      const period = 1 / runner.rate;
      let nextTick = 0;
      let failed = false;

      // Python errors (with traceback) go on screen, and the robot then holds
      // its last controls instead of stopping the whole page.
      const call = (data, fn) => {
        if (failed) return;
        try {
          const ctrl = fn();
          data.ctrl.set(ctrl.toJs());
          ctrl.destroy();
        } catch (err) {
          failed = true;
          showError(err);
        }
      };

      return {
        reset(data) {
          nextTick = 0;
          call(data, () => runner.reset_js(data.ctrl)); // from the start keyframe's controls, if any
        },
        // Called every physics step; ticks the controller at its own rate in
        // simulated time and holds its outputs in between.
        control(data, joy) {
          if (data.time < nextTick) return;
          nextTick += period;
          call(data, () => runner.step_js(
            data.time, joy.leftY, joy.rightX, joy.rightY, [...joy.keys], [...joy.toggles], joy.speed ?? 1,
            !!joy.watch, data.qpos, data.qvel, data.sensordata));
        },
      };
    },
  };
}

// The array layout simbot.Runner reads observations from (see its docstring).
function modelLayout(mujoco, model) {
  const name = (type, i, prefix) => mujoco.mj_id2name(model, type, i) || `${prefix}${i}`;
  const joints = [];
  let free = null;
  for (let j = 0; j < model.njnt; j++) {
    const type = model.jnt_type[j];
    const qadr = model.jnt_qposadr[j];
    const dadr = model.jnt_dofadr[j];
    if (type === mjJNT_FREE) free ??= [qadr, dadr]; // the first free joint is the robot's root
    else if (type !== mjJNT_BALL) joints.push([name(mjOBJ.JOINT, j, 'joint'), qadr, dadr]);
  }
  // Unlimited actuators compile to ctrlrange 0 0 (the bindings can't read
  // the boolean actuator_ctrllimited array).
  const range = (i) => {
    const [lo, hi] = [model.actuator_ctrlrange[2 * i], model.actuator_ctrlrange[2 * i + 1]];
    return lo < hi ? [lo, hi] : null;
  };
  return {
    actuators: Array.from({ length: model.nu }, (_, i) => name(mjOBJ.ACTUATOR, i, 'actuator')),
    ctrl_range: Array.from({ length: model.nu }, (_, i) => range(i)),
    joints,
    sensors: Array.from({ length: model.nsensor }, (_, i) =>
      [name(mjOBJ.SENSOR, i, 'sensor'), model.sensor_adr[i], model.sensor_dim[i]]),
    free,
  };
}

function escapeHtml(text) {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

// Shows an error (e.g. a Python traceback) over the scene.
export function showError(err) {
  console.error(err);
  let el = document.getElementById('error');
  if (!el) {
    el = document.createElement('pre');
    el.id = 'error';
    document.getElementById('app').appendChild(el);
  }
  el.textContent = String(err?.message ?? err);
}
