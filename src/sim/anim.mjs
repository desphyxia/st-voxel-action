/**
 * Rigs and poses: issue #33.
 *
 * Every character and machine used to be a handful of boxes posed in code, one
 * mesh and one draw call per box, with "a wedge on the nose, so facing is
 * visible without an animation system". This is the animation system — the
 * half of it that is not three.js, so it can be asserted in node like the rest
 * of src/sim.
 *
 * A **rig** is data: bones, each at an offset from its parent, and boxes, each
 * riding one bone. The page builds it into one skinned mesh — one draw call a
 * character (#62) — and a pose is a set of small rotations and offsets per bone.
 *
 * A **pose** is a pure function of simulation state and presentation time. It
 * reads the actor or the machine's wire record and never writes to either, so
 * a guest replaying inputs cannot come to depend on an animation having played,
 * and the netcode's bit-identical ending cannot move. Nothing in src/sim reads
 * anything here.
 *
 * Two rules the camera sets. From 45 degrees vertical motion is foreshortened
 * to almost nothing, so what reads is what moves *across* the ground: a swing
 * is a twist of the body and a sweep of the arm, not a raised sword, and the
 * sentry's wind-up is a lean back and its arms drawn behind it. And a committed
 * action is animated as committed: while a swing runs its pose is its clock,
 * exactly, with no blending that could make it look as though it might stop.
 *
 * Trigonometry is src/gen/exact.mjs's, like everything in src/.
 */
import { sin, hyp } from '../gen/exact.mjs';
import { ACTOR, RUN, VAULT_TIME } from './actor.mjs';
import { WINDUP, ACTIVE, SWING_TIME, DODGE_TIME, HURT_TIME, REACH } from './combat.mjs';
import { EST, TELEGRAPH_TIME, STRIKE_TIME, RECOVER_TIME } from './enemy.mjs';

const PI = 3.141592653589793;

/* ---------- the rigs ----------
   Offsets in metres. `at` on a bone is from its parent; `at` on a part is the
   box's centre in its bone's frame. A colour is a hex, or a role the page
   fills in ('cloth', 'skin'), so two players can wear one rig. */

const R = ACTOR.radius, H = ACTOR.height;

export const HERO_RIG = {
  bones: [
    { name: 'root', parent: null, at: [0, 0, 0] },
    { name: 'hips', parent: 'root', at: [0, H * 0.31, 0] },
    { name: 'legL', parent: 'hips', at: [-R * 0.3, 0, 0] },
    { name: 'legR', parent: 'hips', at: [R * 0.3, 0, 0] },
    { name: 'torso', parent: 'hips', at: [0, 0, 0] },
    { name: 'head', parent: 'torso', at: [0, H * 0.35, 0] },
    { name: 'armL', parent: 'torso', at: [-R * 0.7, H * 0.21, 0] },
    { name: 'armR', parent: 'torso', at: [R * 0.7, H * 0.21, 0] },
    { name: 'blade', parent: 'armR', at: [0, 0, 0] },
  ],
  parts: [
    { name: 'legL', bone: 'legL', size: [R * 0.56, H * 0.31, R * 0.8], at: [0, -H * 0.155, 0], color: 0x33302c },
    { name: 'legR', bone: 'legR', size: [R * 0.56, H * 0.31, R * 0.8], at: [0, -H * 0.155, 0], color: 0x33302c },
    { name: 'torso', bone: 'torso', size: [R * 1.49, H * 0.34, R * 1.03], at: [0, H * 0.18, 0], color: 'cloth' },
    { name: 'pack', bone: 'torso', size: [R * 0.86, H * 0.17, R * 0.46], at: [0, H * 0.22, -R * 0.69], color: 0x4a4038 },
    { name: 'head', bone: 'head', size: [R * 0.97, H * 0.18, R * 0.91], at: [0, H * 0.09, 0], color: 'skin' },
    /* The nose stays: facing still has to read at forty pixels tall. */
    { name: 'nose', bone: 'head', size: [R * 0.3, R * 0.3, R * 0.5], at: [0, -H * 0.04, R * 0.72], color: 0xd9a25e },
    { name: 'armL', bone: 'armL', size: [R * 0.34, H * 0.26, R * 0.34], at: [0, -H * 0.11, 0], color: 'cloth' },
    { name: 'hand', bone: 'armR', size: [R * 0.34, R * 0.34, R * 0.6], at: [0, 0, R * 0.12], color: 'skin' },
    { name: 'guard', bone: 'armR', size: [0.30, 0.07, 0.10], at: [0, 0, 0], color: 0x6b6660 },
    /* On a bone of its own, so the lattice's reach can stretch it from the
       guard without stretching the guard. */
    { name: 'blade', bone: 'blade', size: [0.07, 0.09, 1.15], at: [0, 0, 0.58], color: 0x9aa1a7 },
  ],
};

