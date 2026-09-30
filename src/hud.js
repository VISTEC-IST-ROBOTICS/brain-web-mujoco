// The help box in the top-left corner (#hud): back link, Drive / Watch
// mode, controls help and the speed slider.

// Fills #hud for the robot and returns { mode, speed }: mode.watching and
// speed.value are read every frame.
export function createHud(robotDef, touch) {
  const app = document.getElementById('app');
  const hud = document.getElementById('hud');
  const drive = !!robotDef.controllable; // user drives it, or it only runs on its own (watch mode)
  const switchable = drive && !!robotDef.watchable; // both, with a Drive / Watch switch

  const modeHtml = switchable
    ? '<span class="mode-switch" role="group" aria-label="Mode">' +
      '<button type="button" class="mode drive" data-mode="drive" title="You steer it (M)">Drive</button>' +
      '<button type="button" class="mode watch" data-mode="watch" title="It walks on its own (M)">Watch</button></span>'
    : drive ? '<span class="mode drive">Drive mode</span>' : '<span class="mode watch">Watch mode</span>';
  const helpHtml = touch
    ? (drive ? '<div><span class="drive-only"><b>Joystick</b> walk &amp; steer &nbsp; </span>' : '<div>') +
      '<b>Drag</b> orbit &nbsp; <b>Pinch</b> zoom</div>'
    : `<div><b>Drag</b> orbit &nbsp; <b>Scroll</b> zoom</div>${robotDef.hud}` +
      `<div><b>R</b> reset${switchable ? ' &nbsp; <b>M</b> drive/watch' : ''}</div>`;
  hud.innerHTML = '<a class="back" href="./" title="Back to the robot menu (Esc)">&larr; Robot menu</a>' +
    modeHtml + helpHtml;
  app.classList.toggle('touch', touch); // moves the logo badge clear of the touch controls

  const mode = createModeSwitch(drive, switchable);
  const speed = createSpeedControl(robotDef.speedRange);
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape') location.href = './';
    if (e.code === 'KeyM' && !e.repeat) mode.toggle();
  });

  // Narrow screens stack the Body button and logo badge under the HUD
  // (index.html), so publish where the HUD ends as it grows or wraps.
  new ResizeObserver(() => {
    app.style.setProperty('--hud-bottom', `${Math.ceil(hud.getBoundingClientRect().bottom)}px`);
  }).observe(hud);

  return { drive, mode, speed };
}

// Drive / Watch mode. Robots with WATCH_INPUT can switch (HUD buttons, M, or
// ?mode=watch in the URL, kept up to date so a link opens the same mode);
// others are fixed by USER_CONTROL. #app gets .watching, which the CSS uses
// to show the HUD's .drive-only / .watch-only lines and hide the joystick.
function createModeSwitch(drive, switchable) {
  const app = document.getElementById('app');
  const buttons = [...document.querySelectorAll('#hud .mode-switch button')];
  const state = {
    watching: !drive || (switchable && new URLSearchParams(location.search).get('mode') === 'watch'),
    set(watching) {
      state.watching = watching;
      app.classList.toggle('watching', watching);
      buttons.forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.mode === 'watch') === watching)));
      if (!switchable) return;
      const url = new URL(location.href);
      if (watching) url.searchParams.set('mode', 'watch');
      else url.searchParams.delete('mode');
      history.replaceState(null, '', url);
    },
    toggle() {
      if (switchable) state.set(!state.watching);
    },
  };
  buttons.forEach((b) => b.addEventListener('click', () => {
    state.set(b.dataset.mode === 'watch');
    b.blur(); // hand the arrow keys back to driving
  }));
  state.set(state.watching);
  return state;
}

// Speed slider in the HUD for robots that declare SPEED_RANGE = (low, high):
// a multiplier starting at 1, passed to the controller as obs.speed. Shown
// in Watch mode only (.watch-only); when driving, DRIVE_SPEED applies.
function createSpeedControl(range) {
  const state = { value: 1 };
  if (!range) return state;
  const [lo, hi] = range;
  state.value = Math.min(Math.max(1, lo), hi);
  const row = document.createElement('div');
  row.className = 'speed watch-only';
  row.innerHTML = `<b>Speed</b>
    <input type="range" min="${lo}" max="${hi}" step="0.05" value="${state.value}" aria-label="Robot speed">
    <output>${state.value.toFixed(2)}&times;</output>`;
  const slider = row.querySelector('input');
  const label = row.querySelector('output');
  slider.addEventListener('input', () => {
    state.value = Number(slider.value);
    label.textContent = `${state.value.toFixed(2)}×`;
  });
  // Hand the arrow keys back to driving once the slider is let go.
  slider.addEventListener('change', () => slider.blur());
  document.getElementById('hud').appendChild(row);
  return state;
}
