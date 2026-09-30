// The physics side of a robot page: fetching and compiling the MJCF model,
// and stepping MuJoCo with the robot's controller in fixed timesteps.

// Fetches an MJCF file plus any mesh files it references, for a MuJoCo
// virtual filesystem, so models with mesh assets load in the browser. Kept
// apart from compiling so the downloads can start before MuJoCo and Python
// are ready.
// onProgress(fraction): mesh files finished plus the bytes of those under
// way, over all of them (known once the small XML has arrived).
export async function fetchModelFiles(url, onProgress = () => {}) {
  let fileCount = 1;
  let finished = 0;
  const partial = new Map();
  const report = () => onProgress((finished + [...partial.values()].reduce((a, b) => a + b, 0)) / fileCount);
  const read = async (key, res) => {
    const bytes = await readBody(res, (f) => { partial.set(key, f); report(); });
    partial.delete(key);
    finished++;
    report();
    return bytes;
  };

  const res = await fetch(url);
  // Dev servers and some hosts answer a missing file with the index page.
  if (!res.ok || (res.headers.get('content-type') ?? '').includes('text/html')) {
    throw new Error(`Model file not found: public/${url}. Check MODEL in the robot's .py file.`);
  }
  const xml = await res.text();
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const meshdir = doc.querySelector('compiler')?.getAttribute('meshdir') ?? '';
  const base = new URL(url, location.href);
  const files = [...doc.querySelectorAll('mesh[file]')].map((m) => m.getAttribute('file'));
  fileCount = files.length || 1;
  const meshes = await Promise.all(files.map(async (file) => {
    const path = meshdir ? `${meshdir}/${file}` : file;
    const res = await fetch(new URL(path, base));
    if (!res.ok) throw new Error(`failed to fetch mesh ${path}: ${res.status}`);
    return [file, await read(path, res)];
  }));
  onProgress(1);
  return { xml, meshes };
}

// A response body as bytes, reporting onFraction(0..1) as it streams in
// (when the size is known; a compressed response can over-count, hence min).
async function readBody(res, onFraction) {
  // Compressed responses: the size header counts compressed bytes, so skip it.
  const size = res.headers.has('content-encoding') ? 0 : Number(res.headers.get('content-length'));
  if (!res.body || !size) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onFraction(Math.min(1, received / size));
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function compileModel(mujoco, { xml, meshes }) {
  const vfs = new mujoco.MjVFS();
  for (const [file, bytes] of meshes) vfs.addBuffer(file, bytes);
  return mujoco.MjModel.from_xml_string(xml, vfs);
}

// Compiles the model (files from fetchModelFiles) and pairs it with the
// robot's controller (robotDef from loadPythonRobot).
export function createSimulation(mujoco, files, robotDef) {
  const model = compileModel(mujoco, files);
  const data = new mujoco.MjData(model);
  const robot = robotDef.create(mujoco, model);
  const timestep = model.opt.timestep;
  let owed = 0; // real time not simulated yet, s

  const sim = {
    model,
    data,
    // Back to the start: the model's first keyframe when it has one (e.g.
    // B1's standing pose), else its default pose.
    reset() {
      if (model.nkey > 0) mujoco.mj_resetDataKeyframe(model, data, 0);
      else mujoco.mj_resetData(model, data);
      robot.reset(data);
      mujoco.mj_forward(model, data);
      owed = 0;
    },
    // Catches up with `seconds` of real time in whole physics steps (the
    // remainder carries over to the next call), calling the controller
    // before each step with the input `joy`.
    advance(seconds, joy) {
      owed += seconds;
      while (owed >= timestep) {
        robot.control(data, joy, timestep);
        mujoco.mj_step(model, data);
        owed -= timestep;
      }
    },
  };
  sim.reset();
  return sim;
}
