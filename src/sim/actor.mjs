/**
 * The character controller, written against the published movement budget
 * (docs/DECISIONS.md §3) rather than against a feel that happens to emerge:
 *
 *   step up 1 m free · vault 2 m · clear a 2.5 m gap · survive a 6 m drop ·
 *   wade 0.75 m, swim deeper · magma is lethal
 *
 * Only run speed is chosen. Everything about the jump is solved from it, so
 * that a change to `MOVE` moves the character and the terrain together instead
 * of letting them drift apart. A canyon is 3-5 m wide because 2.5 m is what a
 * jump clears; if the jump quietly cleared 3.2 m, canyons would stop being
 * obstacles and nobody would notice for months.
 *
 * Fixed timestep, no randomness, no wall clock: the same inputs give the same
 * trajectory in node and in a browser. That is what lets tools/smoke.mjs assert
 * the budget without a renderer, and what host-authoritative netcode will want.
 *
 * The actor is collided as an axis-aligned box of half-width `radius`. Against
 * a voxel world an AABB is exact where a capsule is only approximate, and it
 * cannot wedge itself on a corner the way a capsule can.
 */
import { MOVE, clamp } from '../gen/constants.mjs';
import { EPS, LIQUID } from './collider.mjs';
import { STAMINA_MAX, PLAYER_HP, advanceCombat, beginSwing, beginDodge,
         speedScale, sweep, DODGE_SPEED } from './combat.mjs';

/** One simulation tick. Every constant below assumes it. */
export const TICK = 1 / 60;

export const ACTOR = { radius: 0.35, height: 1.8 };

export const GRAVITY = 22;
/** The one free parameter: how fast it feels right to run. */
export const RUN = 4.0;

/**
 * How far the jump must carry the actor's centre.
 *
 * The box rests on anything under its footprint, so it can walk one radius out
 * over a drop and land one radius short of the far lip — 2 * radius of the gap
 * is crossed by the body rather than by the jump. One tick of run is added on
 * top so that a jump timed within a frame of the lip still clears MOVE.jump;
 * any more than that and a 3 m canyon would stop being a canyon.
 */
const FLIGHT = MOVE.jump - 2 * ACTOR.radius + RUN * TICK;
export const AIRTIME = FLIGHT / RUN;
export const JUMP_V = (GRAVITY * AIRTIME) / 2;
export const JUMP_APEX = (JUMP_V * JUMP_V) / (2 * GRAVITY);

export const WADE_SPEED = RUN * 0.55;
export const SWIM_SPEED = RUN * 0.45;
/** How much of the wanted velocity an airborne actor can claw back per tick. */
export const AIR_CONTROL = 0.12;
/** A vault is a climb, not a jump: it takes time and cannot be steered. */
export const VAULT_TIME = 0.35;
/** Terminal velocity, low enough that no fall tunnels a floor in one tick. */
export const TERMINAL = 45;

export function makeActor(x, y, z) {
  return {
    x, y, z, vx: 0, vy: 0, vz: 0,
    grounded: false,
    /** Highest point since the feet last left the ground: what a drop measures from. */
    apex: y,
    /** null, or a scripted climb in progress. */
    vault: null,
    /** Set on the tick a vault starts, for anything counting verbs. */
    vaults: 0,
    inWater: false, swimming: false,
    /** Where it is looking. Aim drives this when there is aim; otherwise the
        direction of travel does. Phase 0 uses it for nothing but the model's
        heading — issue #1 decides what aim means once there is an ability. */
    faceX: 0, faceZ: 1,
    /* ---- combat (src/sim/combat.mjs owns the rules; the state lives here so
       that one snapshot is the whole actor) ---- */
    hp: PLAYER_HP, maxHp: PLAYER_HP,
    /** Seconds of flinch left. The renderer's business, nobody else's. */
    hurtT: 0,
    /** A heavy machine does not pull itself over a ledge — see src/sim/enemy.mjs. */
    canVault: true,
    stamina: STAMINA_MAX,
    /** Seconds before stamina starts coming back. */
    staminaHold: 0,
    /** null, or { t, hit } — hit is a bitmask of targets already cut this swing. */
    swing: null,
    /** null, or { t, dx, dz }. */
    dodge: null,
    /** Targets the arc covered this tick, as a bitmask. Cleared every tick. */
    hits: 0,
    /** null while alive, else 'fall' | 'magma' | 'void' | 'struck'. */
    dead: null,
    /** Path length, summed per axis. Not displacement — see the soak. */
    travelled: 0, ticks: 0, blocked: false,
  };
}

