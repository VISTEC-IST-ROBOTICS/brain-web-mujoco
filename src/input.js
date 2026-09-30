import { createTouchControls } from './touch.js';

// Keyboard + Gamepad API (+ on-screen joystick/buttons when `touchButtons` is
// given) -> the joystick axes the robot controllers read (leftY +1 = forward,
// rightX +1 = right, rightY +1 = stick up; the on-screen joystick only when
// `drive`). Pressing a key in `toggleCodes` flips it in `toggles` instead of
// only holding it.
export function createInput(toggleCodes, drive, touchButtons) {
  const keys = new Set();
  const toggles = new Set();
  const stick = touchButtons ? createTouchControls({ keys, toggles, buttons: touchButtons, joystick: drive }) : null;
  window.addEventListener('keydown', (e) => {
    if (!e.repeat && toggleCodes.includes(e.code)) {
      toggles.has(e.code) ? toggles.delete(e.code) : toggles.add(e.code);
    }
    keys.add(e.code);
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  const axis = (pos, neg) => (pos.some((k) => keys.has(k)) ? 1 : 0) - (neg.some((k) => keys.has(k)) ? 1 : 0);
  const dead = (v) => (Math.abs(v) < 0.1 ? 0 : v);
  const clamp = (v) => Math.max(-1, Math.min(1, v));

  return {
    keys,
    read() {
      let leftY = axis(['ArrowUp', 'KeyW'], ['ArrowDown', 'KeyS']);
      let rightX = axis(['ArrowRight', 'KeyD'], ['ArrowLeft', 'KeyA']);
      let rightY = axis(['KeyQ'], ['KeyE']);
      const pad = navigator.getGamepads?.().find((g) => g);
      if (pad) {
        // Standard mapping: axes 0/1 left stick, 2/3 right stick, +Y is down.
        leftY = clamp(leftY - dead(pad.axes[1] ?? 0));
        rightX = clamp(rightX + dead(pad.axes[2] ?? 0));
        rightY = clamp(rightY - dead(pad.axes[3] ?? 0));
      }
      if (stick) {
        leftY = clamp(leftY + stick.y);
        rightX = clamp(rightX + stick.x);
      }
      return { leftY, rightX, rightY, keys, toggles };
    },
  };
}
