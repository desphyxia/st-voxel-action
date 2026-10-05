/**
 * The Reel (#112, docs/DECISIONS.md §4): the second frame, a tether that pulls.
 *
 * Hold to aim — a line is drawn on the ground, §6's rule applied to the
 * players — and release to fire. The tether flies out along it, and what it
 * meets decides what happens:
 *
 *   a light target    is hauled to you and staggered: a hound at your feet
 *   a heavy target    anchors you, and you are hauled to it, ending in a strike
 *   a wall or a prop  anchors you there: a dash
 *   open ground       the same, a few metres short of full range
 *
 * Weight is a property of the archetype (`weight` on a machine: 1 is light, 2
 * is heavy), never a number the tether compares. A practice post has none and
 * counts as heavy: it does not move, so it is something to be hauled to.
 *
 * **A haul is a dash through the same controller, so it stops at a ledge and
 * never crosses a gap.** It only runs while the body is on the ground, it
 * looks ahead for a drop or magma and ends in front of one, and a body that
 * leaves the ground loses it. The movement budget (§3) is untouched, and no
 * module can make the Reel a way over a canyon.
 *
 * Everything here is a function of an actor and `col`, with no randomness, so a
 * guest replaying inputs reproduces a haul exactly. What the tether *hits* is
 * the host's: the guest replays without targets, predicts the flight, and the
 * next snapshot says what it met — the same split as a swing's damage.
 */
import { MOVE } from '../gen/constants.mjs';
import { hyp } from '../gen/exact.mjs';
import { EPS, LIQUID } from './collider.mjs';
import { REEL, TETHER, statsOf, SWING_COST, REACH, RECOVER } from './combat.mjs';
import { frameKind, swapFrame, refitGear } from './lattice.mjs';

/** Is the frame in hand the Reel? */
export function isReel(a) { return !!a.gear && frameKind(a.gear) === 'tether'; }

/** How far, how dear and how slow to come back — all moved by the same modules
    that move a blade, so a socketed sigil, thewed cord or servo still means
    something with the Reel in hand. */
export function reelRange(a) { return REEL.range + (statsOf(a).reach - REACH); }
export function reelCost(a) { const c = REEL.cost + (statsOf(a).swingCost - SWING_COST); return c < 10 ? 10 : c; }
export function reelRetract(a) { return REEL.retract * (statsOf(a).recover / RECOVER); }

/** Aiming needs the ground under you and the stamina to fire. */
export function canAim(a) {
  return isReel(a) && a.grounded && !a.swing && !a.dodge && !a.swimming
    && !a.aim && !a.tether && !a.haul && a.stamina >= reelCost(a);
}

/**
 * Swapping frames: instant, but not in the middle of a committed motion, and
 * not while the tether is out. Returns whether it happened.
 */
export function trySwap(a) {
  if (!a.gear || a.swing || a.dodge || a.tether || a.haul) return false;
  if (!swapFrame(a.gear)) return false;
  refitGear(a);
  a.aim = null;
  return true;
}

/**
 * The Reel's half of intent, in place of a swing's. `input.attack` is the
 * press and `input.hold` is the button still down: press to start aiming, and
 * let go to fire. A click that is over before the tick sees it is both at once.
 */
export function reelIntent(a, input) {
  if (input.attack && canAim(a)) a.aim = { t: 0 };
  if (!a.aim) return;
  if (input.hold) return;
  a.aim = null;
  fireTether(a);
}

function fireTether(a) {
  if (!a.grounded || a.stamina < reelCost(a)) return false;
  const st = statsOf(a);
  a.stamina -= reelCost(a);
  a.staminaHold = st.staminaHold;
  a.tether = { ph: TETHER.OUT, t: 0, len: 0, dx: a.faceX, dz: a.faceZ, tgt: -1, ax: 0, az: 0 };
  return true;
}

/** A haul toward (ax, az), at `sp`, ending `stop` short of it. */
function setHaul(o, ax, az, sp, stop) {
  o.haul = { sp, ax, az, stop, t: 0, dx: 0, dz: 0, arrived: false };
}

/**
 * One tick of a haul, from `step`'s intent: sets the body's horizontal
 * velocity and returns true while it goes on. It ends — and the body is left
 * where it stands — on arrival, on a ledge or magma ahead, on leaving the
 * ground, or when a wall stops it, and says which in `arrived`.
 */