/* Squat and wide, because from 45 degrees you mostly see the top of things
   (docs/DECISIONS.md). The arms are new: a wind-up you can see from above has
   to move across the ground, and a box that only changes height cannot. */
export const SENTRY_RIG = {
  bones: [
    { name: 'root', parent: null, at: [0, 0, 0] },
    { name: 'body', parent: 'root', at: [0, 0.2, 0] },
    { name: 'plate', parent: 'body', at: [0, 0.85, 0] },
    { name: 'armL', parent: 'body', at: [-0.62, 0.5, 0.05] },
    { name: 'armR', parent: 'body', at: [0.62, 0.5, 0.05] },
  ],
  parts: [
    { name: 'skirt', bone: 'root', size: [1.35, 0.28, 1.35], at: [0, 0.14, 0], color: 0x2f2b27 },
    { name: 'body', bone: 'body', size: [1.05, 0.85, 1.05], at: [0, 0.425, 0], color: 0x4a443e },
    { name: 'plate', bone: 'plate', size: [0.92, 0.16, 0.92], at: [0, 0.09, 0], color: 0x3a3532 },
    { name: 'armL', bone: 'armL', size: [0.24, 0.24, 0.62], at: [0, 0, 0.22], color: 0x3b3631 },
    { name: 'armR', bone: 'armR', size: [0.24, 0.24, 0.62], at: [0, 0, 0.22], color: 0x3b3631 },
  ],
};

/* ---------- a pose ----------
   Per bone: rx, ry, rz (radians), px, py, pz (metres, added to the bone's own
   offset), sy and sz (scale). Anything absent is zero, or one for a scale. */

function blank(rig) {
  const p = {};
  for (const b of rig.bones) p[b.name] = { rx: 0, ry: 0, rz: 0, px: 0, py: 0, pz: 0, sy: 1, sz: 1 };
  return p;
}
const KEYS = ['rx', 'ry', 'rz', 'px', 'py', 'pz', 'sy', 'sz'];

/** A pose part-way from `a` to `b`. */
export function blendPose(a, b, k) {
  const out = {};
  for (const n in b) {
    const x = a[n] || b[n], y = b[n], o = {};
    for (const key of KEYS) o[key] = x[key] + (y[key] - x[key]) * k;
    out[n] = o;
  }
  return out;
}

function easeInOut(u) { u = u < 0 ? 0 : (u > 1 ? 1 : u); return u * u * (3 - 2 * u); }

/**
 * The blade's sweep across the ground, as a yaw on the sword arm: back through
 * the wind-up, through the arc while it cuts, home through recovery. The same
 * numbers the build drew before there was a rig, so the swing covers the same
 * ground it always did.
 */
export function swingYaw(t) {
  const mid = WINDUP + ACTIVE;
  if (t < WINDUP) return -1.35 * (t / WINDUP);
  if (t < mid) return -1.35 + 2.75 * ((t - WINDUP) / ACTIVE);
  return 1.40 * (1 - (t - mid) / (SWING_TIME - mid));
}

