// Gecko quadruped (converted from my_robot/gecko-aug-2026.usd by
// tools/usd_to_mjcf.py) driven by a port of the CPG gait in
// my_robot/joy_input.py (MotionControl.publish_continuously).

const mjOBJ_ACTUATOR = 19;
const deg = (d) => (d * Math.PI) / 180;

// joy_input.py orders legs Front-Left, Rear-Left, Rear-Right, Front-Right.
const LEGS = ['lf', 'lh', 'rh', 'rf'];

// Hardware servo groups -> simulated joints. The script's head servo (id_55)
// has no joint in the USD model; its 4 spine servos all get the same command,
// so each of the USD's 3 spine joints gets that value. joint3_* (no servo
// group in the script) is held at 0.
//
// Signs convert the script's (Dynamixel) angle convention into the USD joint
// convention. Stance/tip are negated: that's the only way the script's ±25°
// stance offsets land inside the USD joint limits (e.g. joint2_lf is
// -10..100°, the script commands FL stance -25°). Swing/spine signs were
// chosen so walk-forward moves the robot forward (see tools/test_gecko.mjs).
export const JOINT_SIGNS = { spine: 1, swing: 1, stance: -1, tip: -1 };
const SPINE_JOINTS = ['joint0_f', 'joint0_m', 'joint0_h'];

// Standing height: the stance/tip joints' rest bend. joy_input.py uses 25°
// (belly ~10.8 cm off the ground); 0° lowers the body to ~7.5 cm with the
// feet still flat (the tip joints copy the stance joints). Lower stances
// drift more when walking straight (~6° yaw per 8 s at 25°, ~22° at 0°);
// below about -5° the gait hits the stance joints' -10° limit.
export const STANCE_OFFSET_DEG = 0;
const PITCH_RANGE = deg(50); // the script's 2 x 25°

const RATE = 50; // Hz, same as the ROS node
const DT = 1 / RATE;
const MOVE_TRANSITION_TIME = 1.0;

export class GeckoGait {
  constructor({ stanceOffsetDeg = STANCE_OFFSET_DEG } = {}) {
    this.stanceOffset = deg(stanceOffsetDeg);
    this.reset();
  }

  reset() {
    this.cpg = [1, 0];
    this.movementState = 'REST';
    this.moveSignal = 0;
    this.steeringSignal = 0;
    this.pitchSignal = 0;
    this.stepHighSignal = 0;
  }

  // One 50 Hz controller tick. `joy` holds the /joy axes the script reads:
  // leftY +1 = walk forward, rightX +1 = turn right (the script's steering
  // turns toward +rightX), rightY = body pitch. Returns joint targets (script
  // convention, radians) keyed by group.
  tick(joy) {
    if (joy.stepUp) this.stepHighSignal = Math.min(1, this.stepHighSignal + 0.01);
    else if (joy.stepDown) this.stepHighSignal = Math.max(0, this.stepHighSignal - 0.01);

    if (this.movementState === 'REST') {
      this.moveSignal = 0;
      if (Math.abs(joy.leftY) > 0.02) this.movementState = 'MOVE';
    } else if (Math.abs(joy.leftY) > 0.02) {
      const vel = -joy.leftY * 2 * Math.PI * 1.5;
      if (this.moveSignal < 1) {
        this.moveSignal += (DT / MOVE_TRANSITION_TIME) * Math.abs(vel);
      } else {
        const th = vel * DT;
        const [c0, c1] = this.cpg;
        this.cpg = [Math.cos(th) * c0 - Math.sin(th) * c1, Math.sin(th) * c0 + Math.cos(th) * c1];
      }
    } else if (this.moveSignal > 0) {
      this.moveSignal -= DT / MOVE_TRANSITION_TIME;
    } else {
      this.movementState = 'REST';
    }

    const [c0, c1] = this.cpg;
    const spineAmp = joy.fixedSpine ? 0 : deg(12);
    const spineForward = c1 * spineAmp;
    const spineLeft = -spineAmp / 2 + (c1 * spineAmp) / 2;
    const spineRight = spineAmp / 2 + (c1 * spineAmp) / 2;

    this.steeringSignal = 0.9 * this.steeringSignal + 0.1 * joy.rightX;
    const s = this.steeringSignal;
    const forwardWeight = 1 - Math.abs(s);
    const leftW = s >= 0 ? s : 0;
    const rightW = s < 0 ? -s : 0;
    const spine = forwardWeight * spineForward + leftW * spineLeft + rightW * spineRight;

    const swingAmp = deg(16);
    const swing = [
      -c1 * swingAmp * (1 - rightW),
      c1 * swingAmp * (1 - rightW),
      c1 * swingAmp * (1 - leftW),
      -c1 * swingAmp * (1 - leftW),
    ];

    const stanceAmp = deg(15) * this.moveSignal * (1 + this.stepHighSignal);
    this.pitchSignal = 0.1 * joy.rightY + 0.9 * this.pitchSignal;
    // The script tilts by lowering one end by up to 2 x its 25° offset; with
    // a lower stance there's no room below, so tilt the same way by raising
    // the opposite end instead (nose-down = rear up, nose-up = front up).
    const stanceOffset = this.stanceOffset;
    const tilt = PITCH_RANGE * this.pitchSignal;
    const front = stanceOffset + Math.max(0, -tilt);
    const rear = stanceOffset + Math.max(0, tilt);
    const stance = [
      -front + c0 * stanceAmp,
      rear + c0 * stanceAmp,
      -rear + c0 * stanceAmp,
      front + c0 * stanceAmp,
    ];

    return { spine, swing, stance, tip: stance.slice() };
  }
}

