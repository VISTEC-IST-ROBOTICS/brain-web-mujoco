import { createMjcfViewer, createUrdfViewer } from './viewers.js';

const $ = (id) => document.getElementById(id);
const OPTION_IDS = ['model_path', 'scripts', 'usd_root', 'name', 'kp', 'kv', 'default_mass',
  'fixed_base', 'no_actuators', 'no_floor', 'msh'];

const viewerUi = (kind) => ({
  empty: $(`${kind}Empty`), info: $(`${kind}Info`), joints: $(`${kind}Joints`),
  collision: $(`${kind}Collision`), reset: $(`${kind}Reset`), play: $('play'),
});
const viewers = {
  urdf: createUrdfViewer($('pane-urdf'), viewerUi('urdf')),
  mjcf: createMjcfViewer($('pane-mjcf'), viewerUi('mjcf')),
};

let types = [];
let type = null; // the selected description type
let job = null; // { id, files: [relative paths] }

// ------------------------------------------------------------ tabs and viewers

function showTab(kind) {
  for (const k of ['urdf', 'mjcf']) {
    $(`tab-${k}`).setAttribute('aria-selected', k === kind);
    $(`pane-${k}`).hidden = k !== kind;
  }
}
$('tab-urdf').onclick = () => showTab('urdf');
$('tab-mjcf').onclick = () => showTab('mjcf');

async function view(kind, url) {
  showTab(kind);
  try {
    await viewers[kind].load(url);
  } catch (e) {
    console.error(e);
    viewers[kind].clear();
    const empty = $(`${kind}Empty`);
    empty.textContent = e.message ?? String(e);
    empty.classList.add('err');
  }
}

// ------------------------------------------------------------ description type

function selectType(id) {
  type = types.find((t) => t.id === id);
  for (const b of $('types').children) b.setAttribute('aria-pressed', b.dataset.id === id);
  $('typeHint').textContent = type.hint;
  $('typeHint').classList.remove('warn');
  for (const el of document.querySelectorAll('[data-for]')) el.hidden = !el.dataset.for.split(' ').includes(id);
  $('mainLabel').textContent = `Main file (${type.ext.join(', ')})`;
  refreshMain();
}

