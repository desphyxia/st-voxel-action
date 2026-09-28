/**
 * The character controller, written against the published movement budget
 * (docs/DECISIONS.md §3) rather than against a feel that happens to emerge:
 *
 *   walk up 0.5 m · jump onto 1 m, double-jump onto 2 m · clear a 3 m gap,
 *   4.4 m with the double jump · survive a 6 m drop · wade 0.75 m, swim
 *   deeper · magma is lethal   (revised 2026-09-27, #73)
 *
 * Run speed and the jump's height are chosen; gravity and everything else
 * about the jump are solved from them and the gap, so that a change to `MOVE`
 * moves the character and the terrain together instead of letting them drift
 * apart. A canyon is wider than a double jump clears because 4.4 m is what it
 * clears; if the jump quietly cleared more, canyons would stop being
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
import { advanceCombat, beginSwing, beginDodge, speedScale, sweep,
         statsOf, dodgeSpeed } from './combat.mjs';
import { makeGear, gearWire, applyGearWire } from './lattice.mjs';

/** One simulation tick. Every constant below assumes it. */
export const TICK = 1 / 60;

export const ACTOR = { radius: 0.35, height: 1.8 };

/** How fast it feels right to run: the one number chosen by feel. */
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
/**
 * The jump solved for a box of half-width `rad` (#37). Wider bodies cross more
 * of a gap by standing on its lips, so they need less flight — the same
 * arithmetic as the player's, with the player's radius swapped out. The nav
 * graph (#15) is handed this too: a jump link is only meaningful per radius.
 */
export function flightFor(rad) { return MOVE.jump - 2 * rad + RUN * TICK; }
const FLIGHT = flightFor(ACTOR.radius);
export const AIRTIME = FLIGHT / RUN;
/**
 * Gravity, solved: a jump that rises MOVE.jumpH and comes down again after
 * AIRTIME. A ballistic arc of height h and duration T has g = 8h / T², and the
 * 1 m face the jump is for (MOVE.climb) needs the rise to clear it with room
 * to arrive over the lip. It comes out near 32 m/s² — a brisk jump, not a
 * floaty one, which is the price of a jump that is both high and short.
 */
export const GRAVITY = (8 * MOVE.jumpH) / (AIRTIME * AIRTIME);
export function jumpVFor(rad) { return (GRAVITY * (flightFor(rad) / RUN)) / 2; }
export const JUMP_V = (GRAVITY * AIRTIME) / 2;
export const JUMP_APEX = (JUMP_V * JUMP_V) / (2 * GRAVITY);
/**
 * The double jump (#73): one more push in the air, enough to rise a further
 * MOVE.climb2 - MOVE.climb from wherever it is used — so pressed at the top
 * of the first jump it reaches MOVE.jumpH + 1 m, onto a 2 m face with the
 * same room the single jump has onto a 1 m one. It sets the rise rather than
 * adding to it, so pressed early it gains less, never more.
 */
export const AIR_JUMP_V = Math.sqrt(2 * GRAVITY * (MOVE.climb2 - MOVE.climb));
/** What a double jump costs: height is a resource, like a swing. */
export const AIR_JUMP_COST = 15;

export const WADE_SPEED = RUN * 0.55;
export const SWIM_SPEED = RUN * 0.45;
/** How much of the wanted velocity an airborne actor can claw back per tick. */
export const AIR_CONTROL = 0.12;
/** Terminal velocity, low enough that no fall tunnels a floor in one tick. */
export const TERMINAL = 45;

