# Running, controls and deployment

## In the browser

```sh
npm install
npm run dev          # open the printed URL (http://localhost:5173) and pick a robot
```

The page opens on a menu of robots ([src/landing.js](../src/landing.js)).
Each robot also has its own link, `?robot=<name>`, where `<name>` is the
controller's file name in [python/robots/](../python/robots/), for example
`?robot=morf`. Add `&mode=watch` to open a robot in Watch mode.

Robots with `USER_CONTROL` can be driven with the keyboard, a gamepad or the
touch joystick. Robots that also set `WATCH_INPUT` have a **Watch** mode
where they walk on their own, with a speed slider.

## On the desktop

The same controllers run with native MuJoCo and its viewer, which is the
easiest place to debug them:

```sh
pip install mujoco
python python/run_local.py gecko                               # interactive viewer
python python/run_local.py gecko --headless --seconds 5 --joy left_y=1
python python/run_local.py morf --watch --speed 2              # Watch mode, like the page's slider
python python/test_robots.py                                   # smoke test every robot
```

More options, and the viewer's keys, are in
[python/README.md](../python/README.md#working-locally). On macOS use
`mjpython` instead of `python`.

## Controls

- Drag: orbit camera · Scroll: zoom (the camera follows the robot)
- Up/Down or W/S: walk forward/backward · Left/Right or A/D: steer
- Q/E: pitch the body · `[` / `]`: lower/raise step height (gecko, MORF)
- F: lock the gecko's spine
- M: switch Drive / Watch mode
- R (hold): reset the simulation and camera · Esc: back to the menu
- Gamepad (standard mapping): left stick walk, right stick steer (X) / pitch (Y)
- Phones and tablets get an on-screen joystick plus each robot's buttons;
  add `?touch` to the URL to force it on desktop

## Deployment

The site is static files: `npm run build` writes it to `dist/`.

- **GitHub Pages**: [.github/workflows/deploy.yml](../.github/workflows/deploy.yml)
  builds and publishes it on every push to `main`. One-time setup: repo
  Settings → Pages → Source: GitHub Actions.
- **Cloudflare Pages**: `npm run deploy`.

Everything under `public/` is copied as-is and downloaded by visitors, so
keep meshes small (see [model-tools.md](model-tools.md#smaller-mesh-files)).