function candidates(t) {
  return (job?.files ?? []).filter((f) => t.ext.some((e) => f.toLowerCase().endsWith(e)))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

function refreshMain() {
  const list = candidates(type);
  const select = $('main');
  const keep = select.value;
  select.replaceChildren(...list.map((f) => new Option(f, f)));
  if (list.includes(keep)) select.value = keep;
  $('mainField').hidden = !job;
  if (job && !list.length) {
    $('typeHint').textContent = `No ${type.ext.join(' / ')} file among the uploaded files.`;
    $('typeHint').classList.add('warn');
  }
  $('convert').disabled = !list.length || !!type.unavailable;
  if (!$('name').value && list.length) $('name').placeholder = baseName(select.value);
}

const baseName = (path) => path.split('/').pop().replace(/\.[^.]+$/, '');

// Shows the chosen source file before converting: a URDF in the URDF viewer, an MJCF in the
// MuJoCo one. (Scenes and USD stages need converting first.)
function preview() {
  const main = $('main').value;
  if (!job || !main) return;
  const url = `/jobs/${job.id}/input/${main}`;
  if (type.id === 'urdf') view('urdf', url);
  if (type.id === 'mjcf') view('mjcf', url);
}
$('main').onchange = () => { refreshMain(); preview(); };

// ------------------------------------------------------------ uploads

// JSON from the server; a 409 (save target exists) comes back as { conflict: true, ... }
async function api(path, init) {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (res.status === 409) return { conflict: true, ...body };
  if (!res.ok) throw new Error(body.error ?? `${path}: ${res.status}`);
  return body;
}

// files: [{ path: relative path, file: File }]
async function upload(files) {
  if (!files.length) return;
  setStatus(`<span class="spinner"></span>Uploading ${files.length} files…`);
  $('results').hidden = true;
  $('logBox').hidden = true;
  const { id } = await api('/api/jobs', { method: 'POST' });
  let done = 0;
  const queue = [...files];
  const worker = async () => {
    for (let item; (item = queue.shift());) {
      const path = item.path.split('/').map(encodeURIComponent).join('/');
      await api(`/api/jobs/${id}/input/${path}`, { method: 'PUT', body: item.file });
      $('filesum').textContent = `Uploading… ${++done} / ${files.length}`;
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  const { files: list } = await api(`/api/jobs/${id}/files`, { method: 'POST' });
  job = { id, files: list };
  const size = files.reduce((s, f) => s + f.file.size, 0);
  $('filesum').textContent = `${list.length} files (${(size / 1e6).toFixed(1)} MB uploaded)`;
  setStatus('');

  // Switch to a type that fits the files when the selected one doesn't
  if (!candidates(type).length) {
    const fit = types.find((t) => !t.unavailable && candidates(t).length) ?? types.find((t) => candidates(t).length);
    if (fit) selectType(fit.id);
  }
  $('name').value = '';
  refreshMain();
  preview();
}

// Everything under a dropped folder, recursively.
async function entryFiles(entry) {
  if (entry.isFile) {
    return [{ path: entry.fullPath.replace(/^\//, ''), file: await new Promise((ok, err) => entry.file(ok, err)) }];
  }
  const reader = entry.createReader();
  const entries = [];
  for (let batch; (batch = await new Promise((ok, err) => reader.readEntries(ok, err))).length;) entries.push(...batch);
  return (await Promise.all(entries.map(entryFiles))).flat();
}

const drop = $('drop');
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = async (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const entries = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  const files = entries.length
    ? (await Promise.all(entries.map(entryFiles))).flat()
    : [...e.dataTransfer.files].map((file) => ({ path: file.name, file }));
  upload(files).catch(fail);
};
$('pickFolder').onclick = () => $('folderInput').click();
$('pickFiles').onclick = () => $('filesInput').click();
$('folderInput').onchange = (e) => upload([...e.target.files].map((file) => ({ path: file.webkitRelativePath || file.name, file }))).catch(fail);
$('filesInput').onchange = (e) => upload([...e.target.files].map((file) => ({ path: file.name, file }))).catch(fail);

// ------------------------------------------------------------ convert, download, save

function setStatus(html, cls = '') {
  $('status').innerHTML = html;
  $('status').className = cls;
}
function fail(e) {
  console.error(e);
  setStatus(e.message ?? String(e), 'err');
}

function options() {
  const opts = {};
  for (const id of OPTION_IDS) {
    const el = $(id);
    opts[id] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return opts;
}

$('convert').onclick = async () => {
  const button = $('convert');
  button.disabled = true;
  const slow = type.id === 'coppeliasim' ? ' (CoppeliaSim takes a while to start)' : '';
  setStatus(`<span class="spinner"></span>Converting…${slow}`);
  $('results').hidden = true;
  try {
    const r = await api(`/api/jobs/${job.id}/convert`, {
      method: 'POST', body: JSON.stringify({ type: type.id, main: $('main').value, options: options() }),
    });
    $('log').textContent = r.log;
    $('logBox').hidden = !r.log;
    $('logBox').open = !r.ok;
    if (!r.ok) {
      setStatus('Conversion failed: see the log below.', 'err');
      return;
    }
    const summary = r.log.split('\n').reverse().find((l) => l.startsWith('OK: ')) ?? 'OK';
    setStatus(summary.replace(/^OK: /, 'Done: '), 'ok');
    $('download').href = `/api/jobs/${job.id}/download`;
    $('download').download = `${$('name').value || baseName(r.mjcf)}_mjcf.zip`;
    $('results').hidden = false;
    $('results').dataset.name = baseName(r.mjcf);
    if (r.urdf) viewers.urdf.load(r.urdf).catch(console.error);
    await view('mjcf', r.mjcf);
  } catch (e) {
    fail(e);
  } finally {
    button.disabled = false;
  }
};

$('save').onclick = async () => {
  const name = prompt('Save to assets_src/<name>/. Name:', $('results').dataset.name);
  if (!name) return;
  const save = (overwrite) => api(`/api/jobs/${job.id}/save`, { method: 'POST', body: JSON.stringify({ name, overwrite }) });
  try {
    let r = await save(false);
    if (r.conflict) {
      if (!confirm(`These already exist and will be replaced:\n${r.exists.join('\n')}`)) return;
      r = await save(true);
    }
    setStatus(`Saved to ${r.saved}/`, 'ok');
    loadLibrary();
  } catch (e) {
    fail(e);
  }
};

// ------------------------------------------------------------ project models

async function loadLibrary() {
  const items = await api('/api/library');
  const select = $('library');
  select.replaceChildren(new Option(items.length ? 'Choose…' : 'None yet', ''), ...items.map((i) => {
    const opt = new Option(`${i.type === 'urdf' ? 'URDF' : 'MJCF'} · ${i.label}`, i.url);
    opt.dataset.type = i.type;
    return opt;
  }));
}
$('library').onchange = (e) => {
  const opt = e.target.selectedOptions[0];
  if (opt.value) view(opt.dataset.type, opt.value);
};

// ------------------------------------------------------------ start

types = await api('/api/types');
$('types').replaceChildren(...types.map((t) => {
  const b = document.createElement('button');
  b.className = t.unavailable ? 'type off' : 'type';
  b.dataset.id = t.id;
  b.innerHTML = `<b></b><small></small>`;
  b.querySelector('b').textContent = t.label;
  b.querySelector('small').textContent = t.unavailable ? 'unavailable' : t.ext.join(' ');
  b.title = t.unavailable ?? t.hint;
  b.onclick = () => {
    selectType(t.id);
    if (t.unavailable) {
      $('typeHint').textContent = `Not available here: ${t.unavailable}.`;
      $('typeHint').classList.add('warn');
    } else {
      preview();
    }
  };
  return b;
}));
selectType((types.find((t) => !t.unavailable) ?? types[0]).id);
loadLibrary().catch(console.error);