/**
 * The player's pose. `a` is the actor and is only read. `look` is presentation
 * state the page keeps: `walk`, a stride phase in radians it advances with the
 * distance walked, and `reach`, the blade length the lattice works out to.
 */
export function poseHero(a, look) {
  const p = blank(HERO_RIG);
  const walk = look.walk || 0, reach = look.reach || REACH;
  p.blade.sz = reach / REACH;
  if (a.dead) {
    /* Down on its back, and staying there. */
    p.root.rx = -1.45; p.root.py = R * 0.4;
    p.armL.rx = -0.6; p.armR.ry = 0.4;
    return p;
  }
  const speed = hyp(a.vx || 0, a.vz || 0), m = speed / RUN > 1 ? 1 : speed / RUN;

  /* Walking: the legs and the free arm swing across the ground, the body
     bobs a little and leans into the run. */
  const s = sin(walk);
  p.legL.rx = s * 0.62 * m; p.legR.rx = -s * 0.62 * m;
  p.armL.rx = -s * 0.5 * m;
  p.hips.py = (s < 0 ? -s : s) * 0.035 * m;
  p.torso.rx = 0.1 * m;

  if (a.vault) {
    const u = easeInOut(a.vault.t / VAULT_TIME);
    p.legL.rx = 1.0 * (1 - u) + 0.2; p.legR.rx = 0.5 * (1 - u);
    p.torso.rx = 0.45 * (1 - u); p.armL.rx = -1.2 * (1 - u);
  } else if (!a.grounded) {
    p.legL.rx = 0.55; p.legR.rx = -0.25; p.armL.rx = -0.9; p.armL.rz = -0.3;
  }

  if (a.swing) {
    /* Committed: this is the swing's clock and nothing else. The body turns
       back through the wind-up, drives through as it cuts — a small step onto
       the front foot — and unwinds through recovery. */
    const t = a.swing.t, mid = WINDUP + ACTIVE;
    let twist, lean, step, stance;
    if (t < WINDUP) {
      const k = easeInOut(t / WINDUP);
      twist = -0.5 * k; lean = -0.12 * k; step = 0; stance = k;
    } else if (t < mid) {
      const k = (t - WINDUP) / ACTIVE;
      twist = -0.5 + 1.1 * k; lean = -0.12 + 0.42 * k; step = 0.16 * k; stance = 1;
    } else {
      const k = easeInOut((t - mid) / (SWING_TIME - mid));
      twist = 0.6 * (1 - k); lean = 0.3 * (1 - k); step = 0.16 * (1 - k); stance = 1 - k;
    }
    p.armR.ry = swingYaw(t);
    p.torso.ry = twist; p.torso.rx = lean;
    p.head.ry = -twist * 0.6;
    p.root.pz = step;
    p.legL.rx = 0.32 * stance; p.legR.rx = -0.28 * stance;
    p.armL.rx = -0.4 * stance; p.armL.rz = -0.35 * stance;
  }

  if (a.dodge) {
    /* A flicker, not a fade — it has to be legible in seventeen ticks: a squat,
       and a lean the way the dodge is going, whichever way that is from the
       way it faces. */
    const u = a.dodge.t / DODGE_TIME, k = sin(PI * (u < 0 ? 0 : (u > 1 ? 1 : u)));
    const fx = a.faceX || 0, fz = a.faceZ || 1, dx = a.dodge.dx || 0, dz = a.dodge.dz || 0;
    const fwd = dx * fx + dz * fz, side = dx * fz - dz * fx;
    p.root.sy = 0.78;
    p.root.rx = 0.55 * fwd * k; p.root.rz = -0.55 * side * k;
    p.legL.rx = 0.7 * k; p.legR.rx = 0.7 * k;
  }

  if (a.hurtT > 0) {
    const k = a.hurtT / HURT_TIME;
    p.torso.rx -= 0.4 * k; p.head.rx -= 0.25 * k;
  }
  return p;
}

