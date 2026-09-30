// Page entry point. ?robot=<name> opens a Python robot
// (python/robots/<name>.py); without it (or with an unknown name) the page
// shows the robot menu.
//
// A robot page is put together from:
//   simulation.js      the MJCF model and MuJoCo physics, with the controller
//   robots/python.js   the Python controller, run in Pyodide
//   render/view.js     the Three.js scene that draws the simulation
//   hud.js, input.js   the help box / mode switch, keyboard / gamepad / touch
//   loading.js         the loading screen
import loadMujoco from '@mujoco/mujoco';
import { availableRobotCards, loadPythonRobot, pythonRobotCards, pythonRobotNames, showError } from './robots/python.js';
import { showLanding } from './landing.js';
import { isTouchDevice } from './touch.js';
import { createLoadingScreen, onDownload } from './loading.js';
import { createSimulation, fetchModelFiles } from './simulation.js';
import { createHud } from './hud.js';
import { createInput } from './input.js';
import { createPaintControl } from './paint.js';
import { createView } from './render/view.js';
import { loadVisuals } from './render/visuals.js';

const robotName = new URLSearchParams(location.search).get('robot');

if (pythonRobotNames.includes(robotName)) {
  const card = pythonRobotCards.find((c) => c.name === robotName);
  // Weights: roughly each step's share of a typical load.
  const loading = createLoadingScreen(card?.title ?? robotName, [
    { id: 'python', label: 'Python runtime', weight: 50 },
    { id: 'mujoco', label: 'Physics engine', weight: 10 },
    { id: 'model', label: 'Robot model', weight: 20 },
    ...(card?.visuals ? [{ id: 'visuals', label: '3D visuals', weight: 10 }] : []),
    { id: 'scene', label: 'Building the scene', weight: 10 },
  ]);
  openRobot(card, loading).catch((err) => {
    loading.fail();
    showError(err);
  });
} else {
  availableRobotCards().then((cards) => showLanding(cards, robotName));
}

async function openRobot(card, loading) {
  const hudEl = document.getElementById('hud');
  hudEl.style.visibility = 'hidden'; // until the scene is ready
  const { mujoco, robotDef, files, visuals } = await download(card, loading);

  loading.progress('scene');
  await new Promise((resolve) => setTimeout(resolve)); // let the checklist repaint before the busy part
  const sim = createSimulation(mujoco, files, robotDef);
  const touch = isTouchDevice();
  const hud = createHud(robotDef, touch);
  const view = createView(mujoco, sim, visuals, robotDef.camera);
  createPaintControl(view.scene, robotDef);
  const touchButtons = robotDef.touchButtons ?? [];
  const input = createInput(
    touchButtons.filter((b) => b.toggle).map((b) => b.code),
    hud.drive,
    touch && [{ label: 'Reset', code: 'KeyR' }, ...touchButtons],
  );

  runLoop(sim, view, input, hud, robotDef);
  requestAnimationFrame(() => {
    hudEl.style.visibility = '';
    loading.finish();
  });
}

// Everything the page needs from the network, reported on the loading
// screen. The MuJoCo engine and the model and visuals files the robot's .py
// names (read from its text, as the menu does) download while Pyodide loads.
async function download(card, loading) {
  // MuJoCo's engine (.wasm, ~10 MB): progress when its size is known.
  const stopWatching = onDownload((url) => /mujoco[^/]*\.wasm/.test(url),
    (url, bytes, total) => total && loading.progress('mujoco', 0.9 * bytes / total));
  const mujocoReady = loading.track('mujoco', loadMujoco());
  mujocoReady.then(stopWatching, stopWatching);
  const getModel = (url) => fetchModelFiles(url, (f) => loading.progress('model', f));
  const getVisuals = (url) => loadVisuals(url, (f) => loading.progress('visuals', f));
  const early = {
    model: card?.model && getModel(card.model),
    visuals: card?.visuals && getVisuals(card.visuals),
  };
  Object.values(early).forEach((p) => p?.catch(() => {})); // reported where they're awaited

  const robotDef = await loading.track('python', loadPythonRobot(robotName, (f) => loading.progress('python', f)));
  const mujoco = await mujocoReady;
  // Normally the early downloads; fetched again only if the .py computes
  // its paths in a way the text scan couldn't see.
  const { modelUrl, visualsUrl } = robotDef;
  const [files, visuals] = await Promise.all([
    loading.track('model', modelUrl === card?.model ? early.model : getModel(modelUrl)),
    visualsUrl && loading.track('visuals', visualsUrl === card?.visuals ? early.visuals : getVisuals(visualsUrl)),
  ]);
  return { mujoco, robotDef, files, visuals: visuals || null };
}

// Every animation frame: read the input, simulate the real time that
// passed (R holds the robot at its start pose), draw.
function runLoop(sim, view, input, hud, robotDef) {
  const MAX_FRAME_TIME = 1 / 30; // s; slower frames slow the simulation down instead of piling up steps
  let lastTime = performance.now();
  let resetHeld = false;

  function frame() {
    const now = performance.now();
    const elapsed = Math.min((now - lastTime) / 1000, MAX_FRAME_TIME);
    lastTime = now;

    const joy = input.read();
    // The speed slider is for Watch mode; driving runs at the robot's DRIVE_SPEED.
    joy.speed = hud.mode.watching ? hud.speed.value : robotDef.driveSpeed;
    joy.watch = hud.mode.watching;
    const wasHeld = resetHeld;
    resetHeld = input.keys.has('KeyR');
    if (resetHeld && !wasHeld) {
      sim.reset();
      view.reset();
    }
    if (!resetHeld) sim.advance(elapsed, joy);

    view.render();
    requestAnimationFrame(frame);
  }
  frame();
}
