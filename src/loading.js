// Loading screen shown while a robot's page starts: a progress bar plus a
// checklist of the steps (several run at once). Each step reports a fraction
// 0..1 where there's something real to measure (bytes downloaded, files
// fetched, sub-steps finished); the bar is the weighted sum.

// steps: [{ id, label, weight }]
export function createLoadingScreen(title, steps) {
  const root = document.createElement('div');
  root.id = 'loading';
  root.setAttribute('role', 'progressbar');
  root.setAttribute('aria-valuemin', '0');
  root.setAttribute('aria-valuemax', '100');
  root.setAttribute('aria-label', `Loading ${title}`);
  root.innerHTML = `
    <div class="card">
      <h1>Loading ${escapeHtml(title)}</h1>
      <div class="bar"><div class="fill"></div></div>
      <div class="percent">0%</div>
      <ul>${steps.map(({ id, label }) =>
        `<li data-step="${id}" data-state="pending"><span class="icon" aria-hidden="true"></span>${escapeHtml(label)}</li>`).join('')}
      </ul>
      <a class="back" href="./">&larr; Robot menu</a>
    </div>`;
  document.getElementById('app').appendChild(root);

  const fill = root.querySelector('.fill');
  const percent = root.querySelector('.percent');
  const state = Object.fromEntries(steps.map(({ id, weight }) => [id, { weight, fraction: 0 }]));
  const total = steps.reduce((sum, s) => sum + s.weight, 0);
  const item = (id) => root.querySelector(`li[data-step="${id}"]`);

  const render = () => {
    const done = steps.reduce((sum, { id }) => sum + state[id].weight * state[id].fraction, 0) / total;
    const pct = Math.round(done * 100);
    fill.style.width = `${pct}%`;
    percent.textContent = `${pct}%`;
    root.setAttribute('aria-valuenow', String(pct));
  };

  const screen = {
    // A step is under way (optionally with how far along it is).
    progress(id, fraction = 0) {
      if (!state[id] || item(id).dataset.state === 'done') return;
      state[id].fraction = Math.max(state[id].fraction, Math.min(1, fraction));
      item(id).dataset.state = 'active';
      render();
    },
    done(id) {
      if (!state[id]) return;
      state[id].fraction = 1;
      item(id).dataset.state = 'done';
      render();
    },
    // Wraps a promise: the step is active while it runs, done when it resolves.
    track(id, promise) {
      screen.progress(id);
      promise.then(() => screen.done(id), () => {});
      return promise;
    },
    // Marks the steps still running as failed (the error itself is shown
    // by showError) and keeps the screen up.
    fail() {
      root.classList.add('failed');
      root.querySelectorAll('li[data-state="active"]').forEach((li) => (li.dataset.state = 'failed'));
    },
    // Fades out once the scene is on screen.
    finish() {
      steps.forEach(({ id }) => screen.done(id));
      root.classList.add('finished');
      setTimeout(() => root.remove(), 400);
    },
  };
  return screen;
}

// Byte-level progress for downloads made by code that reports none (Pyodide
// and MuJoCo fetch their big engine files themselves): wraps window.fetch
// once, and passes each matching response through a byte counter. `total`
// is the size header, or null when the response is compressed (the header
// then counts compressed bytes, the stream uncompressed ones).
const downloadListeners = new Set();

export function onDownload(match, callback) {
  installFetchWatch();
  const listener = { match, callback };
  downloadListeners.add(listener);
  return () => downloadListeners.delete(listener);
}

let fetchWatched = false;
function installFetchWatch() {
  if (fetchWatched) return;
  fetchWatched = true;
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const res = await original(input, init);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const listeners = [...downloadListeners].filter((l) => l.match(url));
    if (!listeners.length || !res.body) return res;
    const total = res.headers.has('content-encoding') ? null : Number(res.headers.get('content-length')) || null;
    let received = 0;
    const counter = new TransformStream({
      transform(chunk, controller) {
        received += chunk.byteLength;
        listeners.forEach((l) => l.callback(url, received, total));
        controller.enqueue(chunk);
      },
    });
    // Same status and headers (WebAssembly.instantiateStreaming needs the
    // application/wasm content type).
    return new Response(res.body.pipeThrough(counter), { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
