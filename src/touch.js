// On-screen controls for touch devices: a virtual joystick (up/down = walk or
// drive, left/right = steer) and tap buttons that press or toggle the same
// key codes the keyboard uses, so robots need no touch-specific code.

export const isTouchDevice = () =>
  new URLSearchParams(location.search).has('touch') || matchMedia('(pointer: coarse)').matches;

// buttons: [{ label, code, toggle }] -- toggle buttons flip `code` in
// `toggles`; others hold `code` in `keys` while pressed. joystick: false
// leaves the joystick out (robots the user doesn't drive).
export function createTouchControls({ keys, toggles, buttons, joystick = true }) {
  const root = document.createElement('div');
  root.id = 'touch';
  root.innerHTML = `
    ${joystick ? '<div class="stick"><div class="knob"></div></div>' : ''}
    <div class="buttons"></div>`;
  document.getElementById('app').appendChild(root);

  const stick = { x: 0, y: 0 };
  if (joystick) setUpStick(root, stick);
  addButtons(root, buttons, keys, toggles);
  return stick;
}

function setUpStick(root, stick) {
  const base = root.querySelector('.stick');
  const knob = root.querySelector('.knob');
  let pointerId = null;

  const move = (e) => {
    const r = base.getBoundingClientRect();
    const radius = r.width / 2;
    let dx = e.clientX - (r.left + radius);
    let dy = e.clientY - (r.top + radius);
    const len = Math.hypot(dx, dy);
    if (len > radius) {
      dx *= radius / len;
      dy *= radius / len;
    }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    const dead = (v) => (Math.abs(v) < 0.12 ? 0 : v);
    stick.x = dead(dx / radius);
    stick.y = dead(-dy / radius); // screen up = +1
  };
  const release = (e) => {
    if (e.pointerId !== pointerId) return;
    pointerId = null;
    stick.x = stick.y = 0;
    knob.style.transform = '';
    base.classList.remove('active');
  };
  base.addEventListener('pointerdown', (e) => {
    if (pointerId !== null) return;
    pointerId = e.pointerId;
    base.setPointerCapture(pointerId);
    base.classList.add('active');
    move(e);
  });
  base.addEventListener('pointermove', (e) => e.pointerId === pointerId && move(e));
  base.addEventListener('pointerup', release);
  base.addEventListener('pointercancel', release);

}

function addButtons(root, buttons, keys, toggles) {
  const column = root.querySelector('.buttons');
  for (const { label, code, toggle } of buttons) {
    const btn = document.createElement('button');
    btn.textContent = label;
    column.appendChild(btn);
    if (toggle) {
      btn.addEventListener('click', () => {
        toggles.has(code) ? toggles.delete(code) : toggles.add(code);
        btn.classList.toggle('on', toggles.has(code));
      });
    } else {
      btn.addEventListener('pointerdown', () => keys.add(code));
      for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) {
        btn.addEventListener(ev, () => keys.delete(code));
      }
    }
  }
}
