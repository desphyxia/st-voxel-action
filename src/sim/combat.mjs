/**
 * The first combat verb: one committed swing, one dodge, and a stamina pool
 * that makes you choose between them.
 *
 * These numbers are placeholders and are meant to be. Issue #9 decides what a
 * hit is worth; what this is for is the question underneath all of it — whether
 * a committed swing reads at all under a 45 degree camera, where the character
 * is forty pixels tall and half the arc is foreshortened. So the windows are
 * sized to be *legible* rather than to be balanced: a wind-up long enough to
 * see coming, an active window short enough that spacing matters, and a
 * recovery long enough that a miss costs something.
 *
 * What it deliberately does not do is decide what a hit *does*. `sweep` reports
 * that the arc covered a target this tick and stops there. Damage, poise,
 * stagger and the rest belong to #9 and to the archetypes in enemy.mjs.
 *
 * Pure functions of an actor and a number, like everything else in src/sim, so
 * a guest replaying inputs reproduces the host's swing exactly rather than
 * approximately.
 */
import { MOVE, clamp } from '../gen/constants.mjs';
import { hyp, cos } from '../gen/exact.mjs';

/* ---- stamina: the thing that makes a swing a decision ---- */
export const STAMINA_MAX = 100;
export const SWING_COST = 25;
export const DODGE_COST = 20;
/** Per second, once it starts coming back. */
export const STAMINA_REGEN = 30;
/** Seconds of nothing after spending, so a pool cannot be drip-fed. */
export const STAMINA_HOLD = 0.5;

/* ---- the swing, in three windows ---- */
export const WINDUP = 0.25;
export const ACTIVE = 0.12;
export const RECOVER = 0.40;
export const SWING_TIME = WINDUP + ACTIVE + RECOVER;

/** Longblade reach and arc. One frame of eight; the other seven are not here. */
export const REACH = 1.6;
/** Total arc, radians. Roughly a hundred degrees — a cut, not a spin. */
export const ARC = 1.75;
/** Precomputed, because the test below wants a comparison and not a call. */
const COS_HALF_ARC = cos(ARC / 2);
/** How far above or below the actor's feet a target can be and still be cut. */
export const SPAN = 1.6;

/* ---- how much of yourself you keep while swinging ---- */
export const WINDUP_SPEED = 0.35;
export const ACTIVE_SPEED = 0;
export const RECOVER_SPEED = 0.6;

/* ---- the dodge ---- */
export const DODGE_TIME = 0.28;
export const DODGE_DIST = 3.2;
export const DODGE_SPEED = DODGE_DIST / DODGE_TIME;
/** Invulnerable for most of it, but not the tail: a dodge ends before you do. */
export const DODGE_IFRAMES = 0.20;

/* ---- what a hit costs, until #9 says otherwise ---- */
export const PLAYER_HP = 100;
export const SWING_DAMAGE = 20;
/** Seconds of flinch after taking a hit. Read by the renderer, nothing else. */
export const HURT_TIME = 0.25;

export const PHASE = { NONE: 0, WINDUP: 1, ACTIVE: 2, RECOVER: 3 };

/** Which window a swing is in, or NONE. */
export function phase(a) {
  if (!a.swing) return PHASE.NONE;
  if (a.swing.t < WINDUP) return PHASE.WINDUP;
  if (a.swing.t < WINDUP + ACTIVE) return PHASE.ACTIVE;
  return PHASE.RECOVER;
}

/** 0..1 through the whole swing. What an animation would read. */
export function swingProgress(a) { return a.swing ? clamp(a.swing.t / SWING_TIME, 0, 1) : 0; }

export function dodging(a) { return !!a.dodge; }
export function invulnerable(a) { return !!a.dodge && a.dodge.t < DODGE_IFRAMES; }

/** What fraction of running speed this actor is allowed right now. */
export function speedScale(a) {
  if (a.dodge) return 0;                       /* the dash sets velocity itself */
  switch (phase(a)) {
    case PHASE.WINDUP: return WINDUP_SPEED;
    case PHASE.ACTIVE: return ACTIVE_SPEED;
    case PHASE.RECOVER: return RECOVER_SPEED;
    default: return 1;
  }
}

export function canSwing(a) {
  return !a.swing && !a.dodge && !a.vault && !a.swimming && a.stamina >= SWING_COST;
}

/**
 * A dodge may be started from nothing, or out of a swing's recovery — but never
 * out of the wind-up or the active window. That is the whole meaning of
 * "committed": once the blade is moving you are going to finish the motion.
 */
export function canDodge(a) {
  if (a.dodge || a.vault || a.swimming || a.stamina < DODGE_COST) return false;
  return !a.swing || phase(a) === PHASE.RECOVER;
}

export function beginSwing(a) {
  if (!canSwing(a)) return false;
  a.swing = { t: 0, hit: 0 };
  a.stamina -= SWING_COST;
  a.staminaHold = STAMINA_HOLD;
  return true;
}