export function makeActor(x, y, z, rad) {
  /* Every actor carries a frame, machines included. An empty lattice computes
     exactly the constants in combat.mjs, so a sentry plays the game it always
     played; giving it one anyway means there is no actor anywhere whose rules
     have to be looked up somewhere else. */
  const gear = makeGear();
  const st = gear.st;
  return {
    x, y, z, vx: 0, vy: 0, vz: 0,
    /** Half-width of the collision box (#37). A body's width, not a reach:
        combat's `r` on a target is a separate thing and is not this. */
    rad: rad === undefined ? ACTOR.radius : rad,
    grounded: false,
    /** Highest point since the feet last left the ground: what a drop measures from. */
    apex: y,
    /** Air jumps left before the feet touch ground again: one, or none. */
    airJumps: 1,
    /** Counted for anything tallying verbs: jumps from the ground, and in the air. */
    jumps: 0, airJumped: 0,
    inWater: false, swimming: false,
    /** Rising out of deep water from a jump: buoyancy lets go until it falls. */
    kick: false,
    /** Where it is looking. Aim drives this when there is aim; otherwise the
        direction of travel does. Phase 0 uses it for nothing but the model's
        heading — issue #1 decides what aim means once there is an ability. */
    faceX: 0, faceZ: 1,
    /* ---- combat (src/sim/combat.mjs owns the rules; the state lives here so
       that one snapshot is the whole actor) ---- */
    /* ---- the lattice (src/sim/lattice.mjs owns the rules; like combat, the
       state lives here so that one snapshot is the whole actor) ---- */
    gear,
    /** The stats the lattice works out to. Never written except through gear. */
    st,
    /** How many things this actor has picked up. Counted, not simulated. */
    picked: 0,
    hp: st.maxHp, maxHp: st.maxHp,
    /** Seconds of flinch left. The renderer's business, nobody else's. */
    hurtT: 0,
    /** A heavy machine does not leave the ground — see src/sim/enemy.mjs. */
    canJump: true,
    stamina: st.maxStamina,
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
export function placeOnGround(col, x, z, fromY, rad) {
  const r = rad === undefined ? ACTOR.radius : rad;
  const ceil = (fromY === undefined ? Infinity : fromY) + EPS;
  const g = col.supportUnder(x, z, r, ceil);
  const a = makeActor(x, g === -Infinity ? 0 : g, z, r);
  a.grounded = g !== -Infinity;
  a.apex = a.y;
  return a;
}

/**
 * The whole of an actor's state, as plain numbers.
 *
 * Everything `step` reads or writes, including the air jump still in hand —
 * leave a field out and a guest replaying from a snapshot diverges from the
 * host in mid air. The controller is deterministic, so restoring this and re-applying the
 * same inputs reproduces the same trajectory exactly; that is the whole basis
 * of the reconciliation in src/net.
 */
export function snapshot(a) {
  return {
    x: a.x, y: a.y, z: a.z, vx: a.vx, vy: a.vy, vz: a.vz,
    grounded: a.grounded, apex: a.apex,
    airJumps: a.airJumps, jumps: a.jumps, airJumped: a.airJumped,
    inWater: a.inWater, swimming: a.swimming, kick: a.kick,
    faceX: a.faceX, faceZ: a.faceZ, dead: a.dead,
    hp: a.hp, maxHp: a.maxHp, hurtT: a.hurtT,
    stamina: a.stamina, staminaHold: a.staminaHold,
    /* Nine small numbers, and the stats are recomputed from them on the way
       back in — so the two ends cannot disagree about what a lattice means
       without first disagreeing about the lattice. */
    gear: gearWire(a.gear), picked: a.picked,
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
  a.airJumps = s.airJumps === undefined ? 1 : s.airJumps;
  a.jumps = s.jumps || 0; a.airJumped = s.airJumped || 0;
  a.inWater = s.inWater; a.swimming = s.swimming; a.kick = !!s.kick;
  a.faceX = s.faceX; a.faceZ = s.faceZ; a.dead = s.dead;
  if (s.gear) { applyGearWire(a.gear, s.gear); a.st = a.gear.st; }
  a.hp = s.hp; a.maxHp = s.maxHp === undefined ? a.st.maxHp : s.maxHp;
  a.hurtT = s.hurtT; a.picked = s.picked || 0;
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
    g: a.grounded ? 1 : 0, d: a.dead || 0, hp: a.hp, mh: a.maxHp,
    sw: a.swing ? Math.round(a.swing.t * 1000) / 1000 : -1,
    dv: a.dodge ? 1 : 0, u: Math.round(a.hurtT * 100) / 100,
    /* The arc is drawn at the reach it cuts at, so a partner who has socketed
       a sigil looks like they can reach what they can reach. */
    rc: r3(statsOf(a).reach),
  };
}

/** The inverse, onto an actor kept only for drawing. */
export function applyDisplay(a, m) {
  a.faceX = m.fx; a.faceZ = m.fz;
  a.grounded = !!m.g; a.dead = m.d || null; a.hp = m.hp; a.hurtT = m.u;
  if (m.mh !== undefined) a.maxHp = m.mh;
  /* A drawn-only actor's stats are its own object, so writing the one field
     that is sent does not reach anybody else's numbers. */
  if (m.rc !== undefined) a.st.reach = m.rc;
  a.swing = m.sw >= 0 ? { t: m.sw, hit: 0 } : null;
  a.dodge = m.dv ? { t: 0, dx: m.fx, dz: m.fz } : null;
  return a;
}

/** Is the actor's box inside solid ground? Must never be true after a tick. */
export function embedded(col, a) {
  return col.overlaps(a.x, a.z, a.rad, a.y + EPS, a.y + ACTOR.height - EPS);
}

/**
 * Move the box to (nx, nz) if it fits, climbing a free step if that is what is
 * in the way. Two phases, in this order, because they are different verbs: walk
 * through the air where the body is now, or rise onto the thing blocking it.
 */
function slide(col, a, nx, nz) {
  const r = a.rad, h = ACTOR.height;
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
  const r = a.rad, h = ACTOR.height;

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
  /* A jump out of deep water rises under gravity like any other, and the
     water takes the body back only once it starts to fall. */
  if (a.kick && (a.vy <= 0 || a.grounded)) a.kick = false;
  a.swimming = submerged > MOVE.wade && !a.kick;

  /* ---- intent ---- */
  if (a.dodge) {
    /* A dodge owns the horizontal for its whole window: it is a distance, not
       a nudge, and a player steering out of it would make it a sprint. */
    const ds = dodgeSpeed(a);
    a.vx = a.dodge.dx * ds;
    a.vz = a.dodge.dz * ds;
  } else {
    const base = a.swimming ? SWIM_SPEED : (a.inWater ? WADE_SPEED : RUN);
    /* The lattice scales how fast you go, not how far you jump: the budget in
       DECISIONS §3 is what the terrain was sized against, and a module that
       quietly cleared a wider canyon would be the exact failure the solved
       jump above exists to prevent. */
    const speed = base * speedScale(a) * statsOf(a).speed;
    const wx = (input.mx || 0) * speed, wz = (input.mz || 0) * speed;
    if (a.grounded || a.swimming) { a.vx = wx; a.vz = wz; }
    else { a.vx += (wx - a.vx) * AIR_CONTROL; a.vz += (wz - a.vz) * AIR_CONTROL; }
  }

  /* `input.jump` is a press, not a hold: one tick per press, which is what
     lets the second press be a second jump rather than the first one held. */
  if (a.grounded || a.swimming) a.airJumps = 1;
  if (input.jump && !a.swing && !a.dodge && a.canJump !== false) {
    if (a.grounded || a.swimming) {
      const jv = a.rad === ACTOR.radius ? JUMP_V : jumpVFor(a.rad);
      /* From deep water the jump is a jump from the surface: a kick that
         reaches as high over the water as a jump from the ground reaches
         over the ground, with the air jump still in hand. It was a third of
         a jump, which buoyancy undid on the next tick, so a river between
         straight banks was a pit with no way out. */
      a.vy = a.swimming ? Math.sqrt(jv * jv + 2 * GRAVITY * Math.max(0, liquid.level - a.y)) : jv;
      if (a.swimming) { a.kick = true; a.swimming = false; }
      a.grounded = false;
      a.apex = a.y;
      a.jumps++;
    } else if (a.airJumps > 0 && a.stamina >= AIR_JUMP_COST) {
      /* Allowed after walking off a ledge as well as after a jump: it is the
         one air jump per time off the ground, whichever way you left it. */
      a.vy = AIR_JUMP_V;
      a.airJumps = 0;
      a.airJumped++;
      a.stamina -= AIR_JUMP_COST;
      a.staminaHold = statsOf(a).staminaHold;
    }
  }

  /* False for the tick a jump starts, which is what keeps the snap below from
     pulling the actor straight back down again. */
  const wasGrounded = a.grounded;

  /* ---- horizontal, one axis at a time so a wall is slid along, not stuck on ---- */
  /* A face in the way stops the body; the jump is how it gets over (#73).
     The wanted velocity is kept while airborne against a face, so a jump
     pressed against a ledge carries onto it the moment the body clears the
     lip, rather than having to be steered in again. */
  if (a.vx !== 0 && !slide(col, a, a.x + a.vx * dt, a.z)) {
    a.blocked = true;
    if (a.grounded) a.vx = 0;
  }
  if (a.vz !== 0 && !slide(col, a, a.x, a.z + a.vz * dt)) {
    a.blocked = true;
    if (a.grounded) a.vz = 0;
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
    /* Buoyancy lifts the body with nothing over its head checked — so a swim
       under a bridge floated it into the deck: 1.8 m "inside the ground" on
       frost once lamps moved and the crossing's approach with them. It rises
       only as far as the lowest thing above it lets it. */
    if (ny > a.y) {
      const ceil = col.ceilingOver(a.x, a.z, r, a.y + EPS);
      if (ny + h > ceil - EPS) { ny = Math.max(a.y, ceil - h); a.vy = 0; }
    } else {
      /* And it sinks only as far as the floor. A body that stepped up onto a
         submerged ledge this tick is still flagged swimming from before the
         step, and buoyancy pulled it down into the ledge it stood on. */
      const g = col.supportUnder(a.x, a.z, r, a.y + EPS);
      if (ny < g) { ny = g; a.vy = 0; }
    }
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
