// Summon page (summon.html): a gacha that draws a random robot in a random
// colour variant. Robots come from the same list as the robot menu (minus
// the ones still in progress); variants and the collection are in
// variants.js, the 3D pedestal in stage.js.
import loadMujoco from '@mujoco/mujoco';
import { availableRobotCards } from '../robots/python.js';
import { saveScreenshot } from './screenshot.js';
import { createStage, prepareRobot } from './stage.js';
import { load, PITY, roll, TIERS, VARIANTS } from './variants.js';

const EXCLUDED = ['b1']; // no controller yet

const $ = (sel) => document.querySelector(sel);
const summonButton = $('#summon');
const pityText = $('#pity');
const result = $('#result');
const overlay = $('#overlay');
const dex = $('#dex');
const dexButton = $('#dex-open');

const stage = createStage($('#stage'));
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

let robots = [];
const prepared = new Map(); // robot name -> Promise of prepareRobot's result
let mujocoReady;
let busy = false;

init().catch(fail);

async function init() {
  mujocoReady = loadMujoco();
  robots = (await availableRobotCards()).filter((c) => !EXCLUDED.includes(c.name));
  if (!robots.length) throw new Error('No robots are available to summon.');
  updateCounters();
  await mujocoReady;
  summonButton.disabled = false;
  summonButton.textContent = 'Summon';
  // Warm the cache one robot at a time, with a frame drawn in between:
  // compiling a model holds up the page for a moment, and all of them at
  // once would freeze it. Errors show when that robot is summoned.
  for (const r of robots) {
    await robotModel(r).catch(() => {});
    await new Promise(requestAnimationFrame);
  }
}

function robotModel(card) {
  if (!prepared.has(card.name)) {
    prepared.set(card.name, mujocoReady.then(async (mujoco) => {
      const robot = await prepareRobot(mujoco, card);
      await stage.precompile(robot); // so its first reveal doesn't stall on shaders
      return robot;
    }));
  }
  return prepared.get(card.name);
}

summonButton.addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  summonButton.disabled = true;
  result.hidden = true;
  stage.clear();
  const pull = roll(robots);
  updateCounters();
  try {
    const [model] = await Promise.all([robotModel(pull.robot), playSummon(TIERS[pull.variant.tier])]);
    reveal(pull, model);
  } catch (err) {
    overlay.hidden = true;
    fail(err);
  } finally {
    busy = false;
    summonButton.disabled = false;
  }
});

// The summon box: drops in, shakes, and for each star past the first the
// light leaking from under its lid steps up a tier colour (blue, purple,
// gold) before the lid flies off.
// Clicking skips to the burst.
function playSummon(tier) {
  const steps = Object.values(TIERS).slice(0, tier.stars);
  const box = overlay.querySelector('.box');
  overlay.hidden = false;
  overlay.className = reducedMotion ? 'dropped' : '';
  box.classList.remove('shake');
  box.style.setProperty('--glow', steps[0].color);
  if (reducedMotion) return finishSummon(tier, 300);

  return new Promise((resolve) => {
    const timers = [];
    const done = () => {
      timers.forEach(clearTimeout);
      overlay.removeEventListener('click', done);
      finishSummon(tier, 450).then(resolve);
    };
    overlay.addEventListener('click', done);
    requestAnimationFrame(() => overlay.classList.add('dropped'));
    const SHAKE = 700; // ms per shake
    for (let i = 0; i < 3; i++) {
      timers.push(setTimeout(() => {
        box.classList.remove('shake');
        void box.offsetWidth; // restart the animation
        box.classList.add('shake');
        // Tier-ups land on the later shakes so the last one is the suspense.
        const step = steps[Math.min(steps.length - 1, Math.round((i + 1) * (steps.length - 1) / 3))];
        box.style.setProperty('--glow', step.color);
      }, 500 + i * SHAKE));
    }
    timers.push(setTimeout(done, 500 + 3 * SHAKE + 200));
  });
}

function finishSummon(tier, flashMs) {
  overlay.querySelector('.box').style.setProperty('--glow', tier.color);
  overlay.style.setProperty('--flash', tier.color);
  overlay.classList.add('burst');
  return new Promise((resolve) => setTimeout(() => {
    overlay.hidden = true;
    resolve();
  }, flashMs));
}

