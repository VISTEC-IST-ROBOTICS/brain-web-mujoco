import * as THREE from 'three';
import { loadVisuals } from '/src/render/visuals.js';
import { buildRobot, createStage, DEFAULT_SIZE, poseRobot } from '/src/summon/stage.js';
import { TIERS, VARIANTS } from '/src/summon/variants.js';
import { compile, fetchModelTree } from './viewers.js';

// "Summon demo" in the MJCF tab: the robot as the summon page shows it (its stage, camera and
// pedestal, built by the same src/summon/stage.js code), to set what the site uses:
//  - its size there: SUMMON_SIZE in its python/robots file, the longest side on the pedestal
//    (default 1), compared against another robot drawn see-through;
//  - its pose there: SUMMON_POSE in the same file, joint values over its start pose (the
//    model's first keyframe, which the robot page starts from, so that stays as it is);
//  - which parts change colour: the geoms using the material 'printed', which the summon
//    variants and the robot page's Body colour picker repaint (written by paint.py).

const DIM = 0.3; // "Highlight the chosen parts" darkens the others to this
const HOVER = new THREE.Color(0x555555);
const RING = '#7fd0ff'; // the pedestal ring's colour before a summon
const mjGEOM_PLANE = 0;

export function createSummonDemo(viewer, ui) {
  let stage = null; // the summon stage, made the first time the demo opens
  let t = null; // the viewer's model while the demo is open
  let built = null; // buildRobot's result for it
  let parts = []; // geom ids that can be picked
  let base = new Map(); // geom id -> its material's own look
  let selected = new Set();
  let saved = new Set();
  let size = DEFAULT_SIZE;
  let savedSize = DEFAULT_SIZE;
  let savedColor = ''; // the printed material's colour in the file
  let hovered = -1;
  let ghost = null; // { name, root } of the robot compared against
  let robots = []; // every python/robots file, for Compare with
  let restoreJoints = false;
  let joints = []; // [{ name, lo, hi, start }]: the hinge and slide joints, start = start pose value
  let pose = {}; // { joint name: value } where the summon pose differs from the start pose
  let savedPose = {};
  const sliders = new Map(); // joint name -> its range input

  const variant = () => VARIANTS.find((v) => v.id === ui.variant.value) ?? null;

  ui.variant.replaceChildren(new Option('Its own colour', ''), ...Object.entries(TIERS).map(([tier, { label }]) => {
    const group = document.createElement('optgroup');
    group.label = label;
    group.append(...VARIANTS.filter((v) => v.tier === tier).map((v) => new Option(v.name, v.id)));
    return group;
  }));

  // ---------------------------------------------------------------- open / close

  async function start() {
    t = viewer.target;
    if (!t) return;
    viewer.pause();
    viewer.stage.paused = true;
    if (!stage) {
      stage = createStage(ui.stage);
      listenToCanvas(stage.renderer.domElement);
    }
    ui.stage.hidden = false;
    restoreJoints = !ui.joints.hidden;
    ui.joints.hidden = true;
    ui.panel.hidden = false;
    ui.toggle.classList.add('on');
    ui.viewerControls.forEach((el) => { el.disabled = true; });
    ui.status.textContent = '';

    const gltf = t.visuals ? await loadVisuals(t.visuals).catch(() => null) : null;
    built = buildRobot(t.mujoco, t.model, gltf, 1); // scaled below
    const m = t.model;
    const visualOnly = (i) => !m.geom_contype[i] && !m.geom_conaffinity[i] && m.geom_group[i] !== 3;
    const robotGeom = (i) => built.meshes[i] && m.geom_bodyid[i] !== 0 && m.geom_type[i] !== mjGEOM_PLANE;
    const anyVisual = built.meshes.some((_, i) => robotGeom(i) && visualOnly(i));
    // A VISUALS file's looks aren't geoms: its printed parts are set where it is made
    parts = gltf ? [] : built.meshes.map((_, i) => i).filter((i) => robotGeom(i) && (!anyVisual || visualOnly(i)));
    base = new Map(parts.map((i) => {
      const mat = built.meshes[i].material;
      return [i, { color: `#${mat.color.getHexString()}`, roughness: mat.roughness, metalness: mat.metalness }];
    }));
    saved = new Set(parts.filter((i) => built.meshes[i].material.name === 'printed'));
    selected = new Set(saved);
    const printed = built.printed[0];
    savedColor = ui.color.value = printed ? `#${printed.color.getHexString()}` : '#e8731a';
    ui.partsBox.hidden = !parts.length;
    ui.noParts.hidden = !!parts.length;
    ui.noParts.textContent = gltf
      ? `Its looks come from ${t.visuals.split('/').pop()}, so its colour-changing parts are set where that is made (tools/usd_to_mjcf.py).`
      : 'No parts to pick.';

    savedSize = size = t.robot?.summonSize ?? DEFAULT_SIZE;
    ui.size.value = size;
    savedPose = { ...(t.robot?.summonPose ?? {}) };
    pose = { ...savedPose };
    poseRobot(t.mujoco, t.model, built, pose, size);
    buildPoseSliders();
    robots = await fetch('/api/robots').then((r) => r.json()).catch(() => []);
    const others = robots.filter((r) => r.model && r.model !== t.url);
    ui.compare.replaceChildren(new Option('Nothing', ''),
      ...others.map((r) => new Option(`${r.title} (size ${r.summonSize ?? DEFAULT_SIZE})`, r.name)));
    if (ghost && others.some((r) => r.name === ghost.name)) ui.compare.value = ghost.name;
    ui.sizeNote.textContent = t.robot
      ? `Saved as SUMMON_SIZE in ${t.robot.file}. Default ${DEFAULT_SIZE}.`
      : 'No python/robots file uses this model yet, so its size can be tried here but not saved.';

    stage.show(built, null, RING, { reveal: false });
    if (ghost) stage.turntable.add(ghost.root);
    stage.setTurning(ui.turn.checked);
    update();
  }

  function stop() {
    if (!t) return;
    stage.turntable.remove(built.root);
    if (ghost) stage.turntable.remove(ghost.root);
    built.root.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
    t = built = null;
    hovered = -1;
    ui.stage.hidden = true;
    ui.panel.hidden = true;
    ui.joints.hidden = !restoreJoints;
    ui.toggle.classList.remove('on');
    ui.viewerControls.forEach((el) => { el.disabled = false; });
    viewer.stage.paused = false;
  }

  // ---------------------------------------------------------------- pose

  function buildPoseSliders() {
    const { mujoco, model } = t;
    const data = new mujoco.MjData(model);
    if (model.nkey > 0) mujoco.mj_resetDataKeyframe(model, data, 0);
    joints = [];
    for (let j = 0; j < model.njnt; j++) {
      const type = model.jnt_type[j];
      if (type !== 2 && type !== 3) continue; // slide, hinge
      const limited = model.jnt_range[2 * j] < model.jnt_range[2 * j + 1];
      const span = type === 3 ? Math.PI : 0.5;
      joints.push({
        name: mujoco.mj_id2name(model, 3, j) || `joint ${j}`,
        lo: limited ? model.jnt_range[2 * j] : -span,
        hi: limited ? model.jnt_range[2 * j + 1] : span,
        start: data.qpos[model.jnt_qposadr[j]],
      });
    }
    data.delete();
    sliders.clear();
    ui.poseList.replaceChildren(...joints.map((j) => {
      const row = document.createElement('div');
      row.className = 'joint';
      row.innerHTML = `<label><span></span><span class="v"></span></label>
        <input type="range" min="${j.lo}" max="${j.hi}" step="${(j.hi - j.lo) / 400}">`;
      row.querySelector('span').textContent = row.title = j.name;
      const input = row.querySelector('input');
      const v = row.querySelector('.v');
      input.oninput = () => {
        const value = +input.value;
        if (Math.abs(value - j.start) < 1e-4) delete pose[j.name];
        else pose[j.name] = value;
        v.textContent = value.toFixed(2);
        repose();
      };
      sliders.set(j.name, { input, show: () => { v.textContent = (+input.value).toFixed(2); } });
      return row;
    }));
    ui.poseCount.textContent = `${joints.length} joints`;
    showPose();
  }

  // Sliders to `pose` (the start pose where it says nothing)
  function showPose() {
    for (const j of joints) {
      const s = sliders.get(j.name);
      s.input.value = pose[j.name] ?? j.start;
      s.show();
    }
  }

  function repose() {
    poseRobot(t.mujoco, t.model, built, pose, size);
    update();
  }

  const samePose = (a, b) => {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((k) => Math.abs((a[k] ?? NaN) - (b[k] ?? NaN)) < 1e-4);
  };

  // ---------------------------------------------------------------- showing it

  function update() {
    const v = variant();
    for (const i of parts) {
      const mat = built.meshes[i].material;
      const own = base.get(i);
      mat.color.set(selected.has(i) ? ui.color.value : own.color);
      if (!selected.has(i) && ui.highlight.checked) mat.color.multiplyScalar(DIM);
      mat.roughness = own.roughness;
      mat.metalness = own.metalness;
      mat.emissive.setRGB(0, 0, 0);
    }
    const printed = parts.length ? [...selected].map((i) => built.meshes[i].material) : built.printed;
    stage.setFinish(printed, v, v ? TIERS[v.tier].color : RING);
    for (const i of parts) {
      const mat = built.meshes[i].material;
      if (i === hovered) {
        mat.emissive.copy(HOVER);
        mat.emissiveIntensity = 1;
      }
    }
    built.root.scale.setScalar(size / built.longest);
    ui.sizeOut.textContent = size.toFixed(2);

    const partsChanged = selected.size !== saved.size || [...selected].some((i) => !saved.has(i));
    const summonChanged = t.robot && (Math.abs(size - savedSize) > 1e-6 || !samePose(pose, savedPose));
    ui.count.textContent = `${selected.size} of ${parts.length} parts chosen`;
    const changed = partsChanged || colorChanged() || summonChanged;
    ui.save.disabled = !changed;
    ui.save.textContent = changed ? 'Save changes' : 'Saved';
    ui.list.replaceChildren(...[...selected].sort((a, b) => a - b).map((i) => {
      const li = document.createElement('li');
      li.textContent = label(i);
      li.title = 'Click to take it off';
      li.onclick = () => { selected.delete(i); update(); };
      return li;
    }));
  }

  const colorChanged = () => selected.size > 0 && ui.color.value !== savedColor;

  function label(i) {
    const { mujoco, model } = t;
    const geom = mujoco.mj_id2name(model, 5, i);
    const body = mujoco.mj_id2name(model, 1, model.geom_bodyid[i]) || `body ${model.geom_bodyid[i]}`;
    const mesh = model.geom_dataid[i] >= 0 ? mujoco.mj_id2name(model, 10, model.geom_dataid[i]) : null;
    return `${body} · ${geom || mesh || `geom ${i}`}`;
  }

  async function compareWith(name) {
    if (ghost) stage.turntable.remove(ghost.root);
    ghost = null;
    const robot = robots.find((r) => r.name === name);
    if (!robot) return;
    ui.status.textContent = `Loading ${robot.title}…`;
    try {
      const [tree, gltf] = await Promise.all([fetchModelTree(robot.model), robot.visuals && loadVisuals(robot.visuals)]);
      const model = compile(t.mujoco, tree);
      const other = buildRobot(t.mujoco, model, gltf ?? null, robot.summonSize, robot.summonPose);
      model.delete();
      // See-through, so both robots show where they overlap
      other.root.traverse((o) => {
        if (!o.isMesh) return;
        o.material = o.material.clone();
        Object.assign(o.material, { transparent: true, opacity: 0.25, depthWrite: false });
        o.castShadow = false;
      });
      ghost = { name, root: other.root };
      if (t) stage.turntable.add(ghost.root);
      ui.status.textContent = '';
    } catch (e) {
      ui.status.textContent = `Could not load ${robot.title}: ${e.message ?? e}`;
    }
  }

  // ---------------------------------------------------------------- picking and turning

  function listenToCanvas(canvas) {
    const raycaster = new THREE.Raycaster();
    const partAt = (e) => {
      const r = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(ndc, stage.camera);
      const hit = raycaster.intersectObjects(parts.map((i) => built.meshes[i]).filter((m) => m.visible), false)[0];
      return hit ? built.meshes.indexOf(hit.object) : -1;
    };
    let drag = null;
    canvas.addEventListener('pointerdown', (e) => {
      if (!t) return;
      drag = { x: e.clientX, y: e.clientY, z: stage.turntable.rotation.z, moved: false };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!t) return;
      if (drag) {
        // Dragging turns the pedestal, as on a turntable
        drag.moved ||= Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4;
        if (drag.moved) {
          stage.setTurning(false);
          stage.turntable.rotation.z = drag.z + (e.clientX - drag.x) * 0.01;
        }
        return;
      }
      const i = parts.length ? partAt(e) : -1;
      if (i !== hovered) {
        hovered = i;
        canvas.style.cursor = i >= 0 ? 'pointer' : 'grab';
        update();
      }
    });
    canvas.addEventListener('pointerup', (e) => {
      if (!t || !drag) return;
      const { moved } = drag;
      drag = null;
      stage.setTurning(ui.turn.checked);
      if (moved || !parts.length) return;
      const i = partAt(e);
      if (i < 0) return;
      const on = !selected.has(i);
      const group = ui.similar.checked ? parts.filter((j) => base.get(j).color === base.get(i).color) : [i];
      group.forEach((j) => (on ? selected.add(j) : selected.delete(j)));
      update();
    });
    canvas.addEventListener('pointerleave', () => { if (t && hovered >= 0) { hovered = -1; update(); } });
  }

  // ---------------------------------------------------------------- controls

  ui.toggle.onclick = () => (t ? stop() : start().catch((e) => { ui.status.textContent = e.message; }));
  ui.done.onclick = stop;
  ui.size.oninput = () => { size = +ui.size.value; if (t) repose(); };
  ui.compare.onchange = () => compareWith(ui.compare.value);
  ui.variant.onchange = () => t && update();
  ui.turn.onchange = () => stage?.setTurning(ui.turn.checked);
  ui.color.oninput = () => t && update();
  ui.highlight.onchange = () => t && update();
  ui.none.onclick = () => { selected.clear(); update(); };
  ui.revert.onclick = () => {
    selected = new Set(saved);
    size = savedSize;
    ui.size.value = size;
    pose = { ...savedPose };
    showPose();
    repose();
  };
  ui.poseReset.onclick = () => {
    pose = {};
    showPose();
    repose();
  };

  ui.save.onclick = async () => {
    const { url, robot } = t;
    const partsChanged = selected.size !== saved.size || [...selected].some((i) => !saved.has(i)) || colorChanged();
    const sizeChanged = robot && Math.abs(size - savedSize) > 1e-6;
    const poseChanged = robot && !samePose(pose, savedPose);
    const files = [partsChanged && url.startsWith('/repo/') && url.slice('/repo/'.length),
      (sizeChanged || poseChanged) && robot.file].filter(Boolean);
    if (files.length && !confirm(`This changes ${files.join(' and ')} in the project. Save?`)) return;
    ui.save.disabled = true;
    ui.status.textContent = 'Saving…';
    const post = async (path, body) => {
      const res = await fetch(path, { method: 'POST', body: JSON.stringify(body) });
      const r = await res.json();
      if (!res.ok) throw new Error(r.error ?? res.status);
      return r;
    };
    try {
      const done = [];
      if (sizeChanged || poseChanged) {
        const r = await post('/api/summon', { url, size: sizeChanged ? size : null, pose: poseChanged ? pose : null });
        done.push([sizeChanged && `size ${r.summonSize}`, poseChanged && `pose (${Object.keys(pose).length} joints)`]
          .filter(Boolean).join(' and ') + ` in ${r.file}`);
      }
      if (partsChanged) {
        const r = await post('/api/paint', { url, geoms: [...selected], color: ui.color.value });
        done.push(`${r.printed} colour-changing parts`);
      }
      await viewer.load(url); // the files as written; the demo carries on (see the listeners below)
      ui.status.textContent = `Saved: ${done.join(', ')}.`;
    } catch (e) {
      ui.status.textContent = `Not saved: ${e.message ?? e}`;
      ui.save.disabled = false;
    }
  };

  let resume = false;
  viewer.on('clear', () => { resume = !!t; if (t) stop(); ui.toggle.disabled = true; });
  viewer.on('load', () => {
    ui.toggle.disabled = false;
    if (resume) start().catch((e) => { ui.status.textContent = e.message; });
    resume = false;
  });
  ui.toggle.disabled = true;
}