export const gecko = {
  modelUrl: 'assets/gecko/gecko.xml',
  visualsUrl: 'assets/gecko/gecko_visual.glb',
  bodyColor: '#2b2b2b', // default for the page's Body colour picker
  camera: { position: [0.55, -0.75, 0.45], target: [-0.12, 0, 0.1] },
  hud: `<div><b>&uarr;/&darr;/W/S</b> walk &nbsp; <b>&larr;/&rarr;/A/D</b> steer</div>
    <div><b>Q/E</b> pitch &nbsp; <b>F</b> lock spine &nbsp; <b>[ / ]</b> step height</div>
    <div>Gamepad: left stick walk, right stick steer/pitch</div>`,
  touchButtons: [{ label: 'Lock spine', code: 'KeyF', toggle: true }],
  create: createGeckoRobot,
};

export function createGeckoRobot(mujoco, model, gaitOptions) {
  const act = (name) => {
    const id = mujoco.mj_name2id(model, mjOBJ_ACTUATOR, name);
    if (id < 0) throw new Error(`gecko model has no actuator ${name}`);
    return id;
  };
  const ids = {
    spine: SPINE_JOINTS.map(act),
    swing: LEGS.map((l) => act(`joint1_${l}`)),
    stance: LEGS.map((l) => act(`joint2_${l}`)),
    knee: LEGS.map((l) => act(`joint3_${l}`)),
    tip: LEGS.map((l) => act(`joint4_${l}`)),
  };

  const gait = new GeckoGait(gaitOptions);
  let targets = null;
  let clock = 0;

  function apply(data) {
    const ctrl = data.ctrl;
    ids.spine.forEach((id) => (ctrl[id] = JOINT_SIGNS.spine * targets.spine));
    for (let i = 0; i < 4; i++) {
      ctrl[ids.swing[i]] = JOINT_SIGNS.swing * targets.swing[i];
      ctrl[ids.stance[i]] = JOINT_SIGNS.stance * targets.stance[i];
      ctrl[ids.tip[i]] = JOINT_SIGNS.tip * targets.tip[i];
      ctrl[ids.knee[i]] = 0;
    }
  }

  return {
    reset(data) {
      gait.reset();
      clock = 0;
      targets = gait.tick({ leftY: 0, rightX: 0, rightY: 0 });
      apply(data);
    },
    // Called once per physics step; runs the gait at its native 50 Hz in
    // simulated time and holds the servo targets in between.
    control(data, joy, dt) {
      clock += dt;
      if (!targets || clock >= DT) {
        clock = targets ? clock - DT : 0;
        targets = gait.tick(joy);
        apply(data);
      }
    },
  };
}