export function beginDodge(a, dx, dz) {
  if (!canDodge(a)) return false;
  let ux = dx, uz = dz;
  const l = hyp(ux, uz);
  /* No heading held: dodge the way you are looking. */
  if (l < 1e-6) { ux = a.faceX; uz = a.faceZ; }
  else { ux /= l; uz /= l; }
  a.swing = null;                              /* cancels recovery, never active */
  a.dodge = { t: 0, dx: ux, dz: uz };
  a.stamina -= DODGE_COST;
  a.staminaHold = STAMINA_HOLD;
  return true;
}

/**
 * Advance the timers. Called once a tick, before movement reads speedScale.
 *
 * Named for what it advances rather than just `advance`, because the bundler
 * flattens every module into one scope and a name only makes sense there if it
 * still makes sense next to `step`.
 */
export function advanceCombat(a, dt) {
  a.hits = 0;
  if (a.hurtT > 0) a.hurtT = Math.max(0, a.hurtT - dt);
  if (a.swing) { a.swing.t += dt; if (a.swing.t >= SWING_TIME) a.swing = null; }
  if (a.dodge) { a.dodge.t += dt; if (a.dodge.t >= DODGE_TIME) a.dodge = null; }

  if (a.staminaHold > 0) a.staminaHold = Math.max(0, a.staminaHold - dt);
  else if (a.stamina < STAMINA_MAX) {
    a.stamina = Math.min(STAMINA_MAX, a.stamina + STAMINA_REGEN * dt);
  }
}

/**
 * Is `t` inside an arc of `reach` and `arc` radians in front of `a`?
 *
 * Shared by the player's swing and the enemy's, which have different reaches
 * and different arcs and must not have different *rules*.
 */
export function inArc(a, t, reach, arc, span, cosHalf) {
  const dx = t.x - a.x, dz = t.z - a.z;
  const d = hyp(dx, dz);
  if (d > reach + (t.r || 0)) return false;
  if (Math.abs((t.y || 0) - a.y) > span) return false;
  if (d <= 1e-6) return true;
  /* Angle via the dot product — atan2 is not one of the operations the spec
     pins (see src/gen/exact.mjs). */
  return (dx * a.faceX + dz * a.faceZ) / d >= (cosHalf === undefined ? cos(arc / 2) : cosHalf);
}

/**
 * Take a hit. Returns false if it did not land — dead already, or dodging,
 * which is the entire reason the dodge exists.
 */
export function hurt(a, amount, cause) {
  if (!a || a.dead || a.hp === undefined || invulnerable(a)) return false;
  a.hp -= amount;
  a.hurtT = HURT_TIME;
  if (a.hp <= 0) { a.hp = 0; a.dead = cause || 'struck'; }
  return true;
}

/**
 * Turn this tick's sweep into damage. Targets without hit points — the practice
 * posts — are reported by `sweep` and simply not hurt by this.
 */
export function applyHits(a, targets, damage) {
  if (!a.hits || !targets) return 0;
  let n = 0;
  for (let i = 0; i < targets.length && i < 32; i++) {
    if ((a.hits & (1 << i)) && hurt(targets[i], damage, 'struck')) n++;
  }
  return n;
}

/**
 * Everything the arc covers this tick that it has not already covered during
 * this swing. Targets are `{ x, y, z, r }`; the return is a bitmask of indices,
 * which is also how it goes over the wire — an array here would be one more
 * thing to keep the two ends agreeing about.
 *
 * A target is hit once per swing. Without that a three-tick active window is
 * three hits, and the first thing anyone would do is call that a bug.
 */
export function sweep(a, targets) {
  if (!targets || !targets.length || phase(a) !== PHASE.ACTIVE) return 0;
  let mask = 0;
  for (let i = 0; i < targets.length && i < 32; i++) {
    if (a.swing.hit & (1 << i)) continue;
    const t = targets[i];
    if (t && !t.dead && inArc(a, t, REACH, ARC, SPAN, COS_HALF_ARC)) mask |= (1 << i);
  }
  a.swing.hit |= mask;
  a.hits = mask;
  return mask;
}

/**
 * Somewhere to swing at that does not swing back. The machines in enemy.mjs do.
 *
 * Derived from the world rather than placed by hand, so a host and a guest end
 * up with the same posts in the same order without any of it crossing the wire.
 */
export function practicePosts(col, spawn) {
  const out = [];
  const ring = [[3, 0], [-3, 1.5], [1.5, -3.5], [-2, -3]];
  for (const [dx, dz] of ring) {
    const x = spawn[0] + dx, z = spawn[2] + dz;
    const y = col.supportUnder(x, z, 0.4, spawn[1] + MOVE.vault);
    if (y === -Infinity) continue;
    out.push({ x, y, z, r: 0.45 });
  }
  return out;
}