/**
 * The sentry's pose, from the record a machine sends over the wire — the same
 * record the host draws from, so the two agree by construction. `look.walk` is
 * a stride phase the page advances while the machine moves, and `look.t`
 * presentation time for the shudder of a stagger.
 */
export function poseSentry(m, look) {
  const p = blank(SENTRY_RIG), walk = look.walk || 0, t = look.t || 0;
  if (m.s === EST.DEAD) {
    p.root.rz = 0.9;                            /* toppled, and it stays toppled */
    p.body.sy = 0.72; p.armL.rx = 0.9; p.armR.rx = 0.9;
    return p;
  }
  if (m.s === EST.DORMANT) {
    /* Settled low, arms folded in. */
    p.body.sy = 0.72; p.armL.ry = 0.5; p.armR.ry = -0.5; p.armL.pz = -0.12; p.armR.pz = -0.12;
    return p;
  }
  if (m.s === EST.WAKE || m.s === EST.CLOSE || m.s === EST.RETURN) {
    const s = sin(walk);
    p.body.py = (s < 0 ? -s : s) * 0.035;
    p.body.rz = s * 0.05;
    p.armL.rx = s * 0.25; p.armR.rx = -s * 0.25;
  }
  if (m.s === EST.TELEGRAPH) {
    /* It stops dead, rises, and draws back: the body leans away from you and
       both arms pull behind it. From above, the plate slides backwards across
       the ground while it flares — that is the wind-up you can see. */
    const k = easeInOut((m.t || 0) / TELEGRAPH_TIME);
    p.body.sy = 1 + 0.12 * k;
    p.body.rx = -0.28 * k;
    p.armL.ry = 0.75 * k; p.armR.ry = -0.75 * k;
    p.armL.pz = -0.3 * k; p.armR.pz = -0.3 * k;
  }
  if (m.s === EST.STRIKE) {
    /* All of it forward at once: the lunge you were warned about. */
    const k = easeInOut(((m.t || 0) / STRIKE_TIME) * 2);
    p.body.sy = 1.12 - 0.1 * k;
    p.body.rx = -0.28 + 0.62 * k;
    p.root.pz = 0.28 * k;
    p.armL.ry = 0.75 * (1 - k); p.armR.ry = -0.75 * (1 - k);
    p.armL.pz = -0.3 + 0.65 * k; p.armR.pz = -0.3 + 0.65 * k;
  }
  if (m.s === EST.RECOVER) {
    /* Spent: slumped forward with its arms down. This is the opening. */
    const k = 1 - easeInOut((m.t || 0) / RECOVER_TIME);
    p.body.sy = 0.9 + 0.1 * (1 - k);
    p.body.rx = 0.34 * k;
    p.armL.rx = 0.55 * k; p.armR.rx = 0.55 * k;
  }
  if (m.s === EST.STAGGER) {
    p.root.px = 0.05 * sin(t * 61);
    p.body.rz = 0.14 * sin(t * 43);
    p.body.rx = -0.12;
  }
  if (m.u > 0) p.body.rx -= 0.25 * (m.u / HURT_TIME);
  return p;
}

/** How far a stride carries a character, in metres: one full cycle of `walk`. */
export const STRIDE = 1.35;
/** The same for a machine, which shuffles. */
export const SENTRY_STRIDE = 0.9;

/** Every bone's rest position in the rig's own frame: what a part's box is laid against. */
export function restPositions(rig) {
  const at = {};
  for (const b of rig.bones) {
    const p = b.parent ? at[b.parent] : [0, 0, 0];
    at[b.name] = [p[0] + b.at[0], p[1] + b.at[1], p[2] + b.at[2]];
  }
  return at;
}