function reveal({ robot, variant, isNew, count }, model) {
  const tier = TIERS[variant.tier];
  stage.show(model, variant, tier.color);
  showCard(robot, variant, isNew ? 'new' : `×${count}`);
}

function showCard(robot, variant, badge) {
  const tier = TIERS[variant.tier];
  result.style.setProperty('--tier', tier.color);
  result.innerHTML = `
    <div class="stars" aria-label="${tier.stars} star">${'★'.repeat(tier.stars)}<span>${'★'.repeat(4 - tier.stars)}</span></div>
    <div class="tier">${tier.label}${badge === 'new' ? ' <b class="new">New!</b>' : badge ? ` <b class="count">${badge}</b>` : ''}</div>
    <h2><i class="dot${variant.prism ? ' prism' : ''}" style="background:${variant.color}"></i>${escapeHtml(variant.name)} ${escapeHtml(robot.title)}</h2>
    ${robot.description ? `<p>${escapeHtml(robot.description)}</p>` : ''}
    <div class="actions">
      <a class="walk" href="./?robot=${encodeURIComponent(robot.name)}&variant=${variant.id}">Take it for a walk &rarr;</a>
      <button class="shot" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>Screenshot</button>
    </div>`;
  const shot = result.querySelector('.shot');
  shot.addEventListener('click', async () => {
    shot.disabled = true;
    try {
      await saveScreenshot(stage, robot, variant);
    } catch (err) {
      fail(err);
    } finally {
      shot.disabled = false;
    }
  });
  result.hidden = false;
}

function updateCounters() {
  const { caught, sinceEpic } = load();
  const total = robots.length * VARIANTS.length;
  const found = robots.reduce((n, r) => n + VARIANTS.filter((v) => caught[`${r.name}/${v.id}`]).length, 0);
  dexButton.querySelector('output').textContent = `${found}/${total}`;
  const left = PITY - sinceEpic;
  pityText.textContent = left <= 1 ? 'Next summon: Epic or better guaranteed' : `Epic or better guaranteed within ${left} summons`;
}

// Robodex: every robot × variant, caught ones in colour. Picking a caught
// one puts it on the pedestal.
dexButton.addEventListener('click', () => {
  const { caught } = load();
  const list = dex.querySelector('.list');
  list.innerHTML = robots.map((r) => {
    const have = VARIANTS.filter((v) => caught[`${r.name}/${v.id}`]).length;
    return `<section>
      <h3>${escapeHtml(r.title)} <span>${have}/${VARIANTS.length}</span></h3>
      <ul>${VARIANTS.map((v) => {
        const n = caught[`${r.name}/${v.id}`];
        const tier = TIERS[v.tier];
        return n
          ? `<li><button data-robot="${r.name}" data-variant="${v.id}" style="--tier:${tier.color}" title="${escapeHtml(`${v.name} ${r.title}`)} · ${tier.label} · caught ${n}×">
              <i class="dot${v.prism ? ' prism' : ''}" style="background:${v.color}"></i>${n > 1 ? `<b>${n}</b>` : ''}</button></li>`
          : `<li><span class="unknown" style="--tier:${tier.color}" title="${tier.label}: not caught yet">?</span></li>`;
      }).join('')}</ul>
    </section>`;
  }).join('');
  dex.showModal();
});

dex.addEventListener('click', async (e) => {
  const button = e.target.closest('button[data-variant]');
  if (e.target === dex || e.target.closest('.close')) return dex.close();
  if (!button || busy) return;
  dex.close();
  const robot = robots.find((r) => r.name === button.dataset.robot);
  const variant = VARIANTS.find((v) => v.id === button.dataset.variant);
  try {
    stage.show(await robotModel(robot), variant, TIERS[variant.tier].color);
    showCard(robot, variant, `×${load().caught[`${robot.name}/${variant.id}`]}`);
  } catch (err) {
    fail(err);
  }
});

function fail(err) {
  console.error(err);
  const el = $('#notice');
  el.textContent = `Something went wrong: ${err?.message ?? err}`;
  el.hidden = false;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