export function haulStep(col, a, dt) {
  const h = a.haul;
  h.t += dt;
  const rx = h.ax - a.x, rz = h.az - a.z, rem = hyp(rx, rz) - h.stop;
  const end = (arrived) => { h.arrived = arrived; a.haul = null; a.vx = a.vz = 0; a.lastHaul = h; return false; };
  if (rem <= 0.05) return end(true);
  /* `a.blocked` is cleared at the top of every tick, so a wall is noticed by
     the body not having gone where it was sent. */
  if (h.lx !== undefined && h.t > 3 * dt && hyp(a.x - h.lx, a.z - h.lz) < h.sp * dt * 0.2) return end(false);
  h.lx = a.x; h.lz = a.z;
  if (!a.grounded || h.t > 1.2) return end(false);
  const sp = Math.min(h.sp, rem / dt), l = hyp(rx, rz) || 1;
  h.dx = rx / l; h.dz = rz / l;
  /* Look where the next tick would put it: no ground, a drop past a step, or
     magma, and the haul is over. This is what keeps it off every canyon. */
  const nx = a.x + h.dx * (sp * dt + a.rad), nz = a.z + h.dz * (sp * dt + a.rad);
  const g = col.supportUnder(nx, nz, a.rad, a.y + MOVE.step + EPS);
  if (g === -Infinity || a.y - g > MOVE.step + EPS) return end(false);
  if (col.liquidAt(nx, nz).kind === LIQUID.MAGMA) return end(false);
  a.vx = h.dx * sp; a.vz = h.dz * sp;
  return true;
}

const HIT_R = 0.25;

/** The first of `targets` the tether passes through between lengths, or -1. */
function targetAt(a, targets, px, pz) {
  for (let i = 0; i < targets.length && i < 32; i++) {
    const t = targets[i];
    if (!t || t.dead || t.reserve) continue;
    if (Math.abs((t.y || 0) - a.y) > 1.6) continue;
    if (hyp(t.x - px, t.z - pz) <= (t.r || t.rad || 0.45) + HIT_R) return i;
  }
  return -1;
}

/**
 * Advance the tether: fly it out, find what it meets, and carry it through the
 * haul and back in. `targets` is the host's, `null` on a guest replaying.
 */
export function tetherStep(col, a, targets, dt) {
  const T = a.tether;
  if (!T) return;
  T.t += dt;
  if (T.ph === TETHER.OUT) {
    const from = T.len, range = reelRange(a);
    T.len = Math.min(range, T.len + REEL.speed * dt);
    let met = null;
    for (let s = Math.max(0.5, from + 0.25); s <= T.len + 1e-9 && !met; s += 0.25) {
      const px = a.x + T.dx * s, pz = a.z + T.dz * s;
      if (targets) {
        const i = targetAt(a, targets, px, pz);
        if (i >= 0) { met = { kind: 'target', i, s }; break; }
      }
      if (col.overlaps(px, pz, 0.12, a.y + 0.7, a.y + 1.3)) met = { kind: 'wall', s: s - 0.25 };
    }
    if (!met && T.len < range) return;
    if (!met) met = { kind: 'ground', s: Math.min(range, REEL.ground) };
    T.len = Math.min(T.len, met.s);
    if (met.kind === 'target') {
      const t = targets[met.i];
      if ((t.weight || 2) >= 2) {
        /* Heavy, or a post: anchored, and you go to it. */
        T.tgt = met.i; T.ax = t.x; T.az = t.z;
        setHaul(a, t.x, t.z, REEL.haul, REEL.stopTarget);
        T.ph = TETHER.HAUL;
      } else {
        /* Light: it comes to you, and is hurt and staggered for it. */
        setHaul(t, a.x, a.z, REEL.yank, REEL.yankStop);
        a.hits |= 1 << met.i; a.hitScale = REEL.yankScale;
        T.ph = TETHER.BACK; T.t = 0;
      }
    } else {
      const s = met.s;
      T.ax = a.x + T.dx * s; T.az = a.z + T.dz * s;
      setHaul(a, T.ax, T.az, REEL.haul, met.kind === 'wall' ? REEL.stopWall : 0);
      T.ph = TETHER.HAUL;
    }
    return;
  }
  if (T.ph === TETHER.HAUL) {
    /* The line is as long as what is left of the haul, drawn from the body. */
    T.len = Math.max(0, hyp(T.ax - a.x, T.az - a.z));
    if (a.haul) return;
    const h = a.lastHaul;
    if (T.tgt >= 0 && h && h.arrived && targets) {
      const t = targets[T.tgt];
      if (t && !t.dead && hyp(t.x - a.x, t.z - a.z) <= REEL.stopTarget + (t.r || t.rad || 0.45) + 0.6) {
        a.hits |= 1 << T.tgt; a.hitScale = REEL.strikeScale;
      }
    }
    T.ph = TETHER.BACK; T.t = 0; T.len = 0;
    return;
  }
  if (T.t >= reelRetract(a)) a.tether = null;
}