/** Drop an actor onto whatever holds it at (x, z). How spawning works. */
export function placeOnGround(col, x, z, fromY) {
  const ceil = (fromY === undefined ? Infinity : fromY) + EPS;
  const g = col.supportUnder(x, z, ACTOR.radius, ceil);
  const a = makeActor(x, g === -Infinity ? 0 : g, z);
  a.grounded = g !== -Infinity;
  a.apex = a.y;
  return a;
}

/**
 * The whole of an actor's state, as plain numbers.
 *
 * Everything `step` reads or writes, including the vault in progress — leave a
 * field out and a guest replaying from a snapshot diverges from the host mid
 * climb. The controller is deterministic, so restoring this and re-applying the
 * same inputs reproduces the same trajectory exactly; that is the whole basis
 * of the reconciliation in src/net.
 */
export function snapshot(a) {
  return {
    x: a.x, y: a.y, z: a.z, vx: a.vx, vy: a.vy, vz: a.vz,
    grounded: a.grounded, apex: a.apex,
    vault: a.vault ? { t: a.vault.t, x0: a.vault.x0, y0: a.vault.y0, z0: a.vault.z0,
                       x1: a.vault.x1, y1: a.vault.y1, z1: a.vault.z1 } : null,
    vaults: a.vaults, inWater: a.inWater, swimming: a.swimming,
    faceX: a.faceX, faceZ: a.faceZ, dead: a.dead,
    hp: a.hp, hurtT: a.hurtT,
    stamina: a.stamina, staminaHold: a.staminaHold,
    swing: a.swing ? { t: a.swing.t, hit: a.swing.hit } : null,
    dodge: a.dodge ? { t: a.dodge.t, dx: a.dodge.dx, dz: a.dodge.dz } : null,
    hits: a.hits,
    ticks: a.ticks, travelled: a.travelled, blocked: a.blocked,
  };
}

/** The inverse. `a` is reused rather than replaced so references stay valid. */
export function restore(a, s) {
  a.x = s.x; a.y = s.y; a.z = s.z; a.vx = s.vx; a.vy = s.vy; a.vz = s.vz;
  a.grounded = s.grounded; a.apex = s.apex;
  a.vault = s.vault ? { t: s.vault.t, x0: s.vault.x0, y0: s.vault.y0, z0: s.vault.z0,
                        x1: s.vault.x1, y1: s.vault.y1, z1: s.vault.z1 } : null;
  a.vaults = s.vaults; a.inWater = s.inWater; a.swimming = s.swimming;
  a.faceX = s.faceX; a.faceZ = s.faceZ; a.dead = s.dead;
  a.hp = s.hp; a.hurtT = s.hurtT;
  a.stamina = s.stamina; a.staminaHold = s.staminaHold;
  a.swing = s.swing ? { t: s.swing.t, hit: s.swing.hit } : null;
  a.dodge = s.dodge ? { t: s.dodge.t, dx: s.dodge.dx, dz: s.dodge.dz } : null;
  a.hits = s.hits;
  a.ticks = s.ticks; a.travelled = s.travelled; a.blocked = s.blocked;
  return a;
}

/**
 * What someone *else* needs to draw this actor — a fraction of the state
 * simulating it needs, rounded to millimetres because these are pixels and not
 * a trajectory anyone replays.
 *
 * The other player is drawn by the guest and never simulated by it, so sending
 * a full snapshot of them would be sending twenty numbers to move a model.
 */
export function display(a) {
  const r3 = (v) => Math.round(v * 1000) / 1000;
  return {
    x: r3(a.x), y: r3(a.y), z: r3(a.z), fx: r3(a.faceX), fz: r3(a.faceZ),
    g: a.grounded ? 1 : 0, d: a.dead || 0, hp: a.hp,
    sw: a.swing ? Math.round(a.swing.t * 1000) / 1000 : -1,
    dv: a.dodge ? 1 : 0, u: Math.round(a.hurtT * 100) / 100,
  };
}

/** The inverse, onto an actor kept only for drawing. */
export function applyDisplay(a, m) {
  a.faceX = m.fx; a.faceZ = m.fz;
  a.grounded = !!m.g; a.dead = m.d || null; a.hp = m.hp; a.hurtT = m.u;
  a.swing = m.sw >= 0 ? { t: m.sw, hit: 0 } : null;
  a.dodge = m.dv ? { t: 0, dx: m.fx, dz: m.fz } : null;
  return a;
}

/** Is the actor's box inside solid ground? Must never be true after a tick. */
export function embedded(col, a) {
  return col.overlaps(a.x, a.z, ACTOR.radius, a.y + EPS, a.y + ACTOR.height - EPS);
}

/**
 * Move the box to (nx, nz) if it fits, climbing a free step if that is what is
 * in the way. Two phases, in this order, because they are different verbs: walk
 * through the air where the body is now, or rise onto the thing blocking it.
 */
function slide(col, a, nx, nz) {
  const r = ACTOR.radius, h = ACTOR.height;
  if (!col.overlaps(nx, nz, r, a.y + EPS, a.y + h - EPS)) {
    a.travelled += Math.abs(nx - a.x) + Math.abs(nz - a.z);
    a.x = nx; a.z = nz;
    return true;
  }
  if (!a.grounded) return false;
  const top = col.supportUnder(nx, nz, r, a.y + MOVE.step + EPS);
  if (!(top > a.y + EPS) || top - a.y > MOVE.step + EPS) return false;
  if (col.overlaps(nx, nz, r, top + EPS, top + h - EPS)) return false;
  a.travelled += Math.abs(nx - a.x) + Math.abs(nz - a.z);
  a.x = nx; a.z = nz; a.y = top; a.apex = top;
  return true;
}

/** A ledge too tall to step onto but not too tall to climb. Starts the vault. */
function tryVault(col, a, dx, dz) {
  const r = ACTOR.radius, h = ACTOR.height;
  if (!a.grounded || (dx === 0 && dz === 0)) return false;
  if (a.swing || a.dodge) return false;        /* committed means committed */
  if (a.canVault === false) return false;
  const probe = 0.4;
  const top = col.supportUnder(a.x + dx * probe, a.z + dz * probe, r, a.y + MOVE.vault + EPS);
  if (!(top > a.y + MOVE.step + EPS) || top - a.y > MOVE.vault + EPS) return false;
  /* Room to rise in place — a low ceiling makes a ledge unvaultable. */
  if (col.overlaps(a.x, a.z, r, a.y + EPS, top + h - EPS)) return false;
  /* Somewhere to land, and room to stand up once there. */
  const lx = a.x + dx * (r + probe + 0.2), lz = a.z + dz * (r + probe + 0.2);
  if (col.supportUnder(lx, lz, r, top + EPS) < top - 0.05) return false;
  if (col.overlaps(lx, lz, r, top + EPS, top + h - EPS)) return false;
  a.vault = { t: 0, x0: a.x, y0: a.y, z0: a.z, x1: lx, y1: top, z1: lz };
  a.vaults++;
  a.vx = 0; a.vz = 0; a.vy = 0;
  return true;
}

/**
 * Advance one tick.
 *
 * `input` is { mx, mz, jump, attack, dodge } — a heading of length 0..1 and
 * three booleans — optionally with { aimX, aimZ }, a unit heading to face.
 * Nothing else reaches the controller: no camera, no renderer, no clock.
 *
 * `targets` is an optional list of `{ x, y, z, r }` for the swing to sweep.
 */
export function step(col, a, input, targets, dt = TICK) {
  if (a.dead) return a;
  a.ticks++;
  a.blocked = false;
  const r = ACTOR.radius, h = ACTOR.height;

  /* A vault owns the actor until it finishes: all the way up, and only then
     across. Overlapping the two looks better and puts the box inside the ledge
     for a few ticks on the way through, which is indistinguishable from a
     collision bug the first time someone sees it in a log. */
  if (a.vault) {
    const vt = a.vault;
    vt.t += dt;
    const u = clamp(vt.t / VAULT_TIME, 0, 1);
    const uy = u < 0.5 ? u / 0.5 : 1, uh = u < 0.5 ? 0 : (u - 0.5) / 0.5;
    a.x = vt.x0 + (vt.x1 - vt.x0) * uh;
    a.z = vt.z0 + (vt.z1 - vt.z0) * uh;
    a.y = vt.y0 + (vt.y1 - vt.y0) * uy;
    if (u >= 1) { a.vault = null; a.grounded = true; a.apex = a.y; }
    return a;
  }

  /* Facing: aim if there is any, otherwise wherever it is going. Set before
     anything can return early, so a magma death still faces the right way. */
  if (input.aimX || input.aimZ) {
    const l = Math.sqrt(input.aimX * input.aimX + input.aimZ * input.aimZ);
    if (l > 1e-9) { a.faceX = input.aimX / l; a.faceZ = input.aimZ / l; }
  } else if (input.mx || input.mz) {
    const l = Math.sqrt(input.mx * input.mx + input.mz * input.mz);
    if (l > 1e-9) { a.faceX = input.mx / l; a.faceZ = input.mz / l; }
  }

  /* Combat timers run before intent, so a swing that finishes this tick hands
     control back on this tick rather than the next one. */
  advanceCombat(a, dt);
  if (input.attack) beginSwing(a);
  if (input.dodge) beginDodge(a, input.mx || 0, input.mz || 0);

  const liquid = col.liquidAt(a.x, a.z);
  if (liquid.kind === LIQUID.MAGMA && a.y <= liquid.level + 0.35) { a.dead = 'magma'; return a; }

  const submerged = liquid.kind === LIQUID.WATER ? liquid.level - a.y : 0;
  a.inWater = submerged > EPS;
  a.swimming = submerged > MOVE.wade;

  /* ---- intent ---- */
  if (a.dodge) {
    /* A dodge owns the horizontal for its whole window: it is a distance, not
       a nudge, and a player steering out of it would make it a sprint. */
    a.vx = a.dodge.dx * DODGE_SPEED;
    a.vz = a.dodge.dz * DODGE_SPEED;
  } else {
    const base = a.swimming ? SWIM_SPEED : (a.inWater ? WADE_SPEED : RUN);
    const speed = base * speedScale(a);
    const wx = (input.mx || 0) * speed, wz = (input.mz || 0) * speed;
    if (a.grounded || a.swimming) { a.vx = wx; a.vz = wz; }
    else { a.vx += (wx - a.vx) * AIR_CONTROL; a.vz += (wz - a.vz) * AIR_CONTROL; }
  }

  if (input.jump && !a.swing && !a.dodge && (a.grounded || a.swimming)) {
    a.vy = a.swimming ? JUMP_V * 0.35 : JUMP_V;
    a.grounded = false;
    a.apex = a.y;
  }

  /* False for the tick a jump starts, which is what keeps the snap below from
     pulling the actor straight back down again. */
  const wasGrounded = a.grounded;

  /* ---- horizontal, one axis at a time so a wall is slid along, not stuck on ---- */
  if (a.vx !== 0 && !slide(col, a, a.x + a.vx * dt, a.z)) {
    a.blocked = true;
    if (!tryVault(col, a, Math.sign(a.vx), 0)) a.vx = 0;
    if (a.vault) return a;
  }
  if (a.vz !== 0 && !slide(col, a, a.x, a.z + a.vz * dt)) {
    a.blocked = true;
    if (!tryVault(col, a, 0, Math.sign(a.vz))) a.vz = 0;
    if (a.vault) return a;
  }

  /* ---- vertical ---- */
  if (a.swimming) {
    /* Buoyancy holds the head out of the water. Sinking is not a verb yet. */
    a.vy = clamp((liquid.level - h * 0.45 - a.y) * 4, -2.5, 2.5);
  } else {
    a.vy -= GRAVITY * dt;
    if (a.vy < -TERMINAL) a.vy = -TERMINAL;
  }

  let ny = a.y + a.vy * dt;
  if (a.swimming) {
    a.grounded = false;
  } else if (a.vy <= 0) {
    const g = col.supportUnder(a.x, a.z, r, a.y + EPS);
    if (ny <= g + EPS) {
      ny = g;
      if (!a.inWater && a.apex - g > MOVE.fall + EPS) a.dead = 'fall';
      a.vy = 0; a.grounded = true; a.apex = g;
    } else if (wasGrounded && g !== -Infinity && a.y - g <= MOVE.step + EPS) {
      /* Walked down. A step down is as free as a step up — without this the
         actor is airborne for most of every slope, bouncing its way to the
         bottom, and anything that only acts when grounded never gets a turn. */
      ny = g; a.vy = 0; a.grounded = true; a.apex = g;
    } else {
      a.grounded = false;
    }
  } else {
    const ceil = col.ceilingOver(a.x, a.z, r, a.y + EPS);
    if (ny + h > ceil - EPS) { ny = Math.max(a.y, ceil - h); a.vy = 0; }
    a.grounded = false;
  }
  a.y = ny;
  if (!a.grounded && a.y > a.apex) a.apex = a.y;

  if (a.y < -1) a.dead = 'void';

  /* The blade lands where the tick ended, not where it started. */
  if (targets) sweep(a, targets);
  return a;
}
