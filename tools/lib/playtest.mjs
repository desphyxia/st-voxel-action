/**
 * Driving the character controller without a player.
 *
 * Six things live here, and none is part of the game: a suite of micro-worlds
 * that pin each clause of the movement budget, a five-minute soak that turns a
 * wanderer loose on a generated world and watches for it to fall through, and a
 * suite for the camera and the input table, and a pair of networked sessions
 * talking over a wire with whatever latency and loss the case calls for.
 *
 * The soak's wanderer is deliberately cautious — it turns away from magma and
 * from drops it would not survive — because the soak is asking whether the world
 * and the controller hold together, not whether an idiot can kill itself. The
 * ways to die are pinned by the budget suite instead, where they can be exact.
 */
import { V, MOVE, CEIL, CHUNK as CHUNK_M } from '../../src/gen/constants.mjs';
import { chunkWorld, WINDOW, SKIRT } from '../../src/gen/chunk.mjs';
import { makeChunkField, chunkAt, colliderForChunk } from '../../src/sim/chunks.mjs';
import { makeStream } from '../../src/sim/stream.mjs';
import { sin, cos, hyp } from '../../src/gen/exact.mjs';
import { mulberry32, xmur3 } from '../../src/gen/rng.mjs';
import { makeCollider, colliderForWorld, colliderFromPacked, LIQUID, EPS } from '../../src/sim/collider.mjs';
import { placeOnGround, step, embedded, snapshot, restore, display, applyDisplay, ACTOR, TICK, RUN, JUMP_V, jumpVFor } from '../../src/sim/actor.mjs';
import { makeCamera, moveFrom, project, aimFromStick, aimFromPointer,
         START_YAW, QUARTER, snap } from '../../src/sim/camera.mjs';
import { makeInput, defaultBindings, ACTIONS } from '../../src/sim/input.mjs';
import * as CB from '../../src/sim/combat.mjs';
import * as EN from '../../src/sim/enemy.mjs';
import { findPath, navGraph, NAV_STEP } from '../../src/sim/nav.mjs';
import * as LT from '../../src/sim/lattice.mjs';
import * as LO from '../../src/sim/loot.mjs';
import * as RL from '../../src/sim/reel.mjs';
import * as RV from '../../src/sim/revive.mjs';
import * as ST from '../../src/gen/site.mjs';
import { makeLoopback, conditioned } from '../../src/net/transport.mjs';
import { makeHost, makeGuest, ACT } from '../../src/net/session.mjs';
import * as NS from '../../src/net/session.mjs';
import * as RTC from '../../src/net/rtc.mjs';
import { buildWorld, makeGen } from '../../src/gen/index.mjs';
import { regionAt, clearRegionCache, portsOf, regionOf, REGION, cellKey, keyX, keyZ } from '../../src/gen/region.mjs';
import { erodeAt } from '../../src/gen/erosion.mjs';
import { HERO_RIG, SENTRY_RIG, MORTAR_RIG, HOUND_RIG, MACHINE_RIGS, poseHero, poseSentry, poseMortar, poseHound, poseMachine,
         swingYaw, restPositions } from '../../src/sim/anim.mjs';
import * as SKY from '../../src/sim/sky.mjs';
import { meshChunk, surfaceAt, isCut, innerChunk } from '../../src/mesh/greedy.mjs';
import { meshProps } from '../../src/mesh/propmesh.mjs';
import { palR, palG, palB } from '../../src/gen/palette.mjs';
import { carve, clearEdits, chunkGrid } from '../../src/mesh/carve.mjs';
import { MATERIALS, MAT } from '../../src/gen/materials.mjs';
import { GOLDEN_SEEDS } from './harness.mjs';

/** Five minutes, the bar in docs/PROTOTYPE.md. */
export const SOAK_TICKS = Math.round(300 / TICK);

/* ---------------------------------------------------------------- budget ---- */

const RIM = 19.9;
const slab = (c, x0, x1, top) => c.addBox(x0, x1, -3, 3, top - 2, top);

function march(col, a, ticks, jump) {
  /* The highest ground it ever stood on: where a march ends is wherever the
     last press left it, which can be in the air. */
  a.stood = a.y;
  for (let t = 0; t < ticks && !a.dead; t++) {
    step(col, a, { mx: 1, mz: 0, jump: jump ? jump(col, a) : false });
    if (a.grounded && a.y > a.stood) a.stood = a.y;
  }
  return a;
}

/**
 * True on the last tick before the footprint runs out of ground. A jump is
 * worth exactly MOVE.jump only if it leaves from the lip, so both the budget
 * suite and the wanderer wait for this.
 */
const atTheLip = (col, a, hx, hz) =>
  a.grounded && col.supportUnder(a.x + hx * RUN * TICK, a.z + hz * RUN * TICK,
                                 ACTOR.radius, a.y + EPS) === -Infinity;

/* How a test presses jump: never; once, against the face; or once against it
   and again at the top of that jump. One press a tick at most, as the input
   layer delivers them. */
const PRESS = {
  none: () => false,
  jump: (col, a) => a.grounded && a.blocked,
  double: (col, a) => (a.grounded && a.blocked) || (!a.grounded && a.airJumps > 0 && a.vy <= 0),
};

function ledge(h, press) {
  const c = makeCollider(20, V);
  slab(c, -RIM, 0, 0); slab(c, 0.3, RIM, h);
  return march(c.finish(), placeOnGround(c, -3, 0), 600, PRESS[press || 'none']);
}

function gap(g, twice) {
  const c = makeCollider(20, V);
  slab(c, -RIM, 0, 0); slab(c, g, RIM, 0);
  return march(c.finish(), placeOnGround(c, -5, 0), 900,
               (col, a) => atTheLip(col, a, 1, 0) || (twice && !a.grounded && a.airJumps > 0 && a.vy <= 0));
}

function drop(d, falls) {
  const c = makeCollider(20, V);
  slab(c, -RIM, 0, d); slab(c, 0.3, RIM, 0);
  const col = c.finish(), a = placeOnGround(col, -3, 0);
  /* The debug dialog's switch (#92): one actor's own answer over the world's. */
  if (falls !== undefined) a.fallDamage = falls;
  return march(col, a, 900);
}

/* A bank beside deep water, `h` over its surface, and a swimmer pressing
   into it: jump against the face, and again at the top if `twice`. */
function bank(h, twice) {
  const c = makeCollider(20, V), L = MOVE.wade + 0.75;
  slab(c, -RIM, 0.3, 0); slab(c, 0.3, RIM, L + h);
  c.setLiquid(-RIM, 0.3, -3, 3, LIQUID.WATER, L);
  const a = march(c.finish(), placeOnGround(c, -3, 0), 900,
                  (col, b) => (b.swimming && b.blocked) || (twice && !b.grounded && !b.swimming && b.airJumps > 0 && b.vy <= 0));
  a.stood -= L;
  return a;
}

function pool(kind, level) {
  const c = makeCollider(20, V);
  slab(c, -RIM, RIM, 0);
  c.setLiquid(0, RIM, -3, 3, kind, level);
  return march(c.finish(), placeOnGround(c, -3, 0), 400);
}

/**
 * One assertion per clause of the budget. Each returns { label, ok, detail } so
 * that smoke.mjs can print them without knowing what any of them mean.
 */
export function budgetSuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });

  const s1 = ledge(MOVE.step);
  say(`walks up ${MOVE.step} m without a jump`, s1.stood >= MOVE.step - 0.01 && s1.jumps === 0,
      `stood at ${s1.stood.toFixed(2)}, ${s1.jumps} jumps`);

  const s2 = ledge(MOVE.step + 0.25);
  say(`does not walk up ${MOVE.step + 0.25} m`, s2.stood < 0.1, `stood at ${s2.stood.toFixed(2)}`);

  const c1 = ledge(MOVE.climb, 'jump');
  say(`jumps onto ${MOVE.climb} m`, c1.stood >= MOVE.climb - 0.01 && c1.jumps >= 1 && c1.airJumped === 0,
      `stood at ${c1.stood.toFixed(2)}, ${c1.jumps} jumps`);

  const c2 = ledge(MOVE.climb + 0.5, 'jump');
  say(`one jump does not reach ${MOVE.climb + 0.5} m`, c2.stood < 0.1, `stood at ${c2.stood.toFixed(2)}`);

  const c3 = ledge(MOVE.climb2, 'double');
  say(`double-jumps onto ${MOVE.climb2} m`, c3.stood >= MOVE.climb2 - 0.01 && c3.airJumped >= 1,
      `stood at ${c3.stood.toFixed(2)}, ${c3.jumps} jumps, ${c3.airJumped} in the air`);

  const c4 = ledge(MOVE.climb2 + 0.5, 'double');
  say(`a double jump does not reach ${MOVE.climb2 + 0.5} m`, c4.stood < 0.1, `stood at ${c4.stood.toFixed(2)}`);

  const g1 = gap(MOVE.jump);
  say(`clears a ${MOVE.jump} m gap`, g1.dead === null && g1.x > MOVE.jump,
      `x ${g1.x.toFixed(2)}, ${g1.dead || 'alive'}`);

  const g2 = gap(MOVE.jump + 0.5);
  say(`falls into a ${MOVE.jump + 0.5} m gap`, g2.dead === 'void', g2.dead || 'crossed it');

  const g3 = gap(MOVE.jump2 - 0.1, true);
  say(`double-jumps a ${(MOVE.jump2 - 0.1).toFixed(1)} m gap`, g3.dead === null && g3.x > MOVE.jump2 - 0.1,
      `x ${g3.x.toFixed(2)}, ${g3.dead || 'alive'}, ${g3.airJumped} in the air`);

  const g4 = gap(MOVE.jump2 + 0.5, true);
  say(`falls into a ${MOVE.jump2 + 0.5} m gap even with a double jump`, g4.dead === 'void', g4.dead || 'crossed it');

  const d1 = drop(MOVE.fall);
  say(`survives a ${MOVE.fall} m drop`, d1.dead === null, d1.dead || 'alive');

  const d2 = drop(MOVE.fall + 0.5);
  /* Fall damage is off until decided otherwise: a longer drop is survived too. */
  say(`and survives ${MOVE.fall + 0.5} m too: fall damage is off`, d2.dead === null, d2.dead || 'alive');

  const d3 = drop(MOVE.fall + 0.5, true), d4 = drop(MOVE.fall, true);
  say(`with the debug dialog's fall damage on, ${MOVE.fall + 0.5} m kills and ${MOVE.fall} m does not`,
      d3.dead === 'fall' && d4.dead === null, `${d3.dead || 'alive'}, ${d4.dead || 'alive'}`);

  const w1 = pool(LIQUID.WATER, MOVE.wade);
  say(`wades ${MOVE.wade} m`, w1.inWater && !w1.swimming && w1.x > 5,
      `x ${w1.x.toFixed(2)}, ${w1.swimming ? 'swimming' : 'on foot'}`);

  const w2 = pool(LIQUID.WATER, MOVE.wade + 0.25);
  say(`swims deeper`, w2.swimming, w2.swimming ? '' : 'still walking');

  /* Out of deep water a jump is a jump from the surface, air jump and all:
     a river between straight banks was a pit with no way out. */
  const b1 = bank(MOVE.climb);
  say(`climbs out of deep water onto a bank ${MOVE.climb} m over it`, b1.stood >= MOVE.climb - 0.01 && !b1.inWater,
      `stood ${b1.stood.toFixed(2)} over the water, ${b1.inWater ? 'still in it' : 'out'}`);
  const b2 = bank(MOVE.climb2, true);
  say(`and onto ${MOVE.climb2} m with a double jump`, b2.stood >= MOVE.climb2 - 0.01 && b2.airJumped >= 1,
      `stood ${b2.stood.toFixed(2)} over the water, ${b2.airJumped} in the air`);
  const b3 = bank(MOVE.climb2 + 0.5, true);
  say(`but not onto ${MOVE.climb2 + 0.5} m`, b3.stood < MOVE.climb2 + 0.49, `stood ${b3.stood.toFixed(2)} over the water`);

  const m1 = pool(LIQUID.MAGMA, 0);
  say('magma is lethal', m1.dead === 'magma', m1.dead || 'survived it');

  return out;
}

/* ------------------------------------------------------------------ soak ---- */

/**
 * Turn a wanderer loose on a generated world for five minutes of simulated
 * time and report what happened. Seeded from the world's own seed, so the walk
 * is the same every run.
 */
export function soak(world, name, ticks = SOAK_TICKS, onTick = null) {
  const col = colliderForWorld(world);
  const rnd = mulberry32(xmur3('soak:' + name)());
  const a = placeOnGround(col, world.spawn[0], world.spawn[2]);
  const x0 = a.x, z0 = a.z;

  let hx = 1, hz = 0, hold = 0, jumps = 0, insideTicks = 0, turns = 0, sinceTurn = 99;
  /* A face in the way is climbed if the budget allows (#73): a jump onto 1 m,
     a jump and a second one at its top onto 2 m. `twice` is the second press
     still owed. */
  let climbs = 0, twice = false;
  let insideGrounded = 0, insideDepth = 0;
  let minY = a.y, maxY = a.y;

  const face = (c, s2) => {
    hx = c; hz = s2;
    hold = 30 + ((rnd() * 90) | 0);
    turns++; sinceTurn = 0;
  };
  /** A fresh direction, for when the hold timer runs out. */
  const repick = () => { const ang = rnd() * 6.283185307179586; face(cos(ang), sin(ang)); };
  /** Turn back the way it came, give or take. What a wall or a hazard gets —
      re-rolling at random can point straight back at the thing, and on a shore
      of magma that is eventually fatal. */
  const veer = () => {
    const ang = 2.094 + rnd() * 2.094;                 /* 120 to 240 degrees */
    const c = cos(ang), s2 = sin(ang);
    face(hx * c - hz * s2, hx * s2 + hz * c);
  };
  repick();

  const probe = (d) => {
    const px = a.x + hx * d, pz = a.z + hz * d;
    return {
      g: col.supportUnder(px, pz, ACTOR.radius, a.y + MOVE.step + EPS),
      liq: col.liquidAt(px, pz).kind,
    };
  };
  /* A jump commits the actor for half a second and carries it well past the
     0.7 m the walk looks ahead, so the whole arc has to be checked before
     leaving the ground. Landing in magma was how the ash seed kept dying. */
  const arcIsClear = () => {
    for (let d = 0.6; d <= MOVE.jump + 0.4; d += 0.5)
      if (probe(d).liq === LIQUID.MAGMA) return false;
    return true;
  };

  /* How tall the face straight ahead is, if there is one within reach. */
  const faceAhead = () => {
    const px = a.x + hx * 0.45, pz = a.z + hz * 0.45;
    const top = col.supportUnder(px, pz, ACTOR.radius, a.y + MOVE.climb2 + EPS);
    if (top === -Infinity || top <= a.y + MOVE.step + EPS) return 0;
    if (col.overlaps(px, pz, ACTOR.radius, top + EPS, top + ACTOR.height - EPS)) return 0;
    if (col.liquidAt(px, pz).kind === LIQUID.MAGMA) return 0;
    return top - a.y;
  };

  for (let t = 0; t < ticks; t++) {
    let jump = false;
    sinceTurn++;
    if (twice && !a.grounded && a.airJumps > 0 && a.vy <= 0) { jump = true; twice = false; }
    if (a.grounded) twice = false;
    {
      if (--hold <= 0) repick();
      else if (a.blocked && a.grounded && sinceTurn > 8) {
        const f = faceAhead();
        if (f > 0 && f <= MOVE.climb2 + EPS && arcIsClear()) { jump = true; jumps++; climbs++; twice = f > MOVE.climb + EPS; }
        else veer();
      }
      if (a.grounded && !jump) {
        const near = probe(0.7);
        /* Any drop worth not taking on foot: a step down is free, anything
           deeper is a gap to jump or a reason to turn around. Using the fall
           limit here instead meant the wanderer walked off every canyon rim it
           met and never once jumped. */
        const nothingThere = near.g === -Infinity || a.y - near.g > MOVE.step;
        /* No cooldown on a hazard turn. The cooldown exists to stop a wall
           being re-rolled every tick; applying it here let a fresh heading
           picked beside a magma pool walk straight into it before the turn
           was allowed. */
        /* Ahead is not the only way in. `step` slides a blocked body along a
           wall, so a heading that never points at the pool still walks the
           shoulder into it, and a probe on the heading alone never sees that.
           Checked at the body's own edge and to both sides as well — ash/c
           died at tick 13,373 to exactly this, and it had been invisible
           because the gate only ever ran one walk per seed. */
        const flank = (sx, sz) => col.liquidAt(a.x + sx, a.z + sz).kind === LIQUID.MAGMA;
        const r = ACTOR.radius;
        if (near.liq === LIQUID.MAGMA || probe(r).liq === LIQUID.MAGMA
            || flank(-hz * r, hx * r) || flank(hz * r, -hx * r)) veer();
        else if (nothingThere) {
          const far = probe(MOVE.jump - 0.4);
          const jumpable = far.g !== -Infinity && far.liq !== LIQUID.MAGMA
            && Math.abs(far.g - a.y) <= MOVE.step;
          if (jumpable && arcIsClear() && atTheLip(col, a, hx, hz)) { jump = true; jumps++; }
          else veer();
        } else if (rnd() < 0.008 && arcIsClear()) {
          /* An idle hop. Generated terrain turns out to contain very few gaps
             narrow enough to need a jump - canyons are 3-5 m and the budget
             clears 2.5 - so without this the soak would never exercise the
             verb at all. */
          jump = true; jumps++;
        }
      }
    }
    step(col, a, { mx: hx, mz: hz, jump });
    if (onTick) onTick(a, t, col);
    if (a.y < minY) minY = a.y;
    if (a.y > maxY) maxY = a.y;
    if (embedded(col, a)) {
      insideTicks++;
      if (a.grounded) insideGrounded++;
      /* How far in, by bisection on the feet. "Inside the ground" is two very
         different things: a body resting in a hill, and a body a few
         millimetres into the surface it is landing on for one tick. Counting
         ticks cannot tell them apart; this can. */
      let lo = 0, hi = ACTOR.height;
      for (let b = 0; b < 30; b++) {
        const mid = (lo + hi) / 2;
        if (!col.overlaps(a.x, a.z, ACTOR.radius, a.y + mid + EPS, a.y + ACTOR.height - EPS)) hi = mid;
        else lo = mid;
      }
      if (hi > insideDepth) insideDepth = hi;
    }
    if (a.dead) break;
  }

  const dx = a.x - x0, dz = a.z - z0;
  return {
    seed: name,
    ticks: a.ticks,
    survived: a.dead === null && a.ticks >= ticks,
    dead: a.dead,
    travelled: +a.travelled.toFixed(1),
    displaced: +Math.sqrt(dx * dx + dz * dz).toFixed(1),
    climbs, airJumps: a.airJumped, jumps, turns,
    insideTicks, insideGrounded, insideDepth: +insideDepth.toFixed(4),
    minY: +minY.toFixed(2), maxY: +maxY.toFixed(2),
  };
}

/* ------------------------------------------------------------------ view ---- */


const VP = { w: 1200, h: 800 };
const near = (a, b, eps) => Math.abs(a - b) <= (eps === undefined ? 1e-9 : eps);

/** Screen-space displacement of one tick of a given input, at a given yaw. */
function screenStep(cam, ix, iy) {
  const m = moveFrom(cam, ix, iy);
  const a = project(cam, { x: 0, y: 0, z: 0 }, VP);
  const b = project(cam, { x: m.mx, y: 0, z: m.mz }, VP);
  return { dx: b.x - a.x, dy: b.y - a.y };
}

/**
 * The camera and the input table: the two things in #21 that are easy to get
 * subtly wrong and impossible to see in a screenshot.
 */
export function viewSuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });

  /* 1. Camera-relative movement. The whole point of a snap-rotating view is
        that "up" keeps meaning up: the world direction changes, the picture
        does not. So the screen displacement must be *identical* at all four
        steps, not merely similar. */
  const CARDINALS = [['right', 1, 0], ['up', 0, 1], ['left', -1, 0], ['down', 0, -1],
                     ['up-right', 1, 1], ['down-left', -1, -1]];
  let drift = 0, where = '';
  const ref = {};
  for (let q = 0; q < 4; q++) {
    const cam = makeCamera({ yaw: START_YAW + q * QUARTER });
    for (const [nm, ix, iy] of CARDINALS) {
      const s = screenStep(cam, ix, iy);
      if (q === 0) { ref[nm] = s; continue; }
      const d = Math.abs(s.dx - ref[nm].dx) + Math.abs(s.dy - ref[nm].dy);
      if (d > drift) { drift = d; where = `${nm} at step ${q}`; }
    }
  }
  say('movement is identical at every view step', drift < 1e-9,
      drift < 1e-9 ? '4 steps x 6 headings' : `${where} drifts ${drift.toFixed(6)} px`);

  /* 2. And it points the way the key does: right is right, up is up, and a
        cardinal never leaks into the other axis. */
  const signOk = (v, want) => (want > 0 ? v > 0.5 : (want < 0 ? v < -0.5 : near(v, 0, 1e-9)));
  let wrong = null;
  for (let q = 0; q < 4 && !wrong; q++) {
    const cam = makeCamera({ yaw: START_YAW + q * QUARTER });
    for (const [nm, ix, iy] of CARDINALS.slice(0, 4)) {
      const s = screenStep(cam, ix, iy);
      /* Screen y grows downward, so "up the screen" is a negative dy. */
      if (!signOk(s.dx, ix) || !signOk(s.dy, -iy)) { wrong = `${nm} at step ${q}`; break; }
    }
  }
  say('up is up the screen, right is right', !wrong, wrong || 'every heading, every step');

  /* 3. Snapping is exactly a quarter, and four of them come back round. */
  const c2 = makeCamera({});
  for (let q = 0; q < 4; q++) snap(c2, 1);
  say('four snaps return to the start', near(c2.yawTo - START_YAW, 2 * Math.PI, 1e-9),
      `${(c2.yawTo - START_YAW).toFixed(6)} rad`);

  /* 4. The two aiming models. A stick direction and a mouse point that mean the
        same thing have to produce the same facing — the bar in #21 — and the
        only honest way to check that is to aim with one and read back the
        other. */
  const actor = { x: 3.25, y: 2.5, z: -4.75 };
  let aimErr = 0, aimAt = '';
  for (let q = 0; q < 4; q++) {
    const cam = makeCamera({ yaw: START_YAW + q * QUARTER });
    cam.tx = actor.x - 1.5; cam.ty = actor.y + 1; cam.tz = actor.z + 2;
    for (let a = 0; a < 8; a++) {
      const th = (a / 8) * Math.PI * 2;
      const ax = Math.cos(th), ay = Math.sin(th);
      const stick = aimFromStick(cam, ax, ay);
      if (!stick) continue;
      const p = project(cam, { x: actor.x + stick.x * 5, y: actor.y, z: actor.z + stick.z * 5 }, VP);
      const mouse = aimFromPointer(cam, p.x, p.y, VP, actor);
      const d = Math.abs(mouse.x - stick.x) + Math.abs(mouse.z - stick.z);
      if (d > aimErr) { aimErr = d; aimAt = `step ${q}, ${(th * 57.3) | 0} deg`; }
    }
  }
  say('mouse and stick aim agree', aimErr < 1e-9,
      aimErr < 1e-9 ? '4 steps x 8 directions' : `${aimAt} differs by ${aimErr.toFixed(9)}`);

  /* 5. The dead zone is a dead zone, not a direction. */
  const c3 = makeCamera({});
  say('a resting stick does not aim', aimFromStick(c3, 0.05, -0.02) === null,
      aimFromStick(c3, 0.05, -0.02) ? 'it aimed' : '');

  /* 6. Bindings. Every action reachable out of the box, rebinding takes effect
        and unbinds the old key, and an edge fires once. */
  const unbound = ACTIONS.filter((a) => !(defaultBindings()[a] || []).length);
  say('every action has a default binding', unbound.length === 0, unbound.join(', '));

  const inp = makeInput();
  inp.press('Space');
  const first = inp.took('jump'), second = inp.took('jump');
  say('a press fires once, not every tick', first && !second, `${first} then ${second}`);

  inp.bind('jump', ['KeyJ']);
  inp.release('Space'); inp.press('Space');
  const stale = inp.took('jump');
  inp.press('KeyJ');
  const fresh = inp.took('jump');
  say('rebinding moves the action', !stale && fresh, `old key ${stale}, new key ${fresh}`);

  const inp2 = makeInput();
  inp2.stick(0.9, 0.9);
  inp2.press('KeyA');
  const ax2 = inp2.axes();
  say('a held key beats a drifting stick', ax2.ix === -1 && ax2.iy === 0,
      `ix ${ax2.ix}, iy ${ax2.iy}`);

  return out;
}

/* ------------------------------------------------------------------- net ---- */

const dist2 = (a, b) => hyp(a.x - b.x, a.z - b.z);

/**
 * One host and one guest on one seed, wired through a loopback with whatever
 * latency and loss the case wants. Returns both sessions plus the wire, so a
 * test can read the stats it cares about.
 */
/**
 * Host and guest each hold their own collider, built from their own copy of the
 * world — that separation is the claim, so the suite keeps it. It only builds
 * them once between them: a seed grows the same world every time, and nine
 * cases paying for eighteen generations would put the node half of the gate
 * back over the line it was split to get under.
 */
const WORLDS = new Map();
function sides(seedName) {
  if (!WORLDS.has(seedName)) {
    const cfg = GOLDEN_SEEDS.find((c) => c.nm === seedName);
    const world = buildWorld(cfg);
    const hostCol = colliderForWorld(world), guestCol = colliderForWorld(buildWorld(cfg));
    WORLDS.set(seedName, {
      cfg, world, spawn: world.spawn, hostCol, guestCol,
      /* Derived on each side from its own world, never sent. If the two ends
         disagreed about where the posts are, a swing would land on one and not
         the other and the exact-agreement tests would say so. */
      hostTargets: CB.practicePosts(hostCol, world.spawn),
      guestTargets: CB.practicePosts(guestCol, world.spawn),
    });
  }
  return WORLDS.get(seedName);
}

function twoPlayers(seedName, wire, withFoes, guestWire, gid) {
  const w = sides(seedName || 'meadow');
  /* Fresh every time: the machines in it die, and a suite that shared them
     would be testing whatever the previous case left standing. */
  const encounter = withFoes ? EN.makeEncounter(w.hostCol, w.world, w.hostTargets) : null;
  const host = makeHost({ col: w.hostCol, spawn: w.spawn, transport: wire.a, cfg: w.cfg,
                          targets: encounter ? encounter.targets : w.hostTargets, encounter });
  const guest = makeGuest({
    transport: guestWire || wire.b, gid,
    build: () => ({ col: w.guestCol, spawn: w.spawn }),
  });
  return { host, guest, wire, col: w.hostCol, encounter, w };
}

/**
 * A deterministic wander, so both players move without anyone driving them —
 * swinging and dodging on the way, which is how the combat state gets dragged
 * through snapshot, restore and replay rather than only the position.
 */
function scripted(phase) {
  return (t) => {
    const a = t * 0.017 + phase;
    return { mx: cos(a), mz: sin(a),
             /* and a second press twelve ticks on, in the air: the double
                jump (#73) goes through snapshot, restore and replay too. */
             jump: t % 131 === 0 || t % 131 === 12, attack: t % 73 === 0, dodge: t % 109 === 0 };
  };
}

function run(pair, ticks, hostIn, guestIn, onTick) {
  for (let t = 0; t < ticks; t++) {
    pair.wire.pump();
    pair.host.step(hostIn ? hostIn(t) : null);
    pair.guest.step(guestIn ? guestIn(t) : null);
    if (onTick) onTick(t);
  }
}

/** Everyone stops moving and the wire drains. Both ends must end up identical. */
function settle(pair, ticks) { run(pair, ticks || 120, () => ({}), () => ({})); }

export function netSuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });

  /* 1. The handshake, and that a world is grown rather than shipped. */
  {
    const p = twoPlayers('meadow', makeLoopback({}));
    run(p, 30, scripted(0), scripted(2));
    say('a guest joins from a seed alone', p.host.connected && p.guest.ready,
        `host ${p.host.connected ? 'joined' : 'alone'}, guest ${p.guest.ready ? 'ready' : 'waiting'}`);
  }

  /* 1b. One clock. The sky is read from the host's tick (#30), and a guest
         learns it from the snapshots it already gets — so the two windows see
         the same hour however late the second one opened. */
  {
    const p = twoPlayers('meadow', makeLoopback({ latency: 4 }));
    run(p, 600, scripted(0), scripted(2));
    const lag = p.host.tick - p.guest.tick;
    say('and the guest keeps the host\'s clock, to within a snapshot and the wire',
        p.guest.tick > 0 && lag >= 0 && lag <= 12,
        `host tick ${p.host.tick}, guest hears ${p.guest.tick} (${lag} behind)`);
  }

  /* 2. What actually crosses. Terrain is a pure function of its seed, so the
        wire should carry a seed and two characters and nothing else — checked
        by looking at every message, not by assuming. */
  {
    const wire = makeLoopback({});
    const p = twoPlayers('meadow', wire);
    const msgs = [];
    for (const side of ['a', 'b']) {
      const ep = wire[side], send = ep.send.bind(ep);
      ep.send = (m) => { msgs.push(m); return send(m); };
    }
    run(p, 600, scripted(0), scripted(2));
    const bad = [];
    for (const m of msgs) {
      for (const [k, v] of Object.entries(m)) {
        /* The guest's own state is one fixed record of values, not a list of
           anything (#108) — what it must not be is longer than that record. */
        if (k === 'you') { if (!Array.isArray(v) || v.length > 31) bad.push(`${m.t}.you`); continue; }
        if (Array.isArray(v) && v.length > 3) bad.push(`${m.t}.${k}[${v.length}]`);
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          for (const [k2, v2] of Object.entries(v)) {
            if (Array.isArray(v2) && v2.length > 3) bad.push(`${m.t}.${k}.${k2}[${v2.length}]`);
          }
        }
      }
    }
    const kbs = wire.stat.bytes / (600 / 60) / 1024;
    say('no terrain crosses the wire', bad.length === 0, bad.slice(0, 3).join(', '));
    say('the wire stays small', kbs < 30,
        `${kbs.toFixed(1)} kB/s of JSON — a packed format is worth roughly 100x of it`);
  }

  /* 3. With a perfect wire, prediction and authority are the same thing: once
        everyone stops and the last snapshot lands, the two ends must hold
        identical state, not merely similar. Anything else is a desync. */
  {
    const p = twoPlayers('meadow', makeLoopback({}));
    run(p, 400, scripted(0), scripted(2));
    settle(p, 120);
    const d = dist2(p.guest.me, p.host.peer);
    say('a clean wire ends in agreement, exactly', d === 0 && p.guest.me.y === p.host.peer.y,
        `${d.toFixed(9)} m apart, dy ${(p.guest.me.y - p.host.peer.y).toFixed(9)}`);
  }

  /* 4. The same, over a wire worth calling a wire. */
  {
    const p = twoPlayers('meadow', makeLoopback({ latency: 6 }));
    run(p, 400, scripted(0), scripted(2));
    settle(p, 150);
    const d = dist2(p.guest.me, p.host.peer), dj = p.host.peer.airJumped;
    say('117 ms of latency ends in agreement, double jumps and all', d < 1e-9 && dj > 0 && p.guest.me.airJumped === dj,
        `${d.toFixed(9)} m apart; ${dj} double jumps on the host, ${p.guest.me.airJumped} on the guest`);
  }

  /* 5. And over a bad one. A lost input is never re-sent — the host repeats
        what it has and the next snapshot puts the guest right. */
  {
    const p = twoPlayers('meadow', makeLoopback({ latency: 6, loss: 0.2, seed: 'lossy' }));
    run(p, 500, scripted(0), scripted(2));
    settle(p, 200);
    const d = dist2(p.guest.me, p.host.peer);
    say('a fifth of the packets lost, still no desync', d < 1e-9,
        `${d.toFixed(9)} m apart, ${p.wire.stat.dropped} dropped`);
  }

  /* 6. Prediction is not a stale snapshot with a nice name. Under latency the
        guest's own character must sit ahead of the last thing the host said
        about it, by roughly the round trip — that gap *is* the replay. */
  {
    const p = twoPlayers('meadow', makeLoopback({ latency: 6 }));
    let lead = 0;
    run(p, 300, scripted(0), scripted(2), () => {
      const a = p.guest.authoritative;
      if (a) lead = Math.max(lead, dist2(p.guest.me, a));
    });
    say('the guest leads the last word from the host', lead > 0.15 && p.guest.stats.replayed > 0,
        `${lead.toFixed(2)} m ahead, ${p.guest.stats.replayed} inputs replayed`);
  }

  /* 7. Authority. A guest whose position is wrong — cheating, a bug, a bad
        merge — is corrected, not negotiated with. */
  {
    const p = twoPlayers('meadow', makeLoopback({ latency: 2 }));
    run(p, 120, scripted(0), scripted(2));
    const before = { x: p.host.peer.x, z: p.host.peer.z };
    p.guest.me.x += 40; p.guest.me.z -= 40;
    run(p, 40, scripted(0), scripted(2));
    const pulled = dist2(p.guest.me, p.host.peer);
    const hostMoved = dist2(p.host.peer, before);
    say('the host is authoritative', pulled < 0.5 && hostMoved < 5,
        `guest pulled back to ${pulled.toFixed(2)} m; host never saw the jump (${hostMoved.toFixed(2)} m)`);
  }

  /* 8b. And swing. Combat state is part of the actor, so it rides the same
         snapshot and the same replay — if it did not, a guest would watch its
         own sword pass through nothing on the host's copy. */
  {
    const p = twoPlayers('meadow', makeLoopback({ latency: 5 }));
    run(p, 20, null, null);
    let hostSawSwing = 0, hostSawDodge = 0;
    run(p, 400, scripted(0), scripted(2), () => {
      if (p.host.peer.swing) hostSawSwing++;
      if (p.host.peer.dodge) hostSawDodge++;
    });
    settle(p, 150);
    say('a swing on one machine happens on the other', hostSawSwing > 30 && hostSawDodge > 10,
        `${hostSawSwing} ticks swinging, ${hostSawDodge} dodging, as the host saw it`);

    /* Stamina is the one thing that does *not* end up equal, and should not:
       it is still moving while position has settled, so the guest — predicting
       a round trip ahead — reads a little higher. That lead is the invariant
       worth pinning. Asserting equality here would be asserting that prediction
       had stopped working. */
    const lead = p.guest.me.stamina - p.host.peer.stamina;
    const roundTrip = CB.STAMINA_REGEN * (5 + 4) * TICK;
    say('stamina leads by a round trip and no more', lead >= 0 && lead <= roundTrip,
        `guest is ${lead.toFixed(2)} ahead, a round trip is worth ${roundTrip.toFixed(2)}`);
  }

  /* 8c. The world is the host's. A guest is sent what the machines look like
         and simulates none of it — so if the host's copy stops moving, so does
         the guest's, and if the host kills one it is dead on both. */
  {
    const p = twoPlayers('meadow', makeLoopback({ latency: 4 }), true);
    run(p, 40, scripted(0), scripted(2));
    const sawFoes = (p.guest.foes || []).length;
    const first = p.encounter.enemies[0];
    /* Reach over and kill one the way a hit would. */
    first.hp = 0; first.dead = 'struck';
    run(p, 60, scripted(0), scripted(2));
    const guestFoe = (p.guest.foes || [])[0];
    say('the guest is sent the machines and simulates none of them',
        sawFoes === p.encounter.enemies.length && !!guestFoe,
        `${sawFoes} of ${p.encounter.enemies.length}`);
    say('a machine the host killed is dead on the guest too',
        !!guestFoe && guestFoe.h === 0 && guestFoe.s === EN.EST.DEAD,
        guestFoe ? `hp ${guestFoe.h}, state ${guestFoe.s}` : 'no machine arrived');
  }

  /* 8d. And the wire still fits — with as many machines as a streamed world
         ever simulates at once (#108), not only the nine a window places. */
  {
    const wire = makeLoopback({});
    const p = twoPlayers('meadow', wire, true);
    for (let i = 0; p.encounter.enemies.length < EN.STREAM_ENC.max; i++) {
      p.encounter.add(p.w.spawn[0] + 12 + (i % 3) * 3, p.w.spawn[2] + 10 + ((i / 3) | 0) * 3, p.w.spawn[1] + 3, i % 3);
    }
    run(p, 600, scripted(0), scripted(2));
    const kbs = wire.stat.bytes / (600 / 60) / 1024;
    say('every machine on the wire still fits the budget', kbs < 30,
        `${kbs.toFixed(1)} kB/s with two players and ${p.encounter.enemies.length} machines`);
  }

  /* 8e. Gear is not an input, so it takes the other path: a guest asks, the
         host decides, and the snapshot is the answer. What has to hold is that
         the answer arrives and that both ends then agree, because `step` reads
         the lattice and a replay against the wrong one lands nowhere real. */
  {
    const p = twoPlayers('meadow', makeLoopback({ latency: 5 }));
    run(p, 40, scripted(0), scripted(2));
    /* The host is where a module would arrive from — it owns pickups too. */
    LT.takeModule(p.host.peer.gear, LT.MOD.SIGIL);
    run(p, 20, scripted(0), scripted(2));
    const carried = p.guest.me.gear.carried.slice();
    p.guest.act(ACT.SOCKET, 1, 0);
    run(p, 40, scripted(0), scripted(2));
    settle(p, 60);
    const hostSeated = p.host.peer.gear.slots[1] === LT.MOD.SIGIL;
    const guestSeated = p.guest.me.gear.slots[1] === LT.MOD.SIGIL;
    const d = dist2(p.guest.me, p.host.peer);
    say('a lattice the guest changes is the host\'s to apply, and then both agree',
        carried.length === 1 && hostSeated && guestSeated && d < 1e-9,
        `carried ${carried.length}, host ${hostSeated ? 'seated' : 'EMPTY'}, ` +
        `guest ${guestSeated ? 'seated' : 'EMPTY'}, ${d.toFixed(9)} m apart`);
    say('and the reach it grants crossed with it',
        Math.abs(p.guest.me.st.reach - p.host.peer.st.reach) < 1e-12
          && p.guest.me.st.reach > CB.REACH,
        `${p.guest.me.st.reach} m on the guest, ${p.host.peer.st.reach} m on the host`);
  }

  /* 9. A real network (#95): messages overtake each other, some arrive twice
        and some not at all. Snapshots older than the last are ignored, inputs
        are queued in order once each, and every input rides the next few
        messages too — so the ends still agree exactly. */
  {
    const p = twoPlayers('meadow', makeLoopback({ latency: 4, jitter: 8, dup: 0.15, loss: 0.15, seed: 'rough' }));
    run(p, 500, scripted(0), scripted(2));
    settle(p, 240);
    const d = dist2(p.guest.me, p.host.peer), st = p.wire.stat;
    say('a wire that reorders, duplicates and drops still ends in agreement, exactly', d === 0 && p.guest.me.y === p.host.peer.y,
        `${d.toFixed(9)} m apart; ${st.dropped} dropped, ${st.duplicated} duplicated, up to 8 ticks of jitter`);
  }

  /* 9b. Two 60 Hz clocks are never the same 60 Hz. A guest running 2% fast
         must not build the host a queue — which is a lag — without bound. */
  {
    const p = twoPlayers('meadow', makeLoopback({ latency: 3, jitter: 3, seed: 'drift' }));
    const g = scripted(2), h = scripted(0);
    let most = 0, gt = 0;
    for (let t = 0; t < 1500; t++) {
      p.wire.pump();
      p.host.step(h(t));
      p.guest.step(g(gt++));
      if (t % 50 === 0) p.guest.step(g(gt++));
      most = Math.max(most, p.host.stats.queued);
    }
    settle(p, 240);
    const d = dist2(p.guest.me, p.host.peer);
    say('a guest whose clock runs fast is caught up, not queued', most <= NS.CATCHUP + 3 && p.host.stats.caught > 0 && d === 0,
        `queue at most ${most}, ${p.host.stats.caught} caught up, ${d.toFixed(9)} m apart after`);
  }

  /* 9c. A partner who goes silent — a closed lid, a dropped connection — is
         lost after two seconds and stood still, not driven on by the last
         input the host happened to have. And comes back when they speak. */
  {
    const p = twoPlayers('meadow', makeLoopback({ latency: 2 }));
    run(p, 200, scripted(0), (t) => ({ mx: 1, mz: 0 }));
    /* Silent means nothing at all leaves the guest — not even its answer to
       the host's hello, which a live page gives without stepping. */
    const send = p.wire.b.send;
    p.wire.b.send = () => {};
    for (let t = 0; t < NS.STALE + 60; t++) { p.wire.pump(); p.host.step({}); }
    const lost = p.host.lost, x0 = p.host.peer.x;
    for (let t = 0; t < 30; t++) { p.wire.pump(); p.host.step({}); }
    const drift = Math.abs(p.host.peer.x - x0);
    p.wire.b.send = send;
    run(p, 20, () => ({}), () => ({}));
    say('a partner gone quiet is lost, stood still, and found again', lost && drift < 1e-9 && !p.host.lost,
        `${lost ? 'lost' : 'NOT lost'} after ${NS.STALE + 60} silent ticks, moved ${drift.toFixed(3)} m while lost, `
        + `${p.host.lost ? 'still lost' : 'back'} once heard`);
  }

  /* 9d. A guest that reloads is a new guest: its count starts at one again.
         The host hears a new id, forgets the old queue, announces itself once
         the old guest has gone quiet, and the new one grows the world and
         ends in agreement like the first. */
  {
    const wire = makeLoopback({ latency: 3 });
    let cur = null;
    wire.b.onMessage((m) => { if (cur) cur(m); });
    const sw = { send: (m) => wire.b.send(m), onMessage: (fn) => { cur = fn; }, close() {} };
    const p = twoPlayers('meadow', wire, false, sw, 1);
    run(p, 300, scripted(0), scripted(2));
    const fresh = makeGuest({ transport: sw, gid: 2, build: () => ({ col: p.w.guestCol, spawn: p.w.spawn }) });
    p.guest = fresh;
    let joinedAt = -1;
    for (let t = 0; t < 600; t++) {
      p.wire.pump(); p.host.step(scripted(0)(t)); p.guest.step(scripted(4)(t));
      if (joinedAt < 0 && p.guest.ready) joinedAt = t;
    }
    settle(p, 200);
    const d = dist2(p.guest.me, p.host.peer);
    say('a reloaded guest rejoins and agrees', joinedAt >= 0 && d === 0,
        `rejoined after ${joinedAt} ticks, ${d.toFixed(9)} m apart`);
  }

  /* 9e. What the guest only draws — the host's character — is drawn a little
         in the past, between two snapshots, not eased toward whichever one
         last landed. Measured as jerk (the second difference of position, per
         tick) against the host's own path: easing at 20 Hz over a jittery
         wire was ~27 times as jerky as the path it followed. */
  {
    const p = twoPlayers('meadow', makeLoopback({ latency: 4, jitter: 4, seed: 'smooth' }));
    const hp = [], gp = [];
    for (let t = 0; t < 900; t++) {
      p.wire.pump();
      p.host.step({ mx: cos(t * 0.01), mz: sin(t * 0.01) });
      p.guest.step({});
      if (t > 200) { hp.push([p.host.me.x, p.host.me.z]); gp.push([p.guest.peer.x, p.guest.peer.z]); }
    }
    const jerk = (q) => { let sum = 0; for (let i = 1; i < q.length - 1; i++)
      sum += Math.sqrt((q[i + 1][0] - 2 * q[i][0] + q[i - 1][0]) ** 2 + (q[i + 1][1] - 2 * q[i][1] + q[i - 1][1]) ** 2);
      return sum / (q.length - 2); };
    let lag = 0;
    for (let i = 0; i < hp.length; i++) lag = Math.max(lag, Math.sqrt((hp[i][0] - gp[i][0]) ** 2 + (hp[i][1] - gp[i][1]) ** 2));
    const ratio = jerk(gp) / jerk(hp);
    say('the partner is drawn between snapshots: steady, and not far behind', ratio < 4 && lag < 1.2,
        `${ratio.toFixed(1)}x the jerk of the path it follows (easing was ~27x), at most ${lag.toFixed(2)} m behind`);
  }

  /* 9f. Seating a module is sent once and is not an input, so nothing else
         covers for it if it is lost: it is numbered, sent again until a
         snapshot confirms it, and applied once and in order on the host —
         here over a wire that loses and duplicates a third of everything. */
  {
    const p = twoPlayers('meadow', makeLoopback({ latency: 4, jitter: 4, loss: 0.35, dup: 0.35, seed: 'acts' }));
    run(p, 60, scripted(0), scripted(2));
    LT.takeModule(p.host.peer.gear, LT.MOD.SIGIL);
    LT.takeModule(p.host.peer.gear, LT.MOD.SIGIL);
    run(p, 40, scripted(0), scripted(2));
    const carried = p.guest.me.gear.carried.length;
    p.guest.act(ACT.SOCKET, 1, 0);
    p.guest.act(ACT.SOCKET, 2, 0);
    run(p, 240, scripted(0), scripted(2));
    const g = p.host.peer.gear;
    say('a lattice change survives a lossy wire, and is applied exactly once',
        carried === 2 && g.slots[1] === LT.MOD.SIGIL && g.slots[2] === LT.MOD.SIGIL && g.carried.length === 0
          && p.guest.stats.acts === 0,
        `carried ${carried}; host slots ${g.slots.join(',')}, ${g.carried.length} still carried; `
        + `${p.guest.stats.acts} unconfirmed; ${p.wire.stat.dropped} dropped, ${p.wire.stat.duplicated} duplicated`);
  }

  /* 10. The debug dialog in a game of two (#93). The host's rules reach the
         guest and both simulations run under them: flight here, which a guest
         predicts exactly as its host runs it, so the two still agree. */
  {
    const p = twoPlayers('meadow', makeLoopback({ latency: 4, jitter: 2, loss: 0.1, seed: 'rules' }));
    run(p, 60, scripted(0), scripted(2));
    const y0 = p.host.peer.y;
    p.host.setRules({ fly: 10, fall: true });
    run(p, 40, () => ({}), () => ({ mx: 0.5, rise: true }));
    const heard = p.guest.rules.fly === 10 && p.guest.rules.fall === true;
    run(p, 60, () => ({}), () => ({ mx: 0.5, rise: true }));
    const rose = p.host.peer.y - y0;
    settle(p, 120);
    const d = dist2(p.guest.me, p.host.peer);
    say('a rule the host sets reaches the guest, and both simulations run under it', heard && rose > 5 && d === 0 && p.guest.me.y === p.host.peer.y,
        `guest heard fly ${p.guest.rules.fly}, fall ${p.guest.rules.fall}; the guest flew ${rose.toFixed(1)} m up on the host; ${d.toFixed(9)} m apart after`);

    /* And the guest cannot: it has no setter, and a rules message sent from
       its end is not one the host listens to. */
    const n = p.host.rules.n;
    p.wire.b.send({ t: 'rules', v: NS.RULES_VERSION, n: n + 5, fly: 0, inv: true });
    run(p, 10, () => ({}), () => ({}));
    say('the guest cannot set one', typeof p.guest.setRules === 'undefined' && p.host.rules.n === n && p.host.rules.fly === 10 && !p.host.rules.inv,
        `guest setter ${typeof p.guest.setRules}, host rules still #${p.host.rules.n} with fly ${p.host.rules.fly}`);

    /* A rules message of a version this end does not know is ignored, not guessed at. */
    p.wire.a.send({ t: 'rules', v: NS.RULES_VERSION + 1, n: 999, fly: 0 });
    run(p, 10, () => ({}), () => ({}));
    say('and a version it does not know is ignored', p.guest.rules.fly === 10 && p.guest.rules.n < 999, `guest keeps rules #${p.guest.rules.n}`);
  }

  /* 10b. Paused, nothing moves on either machine — the guest predicts nothing
          the host will not run — and the clock stands; unpaused, it goes on,
          and they agree. */
  {
    const p = twoPlayers('meadow', makeLoopback({ latency: 4, seed: 'pause' }));
    run(p, 80, scripted(0), scripted(2));
    p.host.setRules({ pause: true });
    run(p, 20, scripted(0), scripted(2));
    const at = { t: p.host.tick, h: [p.host.me.x, p.host.me.z], g: [p.guest.me.x, p.guest.me.z], s: p.guest.stats.seq };
    run(p, 120, scripted(0), scripted(2));
    const still = p.host.tick === at.t && p.host.me.x === at.h[0] && p.guest.me.x === at.g[0] && p.guest.stats.seq === at.s;
    p.host.setRules({ pause: false });
    run(p, 60, scripted(0), scripted(2));
    settle(p, 120);
    const d = dist2(p.guest.me, p.host.peer);
    say('the host pauses both machines, and they go on together', still && p.guest.rules.pause === false && p.host.tick > at.t && d === 0,
        `${still ? 'nothing moved' : 'SOMETHING MOVED'} over 120 paused ticks; ${d.toFixed(9)} m apart after`);
  }

  /* 10c. The issue's own bar: 200 ms more of latency and 5% loss, and the two
          still agree where a character ends up. */
  {
    const p = twoPlayers('meadow', makeLoopback({ latency: 12, jitter: 3, loss: 0.05, seed: 'bad' }));
    run(p, 500, scripted(0), scripted(2));
    settle(p, 240);
    const d = dist2(p.guest.me, p.host.peer);
    say('200 ms more latency and 5% loss still end in agreement', d === 0,
        `${d.toFixed(9)} m apart; round trip ${p.guest.stats.rtt} ticks as the guest measures it`);
  }

  /* 10d. The conditioner the dialog puts on a real connection: held back by
          the delay and the jitter, overtaking, and a share of it lost. */
  {
    const due = [], got = [];
    let r = 0;
    const inner = { send: (m) => got.push(m), onMessage() {}, close() {} };
    const c = conditioned(inner, { delay: 200, jitter: 100, loss: 0.2 },
      { later: (fn, ms) => due.push([ms, fn]), rnd: () => { r = (r * 9301 + 49297) % 233280; return r / 233280; } });
    for (let i = 0; i < 500; i++) c.send(i);
    const held = due.length, early = got.length;
    due.sort((x, y) => x[0] - y[0]).forEach((d) => d[1]());
    let overtook = 0;
    for (let i = 1; i < got.length; i++) if (got[i] < got[i - 1]) overtook++;
    const lo = Math.min(...due.map((d) => d[0])), hi = Math.max(...due.map((d) => d[0]));
    say('the network conditioner delays, reorders and drops what it is given',
        early === 0 && held === got.length && c.stat.dropped > 60 && c.stat.dropped < 140 && overtook > 50 && lo >= 200 && hi <= 300,
        `${c.stat.dropped} of 500 dropped, delays ${lo.toFixed(0)}–${hi.toFixed(0)} ms, ${overtook} overtook`);
  }

  /* 8. The point of all of it: each of them can see the other move. */
  {
    const p = twoPlayers('meadow', makeLoopback({ latency: 4 }));
    run(p, 10, scripted(0), scripted(2));          /* let the handshake finish */
    const g0 = { x: p.guest.peer.x, z: p.guest.peer.z };
    const h0 = { x: p.host.peer.x, z: p.host.peer.z };
    /* Furthest reached, not where they ended up: the scripted walk is a circle,
       so after a full turn both are back where they started and a displacement
       test would say nobody moved. */
    let sawHost = 0, sawGuest = 0;
    run(p, 400, scripted(0), scripted(2), () => {
      sawHost = Math.max(sawHost, dist2(p.guest.peer, g0));
      sawGuest = Math.max(sawGuest, dist2(p.host.peer, h0));
    });
    say('each player sees the other move', sawHost > 2 && sawGuest > 2,
        `guest saw ${sawHost.toFixed(1)} m, host saw ${sawGuest.toFixed(1)} m`);
  }

  return out;
}

/* ------------------------------------------------------------------- rtc ---- */

/* A description the shape a browser makes: a data channel, keys, candidates. */
const SAMPLE_SDP = ['v=0', 'o=- 4611731400430051336 2 IN IP4 127.0.0.1', 's=-', 't=0 0',
  'a=group:BUNDLE 0', 'a=msid-semantic: WMS', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0', 'a=candidate:1 1 udp 2113937151 192.168.1.20 54400 typ host generation 0',
  'a=candidate:2 1 udp 1677729535 203.0.113.7 54400 typ srflx raddr 192.168.1.20 rport 54400 generation 0',
  'a=ice-ufrag:Q3xw', 'a=ice-pwd:3cGd0xh2bXq2Qzj0yqS7mH1W',
  'a=fingerprint:sha-256 7B:8B:F0:65:5F:78:E2:51:3B:AC:6F:F3:3F:46:1B:35:DC:B8:5F:64:1A:24:C2:43:F0:A1:58:D0:A1:2C:19:08',
  'a=setup:actpass', 'a=mid:0', 'a=sctp-port:5000', 'a=max-message-size:262144', ''].join('\r\n');

/** Two fake data channels wired to each other, delivering on a pump. */
function channelPair() {
  const q = [];
  const mk = () => ({ readyState: 'open', bufferedAmount: 0, fns: [],
    addEventListener(ev, fn) { this.fns.push(fn); }, close() { this.readyState = 'closed'; } });
  const a = mk(), b = mk();
  a.send = (d) => q.push([b, d]); b.send = (d) => q.push([a, d]);
  return { a, b, pump() { while (q.length) { const [to, d] = q.shift(); for (const f of to.fns) f({ data: d }); } } };
}

/**
 * The WebRTC half that runs without a browser (#95): codes that survive being
 * pasted, refuse the wrong kind, and a transport over a channel. The browser
 * half — two pages actually connecting — is in smoke.mjs.
 */
export async function rtcSuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });

  const inv = await RTC.packCode({ type: 'offer', sdp: SAMPLE_SDP });
  const back = await RTC.unpackCode(inv, 'offer');
  say('an invite code comes back as the description it was made from', back.sdp === SAMPLE_SDP && back.type === 'offer',
      `${SAMPLE_SDP.length} characters of description, ${inv.length} of code`);

  const mangled = '  ' + inv.slice(0, 40) + '\n' + inv.slice(40, 90) + ' \n ' + inv.slice(90) + '\n';
  const linked = 'https://example.org/play/#join=' + inv;
  const m1 = await RTC.unpackCode(mangled, 'offer'), m2 = await RTC.unpackCode(linked, 'offer');
  say('and survives line breaks, spaces and being pasted as a link', m1.sdp === SAMPLE_SDP && m2.sdp === SAMPLE_SDP, 'all three read back');

  const rep = await RTC.packCode({ type: 'answer', sdp: SAMPLE_SDP });
  const why = [];
  for (const [text, want] of [[rep, 'offer'], [inv, 'answer'], ['hello', 'offer'], [inv.slice(0, inv.length - 9), 'offer']]) {
    try { await RTC.unpackCode(text, want); why.push('ACCEPTED'); } catch (e) { why.push(e.message); }
  }
  say('a reply where an invite goes, an invite where a reply goes, and a cut code are refused, saying which',
      why.every((w) => w !== 'ACCEPTED'), why.join(' | '));

  const kinds = RTC.candidateKinds(SAMPLE_SDP);
  say('a description says which kinds of address it offers', kinds.host === 1 && kinds.srflx === 1, JSON.stringify(kinds));

  /* A session over the channel transport, through JSON both ways. */
  const ch = channelPair(), ta = RTC.channelTransport(ch.a), tb = RTC.channelTransport(ch.b);
  const got = [];
  tb.onMessage((m) => got.push(m));
  ta.send({ t: 'x', n: 1.5, a: [1, 2] });
  ch.a.bufferedAmount = RTC.MAX_BUFFER + 1; ta.send({ t: 'late' }); ch.a.bufferedAmount = 0;
  ch.a.readyState = 'connecting'; ta.send({ t: 'early' }); ch.a.readyState = 'open';
  ch.pump();
  say('the channel transport sends JSON, and drops what a full or unopened channel would only delay',
      got.length === 1 && got[0].n === 1.5 && ta.stat.skipped === 2, `${got.length} delivered, ${ta.stat.skipped} dropped`);

  const wire = { a: RTC.channelTransport(ch.a), b: RTC.channelTransport(ch.b), pump: () => ch.pump(), stat: {} };
  const p = twoPlayers('meadow', wire);
  run(p, 300, scripted(0), scripted(2));
  settle(p, 120);
  const d = dist2(p.guest.me, p.host.peer);
  say('a session over the channel transport ends in agreement', p.guest.ready && d === 0, `${d.toFixed(9)} m apart`);
  return out;
}

/* ---------------------------------------------------------------- combat ---- */

/** A flat floor and an actor standing on it, facing +x. */
function arena() {
  const c = makeCollider(20, V);
  c.addBox(-19.9, 19.9, -19.9, 19.9, -2, 0);
  c.finish();
  const a = placeOnGround(c, 0, 0);
  a.faceX = 1; a.faceZ = 0;
  return { col: c, a };
}
const FACE = { mx: 0, mz: 0, aimX: 1, aimZ: 0 };
const swing = () => Object.assign({ attack: true }, FACE);
const hold = () => Object.assign({}, FACE);

/** Run `n` ticks of the same input and hand back the phases seen, in order. */
function phaseTrace(col, a, n, input, targets) {
  const seen = [];
  for (let t = 0; t < n; t++) {
    step(col, a, t === 0 ? input : hold(), targets);
    const p = CB.phase(a);
    if (!seen.length || seen[seen.length - 1][0] !== p) seen.push([p, 1]);
    else seen[seen.length - 1][1]++;
  }
  return seen;
}

/**
 * The first combat verb. Issue #23 is explicit that none of these numbers are
 * balance — what is being pinned is the *shape*: that a swing is committed,
 * that it costs something, and that the arc is an arc rather than a circle.
 */
export function combatSuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });
  const ticks = (sec) => Math.round(sec / TICK);

  /* 1. Three windows, in order, for as long as they say. */
  {
    const { col, a } = arena();
    const trace = phaseTrace(col, a, ticks(CB.SWING_TIME) + 4, swing());
    const order = trace.map((p) => p[0]).join(',');
    const want = [CB.PHASE.WINDUP, CB.PHASE.ACTIVE, CB.PHASE.RECOVER, CB.PHASE.NONE].join(',');
    say('a swing runs wind-up, active, recovery', order === want, order);
    const active = (trace.find((p) => p[0] === CB.PHASE.ACTIVE) || [0, 0])[1];
    say('the active window is the short one',
        active > 0 && active <= ticks(CB.ACTIVE) + 1 && active < ticks(CB.WINDUP),
        `${active} ticks of ${ticks(CB.SWING_TIME)}`);
  }

  /* 2. Committed. Not "slowed" — during the active window you go nowhere, and
        you cannot cancel into a jump or a vault either. */
  {
    const { col, a } = arena();
    step(col, a, swing());
    let windup = 0, activeMoved = 0, recover = 0, x = a.x;
    for (let t = 1; t < ticks(CB.SWING_TIME); t++) {
      const before = a.x;
      step(col, a, Object.assign({ mx: 1 }, FACE, { mx: 1 }));
      const d = a.x - before;
      const p = CB.phase(a);
      if (p === CB.PHASE.WINDUP) windup += d;
      else if (p === CB.PHASE.ACTIVE) activeMoved += d;
      else recover += d;
    }
    const free = RUN * TICK;
    say('the active window pins you in place', Math.abs(activeMoved) < 1e-9,
        `${activeMoved.toFixed(6)} m`);
    say('wind-up and recovery cost speed, not all of it',
        windup > 0 && recover > 0 && windup < ticks(CB.WINDUP) * free * 0.6
          && recover < ticks(CB.RECOVER) * free * 0.8,
        `${windup.toFixed(2)} m of wind-up, ${recover.toFixed(2)} m of recovery`);
  }

  /* 3. Stamina is the reason a swing is a decision. */
  {
    const { col, a } = arena();
    const before = a.stamina;
    step(col, a, swing());
    say('a swing costs stamina', a.stamina === before - CB.SWING_COST,
        `${before} → ${a.stamina}`);

    a.stamina = CB.SWING_COST - 1; a.swing = null; a.staminaHold = 0;
    step(col, a, swing());
    say('an empty pool refuses the swing', a.swing === null, a.swing ? 'it swung anyway' : '');
  }

  /* 4. ...and it comes back on a delay, so it cannot be drip-fed. */
  {
    const { col, a } = arena();
    step(col, a, swing());
    const spent = a.stamina;
    for (let t = 0; t < ticks(CB.STAMINA_HOLD) - 2; t++) step(col, a, hold());
    const held = a.stamina;
    for (let t = 0; t < ticks(1); t++) step(col, a, hold());
    say('stamina waits, then comes back', held === spent && a.stamina >= spent + CB.SWING_COST,
        `${spent.toFixed(0)} held to ${held.toFixed(0)}, then ${a.stamina.toFixed(0)}`);
  }

  /* 5. An arc, not a circle: in front is cut, behind is not, and reach is what
        it says on the frame. */
  {
    const { col, a } = arena();
    const targets = [
      { x: 1.2, y: a.y, z: 0, r: 0 },        /* in front, inside reach   */
      { x: -1.2, y: a.y, z: 0, r: 0 },       /* behind                   */
      { x: 0, y: a.y, z: 1.2, r: 0 },        /* square on, outside 100°  */
      { x: CB.REACH + 0.8, y: a.y, z: 0, r: 0 }, /* in front, too far    */
    ];
    let mask = 0;
    step(col, a, swing(), targets);
    for (let t = 1; t < ticks(CB.SWING_TIME); t++) { step(col, a, hold(), targets); mask |= a.hits; }
    say('the arc cuts what is in front of it', (mask & 1) !== 0, `mask ${mask}`);
    say('and nothing behind or beyond', (mask & ~1) === 0,
        ['behind', 'to the side', 'out of reach'].filter((_, i) => mask & (2 << i)).join(', ') || '');
  }

  /* 6. Once per swing. A three-tick active window is not three hits. */
  {
    const { col, a } = arena();
    const targets = [{ x: 1.0, y: a.y, z: 0, r: 0 }];
    let hits = 0;
    step(col, a, swing(), targets);
    for (let t = 1; t < ticks(CB.SWING_TIME) + 2; t++) {
      step(col, a, hold(), targets);
      if (a.hits) hits++;
    }
    say('a target is cut once per swing', hits === 1, `${hits} hits`);
  }

  /* 7. The dodge: a distance, not a nudge, and it costs. */
  {
    const { col, a } = arena();
    const x0 = a.x, st0 = a.stamina;
    step(col, a, Object.assign({ dodge: true }, FACE));
    let n = 1;
    while (a.dodge) { step(col, a, hold()); n++; }
    const d = a.x - x0;
    say('a dodge covers the distance it claims',
        Math.abs(d - CB.DODGE_DIST) < CB.DODGE_DIST * 0.12,
        `${d.toFixed(2)} m of ${CB.DODGE_DIST} in ${n} ticks`);
    say('a dodge costs stamina', st0 - a.stamina >= CB.DODGE_COST, `${st0 - a.stamina}`);
  }

  /* 8. The invulnerability ends before the dodge does — the tail is where a
        dodge is punished, and without it the verb has no downside. */
  {
    const { col, a } = arena();
    step(col, a, Object.assign({ dodge: true }, FACE));
    let inv = 0, total = 0;
    while (a.dodge) { if (CB.invulnerable(a)) inv++; total++; step(col, a, hold()); }
    say('invulnerability ends before the dodge does', inv > 0 && inv < total,
        `${inv} of ${total} ticks`);
  }

  /* 9. A dodge is the way out of a recovery, and the way out of nothing else. */
  {
    const { col, a } = arena();
    step(col, a, swing());
    for (let t = 1; CB.phase(a) !== CB.PHASE.ACTIVE; t++) step(col, a, hold());
    step(col, a, Object.assign({ dodge: true }, FACE));
    const duringActive = !a.dodge;
    while (CB.phase(a) !== CB.PHASE.RECOVER && a.swing) step(col, a, hold());
    a.stamina = CB.STAMINA_MAX; a.staminaHold = 0;
    step(col, a, Object.assign({ dodge: true }, FACE));
    const duringRecovery = !!a.dodge && a.swing === null;
    say('a dodge cancels recovery but never the swing itself',
        duringActive && duringRecovery,
        `${duringActive ? 'active held' : 'ACTIVE CANCELLED'}, ` +
        `${duringRecovery ? 'recovery cancelled' : 'recovery stuck'}`);
  }

  return out;
}

/* ----------------------------------------------------------------- enemy ---- */

/** A flat arena with one sentry in it and a player facing it. */
function duel(gap) {
  const c = makeCollider(20, V);
  c.addBox(-19.9, 19.9, -19.9, 19.9, -2, 0);
  c.finish();
  const p = placeOnGround(c, 0, 0);
  p.faceX = 1; p.faceZ = 0;
  const e = EN.makeSentry(c, gap === undefined ? 4 : gap, 0);
  return { col: c, p, e, targets: [e] };
}

/** Step both, with the player holding still and facing the machine. */
function watch(d, ticks, playerInput, onTick) {
  for (let t = 0; t < ticks; t++) {
    const dx = d.e.x - d.p.x, dz = d.e.z - d.p.z, l = hyp(dx, dz) || 1;
    const inp = Object.assign({ aimX: dx / l, aimZ: dz / l },
                              playerInput ? playerInput(t, d) : null);
    step(d.col, d.p, inp, d.targets);
    CB.applyHits(d.p, d.targets, CB.SWING_DAMAGE);
    EN.stepSentry(d.col, d.e, [d.p]);
    if (onTick) onTick(t);
    if (d.p.dead || d.e.dead) break;
  }
  return d;
}

/** Run until the machine is in `state`, or give up. */
function until(d, state, cap) {
  let n = 0;
  while (d.e.ai.state !== state && n < (cap || 2000)) { watch(d, 1); n++; }
  return n < (cap || 2000);
}

/**
 * One enemy that closes, telegraphs, swings and dies — issue #24. The telegraph
 * is the part that matters: from 45 degrees you see the top of things, and a
 * wind-up you cannot read is a fight you cannot learn.
 */
export function enemySuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });
  const ticks = (sec) => Math.round(sec / TICK);

  /* 1. It stands on the world like anything else does. */
  {
    const d = duel();
    say('a sentry spawns standing on the ground',
        d.e.grounded && !embedded(d.col, d.e) && d.e.hp === EN.SENTRY.hp,
        `y ${d.e.y.toFixed(2)}, ${d.e.hp} hp`);
  }

  /* 1b. It collides as wide as it is drawn (#37). Two walls a metre apart: a
         player (0.7 m) walks through, a sentry (1.35 m) cannot, and the player's
         jump is exactly the one the budget was solved for. */
  {
    const c = makeCollider(20, V);
    c.addBox(-19.9, 19.9, -19.9, 19.9, -2, 0);
    c.addBox(-0.4, 0.4, -19.9, -0.5, 0, 3);
    c.addBox(-0.4, 0.4, 0.5, 19.9, 0, 3);
    c.finish();
    const through = (a) => {
      for (let t = 0; t < 180; t++) step(c, a, { mx: 1, mz: 0 });
      return a.x > 1;
    };
    const p = through(placeOnGround(c, -3, 0));
    const e = EN.makeSentry(c, -3, 0), es = through(e);
    say('a sentry collides as wide as it is drawn, and a player as a player',
        p && !es && e.rad === EN.SENTRY.rad && jumpVFor(ACTOR.radius) === JUMP_V,
        `a 1 m gap: player ${p ? 'through' : 'STUCK'}, sentry (rad ${e.rad}) ${es ? 'THROUGH' : 'held'}; player jump ${JUMP_V.toFixed(4)} m/s unchanged`);
  }
  /* 1c. It goes round what it cannot climb (#15), and it gives up past its
         leash and walks home (#6). A wall between it and a player that holds
         still: straight at them is a wall, so it has to find the end of it. */
  {
    const c = makeCollider(20, V);
    c.addBox(-19.9, 19.9, -19.9, 19.9, -2, 0);
    c.addBox(2.5, 3.5, -19.9, 6, 0, 3);
    c.finish();
    const p = placeOnGround(c, 0, 0), e = EN.makeSentry(c, 7, 0);
    let reached = -1, detoured = 0;
    for (let t = 0; t < ticks(25) && reached < 0; t++) {
      EN.stepSentry(c, e, [p]);
      if (e.z > detoured) detoured = e.z;
      if (hyp(e.x - p.x, e.z - p.z) <= EN.SENTRY.range + 0.2) reached = t;
    }
    say('a sentry finds its way round a wall to reach you',
        reached > 0 && detoured > 6,
        reached > 0 ? `reached in ${(reached * TICK).toFixed(1)} s, round the wall's end at z ${detoured.toFixed(1)}`
                    : `NOT reached; got as far as ${e.x.toFixed(1)},${e.z.toFixed(1)}`);

    /* Now run: straight away from its post, faster than it walks. */
    const post = e.ai.post;
    let gaveUp = -1, home = -1;
    for (let t = 0; t < ticks(60) && home < 0; t++) {
      step(c, p, { mx: -1, mz: 0 });
      EN.stepSentry(c, e, [p]);
      if (gaveUp < 0 && e.ai.state === EN.EST.RETURN) gaveUp = t;
      if (gaveUp >= 0 && e.ai.state === EN.EST.DORMANT) home = t;
    }
    const off = hyp(e.x - post.x, e.z - post.z);
    say('and past its leash it gives up and walks back to its post',
        gaveUp > 0 && home > gaveUp && off < 1,
        `gave up after ${(gaveUp * TICK).toFixed(1)} s, home ${(home * TICK).toFixed(1)} s, ${off.toFixed(2)} m from its post`);
  }


  /* 2. It notices, closes, and gets into range under its own steam. */
  {
    const d = duel(9);
    const start = hyp(d.e.x - d.p.x, d.e.z - d.p.z);
    let floated = 0;
    watch(d, 600, null, () => { if (!d.e.grounded && d.e.vy === 0) floated++; });
    const end = hyp(d.e.x - d.p.x, d.e.z - d.p.z);
    say('it closes the distance on foot', end < start - 5 && floated === 0,
        `${start.toFixed(1)} m to ${end.toFixed(1)} m, ${floated} ticks hovering`);
  }

  /* 3. The telegraph: a window before anything can hurt you, and nothing lands
        during it. This is the assertion the whole issue is about. */
  {
    const d = duel(3);
    const ok = until(d, EN.EST.TELEGRAPH);
    const hpAtTell = d.p.hp;
    let hurtDuringTell = false;
    let n = 0;
    while (d.e.ai.state === EN.EST.TELEGRAPH && n < 200) {
      watch(d, 1);
      /* The tick that ends the tell is the tick the strike opens on, and the
         blow lands inside it — so only count damage that arrived while the
         machine was still winding up. */
      if (d.e.ai.state === EN.EST.TELEGRAPH && d.p.hp < hpAtTell) hurtDuringTell = true;
      n++;
    }
    say('it telegraphs, and the telegraph is the long part',
        ok && !hurtDuringTell && n >= ticks(EN.TELEGRAPH_TIME) - 1 && n > ticks(EN.STRIKE_TIME) * 3,
        `${n} ticks of tell, ${ticks(EN.STRIKE_TIME)} of strike`);
  }

  /* 4. And then it actually hits you. */
  {
    const d = duel(2.0);
    const before = d.p.hp;
    until(d, EN.EST.STRIKE);
    watch(d, 4);
    say('the strike lands on someone standing in it', d.p.hp === before - EN.SENTRY.damage,
        `${before} → ${d.p.hp}`);
  }

  /* 5. The one that matters for #23: dodge through it and it costs nothing.
        Not "less" — nothing, because the dodge's invulnerability is the whole
        reason the verb exists. */
  {
    const d = duel(2.0);
    until(d, EN.EST.TELEGRAPH);
    const before = d.p.hp;
    let dodged = false;
    watch(d, 200, (t, dd) => {
      /* Dodge just before the blow, so the i-frames cover the strike tick. */
      if (!dodged && dd.e.ai.state === EN.EST.TELEGRAPH
          && EN.TELEGRAPH_TIME - dd.e.ai.t <= CB.DODGE_IFRAMES * 0.5) {
        dodged = true;
        return { dodge: true, mx: -1, mz: 0 };
      }
      return null;
    }, () => {});
    say('a dodge through the strike costs nothing', dodged && d.p.hp === before,
        dodged ? `${before} → ${d.p.hp}` : 'never got the timing');
  }

  /* 6. The opening. A recovery longer than a whole player swing is the
        difference between "you survived" and "you got something for it". */
  {
    const d = duel(2.0);
    until(d, EN.EST.RECOVER);
    let n = 0;
    while (d.e.ai.state === EN.EST.RECOVER && n < 300) { watch(d, 1); n++; }
    say('the recovery is long enough to punish', n >= ticks(CB.SWING_TIME),
        `${n} ticks of opening, a whole swing is ${ticks(CB.SWING_TIME)}`);
  }

  /* 7. It dies, in the number of hits the numbers say, and stays dead. */
  {
    const d = duel(1.3);
    const want = Math.ceil(EN.SENTRY.hp / CB.SWING_DAMAGE);
    let landed = 0;
    watch(d, 2000, (t, dd) => {
      const l = hyp(dd.e.x - dd.p.x, dd.e.z - dd.p.z);
      return l > 1.3 ? { mx: (dd.e.x - dd.p.x) / l, mz: (dd.e.z - dd.p.z) / l }
                     : { attack: !dd.p.swing };
    }, () => { if (d.p.hits) landed++; });
    const restedAt = { x: d.e.x, z: d.e.z };
    watch(d, 120);
    say('it dies in the hits the numbers say, and stays dead',
        d.e.dead === 'struck' && landed === want
          && hyp(d.e.x - restedAt.x, d.e.z - restedAt.z) < 1e-9,
        `${landed} hits of ${want}, ${d.e.dead || 'alive'}`);
  }

  /* 8. It is heavy: it does not pull itself over a ledge the way a player can.
        Going *around* is #15's navigation graph; not walking up a wall is this
        issue's problem, and is the half that would look like a bug. */
  {
    const c = makeCollider(20, V);
    c.addBox(-19.9, 0, -6, 6, -2, 0);
    c.addBox(0.3, 19.9, -6, 6, -2, MOVE.climb);     /* a ledge a player jumps onto */
    c.finish();
    const p = placeOnGround(c, 6, 0);                /* up on the ledge */
    const e = EN.makeSentry(c, -3, 0);
    let sidestepped = false;
    for (let t = 0; t < 900; t++) {
      EN.stepSentry(c, e, [p]);
      if (e.ai.sideT > 0) sidestepped = true;
      if (e.jumps > 0) break;
    }
    say('a sentry does not jump onto a ledge, it goes around',
        e.jumps === 0 && e.y < MOVE.climb - 0.1 && sidestepped,
        `${e.jumps} jumps, y ${e.y.toFixed(2)}, ${sidestepped ? 'stepped aside' : 'pressed into it'}`);
  }

  /* 9. A hit interrupts a machine that has not committed yet — but never one
        that has, which is the same rule the player plays by. */
  {
    const d = duel(2.0);
    until(d, EN.EST.CLOSE);
    const enc = { targets: d.targets };
    EN.jolt(d.e);
    const staggered = d.e.ai.state === EN.EST.STAGGER;
    until(d, EN.EST.STRIKE);
    EN.jolt(d.e);
    const heldThrough = d.e.ai.state === EN.EST.STRIKE;
    say('a hit staggers it, unless it has already committed', staggered && heldThrough,
        `${staggered ? 'staggered' : 'shrugged'}, ${heldThrough ? 'held the strike' : 'STRIKE CANCELLED'}`);
  }

  return out;
}

/* ---------------------------------------------------------------- roster ---- */

/** A flat 40 m arena, and anything else `build` adds before it is finished. */
function pen(build) {
  const c = makeCollider(20, V);
  c.addBox(-19.9, 19.9, -19.9, 19.9, -2, 0);
  if (build) build(c);
  c.finish();
  return c;
}

/** Step machines against players for `n` ticks, players holding still unless
    `move` says otherwise. Stops early when `stop` says so. */
function brawl(c, foes, players, n, stop, move) {
  for (let t = 0; t < n; t++) {
    for (const p of players) step(c, p, Object.assign({ mx: 0, mz: 0 }, move ? move(t, p) : null), null);
    const budget = { left: 1, party: players.length };
    for (const e of foes) EN.stepEnemy(c, e, players, TICK, budget, foes);
    if (stop && stop(t)) return t;
  }
  return n;
}

/**
 * The mortar crawler and the grafted hounds (#106), and what they do to each
 * other. The rule each of them was designed round is the thing asserted: the
 * mortar only hurts where it marked the ground first, and a hound's lunge
 * goes where its line said and nowhere else.
 */
export function rosterSuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });
  const ticks = (sec) => Math.round(sec / TICK);
  const S = EN.EST;

  /* 1. The mortar marks the ground, then hurts only inside the marks. */
  {
    const c = pen(), p = placeOnGround(c, 0, 0), e = EN.makeMortar(c, 10, 0);
    const hp0 = p.hp;
    brawl(c, [e], [p], 600, () => e.ai.state === S.TELEGRAPH);
    const marks = e.ai.marks ? e.ai.marks.slice() : [];
    /* Into a ring: where the shells land depends on which of its three
       patterns it chose (#110), and the triangle's centre is safe. */
    if (marks.length) { p.x = marks[0]; p.z = marks[1]; }
    let tell = 0;
    brawl(c, [e], [p], 600, () => { tell++; return e.ai.state !== S.TELEGRAPH; });
    const lostWhileMarked = hp0 - p.hp;
    brawl(c, [e], [p], 600, () => e.ai.state !== S.STRIKE);
    say('a mortar marks where its shells will land before any land',
        marks.length === EN.MORTAR.shells * 2 && lostWhileMarked === 0 && tell >= ticks(EN.MORTAR_AIM_TIME) - 1,
        `${marks.length / 2} rings, ${tell} ticks of aim, ${lostWhileMarked} hp lost while they were down`);
    say('standing in a ring when the shells come down costs you',
        p.hp === hp0 - EN.MORTAR.damage,
        `${hp0 - p.hp} of ${EN.MORTAR.damage}`);
    let vent = 0;
    brawl(c, [e], [p], 600, () => { vent++; return e.ai.state !== S.RECOVER; });
    say('then it vents, long enough to be the opening', vent >= ticks(EN.MORTAR_VENT_TIME) - 1,
        `${vent} ticks of ${ticks(EN.MORTAR_VENT_TIME)}`);
  }
  {
    /* The same volley, and the player steps out of the rings while they are
       down: to the nearest ground a metre clear of every one of them. */
    const c = pen(), p = placeOnGround(c, 0, 0), e = EN.makeMortar(c, 10, 0);
    brawl(c, [e], [p], 600, () => e.ai.state === S.TELEGRAPH);
    const hp0 = p.hp, m = e.ai.marks || [];
    const clear = (x, z) => { for (let i = 0; i < m.length; i += 2) if (hyp(x - m[i], z - m[i + 1]) < EN.MORTAR.ringR + 1) return false; return true; };
    out: for (let r = 0; r <= 6; r += 0.5) for (let k = 0; k < 16; k++) {
      const x = p.x + cos(k * 0.3927) * r, z = p.z + sin(k * 0.3927) * r;
      if (clear(x, z)) { p.x = x; p.z = z; break out; }
    }
    brawl(c, [e], [p], 600, () => e.ai.state === S.RECOVER);
    say('and stepping out of them costs you nothing', p.hp === hp0,
        `${(hp0 - p.hp)} hp lost, standing at ${p.x.toFixed(1)}, ${p.z.toFixed(1)}`);
  }
  {
    const c = pen(), p = placeOnGround(c, 0, 0), e = EN.makeMortar(c, 3, 0);
    brawl(c, [e], [p], 30);
    const d0 = hyp(e.x - p.x, e.z - p.z);
    brawl(c, [e], [p], 240, () => e.ai.state === S.TELEGRAPH);
    const d1 = hyp(e.x - p.x, e.z - p.z);
    say('a mortar too close to fire backs away first', d1 > d0 + 1 && d1 >= EN.MORTAR.near - 0.3,
        `${d0.toFixed(1)} m to ${d1.toFixed(1)} m`);
  }
  {
    /* Neither the mortar nor the sentry climbs: a 1 m face stops them. */
    const c = pen((k) => k.addBox(4, 19.9, -19.9, 19.9, 0, 1));
    const p = placeOnGround(c, 6, 0), m = EN.makeMortar(c, -2, 0), h = EN.makeHound(c, -2, 3);
    let hTop = -1;
    brawl(c, [m, h], [p], 900, (t) => { if (hTop < 0 && h.y > 0.99 && h.x > 4) hTop = t; return false; });
    say('a hound jumps a 1 m face the crawler cannot climb',
        !m.canJump && m.y < 0.5 && h.canJump && hTop >= 0,
        `crawler at ${m.y.toFixed(2)} m, hound up at tick ${hTop}`);
  }

  /* 2. The hound circles, fixes a line, and lunges along it. */
  {
    const c = pen(), p = placeOnGround(c, 0, 0), e = EN.makeHound(c, 9, 0);
    brawl(c, [e], [p], 900, () => e.ai.state === S.TELEGRAPH);
    const lx = e.ai.lx, lz = e.ai.lz, hp0 = p.hp;
    /* Sidestep during the tell — off the line, square to it, which is the
       counter §6 names: the line must not follow. */
    brawl(c, [e], [p], 600, () => e.ai.state === S.STRIKE, () => ({ mx: -lz, mz: lx }));
    const held = e.ai.lx === lx && e.ai.lz === lz;
    const sx = e.x, sz = e.z;
    brawl(c, [e], [p], 600, () => e.ai.state !== S.STRIKE);
    const dx = e.x - sx, dz = e.z - sz, run = hyp(dx, dz), along = run ? (dx * lx + dz * lz) / run : 0;
    say('a hound fixes its line when the tell starts and the lunge follows it',
        held && run > 1 && along > 0.95,
        `line ${lx.toFixed(2)}, ${lz.toFixed(2)}; lunged ${run.toFixed(1)} m, ${(along * 100).toFixed(0)}% along it`);
    say('and a sidestep during the tell makes it miss', p.hp === hp0,
        `${hp0 - p.hp} hp lost, player moved ${hyp(p.x, p.z).toFixed(1)} m`);
    let stumble = 0;
    brawl(c, [e], [p], 600, () => { stumble++; return e.ai.state !== S.RECOVER; });
    say('it stumbles after, which is the opening', stumble >= ticks(EN.STUMBLE_TIME) - 1,
        `${stumble} ticks of ${ticks(EN.STUMBLE_TIME)}`);
  }
  {
    const c = pen(), p = placeOnGround(c, 0, 0), e = EN.makeHound(c, 9, 0);
    const hp0 = p.hp;
    brawl(c, [e], [p], 900, () => e.ai.state === S.RECOVER);
    say('standing on its line gets you bitten, once', p.hp === hp0 - EN.HOUND.damage,
        `${hp0 - p.hp} of ${EN.HOUND.damage}`);
  }
  {
    /* A strip of deep water between it and you: it will not go in. */
    const c = pen((k) => {
      k.setLiquid(2, 4, -19.9, 19.9, LIQUID.WATER, 1.2);
    });
    const p = placeOnGround(c, 7, 0), e = EN.makeHound(c, -3, 0);
    let wet = 0;
    brawl(c, [e], [p], 900, () => {
      const l = c.liquidAt(e.x, e.z);
      if (l.kind === LIQUID.WATER && l.level - e.y > MOVE.wade) wet++;
      return false;
    });
    say('a hound will not go into deep water after you', wet === 0 && e.x < 2.5,
        `${wet} ticks in deep water, ended at x ${e.x.toFixed(1)}`);
  }

  /* 3. They fight each other: a hound is biological, a sentry is tech. */
  {
    const c = pen(), p = placeOnGround(c, 0, -12);
    const s = EN.makeSentry(c, -2, 0), h = EN.makeHound(c, 2, 0);
    const foes = [s, h];
    /* A player walks past to wake them, and leaves. */
    brawl(c, foes, [p], 40);
    p.x = 19; p.z = 19;
    const f0 = [s.hp, h.hp];
    brawl(c, foes, [], 900, () => s.hp < f0[0] && h.hp < f0[1]);
    say('machines of different traditions fight each other',
        s.hp < f0[0] || h.hp < f0[1], `sentry ${f0[0]} → ${s.hp}, hound ${f0[1]} → ${h.hp}`);
  }
  {
    const c = pen(), a = EN.makeSentry(c, -2, 0), b = EN.makeMortar(c, 2, 0);
    a.ai.state = S.CLOSE; b.ai.state = S.CLOSE;
    const h0 = [a.hp, b.hp];
    brawl(c, [a, b], [], 600);
    say('and leave their own tradition alone', a.hp === h0[0] && b.hp === h0[1],
        `sentry ${a.hp}/${h0[0]}, mortar ${b.hp}/${h0[1]}`);
  }

  /* 4. Better with two: a reserve each, and a little more health. */
  {
    const cfg = GOLDEN_SEEDS[0], world = buildWorld(cfg), col = colliderForWorld(world);
    const enc = EN.makeEncounter(col, world, []);
    const kinds = enc.enemies.map((e) => EN.KIND_NAMES[e.k]);
    const reserves = enc.enemies.filter((e) => e.reserve).length;
    const one = placeOnGround(col, world.spawn[0], world.spawn[2], world.spawn[1] + 2);
    enc.step([one]);
    const stillIn = enc.enemies.filter((e) => e.reserve).length;
    const two = placeOnGround(col, world.spawn[0] + 1, world.spawn[2], world.spawn[1] + 2);
    enc.step([one, two]);
    const out = enc.enemies.filter((e) => e.reserve).length;
    say('every group holds a reserve back until a second player joins',
        reserves > 0 && stillIn === reserves && out === 0
          && kinds.indexOf('mortar') >= 0 && kinds.indexOf('hound') >= 0,
        `${enc.enemies.length} machines (${kinds.join(', ')}); ${reserves} in reserve alone, ${out} with two`);
    const wire = enc.wire();
    say('a reserve travels on the wire as one, and its kind with it',
        wire.every((w, i) => w.k === enc.enemies[i].k), `${wire.length} records`);
    /* Every one of them falls, and each leaves its own tradition behind. */
    for (const e of enc.enemies) { e.hp = 0; e.dead = 'struck'; }
    enc.step([]);
    const by = new Map(enc.loot.spoils.map((sp) => [sp.of, LT.MODULES[sp.mod].trad]));
    say('each machine drops its own tradition: hounds biological, the rest tech',
        by.size === enc.enemies.length
          && enc.enemies.every((e) => by.get(e.id) === (e.k === EN.KIND.HOUND ? LT.TRAD.BIO : LT.TRAD.TECH)),
        enc.enemies.map((e) => `${EN.KIND_NAMES[e.k]}:${LT.TRADITIONS[by.get(e.id)]}`).join(' '));
  }
  {
    const c = pen(), p = placeOnGround(c, 0, 0), q = placeOnGround(c, 1, 0);
    const alone = EN.makeSentry(c, 6, 0), paired = EN.makeSentry(c, 6, 0);
    brawl(c, [alone], [p], 5);
    brawl(c, [paired], [p, q], 5);
    say('a machine woken with two players about has a little more health',
        alone.maxHp === EN.SENTRY.hp && paired.maxHp === Math.round(EN.SENTRY.hp * EN.PARTY_HP)
          && paired.hp === paired.maxHp,
        `${alone.maxHp} alone, ${paired.maxHp} with two`);
  }

  /* 5. The packed wire comes back as it went. */
  {
    const cfg = GOLDEN_SEEDS[0], world = buildWorld(cfg), col = colliderForWorld(world);
    const enc = EN.makeEncounter(col, world, []);
    enc.enemies[1].ai.marks = [1.25, 2.5, 3, 4, 5, 6];
    enc.enemies[0].hurtT = 0.2;
    const w = enc.wire(), back = EN.unpackFoes(EN.packFoes(w));
    const packed = JSON.stringify(EN.packFoes(w)).length, plain = JSON.stringify(w).length;
    say('machines are packed for the wire and come back unchanged',
        JSON.stringify(back) === JSON.stringify(w) && packed < plain * 0.75,
        `${packed} bytes packed, ${plain} spelled out`);
  }

  /* 6. The rigs are whole and the tells move the way they read. */
  {
    const bad = [];
    for (const [nm, rig] of [['mortar', MORTAR_RIG], ['hound', HOUND_RIG]]) {
      const seen = new Set();
      for (const b of rig.bones) {
        if (b.parent && !seen.has(b.parent)) bad.push(`${nm}.${b.name} before its parent`);
        seen.add(b.name);
      }
      for (const q of rig.parts) if (!seen.has(q.bone)) bad.push(`${nm} part ${q.name} on no bone`);
    }
    if (MACHINE_RIGS[EN.KIND.MORTAR] !== MORTAR_RIG || MACHINE_RIGS[EN.KIND.HOUND] !== HOUND_RIG) bad.push('MACHINE_RIGS');
    let tube = 0, mono = true, crouch = 0;
    for (let k = 0; k <= 10; k++) {
      const m = poseMortar({ s: S.TELEGRAPH, t: EN.MORTAR_AIM_TIME * k / 10, k: 1 }, {});
      if (m.tube.rx > tube + 1e-12) mono = false;
      tube = m.tube.rx;
    }
    crouch = poseHound({ s: S.TELEGRAPH, t: EN.HOUND_TELL_TIME, k: 2 }, {}).body.py;
    const lunge = poseHound({ s: S.STRIKE, t: EN.LUNGE_TIME * 0.5, k: 2 }, {});
    const vent = poseMortar({ s: S.RECOVER, t: 0.1, k: 1 }, {});
    const same = JSON.stringify(poseMachine({ s: S.STRIKE, t: 0.1, k: 2 }, {})) === JSON.stringify(poseHound({ s: S.STRIKE, t: 0.1, k: 2 }, {}));
    say('the new rigs are whole, and their tells read: the tube rises, the vent opens, the hound crouches and stretches',
        bad.length === 0 && mono && tube < -0.8 && vent.vent.py > 0.1 && crouch < -0.1 && lunge.body.sz > 1.05 && same,
        bad.length ? bad.join('; ') : `tube ${tube.toFixed(2)}, vent ${vent.vent.py.toFixed(2)} m, crouch ${crouch.toFixed(2)} m, stretch ×${lunge.body.sz.toFixed(2)}`);
  }

  return out;
}

/* ------------------------------------------------------------ dynamics ---- */

/**
 * The machines move like things with weight and decide like things that are
 * paying attention (#110). Each behaviour has dice of its own, seeded from the
 * machine's id, so these run a number of machines and ask for "sometimes":
 * never would be the old turret, always would be a new one.
 */
export function dynamicsSuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });
  const S = EN.EST;
  const ang = (x, z) => Math.atan2(z, x);
  const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

  /* 1. Weight: a walk eases in, and nothing turns faster than its body can. */
  {
    const c = pen(), p = placeOnGround(c, 0, 0), e = EN.makeSentry(c, 9, 0);
    let first = -1, full = -1;
    brawl(c, [e], [p], 300, (t) => {
      const v = hyp(e.ai.mx, e.ai.mz);
      if (first < 0 && v > 0) first = t;
      if (full < 0 && v >= EN.SENTRY.speed * 0.95) full = t;
      return full >= 0;
    });
    let worst = [0, 0, 0];
    for (const k of [0, 1, 2]) {
      const c2 = pen(), q = placeOnGround(c2, 0, 0);
      const m = [EN.makeSentry, EN.makeMortar, EN.makeHound][k](c2, 6, 0);
      let fx = m.faceX, fz = m.faceZ;
      brawl(c2, [m], [q], 600, () => {
        const da = Math.abs(wrap(ang(m.faceX, m.faceZ) - ang(fx, fz)));
        if (da > worst[k]) worst[k] = da;
        fx = m.faceX; fz = m.faceZ;
        return false;
      }, (t) => ({ mx: cos(t * 0.05), mz: sin(t * 0.05) }));
    }
    const limit = EN.MOTION.map((mo) => mo.turn * TICK + 1e-6);
    say('a machine eases into its walk and turns no faster than its body can',
        full - first >= 3 && worst.every((w, k) => w <= limit[k]),
        `sentry at full speed ${full - first} ticks after it started; fastest turn a tick `
        + worst.map((w, k) => `${EN.KIND_NAMES[k]} ${w.toFixed(3)}/${limit[k].toFixed(3)}`).join(', '));
  }

  /* 2. A sentry stalks round you before it steps in. */
  {
    let stalked = 0;
    const n = 8;
    for (let i = 0; i < n; i++) {
      const c = pen(), p = placeOnGround(c, 0, 0), e = EN.makeSentry(c, 7, 0);
      e.id = i;
      let swept = 0, last = null;
      brawl(c, [e], [p], 900, () => {
        const a = ang(e.x - p.x, e.z - p.z);
        if (last !== null && hyp(e.x - p.x, e.z - p.z) < 4.6) swept += Math.abs(wrap(a - last));
        last = a;
        return e.ai.state === S.TELEGRAPH;
      });
      if (swept > 0.35) stalked++;
    }
    say('a sentry circles you before it steps in, not straight at you',
        stalked >= n / 2, `${stalked} of ${n} swept more than 20° round you before their first wind-up`);
  }

  /* 3. It backs off a swing it sees coming — sometimes — and sometimes swings twice. */
  {
    let backed = 0, combos = 0, singles = 0;
    const n = 16;
    for (let i = 0; i < n; i++) {
      const c = pen(), p = placeOnGround(c, 0, 0), e = EN.makeSentry(c, 2.9, 0);
      e.id = 100 + i;
      e.ai.state = S.CLOSE; e.ai.mode = 'stalk'; e.ai.wait = 5;
      let saw = false;
      brawl(c, [e], [p], 40, (t) => { if (e.ai.backT > 0) saw = true; return false; },
            (t) => ({ attack: t === 2, aimX: 1, aimZ: 0 }));
      if (saw) backed++;
      /* And a strike at someone standing in it: one, or two. */
      const c2 = pen(), q = placeOnGround(c2, 0, 0), m = EN.makeSentry(c2, 2, 0);
      m.id = 200 + i;
      q.invincible = true;
      let strikes = 0, was = null;
      brawl(c2, [m], [q], 600, () => {
        if (m.ai.state === S.STRIKE && was !== S.STRIKE) strikes++;
        was = m.ai.state;
        return m.ai.state === S.RECOVER;
      });
      if (strikes >= 2) combos++; else if (strikes === 1) singles++;
    }
    say('a sentry sometimes steps back from a swing it sees wound up',
        backed > 0 && backed < n, `${backed} of ${n} backed off`);
    say('and sometimes follows its strike with a second before it recovers',
        combos > 0 && singles > 0, `${combos} of ${n} swung twice, ${singles} once`);
  }

  /* 4. A mortar shifts between volleys, varies its pattern, and leads you. */
  {
    const c = pen(), p = placeOnGround(c, 0, 0), e = EN.makeMortar(c, 9, 0);
    e.id = 7;
    p.invincible = true;
    const at = [], pats = new Set();
    let was = null;
    brawl(c, [e], [p], 60 * 40, () => {
      if (e.ai.state === S.TELEGRAPH && was !== S.TELEGRAPH) { at.push([e.x, e.z]); pats.add(e.ai.pattern); }
      was = e.ai.state;
      return at.length >= 6;
    });
    let moved = 0;
    for (let i = 1; i < at.length; i++) if (hyp(at[i][0] - at[i - 1][0], at[i][1] - at[i - 1][1]) > 1.5) moved++;
    say('a mortar moves between volleys and changes its pattern',
        at.length >= 4 && moved >= at.length - 2 && pats.size >= 2,
        `${at.length} volleys, ${moved} of ${at.length - 1} from a new spot, patterns ${[...pats].join(',')}`);

    const c2 = pen(), q = placeOnGround(c2, -6, -8), m = EN.makeMortar(c2, 4, 0);
    q.invincible = true;
    let lead = null;
    brawl(c2, [m], [q], 600, () => {
      if (m.ai.state === S.TELEGRAPH && m.ai.marks && lead === null) {
        let cz = 0; for (let i = 1; i < m.ai.marks.length; i += 2) cz += m.ai.marks[i];
        lead = cz / (m.ai.marks.length / 2) - q.z;
      }
      return lead !== null;
    }, () => ({ mx: 0, mz: 1 }));
    say('and it aims where you are going, not where you stand',
        lead !== null && lead > 1, `rings centred ${lead === null ? '-' : lead.toFixed(1)} m ahead of a player walking across its front`);
  }

  /* 5. Hounds take turns, from opposite sides, and feint. */
  {
    const c = pen(), p = placeOnGround(c, 0, 0);
    p.invincible = true;
    const a = EN.makeHound(c, 8, 1), b = EN.makeHound(c, 8, -1);
    a.id = 41; b.id = 42; a.pack = b.pack = [a, b];
    let both = 0, apart = 0, lunges = 0, darts = 0, wasA = 0, wasB = 0;
    const busy = (h) => h.ai.state === S.TELEGRAPH || h.ai.state === S.STRIKE;
    brawl(c, [a, b], [p], 60 * 30, () => {
      if (busy(a) && busy(b)) both++;
      const one = busy(a) ? a : (busy(b) ? b : null);
      /* Where the other one is when the lunge is let go — the moment it matters. */
      if (one && one.ai.state === S.STRIKE && one.ai.t === TICK) {
        lunges++;
        const o = one === a ? b : a;
        const t = Math.abs(wrap(ang(one.x - p.x, one.z - p.z) - ang(o.x - p.x, o.z - p.z)));
        if (t > Math.PI / 2) apart++;
      }
      if (a.ai.dartT > 0 && !wasA) darts++;
      if (b.ai.dartT > 0 && !wasB) darts++;
      wasA = a.ai.dartT > 0; wasB = b.ai.dartT > 0;
      return false;
    });
    say('a pair of hounds never lunges at you together',
        lunges >= 4 && both === 0, `${lunges} lunges in 30 s, ${both} ticks with both committed`);
    say('and the one waiting holds the far side of you', apart >= lunges * 0.6,
        `${apart} of ${lunges} lunges came with the other hound more than 90° round you`);
    say('and they feint: darts in that are neither told nor bitten', darts >= 2,
        `${darts} feints in 30 s`);
  }

  /* 5b. And it leans into its own motion: forward speed tips it, sideways banks it. */
  {
    const still = poseMachine({ s: S.CLOSE, t: 0.2, k: 2 }, { walk: 0 });
    const run = poseMachine({ s: S.CLOSE, t: 0.2, k: 2 }, { walk: 0, fwd: 4, side: -3 });
    const dead = poseMachine({ s: S.DEAD, t: 0.2, k: 2 }, { walk: 0, fwd: 4 });
    say('a body leans into its motion, and only a living one',
        run.body.rx > still.body.rx + 0.1 && run.body.rz > still.body.rz + 0.1
          && JSON.stringify(dead) === JSON.stringify(poseMachine({ s: S.DEAD, t: 0.2, k: 2 }, { walk: 0 })),
        `forward lean ${(run.body.rx - still.body.rx).toFixed(2)}, bank ${(run.body.rz - still.body.rz).toFixed(2)} rad`);
  }

  /* 6. A group wakes as one. */
  {
    const c = pen(), p = placeOnGround(c, 0, 0);
    const s1 = EN.makeSentry(c, 8, 0), m1 = EN.makeMortar(c, 19, 0);
    s1.pack = m1.pack = [s1, m1];
    brawl(c, [s1, m1], [p], 3);
    say('a group wakes as one: the member you were seen by brings the rest',
        s1.ai.state !== S.DORMANT && m1.ai.state !== S.DORMANT,
        `sentry ${s1.ai.state}, mortar ${m1.ai.state} at ${hyp(m1.x - p.x, m1.z - p.z).toFixed(0)} m — out of its own sight`);
  }
  return out;
}

/* ---------------------------------------------------------------- reel ---- */

/**
 * The Reel, the second frame (#112): a tether that hauls light targets to you
 * and hauls you to heavy ones, along the ground and never over a gap, with two
 * frames carried and swapped.
 */
export function reelSuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });
  const T = CB.TETHER;

  /* A player with the Reel in hand, on a flat pen, facing +x. */
  const reeler = (c, x = 0, z = 0) => {
    const p = placeOnGround(c, x, z);
    LT.swapFrame(p.gear); LT.refitGear(p);
    p.faceX = 1; p.faceZ = 0;
    return p;
  };
  /* Press and release, then let it run, stepping what is in `foes` as the
     encounter would: its hits hurt and stagger, then the machines move. */
  const settleHits = (p, targets) => {
    if (!p.hits) return;
    CB.applyHits(p, targets);
    for (let i = 0; i < targets.length; i++) if ((p.hits & (1 << i)) && targets[i].ai) EN.jolt(targets[i]);
  };
  const fire = (c, p, targets, foes, ticks, input) => {
    const inp = (o) => Object.assign({ aimX: p.faceX, aimZ: p.faceZ }, o, input);
    step(c, p, inp({ attack: true, hold: true }), targets); settleHits(p, targets);
    step(c, p, inp({ hold: false }), targets); settleHits(p, targets);
    for (let t = 0; t < ticks; t++) {
      for (const e of foes) EN.stepEnemy(c, e, [p], TICK, null, foes);
      step(c, p, inp({}), targets); settleHits(p, targets);
    }
  };

  /* 1. The frame, and carrying two. */
  {
    const f = LT.FRAMES[LT.FRAME.REEL];
    const deg = f.cells.map((_, i) => f.edges.filter((e) => e[0] === i || e[1] === i).length);
    say('the reel frame is five cells in a line: four edges, the ends touching one neighbour',
        f.cells.length === 5 && f.edges.length === 4 && deg.join('') === '12221', `degrees ${deg.join(',')}`);
    const g = LT.makeGear();
    LT.takeModule(g, LT.MOD.KEEN); LT.takeModule(g, LT.MOD.SIGIL);
    LT.socketModule(g, 0, 0);
    const before = g.carried.slice(), known = g.known;
    LT.swapFrame(g);
    const there = g.frame === LT.FRAME.REEL && g.slots.every((v) => v < 0) && g.slots.length === 5;
    LT.socketModule(g, 2, 0);
    LT.swapFrame(g);
    say('each frame keeps its own sockets while the pack and what is known are shared',
        there && g.frame === LT.FRAME.WARDEN && g.slots[0] === LT.MOD.KEEN
          && g.bench.slots[2] === LT.MOD.SIGIL && g.carried.length === before.length - 1 && g.known === known,
        `warden slot 0 ${g.slots[0]}, reel slot 2 ${g.bench.slots[2]}, ${g.carried.length} carried`);
    const h = LT.makeGear(); LT.applyGearWire(h, LT.gearWire(g));
    say('both frames cross the wire, and the same lattice is the same numbers',
        JSON.stringify(LT.gearWire(h)) === JSON.stringify(LT.gearWire(g)) && JSON.stringify(h.st) === JSON.stringify(g.st),
        `${JSON.stringify(LT.gearWire(g)).length} bytes`);
  }

  /* 2. A swap is refused in the middle of a committed motion. */
  {
    const c = pen(), p = placeOnGround(c, 0, 0);
    const base = LT.frameKind(p.gear);
    step(c, p, { attack: true });
    const midSwing = p.swing && !CB.canSwing(p);
    const refusedSwing = !RL.trySwap(p) && LT.frameKind(p.gear) === base;
    const q = placeOnGround(c, 0, 0);
    step(c, q, { dodge: true, mx: 1 });
    const refusedDodge = !RL.trySwap(q);
    const r = placeOnGround(c, 0, 0);
    step(c, r, { swap: true });
    const swapped = LT.frameKind(r.gear) === 'tether' && r.st === r.gear.st;
    say('a frame swap is refused mid-swing and mid-dodge, and instant otherwise',
        midSwing && refusedSwing && refusedDodge && swapped,
        `swing ${refusedSwing ? 'refused' : 'ALLOWED'}, dodge ${refusedDodge ? 'refused' : 'ALLOWED'}, idle ${swapped ? 'swapped' : 'REFUSED'}`);
  }

  /* 3. Aim, release, and the cost. */
  {
    const c = pen(), p = reeler(c);
    const s0 = p.stamina;
    step(c, p, { attack: true, hold: true, aimX: 1, aimZ: 0 });
    const aiming = !!p.aim && p.stamina === s0 && !p.tether;
    for (let t = 0; t < 20; t++) step(c, p, { hold: true, aimX: 1, aimZ: 0 });
    const stillAiming = !!p.aim && !p.tether;
    step(c, p, { hold: false, aimX: 1, aimZ: 0 });
    const fired = !p.aim && !!p.tether && p.tether.ph === T.OUT;
    say('holding aims, with nothing spent; letting go fires the tether and costs stamina',
        aiming && stillAiming && fired && Math.abs(s0 - p.stamina - RL.reelCost(p)) < 1e-9,
        `${(s0 - p.stamina).toFixed(0)} stamina`);
    const q = placeOnGround(c, 0, 0);
    q.stamina = 5;
    LT.swapFrame(q.gear); LT.refitGear(q);
    step(c, q, { attack: true, hold: true });
    say('and with too little stamina to fire it will not even aim', !q.aim, `${q.stamina} stamina`);
  }

  /* 4. Heavy: you are hauled to it, and strike. A sentry and a mortar. */
  for (const [nm, mk] of [['sentry', EN.makeSentry], ['mortar', EN.makeMortar]]) {
    const c = pen(), p = reeler(c), e = mk(c, 8, 0);
    const hp0 = e.hp;
    fire(c, p, [e], [], 80);
    const near = hyp(e.x - p.x, e.z - p.z);
    say(`a ${nm} anchors the tether: you are hauled to it and strike it`,
        near < 2.3 && p.x > 5.5 && e.x === 8 && e.hp === hp0 - Math.round(p.st.damage * CB.REEL.strikeScale),
        `${near.toFixed(1)} m from it, it did not move, ${hp0 - e.hp} hp lost`);
  }

  /* 5. Light: it is hauled to you, staggered and hurt. */
  {
    const c = pen(), p = reeler(c), h = EN.makeHound(c, 7, 0);
    h.ai.state = EN.EST.CLOSE; h.ai.post = { x: 7, y: h.y, z: 0 };
    const hp0 = h.hp;
    step(c, p, { attack: true, hold: true, aimX: 1, aimZ: 0 }, [h]);
    step(c, p, { hold: false, aimX: 1, aimZ: 0 }, [h]);
    let staggered = false, minD = 99;
    for (let t = 0; t < 60; t++) {
      step(c, p, { aimX: 1, aimZ: 0 }, [h]); settleHits(p, [h]);
      EN.stepEnemy(c, h, [p], TICK, null, [h]);
      if (h.ai.state === EN.EST.STAGGER) staggered = true;
      minD = Math.min(minD, hyp(h.x - p.x, h.z - p.z));
    }
    say('a hound is hauled to you, staggered and hurt, and you stay where you stood',
        staggered && minD < 2 && Math.abs(p.x) < 0.5 && h.hp < hp0,
        `${minD.toFixed(1)} m apart at the nearest, you moved ${p.x.toFixed(2)} m, ${hp0 - h.hp} hp lost`);
  }

  /* 6. A wall is an anchor, and so is open ground — a dash either way. */
  {
    const c = pen((k) => k.addBox(5, 6, -19.9, 19.9, 0, 3));
    const p = reeler(c);
    fire(c, p, [], [], 60);
    say('a wall anchors the tether and the haul stops short of it',
        p.x > 3.8 && p.x < 4.5 && !p.tether && !p.haul, `stopped at x ${p.x.toFixed(2)} of a wall at 5`);
    const d = pen(), q = reeler(d);
    fire(d, q, [], [], 60);
    say('open ground hauls you the length the tether took hold of',
        Math.abs(q.x - CB.REEL.ground) < 0.4 && q.grounded, `${q.x.toFixed(2)} m of ${CB.REEL.ground}`);
  }

  /* 7. Never over a gap, off a ledge or into magma. */
  {
    /* A pit 4.2 m wide, 4 m deep, with ground either side: boxes, because a
       collider adds ground and cannot carve it out. */
    const pit = makeCollider(20, V);
    pit.addBox(-19.9, 2.4, -19.9, 19.9, -30, 0);
    pit.addBox(6.6, 19.9, -19.9, 19.9, -30, 0);
    pit.addBox(2.4, 6.6, -19.9, 19.9, -30, -4);
    pit.finish();
    const a = reeler(pit, 0, 0);
    fire(pit, a, [], [], 90);
    say('a haul toward a gap ends in front of it, on the ground, and never crosses it',
        a.grounded && a.x < 2.5 && a.y > -0.01 && !a.dead,
        `stopped at x ${a.x.toFixed(2)} of a lip at 2.4, y ${a.y.toFixed(2)}`);
    const lava = makeCollider(20, V);
    lava.addBox(-19.9, 19.9, -19.9, 19.9, -30, 0);
    lava.setLiquid(2.5, 7, -19.9, 19.9, LIQUID.MAGMA, 0.5);
    lava.finish();
    const b = reeler(lava, 0, 0);
    fire(lava, b, [], [], 90);
    say('and a haul toward magma stops before it', !b.dead && b.x < 2.6, `stopped at x ${b.x.toFixed(2)} of magma from 2.5`);
    /* A jump pressed while being hauled does nothing: the haul is no way to
       cross anything the budget does not already cross. */
    const flat = pen(), c2 = reeler(flat, 0, 0);
    step(flat, c2, { attack: true, hold: true, aimX: 1, aimZ: 0 });
    step(flat, c2, { hold: false, aimX: 1, aimZ: 0 });
    let hauled = 0, lifted = 0;
    for (let t = 0; t < 40; t++) {
      step(flat, c2, { aimX: 1, aimZ: 0 });
      if (c2.haul) { hauled++; step(flat, c2, { jump: true, aimX: 1, aimZ: 0 }); if (!c2.grounded) lifted++; }
    }
    say('a jump pressed while being hauled does nothing',
        hauled > 3 && lifted === 0, `${hauled} ticks of haul, ${lifted} of them left the ground`);
  }

  /* 8. A partner is never hauled, hurt or anchored to. */
  {
    const c = pen(), p = reeler(c), mate = placeOnGround(c, 3, 0);
    mate.gear = LT.makeGear();
    const hp0 = mate.hp;
    /* The players are not in `targets` — the encounter's own list — so the
       tether flies through them, as it must. */
    fire(c, p, [], [], 60);
    say('a tether flies through a partner standing in its line: no haul, no hit',
        mate.hp === hp0 && mate.x === 3 && p.x > 4, `partner ${mate.hp}/${hp0} hp at x ${mate.x}, you ended at ${p.x.toFixed(2)}`);
  }

  /* 9. Dodge and jump while the tether is out. */
  {
    const c = pen(), p = reeler(c);
    step(c, p, { attack: true, hold: true, aimX: 1, aimZ: 0 });
    const fromAim = CB.canDodge(p);
    step(c, p, { hold: false, aimX: 1, aimZ: 0 });
    const outBlocked = !CB.canDodge(p);
    p.stamina = 100;
    for (let t = 0; t < 40 && !(p.tether && p.tether.ph === T.BACK); t++) step(c, p, { aimX: 1, aimZ: 0 });
    const q = reeler(c, -10, 5);
    step(c, q, { attack: true, hold: true });
    step(c, q, { dodge: true, hold: true, mx: 0, mz: 1 });
    say('a dodge cancels aiming, but not a tether flying out',
        fromAim && outBlocked && !q.aim && !!q.dodge, `aim ${fromAim ? 'dodgeable' : 'LOCKED'}, tether out ${outBlocked ? 'locked' : 'DODGEABLE'}`);
  }

  /* 10. Everything crosses the wire: the state, the display, and the input. */
  {
    const c = pen(), p = reeler(c);
    step(c, p, { attack: true, hold: true, aimX: 1, aimZ: 0 });
    const aimed = ND(p);
    step(c, p, { hold: false, aimX: 1, aimZ: 0 });
    for (let t = 0; t < 4; t++) step(c, p, { aimX: 1, aimZ: 0 });
    const snap = snapshot(p), q = placeOnGround(c, 0, 0);
    restore(q, JSON.parse(JSON.stringify(snap)));
    const same = JSON.stringify(snapshot(q)) === JSON.stringify(snap);
    const disp = display(p), d2 = placeOnGround(c, 0, 0);
    applyDisplay(d2, disp);
    const inp = NS.unpackInput(NS.packInput({ mx: 0.5, mz: -1, attack: true, hold: true, swap: true, aimX: 1, aimZ: 0 }));
    say('aiming, the tether, a haul and the held button all cross the wire',
        same && !!snap.tether && aimed.am === 1 && !!disp.th && disp.fk === 1 && !!d2.tether && inp.hold && inp.swap && inp.attack,
        `snapshot ${JSON.stringify(snap.tether)}, display ${JSON.stringify(disp.th)}`);
    function ND(a) { return display(a); }
  }

  /* 11. A guest predicts a haul exactly: it knows nothing of what the tether met
         on the host, and a snapshot puts it right — so after a rest they agree. */
  {
    const p2 = twoPlayers('meadow', makeLoopback({ latency: 4 }), true);
    const guestIn = (t) => {
      const o = { mx: 0, mz: 0, aimX: 1, aimZ: 0 };
      if (t === 5) o.swap = true;
      if (t >= 20 && t < 24) { o.attack = t === 20; o.hold = true; }
      if (t >= 100 && t < 103) { o.attack = t === 100; o.hold = true; }
      return o;
    };
    run(p2, 300, scripted(0), guestIn);
    settle(p2, 200);
    const d = hyp(p2.guest.me.x - p2.host.peer.x, p2.guest.me.z - p2.host.peer.z);
    say('a haul is predicted by the guest and ends where the host says',
        d < 1e-9 && LT.frameKind(p2.guest.me.gear) === LT.frameKind(p2.host.peer.gear) && LT.frameKind(p2.host.peer.gear) === 'tether',
        `${d.toFixed(9)} m apart, frame ${LT.frameKind(p2.host.peer.gear)} on both`);
  }
  return out;
}

/* ------------------------------------------------------ streamed packs ---- */

/**
 * A streamed world's machines (#108): nine machines placed once round the
 * spawn was all an endless world had. Each loaded chunk nominates a post, its
 * group comes into the simulation as players come near and goes when they
 * leave, a cleared group stays cleared, and what falls is a list on the wire.
 */
export function packSuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });
  const cfg = GOLDEN_SEEDS[0], made = new Map();
  /* Chunks are the expensive part, and the walk comes back to ground it has
     seen: a world per chunk, generated once for the whole suite. */
  const fieldAt = () => {
    const f = makeChunkField(cfg.seed, null, 1);
    f.around = (x, z) => {
      const c = chunkAt(x, z), want = new Set();
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) want.add((c.cx + dx) + ',' + (c.cz + dz));
      for (const e of f.live()) if (!want.has(e.cx + ',' + e.cz)) f.drop(e.cx, e.cz);
      for (const k of want) {
        const [cx, cz] = k.split(',').map(Number);
        if (f.has(cx, cz)) continue;
        if (!made.has(k)) made.set(k, chunkWorld(cfg.seed, cx, cz, null, 1));
        f.adopt(cx, cz, made.get(k));
      }
    };
    return f;
  };
  const visit = (f, enc, p, x, z) => {
    f.around(x, z);
    const g = placeOnGround(f, x, z, 60);
    p.x = g.x; p.y = g.y; p.z = g.z; p.vx = p.vy = p.vz = 0;
    for (let t = 0; t < EN.STREAM_ENC.every; t++) enc.step([p]);
  };

  const f = fieldAt();
  f.around(0, 0);
  const enc = EN.makeEncounter(f, f.chunk(0, 0).w, []);
  const p = placeOnGround(f, 0, 0, 60);
  p.gear = LT.makeGear();
  visit(f, enc, p, 0, 0);
  const home = enc.enemies.map((e) => e.id);
  const far = 6 * 32;
  visit(f, enc, p, far, 0);
  const there = enc.enemies.slice(), g1 = enc.groups;
  const maxD = Math.max(0, ...there.map((e) => hyp(e.x - p.x, e.z - p.z)));
  say('a streamed world has machines wherever you go, not only round the spawn',
      home.length > 0 && there.length > 0 && there.every((e) => home.indexOf(e.id) < 0)
        && maxD < EN.STREAM_ENC.active + 6 && enc.enemies.length <= EN.STREAM_ENC.max,
      `${home.length} at the spawn, ${there.length} at ${far} m out, the farthest ${maxD.toFixed(0)} m away; `
      + `${g1.known} groups known, ${g1.active} active, ${g1.putAway} put away`);

  const ids = there.map((e) => e.id);
  say('and every machine has its own id, on the wire too',
      new Set(ids).size === ids.length && enc.wire().every((w, i) => w.i === there[i].id),
      `${ids.length} ids, ${new Set(ids).size} distinct`);

  /* Again from nothing: the same groups in the same places. */
  const f2 = fieldAt(), p2 = placeOnGround(f2, 0, 0, 60);
  f2.around(far, 0);
  const enc2 = EN.makeEncounter(f2, f.chunk(0, 0) ? f.chunk(0, 0).w : made.get('0,0'), []);
  visit(f2, enc2, p2, far, 0);
  const sig = (es) => JSON.stringify(es.map((e) => [e.id, e.k, Math.round(e.x * 4), Math.round(e.z * 4)]).sort());
  say('the same ground places the same groups, every time',
      sig(enc2.enemies) === sig(there), `${enc2.enemies.length} against ${there.length}`);

  /* Clear what is here, walk away, come back: it stays cleared. */
  for (const e of enc.enemies) if (!e.reserve) { e.hp = 0; e.dead = 'struck'; }
  enc.step([p]);
  const dropped = enc.loot.spoils.length, cleared = enc.groups.cleared;
  visit(f, enc, p, 0, 0);
  const awayCount = enc.enemies.filter((e) => ids.indexOf(e.id) >= 0).length;
  visit(f, enc, p, far, 0);
  const back = enc.enemies.filter((e) => ids.indexOf(e.id) >= 0 && !e.reserve).length;
  say('a group you cleared stays cleared after you leave and come back',
      cleared > 0 && awayCount === 0 && back === 0,
      `${cleared} groups cleared; ${awayCount} of their machines while away, ${back} standing on return`);

  /* What fell is on the ground, goes over the wire as a list, and is taken once. */
  const wire = enc.loot.spoilWire(), other = LO.makeLootField(f, f.chunk(0, 0) ? f.chunk(0, 0).w : made.get('0,0'), 0);
  other.applySpoils(wire);
  const sp = enc.loot.spoils[0];
  if (sp) { p.x = sp.x; p.y = sp.y; p.z = sp.z; }
  const got = enc.loot.collect([p]).length;
  say('what they drop lies on the ground as a list on the wire, and is picked up once',
      dropped > 0 && wire.length === dropped && other.spoils.length === dropped
        && got === 1 && enc.loot.spoils.length === dropped - 1,
      `${dropped} dropped, ${wire.length} on the wire, ${got} picked up, ${enc.loot.spoils.length} left`);
  return out;
}

/* ------------------------------------------------------------------ gear ---- */

/** A flat arena, an actor on it, and a target a fixed distance in front. */
function bench() {
  const c = makeCollider(20, V);
  c.addBox(-19.9, 19.9, -19.9, 19.9, -2, 0);
  c.finish();
  const a = placeOnGround(c, 0, 0);
  a.faceX = 1; a.faceZ = 0;
  return { col: c, a };
}

/** Seat `mod` in `slot` directly, the way a pickup and a socket would. */
function seat(a, slot, mod) {
  LT.takeModule(a.gear, mod);
  LT.socketModule(a.gear, slot, a.gear.carried.length - 1);
  a.st = a.gear.st;
  a.maxHp = a.st.maxHp;
  return a;
}

/**
 * Modules, sockets, fusion and loot — the spine of progression (§4).
 *
 * Same terms as combat: none of these numbers are balance. What is pinned is
 * the shape — that a lattice is adjacency and not a list, that knowledge is
 * something you go and get, and that what is on the ground is derived rather
 * than sent.
 */
export function gearSuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });

  /* 1. An empty frame plays exactly the game that was here before it. */
  {
    const g = LT.makeGear();
    const b = CB.baseStats();
    const drift = Object.keys(b).filter((k) => g.st[k] !== b[k]);
    say('an empty lattice is exactly the numbers in combat.mjs',
        drift.length === 0 && g.slots.length === 4 && LT.FRAMES[g.frame].edges.length === 5,
        drift.length ? drift.join(', ')
                     : `${g.slots.length} sockets, ${LT.FRAMES[g.frame].edges.length} edges`);
  }

  /* 2. Carried is not equipped. The lattice is the only thing that plays. */
  {
    const { a } = bench();
    const before = a.st.reach;
    LT.takeModule(a.gear, LT.MOD.SIGIL);
    const carried = a.gear.st.reach;
    LT.socketModule(a.gear, 0, 0);
    a.st = a.gear.st;
    say('a module in the pack does nothing; the same module in a socket does',
        carried === before && a.st.reach >= before + 0.39 && a.gear.carried.length === 0,
        `${before} m carried ${carried} m, seated ${a.st.reach} m`);
  }

  /* 3. ...and it reaches what it says it reaches, through the same sweep the
        blade always used. This is the end of the wire, not a stat readout. */
  {
    const far = { x: CB.REACH + 0.35, y: 0, z: 0, r: 0 };
    const bare = bench(), kit = bench();
    seat(kit.a, 0, LT.MOD.SIGIL);
    let bareHit = 0, kitHit = 0;
    for (const [w, tally] of [[bare, 'bare'], [kit, 'kit']]) {
      const t = [{ x: far.x, y: w.a.y, z: 0, r: 0 }];
      step(w.col, w.a, { mx: 0, mz: 0, aimX: 1, aimZ: 0, attack: true }, t);
      for (let q = 1; q < 80; q++) {
        step(w.col, w.a, { mx: 0, mz: 0, aimX: 1, aimZ: 0 }, t);
        if (w.a.hits) { if (tally === 'bare') bareHit++; else kitHit++; }
      }
    }
    say('a sigil cuts what the bare blade cannot reach', bareHit === 0 && kitHit === 1,
        `bare ${bareHit} hits at ${far.x.toFixed(2)} m, with the sigil ${kitHit}`);
  }

  /* 4. Fusion wants both halves of its bargain: a shared edge *and* the recipe
        for it. Either alone is two modules sitting next to each other. */
  {
    const near = LT.makeGear();                    /* slots 0 and 1 share an edge */
    LT.takeModule(near, LT.MOD.GOVERNOR); LT.socketModule(near, 0, 0);
    LT.takeModule(near, LT.MOD.KEEN); LT.socketModule(near, 1, 0);
    const unlearned = near.fused.length;
    /* Sitting on a fusion you have not found yet is the thing that is supposed
       to send you looking, so the lattice has to be able to say so. */
    const latent = LT.latentFusions(near);
    LT.learnFusion(near, LT.FUS.REGULATED);
    const learned = near.fused.length;
    const spent = LT.latentFusions(near).length;

    const apart = LT.makeGear();                   /* slots 0 and 3 do not */
    apart.known = (1 << LT.FUS.REGULATED);
    LT.takeModule(apart, LT.MOD.GOVERNOR); LT.socketModule(apart, 0, 0);
    LT.takeModule(apart, LT.MOD.KEEN); LT.socketModule(apart, 3, 0);

    say('a fusion needs a shared edge and a recipe, and takes neither on trust',
        unlearned === 0 && learned === 1 && apart.fused.length === 0
          && near.st.damage > apart.st.damage,
        `unlearned ${unlearned}, learned ${learned}, not adjacent ${apart.fused.length}, `
        + `${near.st.damage} damage against ${apart.st.damage}`);
    say('and an adjacency you cannot yet close is visible as one',
        latent.length === 1 && latent[0] === LT.FUS.REGULATED && spent === 0
          && LT.latentFusions(apart).length === 0,
        `${latent.length} latent before the recipe, ${spent} after, `
        + `${LT.latentFusions(apart).length} across a non-edge`);
  }

  /* 5. The three schools never combined, so two of a kind never fuse — however
        good each of them is on its own. */
  {
    const g = LT.makeGear();
    g.known = 0x3f;                                /* every recipe there is */
    LT.takeModule(g, LT.MOD.GOVERNOR); LT.socketModule(g, 0, 0);
    LT.takeModule(g, LT.MOD.SERVO); LT.socketModule(g, 1, 0);
    const cross = FUSIONS_CROSS();
    say('same-tradition neighbours never fuse', g.fused.length === 0 && cross,
        `${g.fused.length} fusions from two tech modules, `
        + `${cross ? 'every recipe crosses' : 'A RECIPE DOES NOT CROSS'}`);
  }

  /* 6. Limited carried slots, stash at camp — and there is no camp. */
  {
    const g = LT.makeGear();
    let took = 0;
    for (let i = 0; i < LT.CARRY + 3; i++) if (LT.takeModule(g, LT.MOD.KEEN)) took++;
    say('the pack is limited, and says no rather than dropping something',
        took === LT.CARRY && g.carried.length === LT.CARRY, `${took} of ${LT.CARRY + 3} taken`);
  }

  /* 7. A machine leaves the discipline it was built from where it fell, and it
        is picked up once — by whoever was standing there. */
  {
    const { col, a } = bench();
    const field = LO.makeLootField(col, { spawn: [0, 0, 0], lamps: [], lmPos: null }, 1);
    const machine = { x: 6, y: a.y, z: 0 };
    const early = field.collect([a]).length;
    field.drop(0, machine);
    const away = field.collect([a]).length;
    a.x = machine.x; a.z = machine.z;
    const got = field.collect([a]);
    const again = field.collect([a]).length;
    say('a fallen machine leaves its discipline on the ground, taken once',
        early === 0 && away === 0 && got.length === 1 && again === 0
          && a.gear.carried.length === 1,
        `before it fell ${early}, standing off it ${away}, on it ${got.length}, again ${again}`);
  }

  /* 8. A cache is knowledge, and knowledge is somewhere you have to go. Derived
        from the world on both machines, which is why none of it is sent. */
  {
    const w = sides('meadow');
    const mine = LO.cacheSites(w.hostCol, w.world);
    const theirs = LO.cacheSites(w.guestCol, w.world);
    const same = JSON.stringify(mine) === JSON.stringify(theirs);
    let nearest = Infinity, grounded = true;
    for (const c of mine) {
      nearest = Math.min(nearest, hyp(c.x - w.spawn[0], c.z - w.spawn[2]));
      if (!Number.isFinite(c.y)) grounded = false;
    }
    say('caches are derived from the world, identically on both machines',
        mine.length > 0 && same && grounded,
        `${mine.length} caches, ${same ? 'identical' : 'DIFFERENT'}`);
    /* And somewhere the budget can actually get to. A cache on a ruin's roof
       is a cache nobody collects, and the generator's reach flood is the only
       thing that knows the difference. */
    let unreachable = 0;
    for (const c of mine) {
      const ai = Math.round(c.x + w.world.half), bj = Math.round(c.z + w.world.half);
      if (!w.world.reach[ai * w.world.M + bj]) unreachable++;
    }
    say('and every one of them is a walk away, on ground the budget can reach',
        mine.length > 0 && nearest >= 9 && unreachable === 0,
        `nearest is ${Number.isFinite(nearest) ? nearest.toFixed(1) : '-'} m, `
        + `${unreachable} out of reach`);

    /* And what is in one is a module *and* the recipe that makes it worth
       more than a module — the whole reason the landmark is worth the walk. */
    const { a } = bench();
    const before = a.gear.known;
    const field = LO.makeLootField(w.hostCol, w.world, 0);
    const c0 = field.caches[0];
    a.x = c0.x; a.y = c0.y; a.z = c0.z;
    const got = field.collect([a]);
    say('a cache holds a module and the recipe that makes two of them worth more',
        got.length === 1 && got[0].fus >= 0 && a.gear.carried.length === 1
          && a.gear.known !== before,
        got.length ? `${LT.MODULES[got[0].mod].name} and ${LT.FUSIONS[got[0].fus].name}`
                   : 'nothing was there');
  }

  /* 9. The lattice has to survive the round trip, or a guest replays its inputs
        against numbers the host never had. */
  {
    const { a } = bench();
    seat(a, 0, LT.MOD.GOVERNOR);
    seat(a, 1, LT.MOD.KEEN);
    LT.learnFusion(a.gear, LT.FUS.REGULATED);
    a.st = a.gear.st;
    LT.takeModule(a.gear, LT.MOD.BLOOM);
    const b = placeOnGround(bench().col, 0, 0);
    restore(b, snapshot(a));
    const fields = ['damage', 'maxStamina', 'swingCost', 'reach', 'recover', 'speed'];
    const drift = fields.filter((k) => a.st[k] !== b.st[k]);
    say('a lattice survives snapshot and restore, fusions and all',
        drift.length === 0 && b.gear.fused.length === 1
          && b.gear.carried.length === 1 && b.gear.known === a.gear.known,
        drift.length ? drift.join(', ')
                     : `${b.gear.fused.length} fusion, ${b.gear.carried.length} carried`);
  }

  /* 10. And it is paid for. A module that makes the swing cheaper has to make
         the swing cheaper, through the same stamina pool as everything else. */
  {
    const bare = bench(), kit = bench();
    seat(kit.a, 0, LT.MOD.THEW);
    step(bare.col, bare.a, { mx: 0, mz: 0, aimX: 1, aimZ: 0, attack: true });
    step(kit.col, kit.a, { mx: 0, mz: 0, aimX: 1, aimZ: 0, attack: true });
    const cheap = (CB.STAMINA_MAX - kit.a.stamina) < (CB.STAMINA_MAX - bare.a.stamina);
    say('a module that says it is cheaper is cheaper, out of the same pool',
        cheap && kit.a.swing !== null,
        `${(CB.STAMINA_MAX - bare.a.stamina).toFixed(0)} stamina bare, `
        + `${(CB.STAMINA_MAX - kit.a.stamina).toFixed(0)} with the cord`);
  }

  return out;
}

/** Every recipe joins two different traditions. The rule, checked rather than
    trusted: a same-tradition recipe would make case 5 above pass by accident. */
function FUSIONS_CROSS() {
  for (const f of LT.FUSIONS) {
    if (LT.MODULES[f.pair[0]].trad === LT.MODULES[f.pair[1]].trad) return false;
  }
  return true;
}

/* ---------------------------------------------------------------------------
 * REGION — two views of the same ground agree.
 *
 * Issue #16's bar, stated as it states it: "two separately generated adjacent
 * chunks agree on every trail, crossing, site and landmark that crosses their
 * boundary."
 *
 * The method is the only one that can prove it: build the same world twice at
 * different window offsets and compare what they say about the ground they
 * share. Everything is converted to world coordinates first, because that is
 * the only frame in which the two windows are talking about the same place.
 *
 * This is what could not have passed before. The old generator chose its sites,
 * routed its trails and picked its landmark inside whatever window it happened
 * to be filling, and erosion drew from a stream that depended on how much of
 * the window had already been walked — so the same square metre had a different
 * height depending on where the window started.
 * ------------------------------------------------------------------------- */

/** World coordinate to cell index in a window built at (ox, oz), or -1. */
function cellAtWorld(w, ox, oz, x, z) {
  const i = x - ox + w.half, j = z - oz + w.half;
  if (i < 0 || j < 0 || i > w.M - 1 || j > w.M - 1) return -1;
  return i * w.M + j;
}

export function regionSuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });
  const SEED = 'QUARTERSTONE', SIZE = 64;

  /* Three offsets, so the overlap is not always the same shape: one chunk
     apart, two chunks apart, and a diagonal that crosses a region corner. */
  const pairs = [[[0, 0], [32, 0]], [[0, 0], [64, 0]], [[0, 0], [32, 32]]];
  let compared = 0, hBad = 0, tBad = 0, affShared = 0;
  const featureBad = [];

  for (const [[ax, az], [bx, bz]] of pairs) {
    const A = buildWorld({ seed: SEED, size: SIZE, force: null, ox: ax, oz: az });
    const B = buildWorld({ seed: SEED, size: SIZE, force: null, ox: bx, oz: bz });

    const lo = (a, b) => Math.max(a - SIZE / 2, b - SIZE / 2);
    const hi = (a, b) => Math.min(a + SIZE / 2, b + SIZE / 2);
    for (let x = lo(ax, bx); x <= hi(ax, bx); x++) {
      for (let z = lo(az, bz); z <= hi(az, bz); z++) {
        const ia = cellAtWorld(A, ax, az, x, z), ib = cellAtWorld(B, bx, bz, x, z);
        if (ia < 0 || ib < 0) continue;
        compared++;
        if (A.cells[ia].H !== B.cells[ib].H) hBad++;
        if (A.trail[ia] !== B.trail[ib]) tBad++;
      }
    }

    /* Features, in world coordinates, restricted to the ground both can see. */
    const seen = (w, ox, oz, x, z) => cellAtWorld(w, ox, oz, x, z) >= 0;
    const sitesOf = (w, ox, oz) => w.sites.map(([i, j]) => [i - w.half + ox, j - w.half + oz]);
    const bridgesOf = (w, ox, oz) => w.bridges.map((b) => [b[0] + ox, b[1] + oz, b[2], b[3], b[4], b[5]]);
    const shared = (list, other, oox, ooz) =>
      list.filter(([x, z]) => seen(other, oox, ooz, Math.round(x), Math.round(z)))
        .map((v) => v.map((n) => +(+n).toFixed(4)).join(',')).sort();

    const sA = shared(sitesOf(A, ax, az), B, bx, bz), sB = shared(sitesOf(B, bx, bz), A, ax, az);
    if (sA.join('|') !== sB.join('|')) featureBad.push(`sites ${ax},${az} vs ${bx},${bz}`);
    const bA = shared(bridgesOf(A, ax, az), B, bx, bz), bB = shared(bridgesOf(B, bx, bz), A, ax, az);
    if (bA.join('|') !== bB.join('|')) featureBad.push(`crossings ${ax},${az} vs ${bx},${bz}`);

    /* And the encounter affordances (#42): every chokepoint, arena, vantage
       point and piece of cover both can see, identical in kind, height and
       score, not just in place. */
    const affOf = (w, other, oox, ooz) => w.affordances
      .filter((a) => seen(other, oox, ooz, a.wx, a.wz))
      .map((a) => [a.k, a.wx, a.wz, a.h, a.s].join(',')).sort();
    const aA = affOf(A, B, bx, bz), aB = affOf(B, A, ax, az);
    affShared += aA.length;
    if (aA.join('|') !== aB.join('|')) featureBad.push(`affordances ${ax},${az} vs ${bx},${bz}: ${aA.length} vs ${aB.length}`);

    /* A landmark both windows can see must be the same landmark. */
    const lmOf = (w, ox, oz) => (w.lmPos ? [w.lmPos[0] + ox, w.lmPos[1], w.lmPos[2] + oz] : null);
    const la = lmOf(A, ax, az), lb = lmOf(B, bx, bz);
    if (la && lb && seen(B, bx, bz, Math.round(la[0]), Math.round(la[2]))
        && seen(A, ax, az, Math.round(lb[0]), Math.round(lb[2]))) {
      if (la.map((v) => +v.toFixed(4)).join(',') !== lb.map((v) => +v.toFixed(4)).join(',')) {
        featureBad.push(`landmark ${ax},${az} vs ${bx},${bz}`);
      }
    }
  }

  say('overlapping windows agree on the ground between them',
      hBad === 0, `${compared} cells compared, ${hBad} height mismatches`);
  say('and on where the trail runs across it',
      tBad === 0, `${tBad} trail mismatches over ${compared} cells`);
  say('and on the sites, crossings, landmarks and encounter affordances they can both see',
      featureBad.length === 0 && affShared > 0,
      featureBad.length ? featureBad.join('; ') : `every shared feature identical, ${affShared} affordances among them`);

  /* ---- the voxels themselves (issue #41) ----------------------------------
     Agreeing on heights and on where the trail runs is the region pass. This
     is the rest of it: two windows onto the same ground must emit the same
     voxels, the same props and the same grass, down to the shade of each box.

     MARGIN is a measured number, not a guess. A stamp is placed from its
     anchor cell and reaches past it — a canopy, a wall run, the arms of a
     landmark — and it reads the surface through a lookup that clamps at the
     window edge, so a band around the rim is wrong in any window and right in
     its neighbour. Sweeping seven seeds and six offsets, 4 m is clean over 2.4
     million voxels and 3 m fails by eight. That band is exactly the skirt
     chunk streaming (#13) will have to generate and discard. */
  const MARGIN = 4;
  const voxPairs = [[[0, 0], [16, 0]], [[0, 0], [16, 16]], [[0, 0], [32, 32]]];
  const fx = (n) => (+n).toFixed(4);
  let voxBad = 0, voxSeen = 0, grassBad = 0, grassSeen = 0, capped = 0;

  for (const [[ax, az], [bx, bz]] of voxPairs) {
    const A = buildWorld({ seed: SEED, size: SIZE, force: null, ox: ax, oz: az });
    const B = buildWorld({ seed: SEED, size: SIZE, force: null, ox: bx, oz: bz });
    capped += (A.capped || 0) + (B.capped || 0);
    const x0 = Math.max(ax, bx) - SIZE / 2 + MARGIN, x1 = Math.min(ax, bx) + SIZE / 2 - MARGIN;
    const z0 = Math.max(az, bz) - SIZE / 2 + MARGIN, z1 = Math.min(az, bz) + SIZE / 2 - MARGIN;
    const inBox = (x, z) => x >= x0 && x <= x1 && z >= z0 && z <= z1;

    /* A voxel is its place, its palette entry, its shade and its material —
       the whole record. Colour left that record in issue #28; comparing the
       index and the shade byte is comparing strictly more than the three
       floats did, because two entries can resolve to the same colour. */
    const voxOf = (w, ox, oz) => {
      const out = [];
      for (let i = 0; i < w.pos.length; i += 3) {
        const x = w.pos[i] + ox, z = w.pos[i + 2] + oz;
        if (!inBox(x, z)) continue;
        out.push([fx(x), fx(w.pos[i + 1]), fx(z),
                  w.pal[i / 3], w.shd[i / 3], w.mat[i / 3]].join(','));
      }
      return out.sort();
    };
    /* A blade is its place and every attribute the renderer instances it with,
       the per-biome dry colour included (issue #39). */
    const grassOf = (w, ox, oz) => {
      const g = w.grass, out = [];
      for (let i = 0; i < g.ph.length; i++) {
        const x = g.p[i * 3] + ox, z = g.p[i * 3 + 2] + oz;
        if (!inBox(x, z)) continue;
        out.push([fx(x), fx(g.p[i * 3 + 1]), fx(z), fx(g.ph[i]), g.ti[i],
                  fx(g.sc[i]), fx(g.yw[i]), fx(g.c[i * 3]), fx(g.dc[i * 3])].join(','));
      }
      return out.sort();
    };
    const diff = (a, b) => {
      const sa = new Set(a), sb = new Set(b);
      return a.filter((k) => !sb.has(k)).length + b.filter((k) => !sa.has(k)).length;
    };
    const va = voxOf(A, ax, az), vb = voxOf(B, bx, bz);
    voxSeen += va.length; voxBad += diff(va, vb);
    const ga = grassOf(A, ax, az), gb = grassOf(B, bx, bz);
    grassSeen += ga.length; grassBad += diff(ga, gb);
  }

  say('and on every voxel and prop between them',
      voxBad === 0, `${voxSeen} voxels compared, ${voxBad} mismatches (${MARGIN} m skirt)`);
  say('and on every blade of grass, dry ones included',
      grassBad === 0, `${grassSeen} blades compared, ${grassBad} mismatches`);
  /* The per-window prop budgets are inert at every size the generator is run
     at. The day one bites, a prop's existence starts depending on how much
     world you are looking at, and this is the assertion that says so. */
  say('no prop was dropped by a per-window budget',
      capped === 0, capped ? `${capped} props suppressed by a cap` : 'no cap bit');

  /* The pass is pure, not merely cached: a second generator built from the same
     seed string is a different object and must still answer the same. */
  {
    const G1 = makeGen(SEED, null), G2 = makeGen(SEED, null);
    const r1 = regionAt(G1, 3, -2);
    /* Without this the cache answers, and the test proves only that a Map
       returns what was put in it. */
    clearRegionCache();
    const r2 = regionAt(G2, 3, -2);
    const shape = (r) => JSON.stringify({
      sites: r.sites, bridges: r.bridges, landmark: r.landmark,
      trail: [...r.trail].sort(), grade: [...r.grade.entries()].sort(),
    });
    say('a region is the same wherever it is asked from',
        shape(r1) === shape(r2) && r1 !== r2,
        `${r1.trail.size} trail cells, ${r1.grade.size} graded, ${r1.bridges.length} crossings`);
  }

  return out;
}

/* --------------------------------------------------------------- network ----
 * Issue #53. REGION proves two windows agree about a region; it says nothing
 * about whether two *regions* agree with each other, and they did not: every
 * one routed between its own sites from its own centre and stopped, so the
 * trail network was nine islands forty metres apart, each with an end in open
 * ground. These are asserted over a 3 x 3 block of regions on two seeds,
 * because one seed can be continuous by luck.
 *
 * A dead end is judged by shape, not by neighbour count. The trail is two
 * cells wide and its shoulder pokes out at every corner, so "a cell with one
 * trail neighbour" counts nubs as ends. At a real end, everything within four
 * metres lies in one direction — inside a 60 degree cone — and beside a nub,
 * the trail runs off both ways. An end at a site, a port or a crossing is an
 * end that goes somewhere.
 * ------------------------------------------------------------------------- */

function trailNet(G, cx, cz) {
  const T = new Set(), goals = [], bridges = [], lens = [], regions = [];
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
    const r = regionAt(G, cx + a, cz + b);
    regions.push(r); lens.push(r.order.length);
    /* Read back as "x,z": the region keys cells by integer (#63), and this
       walk was written against coordinates it can split and print. */
    r.trail.forEach((k) => T.add(keyX(k) + ',' + keyZ(k)));
    goals.push(...r.sites, ...r.ports);
    bridges.push(...r.bridges);
  }
  const h = REGION / 2;
  return { T, goals, bridges, lens, regions,
           x0: (cx - 1) * REGION - h, x1: (cx + 1) * REGION + h - 1,
           z0: (cz - 1) * REGION - h, z1: (cz + 1) * REGION + h - 1 };
}

function netShape(n) {
  const { T, goals, bridges, x0, x1, z0, z1 } = n;
  const inBox = (x, z) => x >= x0 && x <= x1 && z >= z0 && z <= z1;
  const cells = [...T].map((k) => k.split(',').map(Number)).filter(([x, z]) => inBox(x, z));
  const S = new Set(cells.map(([x, z]) => x + ',' + z));
  const nbs = (x, z) => DIRS4_N.map(([dx, dz]) => [x + dx, z + dz]).filter(([a, b]) => S.has(a + ',' + b));

  const seen = new Set();
  let pieces = 0;
  for (const [x, z] of cells) {
    const k = x + ',' + z;
    if (seen.has(k)) continue;
    pieces++; seen.add(k);
    const st = [[x, z]];
    while (st.length) {
      const [px, pz] = st.pop();
      for (const [qx, qz] of nbs(px, pz)) {
        const qk = qx + ',' + qz;
        if (!seen.has(qk)) { seen.add(qk); st.push([qx, qz]); }
      }
    }
  }

  const dead = [];
  for (const [x, z] of cells) {
    if (nbs(x, z).length !== 1) continue;
    if (x <= x0 + 1 || x >= x1 - 1 || z <= z0 + 1 || z >= z1 - 1) continue;
    if (goals.some(([gx, gz]) => Math.abs(gx - x) + Math.abs(gz - z) <= 3)) continue;
    if (bridges.some((b) => Math.max(Math.abs(b[0] - x), Math.abs(b[1] - z)) <= b[4] / 2 + 1)) continue;
    const vs = [];
    for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
      if ((dx || dz) && S.has((x + dx) + ',' + (z + dz))) vs.push([dx, dz]);
    }
    let mx = 0, mz = 0;
    for (const [a, b] of vs) { const l = Math.sqrt(a * a + b * b); mx += a / l; mz += b / l; }
    const ml = Math.sqrt(mx * mx + mz * mz) || 1;
    const worst = Math.min(...vs.map(([a, b]) => (a * mx + b * mz) / ml / Math.sqrt(a * a + b * b)));
    if (worst > 0.5) dead.push(x + ',' + z);
  }
  return { cells: cells.length, pieces, dead };
}

const DIRS4_N = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** A cell's height as the region pass leaves it: eroded, then graded by the
    region that owns it — which is what every window reads, from any side. */
function baseH(G, x, z) { return Math.max(0, Math.min(CEIL, erodeAt(G, x, z, G.cell(x, z)))); }
function finalH(G, x, z) {
  const g = regionAt(G, regionOf(x), regionOf(z)).grade.get(cellKey(x, z));
  return g === undefined ? baseH(G, x, z) : g;
}

export function networkSuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });
  const SEEDS = GOLDEN_SEEDS.filter((s) => s.nm === 'meadow' || s.nm === 'hero');

  const pieces = [], dead = [], medians = [], portBad = [], ownBad = [];
  let ports = 0, first = null;
  for (const s of SEEDS) {
    const G = makeGen(s.seed, s.force);
    const cx = regionOf(s.ox), cz = regionOf(s.oz);
    const n = trailNet(G, cx, cz), sh = netShape(n);
    if (!first) first = n;
    pieces.push(`${s.nm} ${sh.pieces}`);
    for (const d of sh.dead) dead.push(`${s.nm} ${d}`);
    const lens = n.lens.slice().sort((p, q) => p - q);
    medians.push([s.nm, lens[lens.length >> 1]]);

    /* Every interior edge: both sides name the same port, and the trail
       reaches it from both — the cell on the line is the upper region's, the
       cell before it the lower's. */
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const rx = cx + a, rz = cz + b, mine = portsOf(G, rx, rz).map(String);
      for (const [ux, uz, axis] of [[rx + 1, rz, 0], [rx, rz + 1, 1]]) {
        if (ux > cx + 1 || uz > cz + 1) continue;
        const theirs = portsOf(G, ux, uz).map(String);
        const shared = mine.filter((p) => theirs.includes(p));
        if (shared.length !== 1) { portBad.push(`${s.nm} ${rx},${rz}|${ux},${uz} share ${shared.length}`); continue; }
        ports++;
        const [px, pz] = shared[0].split(',').map(Number);
        const before = axis ? px + ',' + (pz - 1) : (px - 1) + ',' + pz;
        if (!n.T.has(shared[0]) || !n.T.has(before)) portBad.push(`${s.nm} ${shared[0]}`);
        /* And at one height: the port is where two regions' grading meets, so
           it has to be the height both of them graded towards — its own. */
        const [bx, bz] = before.split(',').map(Number), ax2 = axis ? px : px + 1, az2 = axis ? pz + 1 : pz;
        const hp = finalH(G, px, pz), hb = finalH(G, bx, bz), ha = finalH(G, ax2, az2);
        if (hp !== baseH(G, px, pz)) portBad.push(`${s.nm} ${shared[0]} moved ${baseH(G, px, pz)} -> ${hp}`);
        else if (Math.abs(hp - hb) > MOVE.slope || Math.abs(hp - ha) > MOVE.slope) {
          portBad.push(`${s.nm} ${shared[0]} steps ${hb} | ${hp} | ${ha}`);
        }
      }
    }

    /* Only the owner writes. Two regions both grading a cell would each be
       right in their own grid, and a window would take whichever it read last. */
    for (const r of n.regions) {
      const owns = (k) => regionOf(keyX(k)) === r.rx && regionOf(keyZ(k)) === r.rz;
      r.grade.forEach((v, k) => { if (!owns(k)) ownBad.push(`${s.nm} grade ${k} by ${r.rx},${r.rz}`); });
      r.trail.forEach((k) => { if (!owns(k)) ownBad.push(`${s.nm} trail ${k} by ${r.rx},${r.rz}`); });
    }
  }

  say('the trail is one network across a 3x3 block of regions, not nine islands',
      pieces.every((p) => p.endsWith(' 1')), pieces.join(', ') + ' piece(s)');
  say('both regions on an edge name the same port, and the trail reaches it from each side at its height',
      portBad.length === 0 && ports > 0,
      portBad.length ? portBad.slice(0, 5).join('; ') : `${ports} interior edges, every one crossed`);
  say('a region marks and grades only ground it owns',
      ownBad.length === 0, ownBad.length ? ownBad.slice(0, 5).join('; ') : 'no cell written by two regions');
  say('no trail ends in open ground — only at a site, a port or a crossing',
      dead.length === 0, dead.length ? dead.slice(0, 5).join(', ') : 'every end goes somewhere');
  say('a region carries a real length of trail',
      medians.every(([, m]) => m >= 200),
      medians.map(([nm, m]) => `${nm} median ${m} cells`).join(', ') + ' (was ~120)');

  /* The self-test, the same shape as WALK's: plant a six-metre spur into open
     ground and require the dead-end check to find it. A check that reports
     zero is only evidence if it can report one. */
  const { T, goals, bridges, x0, z0 } = first;
  let spur = null;
  outer: for (let x = x0 + 12; x < x0 + REGION * 2; x++) for (let z = z0 + 12; z < z0 + REGION * 2; z++) {
    if (!T.has(x + ',' + z)) continue;
    let clear = true;
    for (let d = 1; d <= 10 && clear; d++) for (let w = -5; w <= 5 && clear; w++) {
      if (T.has((x + d) + ',' + (z + w))) clear = false;
    }
    if (clear && !goals.some(([gx, gz]) => Math.abs(gx - x) + Math.abs(gz - z) < 16)
        && !bridges.some((b) => Math.abs(b[0] - x) + Math.abs(b[1] - z) < 16)) { spur = [x, z]; break outer; }
  }
  const planted = { ...first, T: new Set(T) };
  if (spur) for (let d = 1; d <= 6; d++) planted.T.add((spur[0] + d) + ',' + spur[1]);
  const pd = netShape(planted).dead;
  const tip = spur ? (spur[0] + 6) + ',' + spur[1] : null;
  say('and the dead-end check can see one when there is one',
      !!spur && pd.includes(tip),
      spur ? (pd.includes(tip) ? `six-metre spur planted to ${tip}, found` : `SPUR TO ${tip} NOT SEEN — the check is blind`)
           : 'nowhere to plant a spur');
  return out;
}

/* ------------------------------------------------------------------ anim ----
 * Issue #33. A pose is a pure function of simulation state and presentation
 * time: it reads the actor or the machine's wire record and never writes to
 * either, so nothing the netcode compares can depend on an animation having
 * played. And a committed swing is animated as committed — its pose is its
 * clock, and nothing else.
 * ------------------------------------------------------------------------- */

export function animSuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });

  /* Rigs: every part rides a bone that exists, every bone's parent comes
     before it, and the rest pose is where the boxes are laid. */
  const rigBad = [];
  for (const [nm, rig] of [['hero', HERO_RIG], ['sentry', SENTRY_RIG]]) {
    const seen = new Set();
    for (const b of rig.bones) {
      if (b.parent && !seen.has(b.parent)) rigBad.push(`${nm}.${b.name} before its parent`);
      seen.add(b.name);
    }
    for (const p of rig.parts) if (!seen.has(p.bone)) rigBad.push(`${nm} part ${p.name} on no bone`);
    const rest = restPositions(rig);
    if (Object.keys(rest).length !== rig.bones.length) rigBad.push(`${nm} rest positions`);
  }
  say('both rigs are whole: every part on a bone, every bone after its parent',
      rigBad.length === 0, rigBad.length ? rigBad.join('; ') : `hero ${HERO_RIG.bones.length} bones / ${HERO_RIG.parts.length} parts, sentry ${SENTRY_RIG.bones.length} / ${SENTRY_RIG.parts.length}`);

  /* Read-only: a battery of states, each posed twice, and the actor compared
     byte for byte before and after. */
  const actors = [
    { x: 1, y: 2, z: 3, vx: 3, vz: 1, faceX: 0, faceZ: 1, grounded: true, hurtT: 0, swing: null, dodge: null, vault: null, dead: null },
    { x: 0, y: 0, z: 0, vx: 0, vz: 0, faceX: 1, faceZ: 0, grounded: true, hurtT: 0.1, swing: { t: 0.3, hit: 1 }, dodge: null, vault: null, dead: null },
    { x: 0, y: 0, z: 0, vx: 2, vz: 0, faceX: 0, faceZ: 1, grounded: false, hurtT: 0, swing: null, dodge: { t: 0.1, dx: 1, dz: 0 }, vault: null, dead: null },
    { x: 0, y: 0, z: 0, vx: 0, vz: 0, faceX: 0, faceZ: 1, grounded: true, hurtT: 0, swing: null, dodge: null, vault: { t: 0.2 }, dead: null },
    { x: 0, y: 0, z: 0, vx: 0, vz: 0, faceX: 0, faceZ: 1, grounded: true, hurtT: 0, swing: null, dodge: null, vault: null, dead: 'fell' },
  ];
  let wrote = 0, drift = 0;
  for (const a of actors) {
    const before = JSON.stringify(a);
    const p1 = JSON.stringify(poseHero(a, { walk: 1.3, reach: 1.9 }));
    const p2 = JSON.stringify(poseHero(a, { walk: 1.3, reach: 1.9 }));
    if (JSON.stringify(a) !== before) wrote++;
    if (p1 !== p2) drift++;
  }
  const wires = [0, 1, 2, 3, 4, 5, 6, 7].map((s) => ({ x: 0, y: 0, z: 0, fx: 0, fz: 1, s, t: 0.3, h: 3, u: s === 6 ? 0.1 : 0 }));
  for (const m of wires) {
    const before = JSON.stringify(m);
    const p1 = JSON.stringify(poseSentry(m, { walk: 0.7, t: 2.1 })), p2 = JSON.stringify(poseSentry(m, { walk: 0.7, t: 2.1 }));
    if (JSON.stringify(m) !== before) wrote++;
    if (p1 !== p2) drift++;
  }
  say('a pose reads the simulation and never writes to it, and the same state gives the same pose',
      wrote === 0 && drift === 0, `${actors.length} actor states and ${wires.length} machine states: ${wrote} written to, ${drift} that posed differently twice`);

  /* Committed: the blade is exactly the swing's clock, at every tick of it, and
     the body winds back, drives through and comes home. */
  let off = 0, t, minTwist = 0, maxTwist = 0;
  const base = { x: 0, y: 0, z: 0, vx: 0, vz: 0, faceX: 0, faceZ: 1, grounded: true, hurtT: 0, dodge: null, vault: null, dead: null };
  for (t = 0; t <= CB.SWING_TIME + 1e-9; t += TICK) {
    const p = poseHero({ ...base, swing: { t, hit: 0 } }, { walk: 5 });
    if (Math.abs(p.armR.ry - swingYaw(t)) > 1e-12) off++;
    minTwist = Math.min(minTwist, p.torso.ry); maxTwist = Math.max(maxTwist, p.torso.ry);
  }
  const home = poseHero({ ...base, swing: { t: CB.SWING_TIME - 1e-6, hit: 0 } }, {});
  say('a swing is posed by its clock alone: the blade follows it exactly, the body winds back and drives through',
      off === 0 && minTwist < -0.4 && maxTwist > 0.5 && Math.abs(home.torso.ry) < 0.01,
      `${off} ticks off the clock; body turns ${minTwist.toFixed(2)} to ${maxTwist.toFixed(2)} and ends at ${home.torso.ry.toFixed(3)}`);

  /* The sentry's wind-up grows through the telegraph and releases into the
     strike, on the surfaces the camera can see: lean and arms. */
  let mono = true, lastLean = 1;
  for (let k = 0; k <= 10; k++) {
    const p = poseSentry({ s: EN.EST.TELEGRAPH, t: EN.TELEGRAPH_TIME * k / 10, fx: 0, fz: 1, u: 0 }, {});
    if (p.body.rx > lastLean + 1e-12) mono = false;
    lastLean = p.body.rx;
  }
  const wound = poseSentry({ s: EN.EST.TELEGRAPH, t: EN.TELEGRAPH_TIME, fx: 0, fz: 1, u: 0 }, {});
  const struck = poseSentry({ s: EN.EST.STRIKE, t: EN.STRIKE_TIME, fx: 0, fz: 1, u: 0 }, {});
  say('a telegraph winds up steadily and the strike releases it forward',
      mono && wound.body.rx < -0.2 && wound.armL.ry > 0.5 && struck.body.rx > 0.2 && struck.root.pz > 0.2,
      `lean ${wound.body.rx.toFixed(2)} at the end of the wind-up, ${struck.body.rx.toFixed(2)} and ${struck.root.pz.toFixed(2)} m forward as it strikes`);
  return out;
}

/* ------------------------------------------------------------------ mesh ----
 * Issue #12. The box renderer draws six faces per emitted voxel whether or not
 * anything can see them; the mesher draws the volume's exposed surface, merged.
 * The claims worth pinning are the ratio, that a seam does not double-draw or
 * tear, and that the same world meshes the same way twice.
 * ------------------------------------------------------------------------- */

export function meshSuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });
  const w = buildWorld({ seed: 'QUARTERSTONE', size: 64, force: null, ox: 0, oz: 0 });

  const chunks = [];
  let quads = 0, faces = 0, aoBad = 0, shapeBad = 0;
  for (let cx = 0; cx < 2; cx++) {
    for (let cz = 0; cz < 2; cz++) {
      const m = meshChunk(w, cx, cz);
      chunks.push(m); quads += m.quads; faces += m.faces;
      if (m.pos.length !== m.quads * 12 || m.nor.length !== m.quads * 12
          || m.mat.length !== m.quads * 4 || m.ao.length !== m.quads * 4
          || m.idx.length !== m.quads * 6) shapeBad++;
      for (let i = 0; i < m.ao.length; i++) if (!(m.ao[i] >= 0 && m.ao[i] <= 3)) aoBad++;
    }
  }

  const boxes = (w.pos.length / 3) * 6;
  say('a meshed chunk draws far less than a box per voxel',
      quads > 0 && boxes / quads > 5,
      `${boxes} box faces, ${faces} exposed, ${quads} quads after merging `
      + `— ${(boxes / quads).toFixed(1)}x fewer, ${(faces / quads).toFixed(2)}x from the merge alone`);

  say('every quad is four vertices, four corners of occlusion and six indices',
      shapeBad === 0 && aoBad === 0,
      shapeBad ? `${shapeBad} chunks with mismatched arrays` : `${quads} quads, occlusion within 0..3`);

  /* A face is a place and a direction. Two chunks emitting the same one would
     draw it twice; the pad ring exists so the boundary is culled against the
     neighbour rather than against nothing. */
  const seen = new Set();
  let dup = 0;
  for (const m of chunks) {
    for (let q = 0; q < m.quads; q++) {
      const v = q * 12;
      const k = [m.pos[v], m.pos[v + 1], m.pos[v + 2],
                 m.nor[v], m.nor[v + 1], m.nor[v + 2]].join(',');
      if (seen.has(k)) dup++; else seen.add(k);
    }
  }
  say('and no face is drawn by two chunks at once',
      dup === 0, dup ? `${dup} duplicated at a seam` : `${seen.size} distinct faces across four chunks`);

  /* Issue #56. The terrain material is single-sided, so a triangle wound
     against its normal is simply not drawn. Every -X, -Y and -Z face was, for
     as long as the mesh existed, and three of the four view steps lost their
     walls. Checked per direction, so a regression names the face it lost. */
  const wind = {};
  for (const m of chunks) {
    for (let t = 0; t < m.idx.length; t += 3) {
      const a = m.idx[t] * 3, b = m.idx[t + 1] * 3, c = m.idx[t + 2] * 3, P = m.pos;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      const dot = (uy * vz - uz * vy) * m.nor[a] + (uz * vx - ux * vz) * m.nor[a + 1]
                + (ux * vy - uy * vx) * m.nor[a + 2];
      const k = `${m.nor[a]},${m.nor[a + 1]},${m.nor[a + 2]}`;
      wind[k] = wind[k] || [0, 0];
      wind[k][dot > 0 ? 0 : 1]++;
    }
  }
  const dirs = Object.keys(wind), backward = dirs.filter((k) => wind[k][1] > 0);
  say('every face is wound to face the way it points, in all six directions',
      dirs.length === 6 && backward.length === 0,
      backward.length ? backward.map((k) => `${k}: ${wind[k][1]} of ${wind[k][0] + wind[k][1]} backwards`).join('; ')
                      : `${dirs.length} directions, ${dirs.reduce((s, k) => s + wind[k][0], 0)} triangles, all facing out`);

  const again = meshChunk(w, 0, 0);
  const first = chunks[0];
  const same = again.quads === first.quads
    && again.pos.every((v, i) => v === first.pos[i])
    && again.mat.every((v, i) => v === first.mat[i])
    && again.ao.every((v, i) => v === first.ao[i]);
  say('and meshing the same chunk twice gives the same mesh',
      same, `${again.quads} quads`);

  return out;
}

/* ----------------------------------------------------------------- carve ---- */

/** Everything a chunk's mesh is, flattened into one comparable string. */
function meshSig(m) {
  return m.quads + '|' + m.pos.join(',') + '|' + m.ao.join(',') + '|' + m.pal.join(',');
}

/** Mesh every chunk of a world and key the signatures by "cx,cz". */
function meshAll(w) {
  const g = chunkGrid(w), out = {};
  for (let cx = 0; cx < g; cx++) for (let cz = 0; cz < g; cz++) out[cx + ',' + cz] = meshSig(meshChunk(w, cx, cz));
  return out;
}

/** The column's top voxel index, and the centre of that voxel in metres. */
function topVoxel(w, gi, gj) {
  const h = w.Hs[gi * w.NZ + gj], y = Math.floor((h - 0.001) / V);
  return { y, x: -w.half + gi * V + V / 2, z: -w.half + gj * V + V / 2, cy: y * V + V / 2 };
}

/**
 * Issue #12's third clause: the mesh has to follow an edit, and follow it on
 * exactly the chunks the edit reaches — which is more than the one it is in.
 */
export function carveSuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });
  const w = buildWorld({ seed: 'QUARTERSTONE', size: 64, force: null, ox: 0, oz: 0 });

  const before = meshAll(w);
  /* Somewhere in the middle of chunk 0,0, well away from any seam. */
  const gi = 60, gj = 60, t = topVoxel(w, gi, gj);
  const bite = carve(w, t.x, t.cy, t.z, {});
  const after = meshAll(w);

  let stillThere = 0;
  for (let q = 0; q < bite.removed.length; q += 3) {
    if (!isCut(w, bite.removed[q], bite.removed[q + 1], bite.removed[q + 2])) stillThere++;
  }
  say('a bite out of the ground takes voxels with it, and the chunk remeshes',
      bite.cut > 0 && stillThere === 0 && after['0,0'] !== before['0,0'],
      `${bite.cut} voxels removed, chunk 0,0 remeshed`);

  const moved = Object.keys(after).filter((k) => after[k] !== before[k]);
  const claimed = new Set(bite.chunks.map(([a, b]) => a + ',' + b));
  say('and nothing outside the chunks it named moved',
      moved.length > 0 && moved.every((k) => claimed.has(k)),
      `${moved.length} chunk(s) changed: ${moved.join(' ')}; ${claimed.size} claimed`);

  say('and putting the edits back gives the mesh the generator made',
      (clearEdits(w) === bite.cut) && meshAll(w)['0,0'] === before['0,0'],
      `${bite.cut} edits cleared`);

  /* A carve one voxel from a chunk edge changes the *neighbour's* occlusion,
     because the mesher reads a one-voxel ring past its own boundary to shade
     the seam. Claiming only the chunk the voxel is in leaves a bright crease
     along the join, and this is the case that catches it. */
  const side = Math.round(32 / V), gs = side - 1;
  const t2 = topVoxel(w, gs, 60);
  const edge = carve(w, t2.x, t2.cy, t2.z, { radius: 0.1 });
  const seamAfter = meshAll(w);
  const seamMoved = Object.keys(seamAfter).filter((k) => seamAfter[k] !== before[k]);
  const seamClaimed = new Set(edge.chunks.map(([a, b]) => a + ',' + b));
  say('and a carve on a chunk edge restitches the chunk beside it',
      edge.cut > 0 && seamMoved.includes('1,0')
      && seamMoved.every((k) => seamClaimed.has(k)),
      `${edge.cut} voxel(s) at the seam; ${seamMoved.join(' ')} changed`);
  clearEdits(w);

  /* What comes away is the material's business, not the swing's. */
  const wa = buildWorld({ seed: 'CINDERWAKE', size: 64, force: 4, ox: 0, oz: 0 });
  let bi = -1, bj = -1;
  for (let a = 8; a < wa.NX - 8 && bi < 0; a++) {
    for (let b = 8; b < wa.NZ - 8; b++) {
      const tv = topVoxel(wa, a, b);
      if (MATERIALS[surfaceAt(wa, a, b, tv.y).mat].hard > 1) { bi = a; bj = b; break; }
    }
  }
  const tb = bi < 0 ? null : topVoxel(wa, bi, bj);
  const weak = tb && carve(wa, tb.x, tb.cy, tb.z, { radius: 0.1 });
  const strong = tb && carve(wa, tb.x, tb.cy, tb.z, { radius: 0.1, bite: 1.5 });
  say('and basalt holds against one bite but not against a harder one',
      !!tb && weak.cut === 0 && !!weak.held && weak.held.hard > 1 && strong.cut > 0,
      tb ? `${weak.held ? weak.held.nm : 'nothing'} held at ${bi},${bj}; ${strong.cut} voxel(s) at bite 1.5`
         : 'no hard surface found in the ashfall seed');

  return out;
}

/* --------------------------------------------------------------- foliage ---- */

/**
 * Issue #46: a leaf is not a wall.
 *
 * The material table has said so since #14 — `leaf` has the lowest hardness of
 * anything that exists — and until now nothing read it for collision, so the
 * one place the distinction was written down was the one place it did not
 * apply.
 *
 * **Asking "is this voxel's space solid" does not work**, and the first version
 * of this suite did exactly that and reported 12,259 of 121,159 foliage voxels
 * still solid. A canopy voxel sharing a 25 cm column with the trunk it grows
 * out of answers yes however soft the leaf is. The space is solid; the leaf is
 * not what makes it solid, and the probe cannot tell those apart.
 *
 * The claim is about what the collider is *built from*, so that is what is
 * compared: a collider for the world against a collider for the same world
 * with every soft prop voxel deleted. Identical means foliage contributes
 * nothing. Nothing weaker is the actual statement.
 */
export function foliageSuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });

  /** The same world with the soft prop voxels taken out of its voxel arrays. */
  function withoutSoft(w) {
    const ps = w.propStart === undefined ? w.pos.length / 3 : w.propStart;
    const pos = [], mat = [];
    let cut = 0;
    for (let q = 0; q < w.pos.length / 3; q++) {
      if (q >= ps && (w.mat[q] === MAT.LEAF || w.mat[q] === MAT.SNOW)) { cut++; continue; }
      pos.push(w.pos[q * 3], w.pos[q * 3 + 1], w.pos[q * 3 + 2]);
      mat.push(w.mat[q]);
    }
    return { world: Object.assign({}, w, { pos, mat, propStart: pos.length / 3 }), cut };
  }

  /** Every column's spans, as one comparable string. */
  function spanSig(col) {
    const rows = [];
    for (let i = 0; i < col.n; i++) {
      for (let j = 0; j < col.n; j++) {
        const x = -col.half + (i + 0.5) * col.v, z = -col.half + (j + 0.5) * col.v;
        const sp = col.spansAt(x, z);
        if (sp && sp.length) rows.push(i + ':' + j + ':' + sp.map((r) => r[0] + '-' + r[1]).join(','));
      }
    }
    return rows.join('|');
  }

  let same = 0, cutAll = 0, seeds = 0;
  let groundSnowLost = 0, woodLost = 0;
  for (const s of GOLDEN_SEEDS) {
    const w = buildWorld({ seed: s.seed, size: s.size, force: s.force, ox: s.ox, oz: s.oz });
    const stripped = withoutSoft(w);
    cutAll += stripped.cut; seeds++;
    if (spanSig(colliderForWorld(w)) === spanSig(colliderForWorld(stripped.world))) same++;

    /* The other direction, which is the one that matters more: "soft" must not
       have eaten anything the world is made of. Probed per voxel, which is
       sound here because a *missing* span cannot be supplied by a neighbour. */
    const col = colliderForWorld(w);
    const ps = w.propStart === undefined ? w.pos.length / 3 : w.propStart;
    for (let q = 0; q < w.pos.length / 3; q++) {
      const prop = q >= ps, m = w.mat[q];
      if (!((!prop && m === MAT.SNOW) || (prop && m === MAT.WOOD))) continue;
      const x = w.pos[q * 3], y = w.pos[q * 3 + 1], z = w.pos[q * 3 + 2];
      if (col.overlaps(x, z, V / 4, y - V / 4, y + V / 4)) continue;
      if (prop) woodLost++; else groundSnowLost++;
    }
  }
  say('foliage contributes nothing to collision, on every seed',
      same === seeds && cutAll > 1000,
      `${same}/${seeds} seeds identical to a collider built without them, `
      + `${cutAll} soft prop voxels skipped`);
  say('and settled snow is still ground', groundSnowLost === 0,
      groundSnowLost ? `${groundSnowLost} ground snow voxels went missing` : 'none lost');
  say('and a trunk is still a trunk', woodLost === 0,
      woodLost ? `${woodLost} prop wood voxels went missing` : 'none lost');
  return out;
}

/* ----------------------------------------------------------------- trail ---- */

/**
 * Issue #45: every metre of routed trail has room for a body.
 *
 * Stating this correctly took five attempts, and four of them passed while
 * establishing nothing. They are worth listing, because each failed in a way
 * the next one could not see:
 *
 *   1. `placeOnGround` + `embedded` — zero everywhere. supportUnder takes the
 *      highest thing within the body's radius, so a shoulder beside the path
 *      quietly becomes the floor and nothing is ever embedded.
 *   2. A body box at `Hs` — 44% blocked, mostly by the trail's own surface. A
 *      25 cm lip is a step the controller climbs, not a wall.
 *   3. The same with the support ceiling capped — zero again, and vacuous: the
 *      trail's own surface is always support, so the answer is always yes.
 *   4. Clearance above any span top — saw a bridge as a wall, because it
 *      measured from the ground *under* the deck the trail runs over.
 *
 * What it is now: somewhere in the metre-cell, a body fits standing on some
 * level it could get onto — the ground the trail runs over, or a deck carried
 * over it — with a step's tolerance for the lip in the next column.
 *
 * And because four versions of this were blind, the suite proves it is not:
 * it plants a slab across one metre of trail and requires the check to find it.
 * A measurement that cannot fail is not evidence, and this one has to show its
 * teeth on every run.
 */
export function trailSuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });

  /** Can a body stand anywhere in this column, on a level reachable from `surf`? */
  function fits(col, x, z, surf) {
    const sp = col.spansAt(x, z);
    if (!sp) return false;
    for (let q = 0; q < sp.length; q++) {
      const top = sp[q][1];
      /* A cave floor six metres down has headroom and is not this trail; the
         top of a wall across the trail has headroom and standing on it is not
         walking down the path. MOVE.climb2 is the highest the controller
         climbs (a double jump, #73), and a deck bridge sits inside it — fen's
         is 1.38 m up. */
      if (top > CEIL || top < surf - 0.5 || top > surf + MOVE.climb2) continue;
      if (!col.overlaps(x, z, ACTOR.radius, top + MOVE.step, top + ACTOR.height - EPS)) return true;
    }
    return false;
  }

  function blocked(w, col) {
    const NZ = w.NZ, side = Math.round(1 / V), seen = new Set(), where = [];
    let cells = 0;
    for (let gi = 0; gi < w.NX; gi++) for (let gj = 0; gj < NZ; gj++) {
      if (!(w.FLG[gi * NZ + gj] & 4)) continue;
      const ci = (gi / side) | 0, cj = (gj / side) | 0, k = ci * 4096 + cj;
      if (seen.has(k)) continue;
      seen.add(k); cells++;
      let ok = false;
      for (let a = 0; a < side && !ok; a++) for (let b = 0; b < side && !ok; b++) {
        const ii = ci * side + a, jj = cj * side + b;
        if (ii >= w.NX || jj >= NZ || !(w.FLG[ii * NZ + jj] & 4)) continue;
        if (fits(col, -w.half + ii * V + V / 2, -w.half + jj * V + V / 2, w.Hs[ii * NZ + jj])) ok = true;
      }
      if (!ok) where.push(ci + ',' + cj);
    }
    return { cells, where };
  }

  let total = 0, bad = [];
  let first = null;
  for (const s of GOLDEN_SEEDS) {
    const w = buildWorld({ seed: s.seed, size: s.size, force: s.force, ox: s.ox, oz: s.oz });
    const r = blocked(w, colliderForWorld(w));
    total += r.cells;
    for (const p of r.where) bad.push(s.nm + ' ' + p);
    if (!first) first = w;
  }
  say('a body can walk every metre of routed trail',
      bad.length === 0,
      bad.length ? `${bad.length} of ${total} metre-cells blocked: ${bad.slice(0, 5).join(', ')}`
                 : `${total} metre-cells across six seeds, all passable`);

  /* The self-test. Four earlier versions of the measurement above reported zero
     because they could not see anything, and zero is what a working one reports
     too. Plant a wall; if the check still says the trail is clear, the check is
     the thing that is broken. */
  const NZ = first.NZ, side = Math.round(1 / V);
  let ci = -1, cj = -1;
  outer: for (let gi = 0; gi < first.NX; gi++) for (let gj = 0; gj < NZ; gj++) {
    if (first.FLG[gi * NZ + gj] & 4) { ci = (gi / side) | 0; cj = (gj / side) | 0; break outer; }
  }
  for (let a = 0; a < side; a++) for (let b = 0; b < side; b++) {
    const ii = ci * side + a, jj = cj * side + b;
    const x = -first.half + ii * V + V / 2, z = -first.half + jj * V + V / 2;
    const h = first.Hs[ii * NZ + jj];
    for (let y = h + 0.5; y < h + 2.5; y += V) {
      first.pos.push(x, y, z); first.mat.push(MAT.WOOD); first.pal.push(0); first.shd.push(128);
    }
  }
  const walled = blocked(first, colliderForWorld(first));
  say('and the check can see a wall when there is one',
      walled.where.length === 1 && walled.where[0] === ci + ',' + cj,
      walled.where.length ? `slab over ${ci},${cj} found at ${walled.where.join(' ')}`
                          : `SLAB OVER ${ci},${cj} NOT SEEN — the check is blind`);
  return out;
}

/* ----------------------------------------------------------------- chunk ---- */

/**
 * Issue #13: a chunk generated alone is the same ground its neighbour thinks
 * is there.
 *
 * Streaming needs every chunk generated at any time, in any order, on any
 * thread, and the seams to disappear. Two facts decide whether that is
 * possible, and the second one was not recorded anywhere before this:
 *
 *   - same-size windows at different offsets agree (the #41 skirt result);
 *   - **windows of different sizes do not.** 32 m against 64 m on the same
 *     centre disagree on 87% of what they share, 15.75 m deep.
 *
 * So these assert the rule rather than the hope: every window is `WINDOW`
 * metres, chunks differ by offset alone, and neighbours are identical on every
 * cell they share.
 */
export function chunkSuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });

  /* Absolute voxel index -> value, for the arrays a seam would show up in. */
  function sheet(w) {
    const m = new Map(), vx0 = Math.round(w.OX / V), vz0 = Math.round(w.OZ / V);
    for (let i = 0; i < w.NX; i++) {
      for (let j = 0; j < w.NZ; j++) {
        const k = i * w.NZ + j;
        m.set((i + vx0) + ':' + (j + vz0), w.Hs[k] + '|' + w.FLG[k]);
      }
    }
    return m;
  }

  /* How far a neighbour's window must reach into this chunk. The mesher shades
     a seam by reading one voxel past its own edge (src/mesh/greedy.mjs, pad 1),
     so anything less than that and a chunk cannot be meshed without its
     neighbour being loaded too. SKIRT is 4 m, which is margin over this by a
     factor of sixteen — the margin is deliberate and is not derived from
     anything, which is why the requirement is written down separately from it. */
  const NEED = V;
  let minReach = Infinity;
  let shared = 0, differ = 0, worstRim = -1, pairs = 0;
  for (const s of GOLDEN_SEEDS) {
    const a = chunkWorld(s.seed, 0, 0, s.force);
    const A = sheet(a), avx = Math.round(a.OX / V), avz = Math.round(a.OZ / V);
    for (const [cx, cz] of [[1, 0], [0, 1], [1, 1], [-1, 0], [-1, -1]]) {
      const b = chunkWorld(s.seed, cx, cz, s.force);
      const B = sheet(b), bvx = Math.round(b.OX / V), bvz = Math.round(b.OZ / V);
      pairs++;
      /* How far B's window reaches into A's chunk proper, in metres. */
      const pad = Math.round(SKIRT / V);
      let reach = 0;
      for (let i = pad; i < a.NX - pad; i++) {
        for (let j = pad; j < a.NZ - pad; j++) {
          if (!B.has((i + avx) + ':' + (j + avz))) continue;
          const into = Math.min(i - pad, a.NX - pad - 1 - i, j - pad, a.NZ - pad - 1 - j);
          if ((into + 1) * V > reach) reach = (into + 1) * V;
        }
      }
      if (reach < minReach) minReach = reach;

      for (const [k, v] of A) {
        if (!B.has(k)) continue;
        shared++;
        if (B.get(k) === v) continue;
        differ++;
        const [i, j] = k.split(':').map(Number);
        const rim = Math.min(
          Math.min(i - avx, a.NX - 1 - (i - avx), j - avz, a.NZ - 1 - (j - avz)),
          Math.min(i - bvx, b.NX - 1 - (i - bvx), j - bvz, b.NZ - 1 - (j - bvz))) * V;
        if (rim > worstRim) worstRim = rim;
      }
    }
  }
  /* `shared > 0` is not a formality. With SKIRT at 0 the windows touch without
     overlapping, nothing is compared, and both this and the reach check below
     would pass on an empty set — the same vacuity that cost four attempts at
     the trail measurement. */
  say('a chunk and its neighbour agree on every cell they share',
      differ === 0 && shared > 0,
      differ ? `${differ} of ${shared} cells differ over ${pairs} pairs, deepest ${worstRim.toFixed(2)} m from a rim`
             : (shared ? `${shared} shared cells over ${pairs} neighbour pairs, six seeds, identical`
                       : 'NOTHING WAS COMPARED — the windows do not overlap'));

  /* Agreement alone does not say the skirt is wide enough: a thinner skirt
     shares less ground and agrees just as well on the little it shares. Cutting
     SKIRT from 4 m to 1 m leaves the check above perfectly green, which is why
     this one exists — what must hold is that a neighbour reaches far enough
     into this chunk to shade its seam. */
  const reached = Number.isFinite(minReach) ? minReach : 0;
  say('and a neighbour reaches far enough in to shade the seam',
      reached >= NEED,
      `a neighbour's window reaches ${reached.toFixed(2)} m into this chunk, `
      + `the mesher needs ${NEED.toFixed(2)} m`);

  /* The rule that makes the above true, asserted rather than assumed. If the
     generator ever becomes size-invariant this check is the one that should be
     deleted on purpose — until then, a chunk cut from a differently sized
     window is a different world and nothing else here holds. */
  const w40 = buildWorld({ seed: 'QUARTERSTONE', size: WINDOW, force: null, ox: 0, oz: 0 });
  const w64 = buildWorld({ seed: 'QUARTERSTONE', size: 64, force: null, ox: 0, oz: 0 });
  const S40 = sheet(w40), S64 = sheet(w64);
  let n = 0, d = 0;
  for (const [k, v] of S40) { if (!S64.has(k)) continue; n++; if (S64.get(k) !== v) d++; }
  say('and the generator is size-dependent, which is why every window is one size',
      d > n * 0.5,
      `${WINDOW} m against 64 m on one centre: ${d} of ${n} shared cells differ `
      + `(${(100 * d / n).toFixed(0)}%) — chunks may differ by offset and nothing else`);

  /* The skirt has to be wide enough that the chunk proper is never in it. */
  const w = chunkWorld('QUARTERSTONE', 0, 0, null);
  const pad = Math.round(SKIRT / (2 * w.half / w.NX));
  const side = w.NX - 2 * pad;
  say('and the chunk inside the skirt is exactly one chunk across',
      side * (2 * w.half / w.NX) === CHUNK_M,
      `${w.NX} cells of window, ${pad} of skirt a side, ${side} of chunk `
      + `= ${(side * (2 * w.half / w.NX)).toFixed(0)} m against CHUNK ${CHUNK_M}`);
  return out;
}

/**
 * Issue #13: the loaded chunks answer as one world.
 *
 * `colliderForWorld` builds one bounded grid whose edge is a wall. A chunk's
 * edge is where the ground continues, so each chunk keeps its own unwalled
 * collider and `makeChunkField` routes a query to every chunk its footprint
 * touches. These hold that the stitching is faithful and that the seams are not
 * visible from inside the simulation.
 */
export function fieldSuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });
  const R = ACTOR.radius;

  /* Faithfulness: well inside a chunk, the field must answer exactly what the
     ordinary collider on that chunk's own window answers. Sampled a metre in
     from the chunk edge so neither that collider's wall nor the skirt is in
     the way — the seam itself is the next check's business. */
  let n = 0, bad = 0, worst = 0;
  for (const s of GOLDEN_SEEDS.slice(0, 3)) {
    const f = makeChunkField(s.seed, s.force);
    f.keep([{ x: 0, z: 0 }], 1);
    for (const [cx, cz] of [[0, 0], [1, 0], [0, 1], [-1, -1]]) {
      const w = chunkWorld(s.seed, cx, cz, s.force);
      const one = colliderForWorld(w);
      const c0x = cx * CHUNK_M, c0z = cz * CHUNK_M;
      for (let a = -14; a <= 14; a += 2) {
        for (let b = -14; b <= 14; b += 2) {
          const x = c0x + a, z = c0z + b;
          n++;
          const gf = f.supportUnder(x, z, R, Infinity);
          const g1 = one.supportUnder(a, b, R, Infinity);
          if (Math.abs(gf - g1) > 1e-9) { bad++; worst = Math.max(worst, Math.abs(gf - g1)); }
        }
      }
    }
  }
  say('the field answers what the ordinary collider answers, inside a chunk',
      bad === 0 && n > 500,
      bad ? `${bad} of ${n} sample points differ, worst ${worst.toFixed(3)} m`
          : `${n} points over four chunks and three seeds, identical`);

  /* The seam. The first version of this forbade any step over MOVE.step across
     a boundary, which is not a property of a seam at all — a 3.63 m cliff that
     happens to lie on a chunk edge is a cliff, and the check called it a break.
     What has to hold is that the field says the same thing across the seam as a
     single window does over the same ground, cliffs included. Sampled every
     12.5 cm through each boundary of the centre chunk; the window's own wall is
     4 m further out and never in reach of a 0.35 m footprint. */
  const f = makeChunkField('QUARTERSTONE', null);
  f.keep([{ x: 0, z: 0 }], 1);
  const one = colliderForWorld(chunkWorld('QUARTERSTONE', 0, 0, null));
  let holes = 0, differ = 0, crossed = 0, worstSeam = 0;
  for (const along of [-12, -6, 0, 6, 12]) {
    for (const edge of [CHUNK_M / 2, -CHUNK_M / 2]) {
      for (const axis of [0, 1]) {
        for (let d = -1; d <= 1.0001; d += 0.125) {
          const x = axis ? along : edge + d, z = axis ? edge + d : along;
          const gf = f.supportUnder(x, z, R, Infinity);
          const g1 = one.supportUnder(x, z, R, Infinity);
          crossed++;
          if (!Number.isFinite(gf)) { holes++; continue; }
          if (Math.abs(gf - g1) > 1e-9) { differ++; worstSeam = Math.max(worstSeam, Math.abs(gf - g1)); }
        }
      }
    }
  }
  say('and a chunk boundary is not visible from inside the simulation',
      holes === 0 && differ === 0,
      holes || differ
        ? `${holes} holes and ${differ} disagreements of ${crossed} samples, worst ${worstSeam.toFixed(2)} m`
        : `${crossed} samples through every boundary of a chunk, identical to one window over the same ground`);

  /* Unloaded ground is a wall, not a hole. A body may not walk into ground
     nothing has decided yet; the load radius is what stops it ever meeting
     this, and meeting it should read as a wall rather than a fall. */
  const far = { x: 40 * CHUNK_M, z: 0 };
  say('and ground that is not loaded is a wall rather than a hole',
      f.overlaps(far.x, far.z, R, 0, 2) === true
      && f.supportUnder(far.x, far.z, R, Infinity) === -Infinity,
      'a footprint in an unloaded chunk is solid, and offers no support to stand on');

  /* Streaming proper: what is loaded follows the centres, and two players far
     apart cost two radii rather than the ground between them. */
  const g = makeChunkField('QUARTERSTONE', null);
  const oneCentre = g.keep([{ x: 0, z: 0 }], 1);
  const moved = g.keep([{ x: 8 * CHUNK_M, z: 0 }], 1);
  const twoApart = g.keep([{ x: 0, z: 0 }, { x: 8 * CHUNK_M, z: 0 }], 1);
  say('and what is loaded follows the players, and two of them cost two radii',
      oneCentre === 9 && moved === 9 && twoApart === 18 && g.dropped >= 9,
      `one centre ${oneCentre} chunks, moved eight chunks away ${moved} (not ${oneCentre + 9}), `
      + `two centres ${twoApart}, ${g.dropped} let go`);

  /* The issue's own bar: walk across several chunks. The wanderer from the soak
     drives it, over the field rather than one window, with the load radius
     following it — which is the whole arrangement working at once. */
  const wf = makeChunkField('QUARTERSTONE', null);
  wf.keep([{ x: 0, z: 0 }], 1);
  const wa = placeOnGround(wf, 0, 0);
  const rnd = mulberry32(xmur3('chunkwalk')());
  let hx = 1, hz = 0, hold = 0, inside = 0, minY = wa.y, seen = new Set(), fell = false;
  for (let t = 0; t < SOAK_TICKS; t++) {
    if (--hold <= 0) { const ang = rnd() * 6.283185307179586; hx = cos(ang); hz = sin(ang); hold = 60 + ((rnd() * 120) | 0); }
    else if (wa.blocked) { const ang = 2.094 + rnd() * 2.094; const c2 = cos(ang), s2 = sin(ang);
      const nx = hx * c2 - hz * s2; hz = hx * s2 + hz * c2; hx = nx; hold = 40; }
    step(wf, wa, { mx: hx, mz: hz, jump: false });
    wf.keep([{ x: wa.x, z: wa.z }], 1);
    const c = chunkAt(wa.x, wa.z);
    seen.add(c.cx + ',' + c.cz);
    if (embedded(wf, wa)) inside++;
    if (wa.y < minY) minY = wa.y;
    if (wa.y < -2) fell = true;
  }
  say('and a body walks across several chunks without falling through or sticking',
      seen.size >= 3 && !fell && inside === 0,
      `${seen.size} chunks visited in five minutes, ${inside} ticks inside the ground, `
      + `lowest y ${minY.toFixed(2)}, ${wf.built} chunks built and ${wf.dropped} let go`);

  /* ---- the sample grid that found nothing, and the one that did ----

     The check above walks a chunk on two-metre steps and reports 2,700 points
     identical, and it was identical, and it was not enough. A box's footprint
     is decided by which columns `x - r` and `x + r` fall in, and on that grid
     those edges never land *on* a column boundary — so the one case where two
     colliders can disagree was never generated.

     They can disagree because the column index was `floor((p + half) / v)`,
     which depends on `half`: a chunk collider's 16 and a window collider's 20
     round `p + half` to different doubles, and when `p` sits exactly on a
     boundary the two land on opposite sides of it. One column of footprint,
     and it cost a body the support under its foot.

     So this samples the positions that produce it on purpose: `m * V - r`,
     where the near edge of the box lands exactly on a column line. */
  {
    let n2 = 0, bad2 = 0, worst2 = 0, at = null;
    for (const s of GOLDEN_SEEDS.slice(0, 3)) {
      const g2 = makeChunkField(s.seed, s.force);
      g2.keep([{ x: 0, z: 0 }], 1);
      for (const [cx, cz] of [[0, 0], [1, -1]]) {
        const w = chunkWorld(s.seed, cx, cz, s.force);
        /* Placed in the world, so both sides are asked about the *same world
           coordinate*. Reconstructing a local one from it is a different real
           number once doubles are involved, and a check that does the
           conversion measures its own arithmetic as much as the code's. */
        const at0 = { x: cx * CHUNK_M, z: cz * CHUNK_M };
        const one = colliderForWorld(w, at0);
        for (let m = -56; m <= 56; m += 3) {
          for (const dx of [-R, R]) {
            for (const dz of [-R, R]) {
              const a = m * V - dx, b = (m % 37) * V - dz;
              if (Math.abs(a) > 15 || Math.abs(b) > 15) continue;
              const x = at0.x + a, z = at0.z + b;
              n2++;
              const d = Math.abs(g2.supportUnder(x, z, R, Infinity)
                              - one.supportUnder(x, z, R, Infinity));
              if (d > 1e-9) { bad2++; if (d > worst2) { worst2 = d; at = [a, b]; } }
            }
          }
        }
      }
    }
    say('and it still answers it where the box edge lands exactly on a column line',
        bad2 === 0,
        bad2 ? `${bad2} of ${n2} differ, worst ${worst2.toFixed(3)} m at `
               + `${at[0].toFixed(3)}, ${at[1].toFixed(3)}`
             : `${n2} points whose footprint edge falls on a column boundary, identical`);
  }

  /* And a chunk let go and loaded again is the same chunk. */
  const before = g.supportUnder(0, 0, R, Infinity);
  g.keep([{ x: 40 * CHUNK_M, z: 0 }], 1);
  g.keep([{ x: 0, z: 0 }], 1);
  say('and a chunk dropped and loaded again is the same ground',
      g.supportUnder(0, 0, R, Infinity) === before,
      `support at the origin ${before.toFixed(2)} m before, ${g.supportUnder(0, 0, R, Infinity).toFixed(2)} m after`);

  /* #64: a worker builds a chunk's collider and hands it over packed. After a
     structured clone — which is what postMessage does to it — the unpacked
     collider must answer every query exactly as the one that was built. */
  {
    const s0 = GOLDEN_SEEDS[0], w = chunkWorld(s0.seed, 1, -1, s0.force);
    const built = colliderForChunk(w, 1, -1);
    const back = colliderFromPacked(structuredClone(built.pack()));
    let q = 0, diff = 0;
    const c0x = CHUNK_M, c0z = -CHUNK_M;
    for (let a = -16; a < 16; a += 0.37) {
      for (let b = -16; b < 16; b += 0.41) {
        const x = c0x + a, z = c0z + b; q++;
        const y = back.supportUnder(x, z, 0.3, Infinity);
        if (y !== built.supportUnder(x, z, 0.3, Infinity)
            || back.ceilingOver(x, z, 0.3, y) !== built.ceilingOver(x, z, 0.3, y)
            || back.overlaps(x, z, 0.3, y - 1, y + 0.5) !== built.overlaps(x, z, 0.3, y - 1, y + 0.5)
            || back.liquidAt(x, z).level !== built.liquidAt(x, z).level) diff++;
      }
    }
    const p = built.pack();
    say('and a collider built in a worker answers what the one built here does',
        q > 5000 && diff === 0,
        `${q} points, ${diff} different after a structured clone; ${p.sp.length / 2} spans in `
        + `${(p.sp.byteLength + p.off.byteLength + p.liq.byteLength + p.lev.byteLength) / 1024 | 0} KB of transferable arrays`);
  }
  return out;
}

/**
 * The scheduler — issue #13, step three.
 *
 * ## The measurement this exists to make, and why it is not a timing assertion
 *
 * The question #13 poses is "a frame budget that holds while chunks arrive".
 * The answer turns out to be settled before any scheduling: **one chunk does
 * not fit in a frame**, by a factor of three at the best case measured and
 * twenty-five at the worst. So the first check here times real generation and
 * asserts the *inequality*, with a margin big enough that it is a statement
 * about the generator rather than about how busy the machine is. A bar of
 * "faster than X ms" would be a flake; "a 40 m window costs more than a 16.7 ms
 * frame" has never been close.
 *
 * ## Why the soak uses a stub field
 *
 * Whether the loader keeps up with a running body is a question about geometry
 * and arrival times, not about terrain: the answer does not depend on what is
 * in the chunk, only on when it shows up. Generating two hundred real windows
 * to ask it would add a minute to the node half and measure nothing extra. So
 * the soak drives a stub of the four methods the stream uses, on a timeline
 * where **every chunk is charged the slowest one measured** — not the median,
 * so the result is a worst case rather than an average.
 *
 * That the stream drives a *real* field to the right state is a separate check
 * below, against `keep`, which is the path the FIELD suite already pins.
 */
export function streamSuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });
  const FRAME = 1000 / 60;

  /* ---- what a chunk costs ----
     Cold, and deliberately. `regionAt` caches per 64 m region, so a chunk
     generated next to one the gate has already made is several times cheaper
     than one arriving in ground nobody has been to — and the first version of
     this check timed whatever the suites above happened to leave warm. It
     passed alone and failed inside the gate, which is the only kind of timing
     assertion worth having and the only kind worth being embarrassed by.

     Streaming's cost is the cold one: a chunk arrives because someone walked
     somewhere new. So the cache is cleared before each, and the chunks are far
     enough apart to be in different regions anyway. */
  const costs = [];
  for (let i = 0; i < 4; i++) chunkWorld('warm', i * 4, 0);        /* warm the jit */
  for (let i = 0; i < 8; i++) {
    clearRegionCache();
    const t0 = performance.now();
    chunkWorld('stream-cost-probe', i * 4, i * 4);
    costs.push(performance.now() - t0);
  }
  clearRegionCache();
  costs.sort((a, b) => a - b);
  const median = costs[costs.length >> 1], slowest = costs[costs.length - 1];
  say('one chunk does not fit in a frame, which is why generation leaves the main thread',
      costs[0] > FRAME * 2,
      `${costs.length} cold windows: fastest ${costs[0].toFixed(0)} ms, median ${median.toFixed(0)} ms, `
      + `slowest ${slowest.toFixed(0)} ms, against a ${FRAME.toFixed(1)} ms frame`);

  /* And the shape of that: a pump given a frame's budget cannot spend less than
     a chunk, so it reports the overrun rather than pretending to have obeyed. */
  {
    const f = makeChunkField('hero');
    const st = makeStream(f, { loadR: 1, keepR: 2, flight: 2 });
    st.want([{ x: 0, z: 0 }]);
    clearRegionCache();
    const r = st.pump((cx, cz) => chunkWorld('hero', cx, cz), FRAME);
    say('and a pump asked for a frame builds one chunk and says how far over it went',
        r.built === 1 && r.over > 0,
        `built ${r.built} in ${r.ms.toFixed(0)} ms, ${r.over.toFixed(0)} ms over a frame `
        + `— ${(r.ms / FRAME).toFixed(1)} frames for one chunk`);
  }

  /* ---- ordering: the ground under your feet before the ground at the rim ---- */
  {
    const seen = [];
    const stub = stubField(seen);
    const st = makeStream(stub, { loadR: 3, keepR: 4, flight: 64 });
    st.want([{ x: 0, z: 0 }]);
    const order = [];
    for (;;) { const j = st.next(); if (!j) break; order.push(j); stub.adopt(j.cx, j.cz, 1); }
    let sorted = true, prev = -1;
    for (const j of order) {
      const d2 = j.cx * j.cx + j.cz * j.cz;
      if (d2 < prev) sorted = false;
      prev = Math.max(prev, d2);
    }
    say('and the nearest missing chunk is always the next one built',
        sorted && order.length === 49 && order[0].cx === 0 && order[0].cz === 0,
        `${order.length} chunks handed out at radius 3, nearest first, starting at the centre`);
  }

  /* ---- the cap on work in flight ---- */
  {
    const stub = stubField([]);
    const st = makeStream(stub, { loadR: 3, keepR: 4, flight: 2 });
    st.want([{ x: 0, z: 0 }]);
    let handed = 0;
    for (let i = 0; i < 10; i++) if (st.next()) handed++;
    say('and no more work is in flight than the pool can take',
        handed === 2 && st.inFlight === 2,
        `asked ten times with a pool of two, handed out ${handed}`);
  }

  /* ---- hysteresis, with the control that makes it mean something ---- */
  {
    /* A body pacing across one chunk boundary: twenty steps back and forth over
       the seam at x = 16. With one radius this drops and rebuilds a column every
       crossing; with two it does nothing after the first. */
    const pace = (loadR, keepR) => {
      const stub = stubField([]);
      const st = makeStream(stub, { loadR, keepR, flight: 64 });
      let built = 0;
      for (let i = 0; i < 20; i++) {
        st.want([{ x: i % 2 ? 17 : 15, z: 0 }]);
        for (;;) { const j = st.next(); if (!j) break; stub.adopt(j.cx, j.cz, 1); built++; }
      }
      return built;
    };
    const tight = pace(1, 1), loose = pace(1, 2);
    say('and a body pacing over a chunk boundary does not rebuild the world each step',
        loose < tight / 3 && tight > 20,
        `20 crossings: ${loose} chunks built with a keep radius one wider, ${tight} without`);
  }

  /* ---- the stream settles on exactly what keep() holds ---- */
  {
    const a = makeChunkField('fen'), b = makeChunkField('fen');
    const st = makeStream(a, { loadR: 1, keepR: 2, flight: 2 });
    st.want([{ x: 5, z: -40 }]);
    let guard = 0;
    while (!st.settled && guard++ < 200) st.pump((cx, cz) => chunkWorld('fen', cx, cz), FRAME);
    b.keep([{ x: 5, z: -40 }], 1);
    const la = a.live().map((e) => e.cx + ',' + e.cz).sort().join(' ');
    const lb = b.live().map((e) => e.cx + ',' + e.cz).sort().join(' ');
    const same = la === lb && a.supportUnder(5, -40, ACTOR.radius, Infinity)
                           === b.supportUnder(5, -40, ACTOR.radius, Infinity);
    say('and what the scheduler settles on is what the synchronous path holds',
        same && a.loaded === 9,
        `${a.loaded} chunks either way, same ids, same ground underfoot`);
  }

  /* ---- does a running body outrun the loader? ---- */
  {
    const run = (workers, cost) => {
      const stub = stubField([]);
      const st = makeStream(stub, { loadR: 1, keepR: 2, flight: workers });
      const busy = new Array(workers).fill(null);       /* {cx, cz, due} */
      let t = 0, x = 0, margin = Infinity, blocked = 0;
      /* Spawn with the world already there. A game shows a loading screen for
         this; counting it as outrunning the loader would mean every run failed
         on its first tick for having nothing loaded yet, which is not the
         question. The question starts once the body is standing somewhere. */
      st.want([{ x: 0, z: 0 }]);
      for (;;) { const j = st.next(); if (!j) break; st.deliver(j.cx, j.cz, 1); }
      for (let k = 0; k < SOAK_TICKS; k++) {
        t += TICK * 1000;
        x += RUN * TICK;
        st.want([{ x, z: 0 }]);
        for (let i = 0; i < workers; i++) {
          const w = busy[i];
          if (w && t >= w.due) { st.deliver(w.cx, w.cz, 1); busy[i] = null; }
        }
        for (let i = 0; i < workers; i++) {
          if (busy[i]) continue;
          const j = st.next();
          if (!j) break;
          busy[i] = { cx: j.cx, cz: j.cz, due: t + cost };
        }
        /* How far ahead the decided ground reaches: the near edge of the first
           chunk in front that is not loaded. */
        const here = chunkAt(x, 0).cx;
        let cx = here;
        while (stub.has(cx, 0) && cx < here + 8) cx++;
        const front = (cx - 0.5) * CHUNK_M - x;
        if (front < margin) margin = front;
        if (front <= 0) blocked++;
      }
      return { margin, blocked, x };
    };
    /* Charge the slower of what was measured and 300 ms. Taking the larger only
       makes the case harder, and it keeps the positive check from getting
       easier on a fast machine — which is the direction a timing-derived bar
       fails silently in. The control's cost is fixed outright: its job is to
       show the check can fail, and that should not depend on the machine at
       all. */
    const charge = Math.max(slowest, 300);
    const good = run(2, charge);
    const starved = run(1, 3000);
    say('and a body at a full run never reaches ground that has not been decided',
        good.blocked === 0 && good.margin > CHUNK_M / 2,
        `five minutes and ${good.x.toFixed(0)} m at ${RUN} m/s, every chunk charged `
        + `${charge.toFixed(0)} ms on two workers: decided ground stayed `
        + `${good.margin.toFixed(1)} m ahead at the closest`);
    say('and the same check fails when the loader cannot keep up, which is how it is known to ask anything',
        starved.blocked > 0,
        `one worker at 3 s a chunk: blocked on ${starved.blocked} of ${SOAK_TICKS} ticks, `
        + `front ${starved.margin.toFixed(1)} m`);
  }

  return out;
}

/** The four methods `makeStream` asks of a field, over a bare set of ids. */
function stubField(log) {
  const held = new Set();
  return {
    has: (cx, cz) => held.has(cx + ',' + cz),
    adopt(cx, cz) { held.add(cx + ',' + cz); log.push([cx, cz]); },
    drop(cx, cz) { return held.delete(cx + ',' + cz); },
    live() { return [...held].map((k) => { const [cx, cz] = k.split(',').map(Number); return { cx, cz }; }); },
  };
}

/**
 * Drawing a streamed world without a visible join — issue #13, step four.
 *
 * A chunk's window is 40 m and the chunk it owns is the middle 32 m. Two things
 * have to be true for that to be drawable, and neither is obvious:
 *
 * **The mesh must cover the chunk and not the window**, or every seam's
 * geometry goes in twice and the overlap z-fights.
 *
 * **Neither side may wall off the seam.** A greedy mesher emits a face wherever
 * solid meets air, and at the edge of what it can see everything is air — so a
 * chunk meshed in isolation is a 32 m cube with walls. The skirt is what stops
 * that: the mesher's AO ring reads one cell past the chunk, into ground the
 * window generated and does not keep, and since the neighbour's window agrees
 * with it voxel for voxel (the CHUNK checks) both sides make the same decision
 * about the same face.
 *
 * The second check is the one that matters, and it is stated as a contrast
 * rather than a threshold: the same mesher, on the same window, at a boundary
 * with a skirt behind it and at one with nothing behind it.
 */
export function seamSuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });

  /** Every 25 cm cell a mesh walls off on plane `p` of axis `ax`, facing `nx`. */
  function walled(m, ax, p, nx) {
    const cells = new Set();
    for (let q = 0; q < m.nor.length / 3; q += 4) {
      if (Math.abs(m.nor[q * 3 + ax] - nx) > 1e-6) continue;
      let c = 0;
      for (let k = 0; k < 4; k++) c += m.pos[(q + k) * 3 + ax];
      if (Math.abs(c / 4 - p) > 1e-6) continue;
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let k = 0; k < 4; k++) {
        for (let d = 0; d < 3; d++) {
          const v = m.pos[(q + k) * 3 + d];
          if (v < lo[d]) lo[d] = v;
          if (v > hi[d]) hi[d] = v;
        }
      }
      const u = ax === 0 ? 1 : 0, v2 = ax === 2 ? 1 : 2;
      for (let a = lo[u]; a < hi[u] - 1e-9; a += V) {
        for (let b = lo[v2]; b < hi[v2] - 1e-9; b += V) cells.add(a.toFixed(2) + ',' + b.toFixed(2));
      }
    }
    return cells;
  }

  const H = CHUNK_M / 2;
  const meshOwn = (w) => meshChunk(w, 0, 0, innerChunk(w));

  /* The mesh covers the chunk, not the window. */
  {
    const w = chunkWorld('hero', 0, 0);
    const m = meshOwn(w);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < m.pos.length; i += 3) {
      if (m.pos[i] < lo) lo = m.pos[i];
      if (m.pos[i] > hi) hi = m.pos[i];
    }
    say('a chunk draws the chunk it owns, not the window it was generated in',
        lo === -H && hi === H,
        `mesh spans ${lo.toFixed(2)} to ${hi.toFixed(2)} m of a ${w.size} m window — `
        + `the middle ${CHUNK_M} m`);
  }

  /* Neither side of a seam walls it off, and neither draws the other's faces. */
  {
    let pairs = 0, both = 0, emitted = 0;
    for (const s of GOLDEN_SEEDS.slice(0, 3)) {
      const mid = meshOwn(chunkWorld(s.seed, 0, 0, s.force));
      for (const [ax, dx, dz] of [[0, 1, 0], [0, -1, 0], [2, 0, 1], [2, 0, -1]]) {
        const nb = meshOwn(chunkWorld(s.seed, dx, dz, s.force));
        const sign = dx || dz;
        const mine = walled(mid, ax, sign * H, sign);
        const theirs = walled(nb, ax, -sign * H, -sign);
        pairs++;
        emitted += mine.size + theirs.size;
        for (const k of mine) if (theirs.has(k)) both++;
      }
    }
    say('and neither side of a seam draws a face the other also draws',
        both === 0,
        `${pairs} seams over three seeds, ${emitted} faces on them in all, ${both} drawn twice`);
  }

  /* The contrast that says what the skirt is for. */
  {
    let withSkirt = 0, without = 0;
    for (const s of GOLDEN_SEEDS.slice(0, 3)) {
      const w = chunkWorld(s.seed, 0, 0, s.force);
      withSkirt += walled(meshOwn(w), 0, -H, -1).size;
      /* The same mesher on the same window, addressed from the window's own
         corner instead: past that edge there is nothing to read, so everything
         beyond it is air and the chunk is meshed as a box. */
      without += walled(meshChunk(w, 0, 0), 0, -w.half, -1).size;
    }
    say('and the skirt is what keeps a chunk from being meshed as a closed box',
        without > withSkirt * 50 && withSkirt < 200,
        `-x boundary over three seeds: ${withSkirt} cells walled with a skirt behind it, `
        + `${without} with nothing behind it`);
  }

  return out;
}

/**
 * Props without the faces nobody can see — issue #51.
 *
 * The claim is narrow and worth stating exactly: **the same surfaces, minus
 * the ones inside solid**. Not a simplification, not a merge, not a re-light.
 * So the checks are about what is *kept*, not about how much is dropped —
 * dropping is easy and dropping too much is the failure mode.
 */
/**
 * GROUND: is the terrain undulated rather than noisy, and is a trail flatter
 * than the ground beside it? Issue #52.
 *
 * Three numbers, all read off the voxel height field every seed produces.
 *
 *   **lone columns** — a column strictly higher or strictly lower than all
 *   four of its neighbours. This is the single protruding voxel the issue is
 *   named for. Every one of them came from `detail`: 0.13% of columns with the
 *   old field, 0.00% with the macro field alone.
 *
 *   **direction reversals** — how often the ground changes from rising to
 *   falling along a line, per metre. This is what separates undulation from
 *   chatter, and it is the number that moved most: 0.45 before, which is a
 *   reversal every 2.2 m, against 0.02-0.07 for the macro field on its own.
 *
 *   **trail against its surroundings** — measured *locally*, against the
 *   non-trail ground within 2 m, not against the window. A trail climbing a
 *   canyon wall is rightly rougher than a flat mesa top a hundred metres away,
 *   so a window-wide comparison asks the wrong question and cannot be
 *   satisfied on mesa however well the route is graded.
 */
export function groundSuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });
  const D4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  /* A reversal every 6.7 m or less is chatter; the macro field manages 14 m and
     up. Set where it is because the measured spread across biomes is 0.06 to
     0.11 and mesa, the roughest, has to fit under it. */
  /* 0.16 since the ramps (#73): ordinary ground now climbs a 1 m cell step
     as four voxel columns, and where that meets a 2 m face the cells on
     either side disagree about which neighbour is a slope, so the stair
     turns back once more. Measured on ash, the roughest now, 0.151 against
     0.143 before; the noise this bar exists to catch was 0.4. */
  const FLIP_BAR = 0.16;
  /* Not zero, and the reason is worth keeping. The old field left 0.13% of
     columns standing alone — about 85 in a window. What is left is 0 to 3, and
     they are not attributable to `detail` at all: taking it out entirely
     *removes* them from mesa and frost and *adds* one to meadow. One column in
     65,536 is the floor of this measurement rather than a feature of the
     terrain. The bar is six times under the old value and four times over what
     is measured now, so it catches a regression that restores even a sixth of
     the noise without failing on a coin toss. */
  const LONE_BAR = 0.02;

  const rows = [];
  for (const s of GOLDEN_SEEDS) {
    const w = buildWorld({ seed: s.seed, size: s.size, force: s.force, ox: s.ox, oz: s.oz });
    const { Hs, FLG, NX, NZ } = w;
    const at = (i, j) => Hs[i * NZ + j];
    const onTrail = (i, j) => (FLG[i * NZ + j] & 4) !== 0;

    let lone = 0, cols = 0, flips = 0;
    for (let i = 1; i < NX - 1; i++) {
      for (let j = 1; j < NZ - 1; j++) {
        const h = at(i, j), a = at(i - 1, j), b = at(i + 1, j), c = at(i, j - 1), d = at(i, j + 1);
        cols++;
        if ((h > a && h > b && h > c && h > d) || (h < a && h < b && h < c && h < d)) lone++;
      }
    }
    for (let j = 0; j < NZ; j++) {
      let prev = 0;
      for (let i = 1; i < NX; i++) {
        const d = Math.sign(at(i, j) - at(i - 1, j));
        if (d === 0) continue;
        if (prev !== 0 && d !== prev) flips++;
        prev = d;
      }
    }

    /* Trail roughness against the ground beside it. Neighbours are only counted
       when they are on the same side of the trail flag, so the step across the
       trail's own edge is never charged to either. */
    let ts = 0, tn = 0, bs = 0, bn = 0;
    const R = 8;
    for (let i = 1; i < NX - 1; i++) {
      for (let j = 1; j < NZ - 1; j++) {
        const mine = onTrail(i, j);
        if (!mine) {
          let near = false;
          for (let a = -R; a <= R && !near; a++) {
            for (let b = -R; b <= R; b++) {
              const ni = i + a, nj = j + b;
              if (ni < 1 || nj < 1 || ni >= NX - 1 || nj >= NZ - 1) continue;
              if (onTrail(ni, nj)) { near = true; break; }
            }
          }
          if (!near) continue;
        }
        for (const [di, dj] of D4) {
          const ni = i + di, nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= NX || nj >= NZ) continue;
          if (onTrail(ni, nj) !== mine) continue;
          const g = Math.abs(at(i, j) - at(ni, nj));
          if (mine) { ts += g; tn++; } else { bs += g; bn++; }
        }
      }
    }
    rows.push({ nm: s.nm, lone: 100 * lone / cols, flips: flips / (NX * NZ * V),
                trail: tn ? ts / tn : 0, beside: bn ? bs / bn : 0, tn });
  }

  const speckled = rows.filter((r) => r.lone > LONE_BAR);
  say('almost no column stands alone, where 0.13% of them used to',
      speckled.length === 0,
      rows.map((r) => r.nm + ' ' + r.lone.toFixed(3) + '%').join(', ')
        + ', bar is ' + LONE_BAR + '%');

  const chattery = rows.filter((r) => r.flips > FLIP_BAR);
  say('the ground undulates rather than chatters',
      chattery.length === 0,
      rows.map((r) => r.nm + ' ' + (1 / r.flips).toFixed(0) + ' m').join(', ')
        + ' between direction reversals, bar is ' + (1 / FLIP_BAR).toFixed(1) + ' m');

  const notFlat = rows.filter((r) => r.tn > 0 && r.trail >= r.beside);
  say('and a graded trail is flatter than the ground beside it',
      notFlat.length === 0 && rows.every((r) => r.tn > 0),
      rows.map((r) => r.nm + ' ' + (r.beside / r.trail).toFixed(2) + 'x').join(', ')
        + '  (a mean, so the ramp counts against it: a route that climbs a voxel'
        + ' at a time has more non-zero steps than one that was flat and then a'
        + ' cliff, which is why the margin is thin on ash)');

  /* A route may not climb faster than one voxel per voxel column.
     Every step along a trail used to be 0, 4, 8 or 12 voxels and never 1, 2 or
     3, because a trail took the integer height of the cell it stood on; a 1 m
     cell step was a 1 m cliff across 25 cm of ground. Sampling the cell field
     *between* the lattice points spreads that over four columns.
     Two exclusions, both deliberate and both visible in the detail line:
       a ford steps down into its water and a bank is a bank, so a pair with
       water or magma on either side is counted separately;
       the outer edge of a route meets ground that was never graded, which
       leaves a handful of half-metre steps at the verge. Closing those means
       widening every cutting in the world, which is a bigger change than they
       are worth — so the bar is a small share rather than none. */
  const STEP_BAR = 0.5;
  const steps = [];
  for (const s of GOLDEN_SEEDS) {
    const w = buildWorld({ seed: s.seed, size: s.size, force: s.force, ox: s.ox, oz: s.oz });
    const { Hs, FLG, NX, NZ } = w;
    const onT = (i, j) => (FLG[i * NZ + j] & 4) !== 0;
    const dry = (i, j) => (FLG[i * NZ + j] & 3) === 0;
    let pairs = 0, over = 0, worst = 0, wet = 0;
    for (let i = 0; i < NX; i++) {
      for (let j = 0; j < NZ; j++) {
        if (!onT(i, j)) continue;
        for (const [di, dj] of D4) {
          const ni = i + di, nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= NX || nj >= NZ || !onT(ni, nj)) continue;
          if (ni < i || (ni === i && nj < j)) continue;
          const d = Math.round(Math.abs(Hs[i * NZ + j] - Hs[ni * NZ + nj]) / V);
          if (!dry(i, j) || !dry(ni, nj)) { if (d > 1) wet++; continue; }
          pairs++;
          if (d > 1) { over++; if (d > worst) worst = d; }
        }
      }
    }
    steps.push({ nm: s.nm, pct: 100 * over / pairs, worst, wet });
  }
  const jumpy = steps.filter((r) => r.pct > STEP_BAR || r.worst > 2);
  say('and it never climbs more than a voxel at a time, bar the verge',
      jumpy.length === 0,
      steps.map((r) => r.nm + ' ' + r.pct.toFixed(2) + '% worst '
        + (r.worst * V).toFixed(2) + ' m').join(', ')
        + ', bar is ' + STEP_BAR + '% and 0.50 m; '
        + steps.reduce((a, r) => a + r.wet, 0) + ' ford pairs excluded');

  return out;
}

export function propSuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });
  const key = (x, y, z) => Math.round(x / V) + ',' + Math.round(y / V) + ',' + Math.round(z / V);
  const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

  /* Every face kept is exposed, and every face dropped is not. Checked against
     an independent walk of the voxel list rather than against the mesher's own
     bookkeeping, which would only prove it agrees with itself. */
  {
    let kept = 0, dropped = 0, wrongKept = 0, wrongDropped = 0;
    for (const s of GOLDEN_SEEDS.slice(0, 3)) {
      const w = chunkWorld(s.seed, 0, 0, s.force);
      const m = meshProps(w);
      const n = w.pos.length / 3, start = w.propStart === undefined ? n : w.propStart;
      const solid = new Set();
      for (let q = 0; q < n; q++) solid.add(key(w.pos[q * 3], w.pos[q * 3 + 1], w.pos[q * 3 + 2]));
      /* what the mesher emitted, as a set of (voxel, normal) pairs */
      const emitted = new Set();
      for (let f = 0; f < m.faces; f++) {
        const v = f * 4;
        let cx = 0, cy = 0, cz = 0;
        for (let k = 0; k < 4; k++) {
          cx += m.pos[(v + k) * 3]; cy += m.pos[(v + k) * 3 + 1]; cz += m.pos[(v + k) * 3 + 2];
        }
        const nx = m.nor[v * 3], ny = m.nor[v * 3 + 1], nz = m.nor[v * 3 + 2];
        /* the face centre, stepped back half a voxel along its normal, is the
           centre of the voxel it belongs to */
        emitted.add(key(cx / 4 - nx * V / 2, cy / 4 - ny * V / 2, cz / 4 - nz * V / 2)
                    + '|' + nx + ',' + ny + ',' + nz);
      }
      for (let q = start; q < n; q++) {
        const x = w.pos[q * 3], y = w.pos[q * 3 + 1], z = w.pos[q * 3 + 2];
        for (const d of DIRS) {
          const hidden = solid.has(key(x + d[0] * V, y + d[1] * V, z + d[2] * V));
          const has = emitted.has(key(x, y, z) + '|' + d[0] + ',' + d[1] + ',' + d[2]);
          if (hidden) { dropped++; if (has) wrongKept++; }
          else { kept++; if (!has) wrongDropped++; }
        }
      }
    }
    say('every prop face that can be seen is drawn, and every one that cannot is not',
        wrongKept === 0 && wrongDropped === 0,
        `${(kept + dropped).toLocaleString()} faces over three chunks: ${kept.toLocaleString()} exposed `
        + `and all drawn, ${dropped.toLocaleString()} buried and none drawn `
        + `(${(100 * dropped / (kept + dropped)).toFixed(1)}% of a prop is inside itself or the ground)`);
  }

  /* The control: terrain has to count as solid. Hiding a face only behind
     another *prop* leaves the sunk half of every boulder on screen, and the
     check above would still pass because it would be measuring the same wrong
     rule twice — so the rule is measured against the world instead. */
  {
    let bothWays = 0, propsOnly = 0;
    for (const s of GOLDEN_SEEDS.slice(0, 3)) {
      const w = chunkWorld(s.seed, 0, 0, s.force);
      const n = w.pos.length / 3, start = w.propStart === undefined ? n : w.propStart;
      const all = new Set(), props = new Set();
      for (let q = 0; q < n; q++) {
        const k = key(w.pos[q * 3], w.pos[q * 3 + 1], w.pos[q * 3 + 2]);
        all.add(k);
        if (q >= start) props.add(k);
      }
      for (let q = start; q < n; q++) {
        const x = w.pos[q * 3], y = w.pos[q * 3 + 1], z = w.pos[q * 3 + 2];
        for (const d of DIRS) {
          const k = key(x + d[0] * V, y + d[1] * V, z + d[2] * V);
          if (all.has(k)) bothWays++;
          if (props.has(k)) propsOnly++;
        }
      }
    }
    /* The margin is small and the bar is set where the measurement put it, not
       where it felt like it should be: a prop is mostly buried in *itself*,
       and only 1.9% of its hidden faces are against terrain. That is still the
       difference between a boulder with a sunk half and one without, and
       dropping terrain from the occupancy is caught by it. A bar of "5% more"
       was invented rather than measured, and failed on correct code. */
    say('and the ground counts as solid, not just the prop itself',
        bothWays > propsOnly,
        `${bothWays.toLocaleString()} faces hidden by anything solid against `
        + `${propsOnly.toLocaleString()} hidden by another prop alone — `
        + `${(bothWays - propsOnly).toLocaleString()} more, `
        + `${(100 * (bothWays - propsOnly) / bothWays).toFixed(1)}%, are buried in the ground`);
  }

  /* A face keeps its own voxel's colour: this is a cull, not a restyle. */
  {
    let checked = 0, wrong = 0;
    const w = chunkWorld('hero', 0, 0);
    const m = meshProps(w);
    const n = w.pos.length / 3, start = w.propStart === undefined ? n : w.propStart;
    /* A cell can hold more than one prop voxel — 4-8% of them are coincident,
       either doubled or sitting in a terrain cell — so a face there belongs to
       whichever of them emitted it, and a lookup that keeps one answer is
       ambiguous rather than wrong. The check accepts any voxel in the cell.
       (That coincidence is itself worth fixing and is not this change's
       business: the instanced renderer draws both too, and deciding which wins
       changes what is on screen. Recorded in #51.) */
    const byKey = new Map();
    for (let q = start; q < n; q++) {
      const k = key(w.pos[q * 3], w.pos[q * 3 + 1], w.pos[q * 3 + 2]);
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(q);
    }
    for (let f = 0; f < m.faces; f += 37) {
      const v = f * 4;
      let cx = 0, cy = 0, cz = 0;
      for (let k = 0; k < 4; k++) {
        cx += m.pos[(v + k) * 3]; cy += m.pos[(v + k) * 3 + 1]; cz += m.pos[(v + k) * 3 + 2];
      }
      const nx = m.nor[v * 3], ny = m.nor[v * 3 + 1], nz = m.nor[v * 3 + 2];
      const qs = byKey.get(key(cx / 4 - nx * V / 2, cy / 4 - ny * V / 2, cz / 4 - nz * V / 2));
      if (!qs) { wrong++; continue; }
      checked++;
      let any = false;
      for (const q of qs) {
        const want = [palR(w.pal[q], w.shd[q]), palG(w.pal[q], w.shd[q]), palB(w.pal[q], w.shd[q])];
        let ok = true;
        for (let c = 0; c < 3; c++) if (Math.abs(m.col[v * 3 + c] - want[c]) > 1e-9) { ok = false; break; }
        if (ok) { any = true; break; }
      }
      if (!any) wrong++;
    }
    say('and a face carries the colour the box carried, so this is a cull and not a restyle',
        wrong === 0 && checked > 100,
        `${checked} faces sampled across a chunk, every one the palette index and shade `
        + 'of the voxel it belongs to');
  }

  /* The clip a streamed chunk uses must not open a seam: a neighbour's prop is
     not drawn here, but it still hides what it is standing against. */
  {
    const w = chunkWorld('fen', 0, 0);
    const inner = meshProps(w, CHUNK_M / 2), whole = meshProps(w);
    let outside = 0;
    for (let f = 0; f < inner.faces; f++) {
      const v = f * 4;
      const x = inner.pos[v * 3], z = inner.pos[v * 3 + 2];
      if (Math.abs(x) > CHUNK_M / 2 + V || Math.abs(z) > CHUNK_M / 2 + V) outside++;
    }
    say('and a streamed chunk draws its own props only, while the neighbour\'s still hide faces',
        outside === 0 && inner.faces > 0 && inner.faces < whole.faces,
        `${inner.faces.toLocaleString()} faces inside the chunk against `
        + `${whole.faces.toLocaleString()} across the whole window, none beyond the boundary`);
  }

  return out;
}

/**
 * The sky (#30): a clock, a sun on it, and weather that is a function of the
 * seed and the hour — so two players see the same sky without a byte of it
 * crossing the wire.
 */
export function skySuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });
  const D = SKY.DAY_SECONDS, at = (ph) => (ph - SKY.DAWN_START) * D;
  const CLEAR = { cloud: 0, rain: 0, wetness: 0 };

  const noon = SKY.skyAt(at(0.5), 'QUARTERSTONE', CLEAR), night = SKY.skyAt(at(1.0), 'QUARTERSTONE', CLEAR);
  const L = Math.sqrt(16 * 16 + 26 * 26 + 12 * 12), old = [-16 / L, 26 / L, 12 / L];
  const off = Math.sqrt(noon.sunDir.reduce((a, v, i) => a + (v - old[i]) * (v - old[i]), 0));
  say('noon puts the sun where the fixed sun always stood, and midnight puts it under the ground',
      off < 0.01 && night.sunDir[1] < -0.5 && noon.sunI > 1 && night.sunI === 0,
      `noon ${noon.sunDir.map((v) => v.toFixed(3)).join(',')} (${off.toFixed(4)} from the old sun), midnight elevation ${night.sunDir[1].toFixed(2)}`);

  const rise = [], set = [];
  for (let ph = 0; ph < 1; ph += 1 / 480) {
    const a = SKY.skyAt(at(ph), 1, CLEAR), b = SKY.skyAt(at(ph + 1 / 480), 1, CLEAR);
    if (a.sunDir[1] <= 0 && b.sunDir[1] > 0) rise.push(ph * 24);
    if (a.sunDir[1] > 0 && b.sunDir[1] <= 0) set.push(ph * 24);
  }
  say('the sun rises at six and sets at eighteen, once each a day',
      rise.length === 1 && set.length === 1 && Math.abs(rise[0] - 6) < 0.1 && Math.abs(set[0] - 18) < 0.1,
      `rise ${rise.map((h) => h.toFixed(2)).join(',')} h, set ${set.map((h) => h.toFixed(2)).join(',')} h`);

  const dusk = SKY.skyAt(at(0.73), 1, CLEAR);
  say('the golden hour is golden, and the lamps come on at night and off by day',
      dusk.sunCol[2] < 0.6 * noon.sunCol[2] && dusk.low > 0.8 && noon.lamps === 0 && night.lamps === 1,
      `dusk sun ${dusk.sunCol.map((v) => v.toFixed(2)).join(',')} against noon ${noon.sunCol.map((v) => v.toFixed(2)).join(',')}; lamps ${noon.lamps} at noon, ${night.lamps} at midnight`);

  let same = 0, n = 0, differ = 0;
  for (let t = 0; t < 4 * D; t += 37) {
    n++;
    if (JSON.stringify(SKY.skyAt(t, 'QUARTERSTONE')) === JSON.stringify(SKY.skyAt(t, 'QUARTERSTONE'))) same++;
    if (SKY.weatherAt('QUARTERSTONE', t).cloud !== SKY.weatherAt('MEADOWLANDS', t).cloud) differ++;
  }
  say('the sky is a function of the seed and the hour and nothing else',
      same === n && differ > n / 2 && SKY.skyWord('QUARTERSTONE') === SKY.skyWord('QUARTERSTONE'),
      `${same}/${n} hours identical twice over; another seed has other weather at ${differ} of them`);

  let rainy = 0, jump = 0;
  for (let k = 0; k < 400; k++) if (SKY.spellAt(SKY.skyWord('X' + k), k).rain) rainy++;
  let prev = SKY.weatherAt(7, 0);
  for (let t = 1; t < 20 * SKY.SPELL_SECONDS; t++) {
    const w = SKY.weatherAt(7, t);
    jump = Math.max(jump, Math.abs(w.cloud - prev.cloud), Math.abs(w.rain - prev.rain));
    prev = w;
  }
  say('about one spell in six rains, and weather never changes in a step',
      rainy > 400 / 10 && rainy < 400 / 3.5 && jump < 0.05,
      `${rainy} of 400 spells rain; largest change in one second ${jump.toFixed(3)}`);

  /* Wetness: rises while it rains, still there just after, gone some spells on. */
  let spell = -1;
  for (let k = 1; k < 200 && spell < 0; k++) {
    const a = SKY.spellAt(SKY.skyWord(3), k);
    if (a.rain && !SKY.spellAt(SKY.skyWord(3), k + 1).rain && !SKY.spellAt(SKY.skyWord(3), k + 2).rain
        && !SKY.spellAt(SKY.skyWord(3), k + 3).rain && !SKY.spellAt(SKY.skyWord(3), k + 4).rain) spell = k;
  }
  const S = SKY.SPELL_SECONDS;
  const during = SKY.weatherAt(3, (spell + 0.5) * S).wetness, after = SKY.weatherAt(3, (spell + 1.5) * S).wetness,
        dry = SKY.weatherAt(3, (spell + 4.5) * S).wetness;
  say('rain wets the ground, and it dries after',
      spell > 0 && during > 0.5 && after > 0 && after < during && dry === 0,
      `spell ${spell}: wetness ${during.toFixed(2)} in the rain, ${after.toFixed(2)} a spell later, ${dry.toFixed(2)} four on`);

  /* Storms (#102): some of the rain, and none of anything else. Lightning is
     the sky's too — a function of the seed and the second — so it strikes at
     the same moment on both machines, only in a storm, every few seconds. */
  let storms = 0, dryStorms = 0;
  for (let k = 0; k < 400; k++) { const sp = SKY.spellAt(SKY.skyWord('X' + k), k); if (sp.storm) { storms++; if (!sp.rain) dryStorms++; } }
  let stormAt = -1;
  for (let k = 0; k < 400 && stormAt < 0; k++) if (SKY.spellAt(SKY.skyWord(11), k).storm) stormAt = k;
  const strikes = new Set(); let calmFlash = 0, twice = 0, frames = 0;
  if (stormAt >= 0) for (let t = (stormAt + 0.05) * S; t < (stormAt + 0.8) * S; t += 1 / 30) {
    const a = SKY.lightningAt(11, t); frames++;
    if (JSON.stringify(a) === JSON.stringify(SKY.lightningAt(11, t))) twice++;
    if (a.flash > 0) strikes.add(a.id);
  }
  for (let t = 0; t < 3000; t += 0.25) if (SKY.lightningAt(11, t, { cloud: 0.9, rain: 1, wetness: 1, storm: 0 }).flash > 0) calmFlash++;
  const perMin = strikes.size / (0.75 * S / 60);
  say('about a third of the rain is a storm, and a storm strikes every few seconds — the same strikes on both machines',
      storms > 0 && dryStorms === 0 && storms < 400 / 5 && perMin >= 4 && perMin <= 20 && twice === frames && calmFlash === 0,
      `${storms} of 400 spells storm, ${dryStorms} without rain; ${perMin.toFixed(1)} strikes a minute in one; `
      + `${twice}/${frames} moments identical twice; ${calmFlash} flashes in rain that is not a storm`);
  return out;
}

/* ------------------------------------------------------------------ nav ---- */

/**
 * The navigation graph (#15): the verbs of the movement budget, per radius
 * (#37), asked ahead of time. Built on small hand-made colliders so each edge
 * kind is tested on its own, then the machines on real ground.
 */
export function navSuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });
  const floor = () => { const c = makeCollider(20, V); c.addBox(-19.9, 19.9, -19.9, 19.9, -2, 0); return c; };
  const P = { rad: ACTOR.radius }, S = { rad: EN.SENTRY.rad, canJump: false };

  /* A wall across the arena with a 1 m door, and a long way round. */
  {
    const c = floor();
    c.addBox(-0.5, 0.5, -19.9, -0.5, 0, 3);
    c.addBox(-0.5, 0.5, 0.5, 12, 0, 3);
    c.finish();
    const a = { x: -4, y: 0, z: 0 }, b = { x: 4, z: 0 };
    const pp = findPath(c, a, b, P), sp = findPath(c, a, b, Object.assign({ maxNodes: 20000 }, S));
    const lenOf = (p) => p.reduce((s, q, i) => s + (i ? hyp(q.x - p[i - 1].x, q.z - p[i - 1].z) : 0), 0);
    const aroundZ = sp && Math.max(...sp.map((q) => q.z));
    say('a player paths through a door a sentry has to go round',
        pp && !pp.partial && sp && !sp.partial && lenOf(pp) < 10 && lenOf(sp) > 20 && aroundZ > 12,
        `player ${pp ? lenOf(pp).toFixed(1) : '-'} m through the door; sentry ${sp ? lenOf(sp).toFixed(1) : '-'} m, round the end at z ${aroundZ ? aroundZ.toFixed(1) : '-'}`);
  }

  /* A 1 m face is a jump up, a 2 m face a double jump, for a body that jumps
     (#73); a sentry, which does not, stops short of either. */
  {
    const up = (h) => {
      const c = floor();
      c.addBox(2, 19.9, -19.9, 19.9, 0, h);
      c.finish();
      return { p: findPath(c, { x: 0, y: 0, z: 0 }, { x: 4, z: 0 }, P),
               s: findPath(c, { x: 0, y: 0, z: 0 }, { x: 4, z: 0 }, S) };
    };
    const kinds = (p) => (p ? p.map((q) => q.kind).filter((k) => k && k !== 'walk') : []);
    const one = up(MOVE.climb), two = up(MOVE.climb2), wall = up(MOVE.climb2 + 0.5);
    say('a 1 m face is a jump up and a 2 m face a double jump for a player, and neither for a sentry',
        one.p && !one.p.partial && kinds(one.p).includes('climb') && two.p && !two.p.partial && kinds(two.p).includes('climb2')
          && wall.p && wall.p.partial && one.s && one.s.partial && two.s && two.s.partial,
        `player: 1 m ${kinds(one.p).join(',') || 'NONE'}, 2 m ${kinds(two.p).join(',') || 'NONE'}, `
        + `2.5 m ${wall.p && wall.p.partial ? 'stops short' : 'CLIMBED'}; sentry ${one.s && one.s.partial && two.s && two.s.partial ? 'stops short' : 'CLIMBED'}`);
  }

  /* A gap: one inside the jump budget is a jump link, one past it is not. */
  {
    const gap = (w) => {
      const c = makeCollider(20, V);
      c.addBox(-19.9, 0, -19.9, 19.9, -2, 0);
      c.addBox(w, 19.9, -19.9, 19.9, -2, 0);
      c.finish();
      const g = navGraph(c, { x0: -3, x1: w + 3, z0: -1, z1: 1 }, P);
      return g.links.filter((l) => l.kind === 'jump').length;
    };
    const j2 = gap(MOVE.jump - 0.5), j3 = gap(MOVE.jump + 0.5);
    say('a gap inside the jump budget is a jump link, and one past it is not',
        j2 > 0 && j3 === 0, `${MOVE.jump - 0.5} m gap: ${j2} jump links; ${MOVE.jump + 0.5} m gap: ${j3}`);
  }

  /* On real ground: the machines' posts, and a machine reaching a player on
     the far side of something it cannot climb. */
  {
    let placed = 0, fromGround = 0, bad = [], up = [];
    for (const s of GOLDEN_SEEDS) {
      const w = buildWorld(s), col = colliderForWorld(w), posts = EN.postsFor(col, w);
      placed += posts.length;
      posts.forEach((p, i) => {
        if (w.affordances.some((a) => a.x === p[0] && a.z === p[1])) fromGround++;
        const d = hyp(p[0] - w.spawn[0], p[1] - w.spawn[2]);
        if (d < EN.SENTRY.sight) bad.push(`${s.nm} post ${i} ${d.toFixed(1)} m from spawn`);
        for (let q = 0; q < i; q++) if (hyp(p[0] - posts[q][0], p[1] - posts[q][1]) < 10) bad.push(`${s.nm} posts ${q},${i} close`);
        /* On the ground, not on a canopy over it: the machine stands within a
           step of the terrain's own surface at its post (#3 found one 2.9 m
           up a tree, out of reach of anyone). */
        const e = EN.makeSentry(col, p[0], p[1], p[2] + 1e-6);
        /* The ground under its whole footprint, not the one voxel under its
           middle: on a hillside ramp (#73) the ground rises a quarter a voxel,
           and a body stands on the highest of it. */
        let g = -Infinity;
        for (let dx = -EN.SENTRY.rad; dx <= EN.SENTRY.rad + 1e-9; dx += V) for (let dz = -EN.SENTRY.rad; dz <= EN.SENTRY.rad + 1e-9; dz += V) {
          if (dx * dx + dz * dz > EN.SENTRY.rad * EN.SENTRY.rad) continue;
          const k = Math.floor((p[0] + dx + w.half) / V) * w.NZ + Math.floor((p[1] + dz + w.half) / V);
          if (w.Hs[k] > g) g = w.Hs[k];
        }
        if (Math.abs(e.y - g) > MOVE.step) up.push(`${s.nm} post ${i} at ${e.y.toFixed(2)} over ground ${g}`);
      });
    }
    say('and every machine stands on the ground at its post, not on what grows there',
        up.length === 0 && placed > 0, up.length ? up.join('; ') : `${placed} machines within a step of the ground`);
    say('machines hold posts the ground offers, out of sight of the spawn and apart',
        bad.length === 0 && placed >= GOLDEN_SEEDS.length * 2 && fromGround >= placed * 0.8,
        bad.length ? bad.join('; ') : `${placed} posts over ${GOLDEN_SEEDS.length} seeds, ${fromGround} from the region's affordances`);
  }
  return out;
}

/* ---------------------------------------------------------------- canyons ---- */

/**
 * Gorges (#74, DECISIONS §5 "Canyons"), measured straight off the cell field
 * over 600 m of two seeds whose ground is canyon country: deep enough that a
 * double jump does not climb out, and never a trap — every stretch of floor
 * can be reached and left by the budget's own rules, through a breach or an
 * end.
 */
export function canyonSuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });
  const rows = [];
  for (const seed of ['EMBERFALL', 'MOSSGATE']) {
    const G = makeGen(seed, null), R = 300, N = 2 * R;
    /* `dry` is ground a body can be on at all — not magma, and water only
       where it can be waded or swum out of — and `S` the height it is on:
       the surface, for water. */
    const H = new Int16Array(N * N), S = new Float32Array(N * N), inC = new Uint8Array(N * N), dry = new Uint8Array(N * N);
    let narrow = 0;
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const c = G.cell(i - R, j - R), k = i * N + j;
      H[k] = c.H; S[k] = c.water ? c.wl : c.H; dry[k] = c.magma || (c.water && c.wl - c.H > 1.5) ? 0 : 1;
      inC[k] = c.canyon && c.cw > 0.28 && c.canyon.d < c.canyon.w / 2 && c.canyon.body ? 1 : 0;
      if (inC[k] && c.canyon.w < 6) narrow++;
    }
    /* Walls: where a canyon cell meets ground outside it, rim over floor. */
    let walls = 0, deep = 0, cells = 0;
    for (let i = 1; i < N - 1; i++) for (let j = 1; j < N - 1; j++) {
      const k = i * N + j; if (!inC[k]) continue; cells++;
      for (const q of [k + 1, k - 1, k + N, k - N]) if (!inC[q]) { walls++; if (H[q] - H[k] > MOVE.climb2) deep++; }
    }
    /* Reached from outside, and left again: two floods over the budget's
       moves — up no more than a double jump, down no more than a survivable
       drop — one forward from all the ground outside, one backward. */
    const flood = (back) => {
      const seen = new Uint8Array(N * N), q = [];
      /* Seeded from all the ground outside the canyon, and from the edge of
         the sample: a gorge that runs out of it goes on somewhere, and a
         breach there is a breach. */
      for (let k = 0; k < N * N; k++) {
        const i = (k / N) | 0, j = k % N, edge = i === 0 || j === 0 || i === N - 1 || j === N - 1;
        if (dry[k] && (!inC[k] || edge)) { seen[k] = 1; q.push(k); }
      }
      for (let h = 0; h < q.length; h++) {
        const k = q[h], i = (k / N) | 0, j = k % N;
        for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ii = i + a, jj = j + b; if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue;
          const p = ii * N + jj; if (seen[p] || !dry[p]) continue;
          const dh = back ? S[k] - S[p] : S[p] - S[k];
          if (dh > MOVE.climb2 || dh < -MOVE.fall) continue;
          seen[p] = 1; q.push(p);
        }
      }
      return seen;
    };
    const into = flood(false), outOf = flood(true);
    let floor = 0, reached = 0, left = 0;
    for (let k = 0; k < N * N; k++) if (inC[k] && dry[k]) { floor++; if (into[k]) reached++; if (outOf[k]) left++; }
    rows.push({ seed, cells, walls, deep, floor, reached, left, narrow });
  }
  say('a gorge is deep: most of its walls are taller than a double jump climbs',
      rows.every((r) => r.cells > 1000 && r.deep > r.walls * 0.5),
      rows.map((r) => `${r.seed} ${r.cells} cells, ${(100 * r.deep / r.walls).toFixed(0)}% of ${r.walls} wall edges over ${MOVE.climb2} m`).join('; '));
  say('and too wide to jump across: none is under 6 m',
      rows.every((r) => r.narrow === 0), rows.map((r) => `${r.seed} ${r.narrow} narrower`).join('; '));
  say('and never a trap: its floor can be reached and left, by a breach or an end',
      rows.every((r) => r.reached >= r.floor * 0.99 && r.left >= r.floor * 0.99),
      rows.map((r) => `${r.seed} ${r.floor} floor cells: ${(100 * r.reached / r.floor).toFixed(1)}% reached, ${(100 * r.left / r.floor).toFixed(1)}% left`).join('; '));
  return out;
}

/* Seeds with redrock enough for a handful of mesas in 600 m. */
const MESA_SEEDS = ['EMBERFALL', 'MOSSGATE', 'DUSKWARD'];

/**
 * Mesas (#75): a top walled all round, and one way up it — the stones.
 *
 * Over the cell field of a stretch of redrock, three floods under the
 * budget's moves: a step up of at most a double jump, a drop of at most a
 * survivable fall, and a jump over one lower cell onto ground within a slope
 * of the take-off, the way src/gen/reach.mjs floods a window. Seeded from all
 * the ground that is neither top nor stone. With the stones, every top is
 * reached and left; with the stones taken away, none is.
 */
export function mesaSuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });
  const rows = [], built = [];
  for (const seed of MESA_SEEDS) {
    const G = makeGen(seed, null), R = 300, N = 2 * R;
    const S = new Float32Array(N * N), kind = new Uint8Array(N * N), dry = new Uint8Array(N * N);
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const c = G.cell(i - R, j - R), k = i * N + j;
      S[k] = c.water ? c.wl : c.H; kind[k] = c.mesa || 0;
      dry[k] = c.magma || (c.water && c.wl - c.H > 1.5) ? 0 : 1;
    }
    /* Tops, one component each. */
    const comp = new Int32Array(N * N).fill(-1), tops = [];
    for (let k = 0; k < N * N; k++) {
      if (kind[k] !== 1 || comp[k] >= 0 || !dry[k]) continue;
      const id = tops.length, q = [k]; comp[k] = id;
      for (let h = 0; h < q.length; h++) {
        const p = q[h], i = (p / N) | 0, j = p % N;
        for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ii = i + a, jj = j + b; if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue;
          const r = ii * N + jj; if (kind[r] === 1 && comp[r] < 0 && dry[r]) { comp[r] = id; q.push(r); }
        }
      }
      const edge = q.some((p) => { const i = (p / N) | 0, j = p % N; return i === 0 || j === 0 || i === N - 1 || j === N - 1; });
      let sx = 0, sz = 0; for (const p of q) { sx += (p / N) | 0; sz += p % N; }
      tops.push({ cells: q, edge, cx: Math.round(sx / q.length) - R, cz: Math.round(sz / q.length) - R });
      if (!edge && built.length < 8 && Math.abs(tops.at(-1).cx) < R - 32 && Math.abs(tops.at(-1).cz) < R - 32) built.push([seed, G, tops.at(-1)]);
    }
    /* Walls: a top cell against ground that is neither top nor stone. */
    let walls = 0, low = 0;
    for (let k = 0; k < N * N; k++) {
      if (kind[k] !== 1) continue;
      const i = (k / N) | 0, j = k % N;
      for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ii = i + a, jj = j + b; if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue;
        const r = ii * N + jj; if (kind[r] === 1 || kind[r] === 2 || !dry[r]) continue;
        walls++; if (S[k] - S[r] <= MOVE.climb2) low++;
      }
    }
    /* `stones`: all of them, none, or a test of which stone cells stand. */
    const flood = (back, stones) => {
      const ok = typeof stones === 'function'
        ? (k) => dry[k] && (kind[k] !== 2 || stones(k))
        : (k) => dry[k] && (stones || kind[k] !== 2);
      const seen = new Uint8Array(N * N), q = [];
      for (let k = 0; k < N * N; k++) if (ok(k) && kind[k] !== 1 && kind[k] !== 2) { seen[k] = 1; q.push(k); }
      for (let h = 0; h < q.length; h++) {
        const k = q[h], i = (k / N) | 0, j = k % N;
        for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ii = i + a, jj = j + b; if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue;
          const p = ii * N + jj;
          if (!seen[p] && ok(p)) {
            const dh = back ? S[k] - S[p] : S[p] - S[k];
            if (dh <= MOVE.climb2 && dh >= -MOVE.fall) { seen[p] = 1; q.push(p); }
          }
          /* over one lower cell, onto ground within a slope of the take-off */
          const i2 = i + 2 * a, j2 = j + 2 * b; if (i2 < 0 || j2 < 0 || i2 >= N || j2 >= N) continue;
          const p2 = i2 * N + j2; if (seen[p2] || !ok(p2)) continue;
          if (S[p] <= S[k] - 1 && Math.abs(S[p2] - S[k]) <= MOVE.slope) { seen[p2] = 1; q.push(p2); }
        }
      }
      return seen;
    };
    const up = flood(false, true), down = flood(true, true), bare = flood(false, false);
    let whole = 0, reached = 0, left = 0, cheat = 0;
    for (const t of tops) {
      if (t.edge) continue; whole++;
      if (t.cells.some((k) => up[k])) reached++;
      if (t.cells.some((k) => down[k])) left++;
      if (t.cells.some((k) => bare[k])) cheat++;
    }
    rows.push({ seed, whole, reached, left, cheat, walls, low });
  }
  const all = (f) => rows.every(f), tell = (f) => rows.map((r) => `${r.seed} ${f(r)}`).join('; ');
  say('mesas stand in the redrock', all((r) => r.whole >= 4), tell((r) => `${r.whole} whole mesas`));
  /* And on the golden redrock seed, which is what --diag counts. */
  const gm = GOLDEN_SEEDS.find((g) => g.nm === 'mesa'), gw = makeGen(gm.seed, gm.force);
  const gn = gw.mesasIn(gm.ox - 128, gm.oz - 128, gm.ox + 128, gm.oz + 128);
  say('and round the golden redrock window too', gn >= 3, `${gn} mesas within 128 m of ${gm.seed}'s window`);
  say('walled all round: no top is within a double jump of the ground at its foot',
      all((r) => r.low === 0), tell((r) => `${r.low} of ${r.walls} wall edges within ${MOVE.climb2} m`));
  say('and climbed by its stones: every top is reached, and left, from the ground',
      all((r) => r.reached === r.whole && r.left === r.whole), tell((r) => `${r.reached}/${r.whole} reached, ${r.left}/${r.whole} left`));
  say('and by nothing else: take the stones away and no top is reached',
      all((r) => r.cheat === 0), tell((r) => `${r.cheat} reached without them`));

  /* The same, on built windows rather than the cell field: erosion, the
     routes and their grading, the reach repair and every prop have all run.
     The height is the collider's own — a canopy or a ruin is ground here —
     sampled a voxel at a time, and flooded from the window's edge by a step
     up of at most a double jump, with the stones taken away. Nothing may
     reach a top. */
  let cheats = [];
  for (const [seed, G, t] of built) {
    const w = buildWorld({ seed, size: 64, ox: t.cx, oz: t.cz }), col = colliderForWorld(w), M = 64 / V;
    const h = new Float32Array(M * M), k2 = new Uint8Array(M * M);
    for (let i = 0; i < M; i++) for (let j = 0; j < M; j++) {
      const x = -32 + (i + 0.5) * V, z = -32 + (j + 0.5) * V;
      h[i * M + j] = col.supportUnder(x, z, 0.01, CEIL * 2);
      k2[i * M + j] = G.cell(Math.round(x) + t.cx, Math.round(z) + t.cz).mesa || 0;
    }
    /* The footholds up a wall (#75) are a way up by design, like the stones:
       they are taken away with them here, and climbed below. */
    for (const m of G.mesasNear(t.cx - 32, t.cz - 32, t.cx + 32, t.cz + 32)) for (const [x, , z, ox, oz] of m.nubs) for (let d = -1; d <= 2; d++) {
      const i = Math.round((x + ox * d * V - t.cx + 32) / V), j = Math.round((z + oz * d * V - t.cz + 32) / V);
      if (i >= 0 && j >= 0 && i < M && j < M) k2[i * M + j] = 2;
    }
    const seen = new Uint8Array(M * M), q = [];
    for (let k = 0; k < M * M; k++) {
      const i = (k / M) | 0, j = k % M;
      if ((i === 0 || j === 0 || i === M - 1 || j === M - 1) && !k2[k]) { seen[k] = 1; q.push(k); }
    }
    for (let n = 0; n < q.length; n++) {
      const k = q[n], i = (k / M) | 0, j = k % M;
      for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ii = i + a, jj = j + b; if (ii < 0 || jj < 0 || ii >= M || jj >= M) continue;
        const p = ii * M + jj; if (seen[p] || k2[p] === 2) continue;
        const dh = h[p] - h[k]; if (dh <= MOVE.climb2 && dh >= -MOVE.fall) { seen[p] = 1; q.push(p); }
      }
    }
    let n = 0; for (let k = 0; k < M * M; k++) if (k2[k] === 1 && seen[k]) n++;
    if (n) cheats.push(`${seed} ${t.cx},${t.cz}: ${n} voxels`);
  }
  say('and in a built world too: grading, repairs and props give no other way up',
      built.length >= 6 && cheats.length === 0, cheats.length ? cheats.join('; ') : `${built.length} mesas built, none reached without the stones`);

  /* The shortcut (#75): a body at the foot of a wall, under its first
     foothold, double jumps onto each in turn and from the last onto the top,
     never touching a stone. */
  const shorts = [], stuck = [];
  for (const [seed, G, t] of built) {
    const s = G.mesaOver(t.cx, t.cz);
    if (!s || !s.nubs.length || shorts.length >= 4) continue;
    shorts.push(s);
    const w = buildWorld({ seed, size: 64, ox: s.cx, oz: s.cz }), col = colliderForWorld(w);
    /* Which way is out of the wall, and where each foothold's top is. */
    const n0 = s.nubs[0], alongX = s.dx !== 0;
    const out = alongX ? Math.sign(n0[2] - s.cz) : Math.sign(n0[0] - s.cx);
    const outV = alongX ? [0, out] : [out, 0];
    /* Where a body stands on each: over the foothold's column, pressed to
       the wall — the actor does not slide, so steering into the face stops
       it dead. */
    const holds = s.nubs.map(([x, y, z]) => [x - s.cx + V / 2 + outV[0] * 0.3, y, z - s.cz + V / 2 + outV[1] * 0.3]);
    const st = [holds[0][0] + outV[0] * 1.2, holds[0][2] + outV[1] * 1.2];
    const g0 = w.cells[Math.round(st[0] + 32) * w.M + Math.round(st[1] + 32)].H;
    const b = placeOnGround(col, st[0], st[1], g0 + 1.5);
    let reached = 0;
    for (const hold of [...holds, null]) {
      const [hx, hy, hz] = hold || [null, null, null];
      /* Aim at the foothold, or for the top a metre in past the wall. */
      const tx = hx === null ? b.x - outV[0] * 1.5 : hx, tz = hx === null ? b.z - outV[1] * 1.5 : hz;
      const ty = hx === null ? s.T : hy;
      let ok = false;
      for (let tries = 0; tries < 3 && !ok && !b.dead; tries++) {
        for (let tk = 0; tk < 150 && !b.dead; tk++) {
          const dx = tx - b.x, dz = tz - b.z, d = hyp(dx, dz);
          if (b.grounded && b.y >= ty - 0.3 && d < 0.8) { ok = true; break; }
          const j = (b.grounded && tk > 1) || (!b.grounded && b.airJumps > 0 && b.vy <= 0);
          /* Up first, then over: drifting across under the next foothold
             puts a shoulder into it. */
          const sp = d > 0.05 && (b.y > ty - 0.1 || d > 1.3) ? Math.min(1, d / 0.4) : 0;
          step(col, b, { mx: sp * dx / (d || 1), mz: sp * dz / (d || 1), jump: j });
        }
      }
      if (!ok) break;
      reached++;
    }
    if (reached < s.nubs.length + 1) stuck.push(`${seed} ${s.cx},${s.cz}: ${reached} of ${s.nubs.length} footholds and the top, ended ${b.x.toFixed(1)},${b.y.toFixed(2)},${b.z.toFixed(1)}`);
  }
  say('and a double-jump shortcut up a wall: a body climbs its footholds onto the top', shorts.length >= 3 && stuck.length === 0,
      stuck.length ? stuck.join('; ') : `${shorts.length} walls climbed by ${shorts.map((s) => s.nubs.length).join('/')} footholds`);

  /* And a body does it, on a built window rather than the cell field: the
     surface pass must leave every stone a face with a lip to leave from. The
     first built mesa with stones, walked from the ground beyond the last of
     them towards the top: a jump at each face and at each lip, and never a
     second one in the air. */
  const pick = built.map(([seed, G, t]) => [seed, G.mesaOver(t.cx, t.cz)]).find(([, m]) => m && m.st.length >= 2);
  let climbed = 'no built mesa with two stones or more', cached = climbed;
  if (pick) {
    const [seed, m] = pick, r = m.dx ? m.rx : m.rz, far = m.st[m.st.length - 1] + 4;
    const cw = buildWorld({ seed, size: 64, ox: m.cx, oz: m.cz }), cc = colliderForWorld(cw);
    /* The stones are two wide, across offsets 0 and 1: walk the line between. */
    const b = placeOnGround(cc, m.dx * far + (m.dx ? 0 : 0.5), m.dz * far + (m.dz ? 0 : 0.5));
    const drops = () => cc.supportUnder(b.x - m.dx * RUN * TICK, b.z - m.dz * RUN * TICK, ACTOR.radius, b.y + EPS) < b.y - MOVE.step;
    let jumps = 0;
    for (let t = 0; t < 1200 && !b.dead && (b.x * m.dx + b.z * m.dz) > r - 2; t++) {
      const j = b.grounded && (b.blocked || drops());
      if (j) jumps++;
      step(cc, b, { mx: -m.dx, mz: -m.dz, jump: j });
    }
    const on = cw.G.cell(Math.round(b.x) + m.cx, Math.round(b.z) + m.cz);
    const caches = LO.cacheSites(cc, cw), up = caches.filter((q) => cw.G.cell(Math.round(q.x) + m.cx, Math.round(q.z) + m.cz).mesa === 1);
    cached = { ok: up.length === 1 && up[0].y >= m.T - 0.5,
      detail: `${caches.length} caches in the window, ${up.length} on the top${up.length ? ` at ${up[0].y.toFixed(2)} against a top at ${m.T}` : ''}` };
    climbed = { ok: on.mesa === 1 && !b.dead && b.airJumped === 0 && jumps >= m.st.length,
      detail: `${seed} ${m.cx},${m.cz}, ${m.st.length} stones: ended ${(b.y - (m.T - m.st.length)).toFixed(2)} m over the last stone on ${['open ground', 'the top', 'a stone', 'the apron'][on.mesa || 0]}, ${jumps} jumps, ${b.airJumped} in the air` };
  }
  say('a body climbs the stones onto the top, one jump each and none in the air',
      climbed.ok === true, climbed.detail || climbed);
  say('and finds a cache up there: the reason to climb',
      cached.ok === true, cached.detail || cached);
  return out;
}

/* Seeds with burn enough for several column fields in 600 m. */
const BASALT_SEEDS = ['DUSKWARD', 'CINDERFALL'];

/**
 * Basalt column fields (#76, Ashfall): crossed a jump at a time over magma.
 *
 * Over the cell field of each seed, a flood under the budget's moves — a step
 * up of at most a double jump, a drop of at most a fall, and a jump over one
 * lower cell (magma included) onto ground within a slope of the take-off —
 * seeded from all the dry ground that is not a column. Every column on the
 * two lines through a field must be reached, and left; no two columns touch,
 * so every one of those moves across the field is a jump. On a built window,
 * a body walks a line through one from rim to rim.
 */
export function basaltSuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });
  const rows = [];
  let pickSeed = null, pick = null;
  for (const seed of BASALT_SEEDS) {
    const G = makeGen(seed, null), R = 300, N = 2 * R;
    const S = new Float32Array(N * N), kind = new Uint8Array(N * N), dry = new Uint8Array(N * N), mag = new Uint8Array(N * N);
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const c = G.cell(i - R, j - R), k = i * N + j;
      S[k] = c.water ? c.wl : c.H; kind[k] = c.basalt || 0; mag[k] = c.magma ? 1 : 0;
      dry[k] = c.magma || (c.water && c.wl - c.H > 1.5) ? 0 : 1;
    }
    const flood = (back) => {
      const seen = new Uint8Array(N * N), q = [];
      for (let k = 0; k < N * N; k++) if (dry[k] && kind[k] !== 1) { seen[k] = 1; q.push(k); }
      for (let h = 0; h < q.length; h++) {
        const k = q[h], i = (k / N) | 0, j = k % N;
        for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ii = i + a, jj = j + b; if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue;
          const p = ii * N + jj;
          if (!seen[p] && dry[p]) {
            const dh = back ? S[k] - S[p] : S[p] - S[k];
            if (dh <= MOVE.climb2 && dh >= -MOVE.fall) { seen[p] = 1; q.push(p); }
          }
          const i2 = i + 2 * a, j2 = j + 2 * b; if (i2 < 0 || j2 < 0 || i2 >= N || j2 >= N) continue;
          const p2 = i2 * N + j2; if (seen[p2] || !dry[p2]) continue;
          if ((mag[p] || S[p] <= S[k] - 1) && Math.abs(S[p2] - S[k]) <= MOVE.slope) { seen[p2] = 1; q.push(p2); }
        }
      }
      return seen;
    };
    const into = flood(false), outOf = flood(true);
    /* Fields wholly inside the sample, found through the generator's own record. */
    const fields = new Map();
    for (let k = 0; k < N * N; k++) {
      if (kind[k] !== 1) continue;
      const i = (k / N) | 0, j = k % N, s = G.basaltOver(i - R, j - R);
      if (!s || Math.abs(s.cx) > R - 16 || Math.abs(s.cz) > R - 16) continue;
      if (!fields.has(s)) fields.set(s, { spine: 0, reached: 0, left: 0, cols: 0, touch: 0 });
      const f = fields.get(s); f.cols++;
      /* Touching another column, not its own block: a different block's cell. */
      for (const [a, b] of [[1, 0], [0, 1]]) if (kind[(i + a) * N + j + b] === 1
          && (Math.floor((i + a - R - s.cx) / 3) !== Math.floor((i - R - s.cx) / 3) || Math.floor((j + b - R - s.cz) / 3) !== Math.floor((j - R - s.cz) / 3))) f.touch++;
      if (Math.floor((i - R - s.cx) / 3) === 0 || Math.floor((j - R - s.cz) / 3) === 0) { f.spine++; if (into[k]) f.reached++; if (outOf[k]) f.left++; }
    }
    let whole = 0, crossed = 0, touching = 0;
    for (const [s, f] of fields) {
      whole++; touching += f.touch;
      if (f.reached === f.spine && f.left === f.spine) crossed++;
      if (!pick && s.rx >= 7) { pick = s; pickSeed = seed; }
    }
    rows.push({ seed, whole, crossed, touching });
  }
  const tell = (f) => rows.map((r) => `${r.seed} ${f(r)}`).join('; ');
  say('column fields stand in the burn', rows.every((r) => r.whole >= 3), tell((r) => `${r.whole} whole fields`));
  say('no two columns touch: every step across is a jump over magma', rows.every((r) => r.touching === 0),
      tell((r) => `${r.touching} touching`));
  say('and every field is crossed: each column on its two lines is reached, and left',
      rows.every((r) => r.crossed === r.whole), tell((r) => `${r.crossed}/${r.whole}`));
  const gb = GOLDEN_SEEDS.find((g) => g.nm === 'ash'), gg = makeGen(gb.seed, gb.force);
  const gn = gg.basaltIn(gb.ox - 128, gb.oz - 128, gb.ox + 128, gb.oz + 128);
  say('and round the golden ash window too', gn >= 2, `${gn} fields within 128 m of ${gb.seed}'s window`);

  /* A body crosses one: along its line from rim to rim, a jump at each lip. */
  let crossed = 'no field wide enough';
  if (pick) {
    const cw = buildWorld({ seed: pickSeed, size: 64, ox: pick.cx, oz: pick.cz }), cc = colliderForWorld(cw);
    const b = placeOnGround(cc, -pick.rx - 2, 0.5);
    const drops = () => cc.supportUnder(b.x + RUN * TICK, b.z, ACTOR.radius, b.y + EPS) < b.y - MOVE.step;
    let jumps = 0;
    for (let t = 0; t < 1200 && !b.dead && b.x < pick.rx + 2; t++) {
      const j = b.grounded && (b.blocked || drops());
      if (j) jumps++;
      step(cc, b, { mx: 1, mz: 0, jump: j });
    }
    crossed = { ok: !b.dead && b.x >= pick.rx + 2 && jumps >= Math.floor(2 * pick.rx / 3),
      detail: `${pickSeed} ${pick.cx},${pick.cz}, ${2 * pick.rx + 1} m across: ended at ${b.x.toFixed(1)}, ${b.dead || 'alive'}, ${jumps} jumps` };
  }
  say('a body crosses one from rim to rim, a jump at each lip', crossed.ok === true, crossed.detail || crossed);
  return out;
}

/* Seeds with pine enough for several cliff bands in 600 m. */
const CLIFF_SEEDS = ['EMBERFALL', 'QUARTERSTONE'];

/**
 * Cliff bands (#76, Cloudpine): a face you cannot jump, and a ledge line up it.
 *
 * Over the cell field, for every band wholly in the sample: its face stands
 * more than a double jump over the ground in front of it, wherever there is
 * no ledge. Then two floods confined to the front of the band — the apron,
 * the ledges and the face row, never the slope behind — from the apron:
 * with the ledges the face row is reached, and without them it is not. So
 * the ledges are the way up the front, and the only one. On a built window a
 * body climbs one: along the ledges, a jump at each, then onto the top.
 */
export function cliffSuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });
  const rows = [];
  let pick = null, pickSeed = null;
  for (const seed of CLIFF_SEEDS) {
    const G = makeGen(seed, null), R = 300, N = 2 * R;
    const S = new Float32Array(N * N), kind = new Uint8Array(N * N), dry = new Uint8Array(N * N), site = new Array(N * N);
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const c = G.cell(i - R, j - R), k = i * N + j;
      S[k] = c.water ? c.wl : c.H; kind[k] = c.cliff || 0;
      dry[k] = c.magma || (c.water && c.wl - c.H > 1.5) ? 0 : 1;
      if (kind[k]) site[k] = G.cliffOver(i - R, j - R);
    }
    const bands = new Map();
    const band = (s) => { if (!bands.has(s)) bands.set(s, { low: 0, faces: 0, up: false, cheat: false }); return bands.get(s); };
    for (let k = 0; k < N * N; k++) {
      if (kind[k] !== 2) continue;
      const s = site[k]; if (!s || Math.abs(s.cx) > R - 40 || Math.abs(s.cz) > R - 40) continue;
      const b = band(s), i = (k / N) | 0, j = k % N;
      /* The cell in front: one step out of the band, across the face. */
      const fi = s.ax ? i : i - s.sg, fj = s.ax ? j - s.sg : j, fk = fi * N + fj;
      if (kind[fk] === 3 || !dry[fk]) continue;
      b.faces++; if (S[k] - S[fk] <= MOVE.climb2) b.low++;
    }
    const flood = (ledges) => {
      const ok = (k) => dry[k] && (kind[k] === 4 || kind[k] === 2 || (ledges && kind[k] === 3));
      const seen = new Uint8Array(N * N), q = [];
      for (let k = 0; k < N * N; k++) if (kind[k] === 4 && dry[k]) { seen[k] = 1; q.push(k); }
      for (let h = 0; h < q.length; h++) {
        const k = q[h], i = (k / N) | 0, j = k % N;
        for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ii = i + a, jj = j + b; if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue;
          const p = ii * N + jj; if (seen[p] || !ok(p)) continue;
          const dh = S[p] - S[k]; if (dh <= MOVE.climb2 && dh >= -MOVE.fall) { seen[p] = 1; q.push(p); }
        }
      }
      return seen;
    };
    const withL = flood(true), without = flood(false);
    for (let k = 0; k < N * N; k++) {
      if (kind[k] !== 2 || !bands.has(site[k])) continue;
      const b = bands.get(site[k]);
      if (withL[k]) b.up = true;
      if (without[k]) b.cheat = true;
    }
    let whole = 0, low = 0, up = 0, cheat = 0;
    for (const [s, b] of bands) {
      whole++; low += b.low; if (b.up) up++; if (b.cheat) cheat++;
      if (!pick && s.ln >= 3) { pick = s; pickSeed = seed; }
    }
    rows.push({ seed, whole, low, up, cheat });
  }
  const tell = (f) => rows.map((r) => `${r.seed} ${f(r)}`).join('; ');
  say('cliff bands stand in the pines', rows.every((r) => r.whole >= 3), tell((r) => `${r.whole} whole bands`));
  say('each face is more than a double jump wherever there is no ledge', rows.every((r) => r.low === 0),
      tell((r) => `${r.low} low face cells`));
  say('and its ledge line climbs it from the front', rows.every((r) => r.up === r.whole), tell((r) => `${r.up}/${r.whole}`));
  say('and nothing else does: take the ledges away and the front is a wall', rows.every((r) => r.cheat === 0),
      tell((r) => `${r.cheat} climbed without them`));
  const gp = GOLDEN_SEEDS.find((g) => g.nm === 'pine'), gg = makeGen(gp.seed, gp.force);
  const gn = gg.cliffIn(gp.ox - 128, gp.oz - 128, gp.ox + 128, gp.oz + 128);
  say('and round the golden pine window too', gn >= 2, `${gn} bands within 128 m of ${gp.seed}'s window`);

  /* A body climbs one: along the ledges, jumping at each, then into the band. */
  let climbed = 'no band with three ledges';
  if (pick) {
    const cw = buildWorld({ seed: pickSeed, size: 64, ox: pick.cx, oz: pick.cz }), cc = colliderForWorld(cw);
    /* The site's frame in the window's: along is x or z, across the other. */
    const at = (al, ac) => (pick.ax ? [al, ac * pick.sg] : [ac * pick.sg, al]);
    const alongV = pick.ax ? [1, 0] : [0, 1], intoV = pick.ax ? [0, pick.sg] : [pick.sg, 0];
    const p0 = at(pick.l0 - 3, -1), b = placeOnGround(cc, p0[0], p0[1]);
    const frame = () => cw.G.cliffFrame(pick, b.x + pick.cx, b.z + pick.cz);
    let jumps = 0, t = 0;
    const last = pick.l0 + 2 * pick.ln - 1;
    for (; t < 1500 && !b.dead; t++) {
      const [al, ac] = frame();
      const dir = al < last ? alongV : intoV;
      if (ac > 1.5) break;
      const j = b.grounded && b.blocked;
      if (j) jumps++;
      step(cc, b, { mx: dir[0], mz: dir[1], jump: j });
    }
    const [al, ac] = frame();
    climbed = { ok: !b.dead && ac > 0.5 && b.y >= pick.T - 1.5 && jumps >= pick.ln,
      detail: `${pickSeed} ${pick.cx},${pick.cz}, ${pick.ln} ledges to a ${pick.T - pick.lg} m face: ended ${ac.toFixed(1)} m into the band at ${b.y.toFixed(2)} against a top of ${pick.T}, ${jumps} jumps` };
  }
  say('a body climbs a ledge line onto the band, a jump at each ledge', climbed.ok === true, climbed.detail || climbed);
  return out;
}

/* Seeds with thorn enough for thickets in 600 m. */
const THORN_SEEDS = ['CINDERFALL', 'EMBERFALL'];

/**
 * Thickets (#76, Thornwood): a patch nobody gets into or over, and a log
 * through it that is the way across.
 *
 * On built windows round the first few thickets of each seed — props and
 * all, since the thicket *is* props — the collider's own heights, a voxel at
 * a time, flooded from the window's edge under the budget: up a double jump,
 * down a fall. No column of thicket is reached, top or inside; the log is.
 * Then a body walks the log's line from open ground to open ground, a jump
 * onto it and none needed after.
 */
export function thornSuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });
  const sites = [];
  for (const seed of THORN_SEEDS) {
    const G = makeGen(seed, null), seen = new Set();
    for (let x = -300; x <= 300 && sites.filter((q) => q[0] === seed).length < 3; x += 4) for (let z = -300; z <= 300; z += 4) {
      const s = G.thornOver(x, z); if (!s || seen.has(s)) continue;
      seen.add(s); sites.push([seed, s]); if (sites.filter((q) => q[0] === seed).length >= 3) break;
    }
  }
  /* A double jump at the thicket: pressed at the wall and again at the top
     of the rise, still pushing in. It has worked if the body ends up over the
     thicket's ground — on it or in it. */
  const tries = (w, col, x, z, dx, dz, inside, top) => {
    /* On the ground, not on whatever stands highest there: beside a tree
       that is the tree, and a run in from a treetop is not what is asked. */
    const g = w.cells[Math.round(x + 32) * w.M + Math.round(z + 32)].H;
    const b = placeOnGround(col, x, z, g + 1.5); b.top = top;
    for (let t = 0; t < 150 && !b.dead; t++) {
      const j = (b.grounded && t > 2) || (!b.grounded && b.airJumps > 0 && b.vy <= 0);
      step(col, b, { mx: dx, mz: dz, jump: j });
    }
    if (!inside(b.x, b.z)) return null;
    /* In it: thicket over its head. On it: standing near its top. Against its
       outer wall, neither — which is where the offset prop lattice leaves a
       body an ellipse test would call inside. */
    const over = col.supportUnder(b.x, b.z, 0.01, CEIL * 2);
    return over > b.y + 1.5 || b.y > b.top - 1 ? b : null;
  };
  let got = [], attempts = 0, crossed = [], H = 0;
  for (const [seed, s] of sites) {
    const w = buildWorld({ seed, size: 64, ox: s.cx, oz: s.cz }), col = colliderForWorld(w);
    /* Over the thicket's own ground, a quarter-metre in from its edge, and
       not on the log's lane. */
    const inside = (x, z) => {
      const ex = x / (s.rx - 0.25), ez = z / (s.rz - 0.25);
      return ex * ex + ez * ez <= 1 && (s.ax ? Math.abs(z) > 0.75 : Math.abs(x) > 0.75);
    };
    /* From outside, at twelve points round it, running straight in. */
    for (let a = 0; a < 12; a++) {
      const u = cos(a * Math.PI / 6), v = sin(a * Math.PI / 6);
      const x = u * (s.rx + 1.5), z = v * (s.rz + 1.5);
      if (s.ax ? Math.abs(z) < 1.5 : Math.abs(x) < 1.5) continue;
      attempts++;
      const b = tries(w, col, x, z, -u, -v, inside, s.top);
      if (b) got.push(`${seed} ${s.cx},${s.cz} from ${x.toFixed(0)},${z.toFixed(0)} to ${b.x.toFixed(1)},${b.y.toFixed(1)},${b.z.toFixed(1)}`);
    }
    /* From the log, at every other metre along it, off to each side. */
    const r = s.ax ? s.rx : s.rz;
    for (let t = -r + 1; t <= r - 1; t += 2) for (const side of [-1, 1]) {
      const x = s.ax ? t : 0, z = s.ax ? 0 : t, dx = s.ax ? 0 : side, dz = s.ax ? side : 0;
      attempts++;
      const b = tries(w, col, x, z, dx, dz, inside, s.top);
      if (b) got.push(`${seed} ${s.cx},${s.cz} off the log at ${t} to ${b.x.toFixed(1)},${b.y.toFixed(1)},${b.z.toFixed(1)}`);
    }
    /* Along the log, from open ground to open ground. */
    const at = (t) => (s.ax ? [t, 0] : [0, t]), dir = s.ax ? [1, 0] : [0, 1];
    const p0 = at(-r - 3), body = placeOnGround(col, p0[0], p0[1]);
    for (let t = 0; t < 900 && !body.dead && (s.ax ? body.x : body.z) < r + 3; t++) {
      step(col, body, { mx: dir[0], mz: dir[1], jump: body.grounded && body.blocked });
    }
    const end = s.ax ? body.x : body.z;
    if (body.dead || end < r + 3) crossed.push(`${seed} ${s.cx},${s.cz} stopped at ${end.toFixed(1)} of ${r + 3}`);
    else H++;
  }
  say('thickets stand in the thorn, and no double jump gets into one or onto it', sites.length >= 6 && got.length === 0,
      got.length ? got.slice(0, 6).join('; ') : `${sites.length} thickets built, ${attempts} double jumps at them from outside and off their logs, none got in`);
  say('and a body walks its log from one side to the other', crossed.length === 0,
      crossed.length ? crossed.join('; ') : `${H}/${sites.length} crossed along the log`);
  const gt = GOLDEN_SEEDS.find((g) => g.nm === 'thorn'), gg = makeGen(gt.seed, gt.force);
  const gn = gg.thornIn(gt.ox - 128, gt.oz - 128, gt.ox + 128, gt.oz + 128);
  say('and round the golden thorn window too', gn >= 2, `${gn} thickets within 128 m of ${gt.seed}'s window`);
  return out;
}

/* Seeds with rime enough for crevasse fields in 600 m. */
const RIME_SEEDS = ['QUARTERSTONE', 'ICEBOUND', 'COLDHARBOUR'];

/**
 * Crevasse fields (#76, Rimewaste): a glacier cut across by crevasses, each
 * crossed by one snow bridge, with a stair out of it onto the side a body
 * fell from.
 *
 * Over the cell field of each field's sheet, the floods of the mesa suite —
 * up a double jump, down a fall, over one lower cell — from the first band of
 * ice: with the bridges every band is reached; without them none past the
 * first, the floors and stairs included. From every floor cell the ice is
 * reached again. Then, on built windows and against the collider: a body
 * walks bridge to bridge from one end to the other; double jumps at every
 * crevasse from its near lip land nobody on the far side; and a body dropped
 * on a floor either side of the bridge climbs a stair out.
 */
export function rimeSuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });
  const W = 7, D = 4;
  const sites = [];
  for (const seed of RIME_SEEDS) {
    const G = makeGen(seed, null), seen = new Set();
    for (let x = -300; x <= 300 && sites.filter((q) => q[0] === seed).length < 2; x += 4) for (let z = -300; z <= 300; z += 4) {
      const s = G.rimeOver(x, z); if (!s || seen.has(s)) continue;
      seen.add(s); sites.push([seed, s, G]); if (sites.filter((q) => q[0] === seed).length >= 2) break;
    }
  }
  /* Which band of ice (0..n) an along-coordinate is on, or -1 in a crevasse. */
  const bandOf = (s, al) => {
    for (let k = 0; k < s.n; k++) { if (al < s.cr[k]) return k; if (al < s.cr[k] + W) return -1; }
    return s.n;
  };
  const flat = [], cheats = [], traps = [];
  for (const [seed, s, G] of sites) {
    /* The sheet in its own frame: along a, across c. */
    const A = s.hi - s.lo + 1, C = 2 * s.wd + 1, N = A * C;
    const Hc = new Float32Array(N), kind = new Uint8Array(N);
    for (let a = 0; a < A; a++) for (let c = 0; c < C; c++) {
      const al = s.lo + a, ac = c - s.wd;
      const [x, z] = s.ax ? [s.cx + al, s.cz + ac] : [s.cx + ac, s.cz + al];
      const cl = G.cell(x, z); Hc[a * C + c] = cl.H; kind[a * C + c] = cl.rime;
    }
    const flood = (seeds, bridges, back) => {
      const Hh = (k) => (!bridges && kind[k] === 3 ? s.S - D : Hc[k]);
      const seen = new Uint8Array(N), q = [];
      for (const k of seeds) { seen[k] = 1; q.push(k); }
      for (let h = 0; h < q.length; h++) {
        const k = q[h], a = (k / C) | 0, c = k % C;
        for (const [da, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const a1 = a + da, c1 = c + dc; if (a1 < 0 || c1 < 0 || a1 >= A || c1 >= C) continue;
          const p = a1 * C + c1;
          if (!seen[p]) {
            const dh = back ? Hh(k) - Hh(p) : Hh(p) - Hh(k);
            if (dh <= MOVE.climb2 && dh >= -MOVE.fall) { seen[p] = 1; q.push(p); }
          }
          const a2 = a + 2 * da, c2 = c + 2 * dc; if (a2 < 0 || c2 < 0 || a2 >= A || c2 >= C) continue;
          const p2 = a2 * C + c2; if (seen[p2]) continue;
          if (Hh(p) <= Hh(k) - 1 && Math.abs(Hh(p2) - Hh(k)) <= MOVE.slope) { seen[p2] = 1; q.push(p2); }
        }
      }
      return seen;
    };
    const band0 = [], ice = [];
    for (let k = 0; k < N; k++) if (kind[k] === 1) { ice.push(k); if (bandOf(s, s.lo + ((k / C) | 0)) === 0) band0.push(k); }
    const bands = (seen) => { const b = new Set(); for (const k of ice) if (seen[k]) b.add(bandOf(s, s.lo + ((k / C) | 0))); return b.size; };
    const withB = bands(flood(band0, true, false)), without = bands(flood(band0, false, false));
    if (withB !== s.n + 1) flat.push(`${seed} ${s.cx},${s.cz}: ${withB}/${s.n + 1} bands`);
    if (without !== 1) cheats.push(`${seed} ${s.cx},${s.cz}: ${without} bands without bridges`);
    /* From every floor and stair cell, some ice is reached: flooded back
       from the ice, every one of them is in it. With the bridges standing —
       one walls a floor in two, and each half needs its own way out. */
    const home = flood(ice, true, true);
    let lost = 0; for (let k = 0; k < N; k++) if ((kind[k] === 2 || kind[k] === 4) && !home[k]) lost++;
    if (lost) traps.push(`${seed} ${s.cx},${s.cz}: ${lost} floor cells with no way out`);
  }
  say('crevasse fields stand in the rime', sites.length >= 5, `${sites.length} fields over ${RIME_SEEDS.length} seeds`);
  say('and over the bridges every band of ice is reached from the first', flat.length === 0,
      flat.length ? flat.join('; ') : `${sites.length} fields, every band reached`);
  say('and without them none past the first, down in the crevasses or not', cheats.length === 0,
      cheats.length ? cheats.join('; ') : `${sites.length} fields, one band each without bridges`);
  say('and a body in a crevasse always has a way out', traps.length === 0,
      traps.length ? traps.join('; ') : 'every floor and stair cell climbs back to the ice');

  /* On built windows, against the collider. */
  const walked = [], leapt = [], stuck = [], standing = [];
  let leaps = 0, climbs = 0;
  for (const [seed, s] of sites.slice(0, 4)) {
    const w = buildWorld({ seed, size: 96, ox: s.cx, oz: s.cz }), col = colliderForWorld(w);
    /* The window's own coordinates of a point in the site's frame. */
    const at = (al, ac) => (s.ax ? [al, ac] : [ac, al]);
    const fr = (b) => (s.ax ? [b.x, b.z] : [b.z, b.x]);
    const steerTo = (b, al, ac, limit) => {
      for (let t = 0; t < limit && !b.dead; t++) {
        const [a, c] = fr(b), da = al - a, dc = ac - c, d = hyp(da, dc);
        if (d < 0.3) return true;
        const [mx, mz] = at(da / d, dc / d);
        step(col, b, { mx, mz, jump: b.grounded && b.blocked });
      }
      return false;
    };
    /* Nothing stands in a crevasse: over its floor, clear of the stairs and
       the bridge, the collider's ground is the floor, snow and all. A pile
       of scree or a rim hung from the skirt is a way across or out. */
    for (let k = 0; k < s.n; k++) for (let o = 0.125; o < W; o += 0.25) for (let ac = -s.wd + 0.125; ac < s.wd + 1; ac += 0.25) {
      const cell = Math.round(ac);
      if (Math.abs(cell) > s.wd || (o < 2 && Math.abs(cell) >= s.wd - 2) || (cell >= s.br[k] - 1 && cell <= s.br[k] + 2)) continue;
      const [x, z] = at(s.cr[k] - 0.5 + o, ac), top = col.supportUnder(x, z, 0.01, CEIL * 2);
      if (top > s.S - D + 0.5) { standing.push(`${seed} ${s.cx},${s.cz} crevasse ${k} at ${o.toFixed(2)},${ac.toFixed(2)}: ${top.toFixed(2)}`); break; }
    }
    /* Bridge to bridge, from the first band's middle to the last's. */
    const p0 = at(s.lo + 2, s.br[0] + 1), body = placeOnGround(col, p0[0], p0[1]);
    let ok = true;
    for (let k = 0; k < s.n && ok; k++) {
      const mid = s.br[k] + 1;
      ok = steerTo(body, s.cr[k] - 2, mid, 900) && steerTo(body, s.cr[k] + W + 1.5, mid, 900);
    }
    if (!ok || body.y < s.S - 0.5) walked.push(`${seed} ${s.cx},${s.cz} stopped at ${fr(body).map((v) => v.toFixed(1))} y ${body.y.toFixed(2)}`);
    /* A double jump at every crevasse from its near lip, a run-up of three
       metres, at three places across it clear of the bridge and the stair. */
    for (let k = 0; k < s.n; k++) for (const ac of [-s.wd + 1.5, 0.5, s.wd - 3.5]) {
      if (ac >= s.br[k] - 1 && ac <= s.br[k] + 3) continue;
      leaps++;
      const q = at(s.cr[k] - 3.5, ac), b = placeOnGround(col, q[0], q[1]);
      const dir = at(1, 0);
      for (let t = 0; t < 150 && !b.dead; t++) {
        const j = (b.grounded && t > 2) || (!b.grounded && b.airJumps > 0 && b.vy <= 0);
        step(col, b, { mx: dir[0], mz: dir[1], jump: j });
      }
      const [a] = fr(b);
      if (a >= s.cr[k] + W && b.y > s.S - 1) leapt.push(`${seed} ${s.cx},${s.cz} crevasse ${k} at ${ac}: landed ${a.toFixed(1)},${b.y.toFixed(2)}`);
    }
    /* Dropped on a floor either side of the bridge, clear of the stairs:
       out by the stair at that end, onto the near band. */
    for (let k = 0; k < s.n; k++) for (const e of [-1, 1]) {
      const f = at(s.cr[k] + 4, e > 0 ? s.wd - 4 : -s.wd + 4), b = placeOnGround(col, f[0], f[1]);
      const reach = steerTo(b, s.cr[k] + 3.5, e * (s.wd - 2.5), 600) && steerTo(b, s.cr[k] + 0.5, e * (s.wd - 2.5), 600);
      /* Up the stair toward the end wall, jumping at each step; from its top a
         jump back onto the ice beside it. */
      const dirE = at(0, e), dirN = at(-1, 0);
      let t = 0;
      for (; t < 240 && !b.dead && e * fr(b)[1] < s.wd - 0.4; t++) step(col, b, { mx: dirE[0], mz: dirE[1], jump: b.grounded && b.blocked });
      for (t = 0; t < 200 && !b.dead && !(b.grounded && fr(b)[0] < s.cr[k] - 0.5); t++) {
        const j = (b.grounded && t > 2) || (!b.grounded && b.airJumps > 0 && b.vy <= 0);
        step(col, b, { mx: dirN[0], mz: dirN[1], jump: j });
      }
      climbs++;
      if (!reach || b.y < s.S - 0.5 || bandOf(s, Math.floor(fr(b)[0])) !== k)
        stuck.push(`${seed} ${s.cx},${s.cz} crevasse ${k} end ${e}: ended at ${fr(b).map((v) => v.toFixed(1))} y ${b.y.toFixed(2)} against ice at ${s.S}`);
    }
  }
  say('nothing stands in a crevasse on a built window: its floor is the floor', standing.length === 0,
      standing.length ? standing.slice(0, 6).join('; ') : `${Math.min(4, sites.length)} fields, every crevasse clear`);
  say('a body walks the bridges from one end of a field to the other', walked.length === 0,
      walked.length ? walked.join('; ') : `${Math.min(4, sites.length)} fields crossed`);
  say('and no double jump clears a crevasse', leapt.length === 0,
      leapt.length ? leapt.slice(0, 6).join('; ') : `${leaps} double jumps from the near lip, none landed across`);
  say('and a body dropped in one climbs a stair out, onto the side it fell from', stuck.length === 0,
      stuck.length ? stuck.slice(0, 6).join('; ') : `${climbs} of ${climbs} climbed out`);
  const gr = GOLDEN_SEEDS.find((g) => g.nm === 'rime'), gg = makeGen(gr.seed, gr.force);
  const gn = gg.rimeIn(gr.ox - 128, gr.oz - 128, gr.ox + 128, gr.oz + 128);
  say('and round the golden rime window too', gn >= 2, `${gn} fields within 128 m of ${gr.seed}'s window`);
  return out;
}

/* Seeds with spore enough for towers in 600 m. */
const SPORE_SEEDS = ['MOSSGATE', 'DUSKWARD', 'COLDHARBOUR'];

/**
 * Fungal towers (#76, Sporeverge): a stalk nobody climbs, and a spiral of
 * shelves round it that is the way up.
 *
 * Over the cell field round each tower, the floods of the mesa suite from
 * all the ground that is neither stalk nor shelf: with the shelves the cap is
 * reached, and left; with them taken away it is not. Then, on built windows
 * and against the collider — where a high shelf is a slab with air under it —
 * a body climbs the spiral shelf by shelf onto the cap, and double jumps at
 * the stalk from all round it land nobody on top.
 */
export function sporeSuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });
  const sites = [];
  for (const seed of SPORE_SEEDS) {
    const G = makeGen(seed, null), seen = new Set();
    for (let x = -300; x <= 300 && sites.filter((q) => q[0] === seed).length < 3; x += 4) for (let z = -300; z <= 300; z += 4) {
      const s = G.sporeOver(x, z); if (!s || seen.has(s)) continue;
      seen.add(s); sites.push([seed, s, G]); if (sites.filter((q) => q[0] === seed).length >= 3) break;
    }
  }
  const unreached = [], stranded = [], cheats = [];
  let floating = 0;
  for (const [seed, s, G] of sites) {
    const E = s.R + 9, N = 2 * E + 1;
    const Hc = new Float32Array(N * N), bare = new Float32Array(N * N), kind = new Uint8Array(N * N), dry = new Uint8Array(N * N);
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const c = G.cell(s.cx + i - E, s.cz + j - E), k = i * N + j;
      Hc[k] = c.water ? c.wl : c.H; kind[k] = c.spore;
      dry[k] = c.magma || (c.water && c.wl - c.H > 1.5) ? 0 : 1;
      if (c.sporeLo) floating++;
      /* With the shelf taken away, the ground it stood over. */
      bare[k] = c.spore === 2 ? (c.sporeLo || s.G) : Hc[k];
    }
    const flood = (H, back) => {
      const seen = new Uint8Array(N * N), q = [];
      for (let k = 0; k < N * N; k++) if (dry[k] && kind[k] !== 1 && kind[k] !== 2) { seen[k] = 1; q.push(k); }
      for (let h = 0; h < q.length; h++) {
        const k = q[h], i = (k / N) | 0, j = k % N;
        for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ii = i + a, jj = j + b; if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue;
          const p = ii * N + jj;
          if (!seen[p] && dry[p]) {
            const dh = back ? H[k] - H[p] : H[p] - H[k];
            if (dh <= MOVE.climb2 && dh >= -MOVE.fall) { seen[p] = 1; q.push(p); }
          }
          const i2 = i + 2 * a, j2 = j + 2 * b; if (i2 < 0 || j2 < 0 || i2 >= N || j2 >= N) continue;
          const p2 = i2 * N + j2; if (seen[p2] || !dry[p2]) continue;
          if (H[p] <= H[k] - 1 && Math.abs(H[p2] - H[k]) <= MOVE.slope) { seen[p2] = 1; q.push(p2); }
        }
      }
      return seen;
    };
    const cap = [...Array(N * N).keys()].filter((k) => kind[k] === 1);
    const up = flood(Hc, false), down = flood(Hc, true), bareUp = flood(bare, false);
    if (!cap.some((k) => up[k])) unreached.push(`${seed} ${s.cx},${s.cz}`);
    if (!cap.some((k) => down[k])) stranded.push(`${seed} ${s.cx},${s.cz}`);
    if (cap.some((k) => bareUp[k])) cheats.push(`${seed} ${s.cx},${s.cz}`);
  }
  say('fungal towers stand in the spore', sites.length >= 6, `${sites.length} towers over ${SPORE_SEEDS.length} seeds, ${floating} shelf cells with air under them`);
  say('and up their shelves every cap is reached, and left, from the ground', unreached.length === 0 && stranded.length === 0,
      unreached.length || stranded.length ? `not reached: ${unreached.join(', ') || 'none'}; not left: ${stranded.join(', ') || 'none'}` : `${sites.length} caps reached and left`);
  say('and without the shelves no cap is reached', cheats.length === 0,
      cheats.length ? cheats.join('; ') : `${sites.length} towers, none climbed without them`);

  /* On built windows, against the collider. */
  const climbed = [], got = [], props = [];
  let tries = 0, done = 0;
  for (const [seed, s] of sites.slice(0, 5)) {
    const w = buildWorld({ seed, size: 64, ox: s.cx, oz: s.cz }), col = colliderForWorld(w);
    /* No prop stands within the tower's reach: a canopy leaning over the
       stalk is a way onto the cap, and one over the shelves a way past them. */
    const ps = w.propStart === undefined ? w.pos.length / 3 : w.propStart, E = s.R + 3;
    for (let q = ps; q < w.pos.length / 3; q++) {
      const x = w.pos[q * 3], y = w.pos[q * 3 + 1], z = w.pos[q * 3 + 2];
      if (Math.abs(x) <= E && Math.abs(z) <= E && y > s.G + 0.5) { props.push(`${seed} ${s.cx},${s.cz}: a prop at ${x},${y},${z}`); break; }
    }
    const onCap = (b) => Math.abs(b.x) <= s.R + 0.5 && Math.abs(b.z) <= s.R + 0.5 && b.y > s.T - 0.5;
    /* Shelf by shelf, jumping at each, then onto the cap. */
    const targets = s.shelves.map((run, i) => [run[0][0] + (run[1][0] - run[0][0]) / 2, run[0][1] + (run[1][1] - run[0][1]) / 2, s.G + 1 + i]);
    targets.push([0, 0, s.T]);
    const f = s.shelves[0][0], st = [f[0] * 1.8, f[1] * 1.8];
    const g0 = w.cells[Math.round(st[0] + 32) * w.M + Math.round(st[1] + 32)].H;
    const b = placeOnGround(col, st[0], st[1], g0 + 1.5);
    let ti = 0;
    for (let t = 0; t < 3000 && !b.dead && ti < targets.length; t++) {
      const [tx, tz, th] = targets[ti], dx = tx - b.x, dz = tz - b.z, d = hyp(dx, dz);
      if (b.grounded && d < 0.45 && b.y > th - 0.3) { ti++; continue; }
      /* From the lip of one shelf, a metre short of the next one's middle
         and a metre of air between; again at the top of the arc if the
         next is still over head height. */
      const near = d < 2.2 && th > b.y + 0.3;
      const j = (b.grounded && (b.blocked || near)) || (!b.grounded && b.airJumps > 0 && b.vy <= 0 && th > b.y - 0.2);
      const sp = d > 0.01 ? Math.min(1, d / 0.6) : 0;
      step(col, b, { mx: sp * dx / (d || 1), mz: sp * dz / (d || 1), jump: j });
    }
    if (onCap(b) && !b.dead) done++;
    else climbed.push(`${seed} ${s.cx},${s.cz}: shelf ${ti} of ${s.n}, at ${b.x.toFixed(1)},${b.y.toFixed(2)},${b.z.toFixed(1)}${b.dead ? ' dead' : ''}`);
    /* Double jumps at the stalk from twelve points round it, run straight in. */
    for (let a = 0; a < 12; a++) {
      const u = cos(a * Math.PI / 6), v = sin(a * Math.PI / 6), x = u * (s.R + 3), z = v * (s.R + 3);
      const g = w.cells[Math.round(x + 32) * w.M + Math.round(z + 32)].H;
      const c = placeOnGround(col, x, z, g + 1.5);
      tries++;
      for (let t = 0; t < 150 && !c.dead; t++) {
        const j = (c.grounded && t > 2) || (!c.grounded && c.airJumps > 0 && c.vy <= 0);
        step(col, c, { mx: -u, mz: -v, jump: j });
      }
      if (onCap(c)) got.push(`${seed} ${s.cx},${s.cz} from ${x.toFixed(0)},${z.toFixed(0)} at y ${c.y.toFixed(2)}`);
    }
  }
  say('nothing grows within three metres of a stalk on a built window', props.length === 0,
      props.length ? props.join('; ') : `${Math.min(5, sites.length)} towers, no prop within reach`);
  say('a body climbs the shelves onto the cap, a jump at each', climbed.length === 0,
      climbed.length ? climbed.join('; ') : `${done} towers climbed`);
  say('and no double jump from the ground lands on one', got.length === 0,
      got.length ? got.slice(0, 6).join('; ') : `${tries} double jumps at the stalks, none on a cap`);
  const gs = GOLDEN_SEEDS.find((g) => g.nm === 'spore'), gg = makeGen(gs.seed, gs.force);
  const gn = gg.sporeIn(gs.ox - 128, gs.oz - 128, gs.ox + 128, gs.oz + 128);
  say('and round the golden spore window too', gn >= 2, `${gn} towers within 128 m of ${gs.seed}'s window`);
  return out;
}

/* Seeds with glass enough for shard fields in 600 m. */
const GLASS_SEEDS = ['MOSSGATE', 'ALDER-RUN', 'GLASSMERE'];

/**
 * Shard fields (#76, Glasslands): glass nobody gets into or onto, and a lane
 * of vitrified plates through it that is the way across.
 *
 * On built windows round the first few fields of each seed — props and all,
 * as with the thickets — double jumps from twelve points round each field,
 * and off every plate at the walls either side of it: none ends up in the
 * glass or on it. Then a body crosses the lane plate to plate, from open
 * ground to open ground, hopping each slot.
 */
export function glassSuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });
  const sites = [];
  for (const seed of GLASS_SEEDS) {
    const G = makeGen(seed, null), seen = new Set();
    for (let x = -300; x <= 300 && sites.filter((q) => q[0] === seed).length < 3; x += 4) for (let z = -300; z <= 300; z += 4) {
      const s = G.glassOver(x, z); if (!s || seen.has(s)) continue;
      seen.add(s); sites.push([seed, s]); if (sites.filter((q) => q[0] === seed).length >= 3) break;
    }
  }
  const tries = (w, col, x, z, dx, dz, inside, top) => {
    const g = w.cells[Math.round(x + 32) * w.M + Math.round(z + 32)].H;
    const b = placeOnGround(col, x, z, g + 1.5);
    for (let t = 0; t < 150 && !b.dead; t++) {
      const j = (b.grounded && t > 2) || (!b.grounded && b.airJumps > 0 && b.vy <= 0);
      step(col, b, { mx: dx, mz: dz, jump: j });
    }
    if (!inside(b.x, b.z)) return null;
    const over = col.supportUnder(b.x, b.z, 0.01, CEIL * 2);
    return over > b.y + 1.5 || b.y > top - 1 ? b : null;
  };
  const got = [], crossed = [];
  let attempts = 0, H = 0;
  for (const [seed, s] of sites) {
    const w = buildWorld({ seed, size: 64, ox: s.cx, oz: s.cz }), col = colliderForWorld(w);
    const r = s.ax ? s.rx : s.rz;
    /* Over the glass, a quarter-metre in from its edge and off the lane. */
    const inside = (x, z) => {
      const ex = x / (s.rx - 0.25), ez = z / (s.rz - 0.25), u = s.ax ? z : x;
      return ex * ex + ez * ez <= 1 && (u < -0.25 || u > 1.75);
    };
    for (let a = 0; a < 12; a++) {
      const u = cos(a * Math.PI / 6), v = sin(a * Math.PI / 6);
      const x = u * (s.rx + 1.5), z = v * (s.rz + 1.5), lu = s.ax ? z : x;
      if (lu > -1.5 && lu < 2.5) continue;
      attempts++;
      const b = tries(w, col, x, z, -u, -v, inside, s.top);
      if (b) got.push(`${seed} ${s.cx},${s.cz} from ${x.toFixed(0)},${z.toFixed(0)} to ${b.x.toFixed(1)},${b.y.toFixed(1)},${b.z.toFixed(1)}`);
    }
    /* Off every plate, at the walls either side. */
    for (let t = -r - 1; t <= r + 1; t++) {
      if ((((t + r + 1) % 3) + 3) % 3 === 2) continue;
      for (const side of [-1, 1]) {
        const u0 = side < 0 ? 0.3 : 0.7;
        const x = s.ax ? t : u0, z = s.ax ? u0 : t, dx = s.ax ? 0 : side, dz = s.ax ? side : 0;
        attempts++;
        const b = tries(w, col, x, z, dx, dz, inside, s.top);
        if (b) got.push(`${seed} ${s.cx},${s.cz} off the plate at ${t} to ${b.x.toFixed(1)},${b.y.toFixed(1)},${b.z.toFixed(1)}`);
      }
    }
    /* Along the lane, plate to plate: a jump wherever the ground just ahead
       falls away. */
    const at = (t) => (s.ax ? [t, 0.5] : [0.5, t]), dir = s.ax ? [1, 0] : [0, 1];
    const p0 = at(-r - 3), body = placeOnGround(col, p0[0], p0[1]);
    for (let t = 0; t < 900 && !body.dead && (s.ax ? body.x : body.z) < r + 3; t++) {
      const ahead = col.supportUnder(body.x + dir[0] * 0.7, body.z + dir[1] * 0.7, 0.01, body.y + 0.5);
      const j = body.grounded && (body.blocked || ahead < body.y - 0.5);
      step(col, body, { mx: dir[0], mz: dir[1], jump: j });
    }
    const end = s.ax ? body.x : body.z;
    if (body.dead || end < r + 3) crossed.push(`${seed} ${s.cx},${s.cz} stopped at ${end.toFixed(1)} of ${r + 3}, y ${body.y.toFixed(2)}`);
    else H++;
  }
  say('shard fields stand in the glass, and no double jump gets into one or onto it', sites.length >= 6 && got.length === 0,
      got.length ? got.slice(0, 6).join('; ') : `${sites.length} fields built, ${attempts} double jumps at them from outside and off their plates, none got in`);
  say('and a body crosses on the plates, hopping each slot', crossed.length === 0,
      crossed.length ? crossed.join('; ') : `${H}/${sites.length} crossed plate to plate`);
  const gg0 = GOLDEN_SEEDS.find((g) => g.nm === 'glass'), gg = makeGen(gg0.seed, gg0.force);
  const gn = gg.glassIn(gg0.ox - 128, gg0.oz - 128, gg0.ox + 128, gg0.oz + 128);
  say('and round the golden glass window too', gn >= 2, `${gn} fields within 128 m of ${gg0.seed}'s window`);
  return out;
}

/* Seeds with meadow enough for enclosures in 600 m. */
const MEADOW_SEEDS = ['QUARTERSTONE', 'MOSSGATE', 'ALDER-RUN'];

/**
 * Enclosures (#76, Meadowlands): hedges nobody clears, and walls that are
 * the way in.
 *
 * Over the cell field round each enclosure, the floods of the mesa suite
 * from the ground outside it, never through a hedge: with the walls the
 * field inside is reached; with the walls made hedge too, it is not. On
 * built windows and against the collider: a body walks in over a wall, a
 * jump at it; double jumps at the hedges from both sides, and along the
 * perimeter off the top of every wall beside one, land nobody on a hedge or
 * over it.
 */
export function meadowSuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });
  const sites = [];
  for (const seed of MEADOW_SEEDS) {
    const G = makeGen(seed, null), seen = new Set();
    for (let x = -300; x <= 300 && sites.filter((q) => q[0] === seed).length < 3; x += 4) for (let z = -300; z <= 300; z += 4) {
      const s = G.meadowOver(x, z); if (!s || seen.has(s)) continue;
      seen.add(s); sites.push([seed, s, G]); if (sites.filter((q) => q[0] === seed).length >= 3) break;
    }
  }
  const closed = [], open = [];
  for (const [seed, s, G] of sites) {
    const EX = s.hx + 6, EZ = s.hz + 6, NX = 2 * EX + 1, NZ = 2 * EZ + 1, N = NX * NZ;
    const Hc = new Float32Array(N), kind = new Uint8Array(N), dry = new Uint8Array(N);
    for (let i = 0; i < NX; i++) for (let j = 0; j < NZ; j++) {
      const c = G.cell(s.cx + i - EX, s.cz + j - EZ), k = i * NZ + j;
      Hc[k] = c.water ? c.wl : c.H; kind[k] = c.hedge;
      dry[k] = c.magma || (c.water && c.wl - c.H > 1.5) ? 0 : 1;
    }
    const flood = (walls) => {
      const ok = (k) => dry[k] && kind[k] !== 2 && (walls || kind[k] !== 1);
      const seen = new Uint8Array(N), q = [];
      for (let k = 0; k < N; k++) if (ok(k) && kind[k] !== 3 && kind[k] !== 1) { seen[k] = 1; q.push(k); }
      for (let h = 0; h < q.length; h++) {
        const k = q[h], i = (k / NZ) | 0, j = k % NZ;
        for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ii = i + a, jj = j + b; if (ii < 0 || jj < 0 || ii >= NX || jj >= NZ) continue;
          const p = ii * NZ + jj;
          if (!seen[p] && ok(p)) {
            const dh = Hc[p] - Hc[k];
            if (dh <= MOVE.climb2 && dh >= -MOVE.fall) { seen[p] = 1; q.push(p); }
          }
        }
      }
      return seen;
    };
    const inside = [...Array(N).keys()].filter((k) => kind[k] === 3);
    if (!inside.some((k) => flood(true)[k])) closed.push(`${seed} ${s.cx},${s.cz}`);
    if (inside.some((k) => flood(false)[k])) open.push(`${seed} ${s.cx},${s.cz}`);
  }
  say('enclosures stand in the meadow', sites.length >= 6, `${sites.length} enclosures over ${MEADOW_SEEDS.length} seeds`);
  say('and over their walls every field inside is reached', closed.length === 0, closed.length ? closed.join('; ') : `${sites.length} fields reached`);
  say('and with the walls made hedge none is', open.length === 0, open.length ? open.join('; ') : `${sites.length} fields shut`);

  const got = [], stuck = [];
  let attempts = 0, walked = 0;
  for (const [seed, s] of sites.slice(0, 6)) {
    const w = buildWorld({ seed, size: 64, ox: s.cx, oz: s.cz }), col = colliderForWorld(w);
    const kindAt = (x, z) => s.kind.get(Math.round(x) * 64 + Math.round(z));
    /* On a hedge, or across one: over a hedge cell and near its top, or
       ended on the far side of the hedge it was run at. */
    const bad = (b, side0) => {
      const k = kindAt(b.x, b.z);
      if (k === 2 && b.y > s.top - 1) return true;
      return side0 !== null && side0(b);
    };
    const jumpAt = (x, z, dx, dz, across) => {
      const g = w.cells[Math.round(x + 32) * w.M + Math.round(z + 32)].H;
      const b = placeOnGround(col, x, z, g + 1.5);
      for (let t = 0; t < 150 && !b.dead; t++) {
        const j = (b.grounded && t > 2) || (!b.grounded && b.airJumps > 0 && b.vy <= 0);
        step(col, b, { mx: dx, mz: dz, jump: j });
      }
      /* Judged where it lands, not in the air. */
      for (let t = 0; t < 120 && !b.dead && !b.grounded; t++) step(col, b, { mx: 0, mz: 0, jump: false });
      attempts++;
      return bad(b, across) ? b : null;
    };
    /* Every hedge cell on the four sides, run at from a metre and a half out
       and a metre and a half in. */
    for (const [key, k] of s.kind) {
      if (k !== 2) continue;
      const hx = Math.floor((key + 32 * 64 + 32) / 64) - 32, hz = key - hx * 64;
      const nx = Math.abs(hx) === s.hx ? Math.sign(hx) : 0, nz = nx ? 0 : Math.sign(hz);
      if ((hx + hz) % 2) continue;
      for (const sd of [1, -1]) {
        const x = hx + nx * 1.5 * sd, z = hz + nz * 1.5 * sd;
        const across = (b) => ((b.x - hx) * nx + (b.z - hz) * nz) * sd < -0.6 && kindAt(b.x - nx * sd, b.z - nz * sd) === 2;
        const b = jumpAt(x, z, -nx * sd, -nz * sd, across);
        if (b) got.push(`${seed} ${s.cx},${s.cz} at ${hx},${hz} from ${sd > 0 ? 'outside' : 'inside'}: ${b.x.toFixed(1)},${b.y.toFixed(1)},${b.z.toFixed(1)}`);
      }
    }
    /* Off every wall beside a hedge, along the side onto it. */
    for (const [key, k] of s.kind) {
      if (k !== 1) continue;
      const wx = Math.floor((key + 32 * 64 + 32) / 64) - 32, wz = key - wx * 64;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (s.kind.get((wx + dx) * 64 + wz + dz) !== 2) continue;
        const b = jumpAt(wx, wz, dx, dz, null);
        if (b) got.push(`${seed} ${s.cx},${s.cz} off the wall at ${wx},${wz}: ${b.x.toFixed(1)},${b.y.toFixed(1)},${b.z.toFixed(1)}`);
      }
    }
    /* In over the first wall, from three metres out. */
    let wk = null;
    for (const [key, k] of s.kind) {
      const x = Math.floor((key + 32 * 64 + 32) / 64) - 32, z = key - x * 64;
      if (k === 1 && (Math.abs(x) !== s.hx || Math.abs(z) !== s.hz)) { wk = key; break; }
    }
    const wx = Math.floor((wk + 32 * 64 + 32) / 64) - 32, wz = wk - wx * 64;
    const nx = Math.abs(wx) === s.hx ? Math.sign(wx) : 0, nz = nx ? 0 : Math.sign(wz);
    const b = placeOnGround(col, wx + nx * 3, wz + nz * 3);
    for (let t = 0; t < 400 && !b.dead; t++) {
      if (b.grounded && Math.abs(b.x) < s.hx - 0.8 && Math.abs(b.z) < s.hz - 0.8) break;
      step(col, b, { mx: -nx, mz: -nz, jump: b.grounded && b.blocked });
    }
    if (Math.abs(b.x) < s.hx - 0.8 && Math.abs(b.z) < s.hz - 0.8) walked++;
    else stuck.push(`${seed} ${s.cx},${s.cz} over the wall at ${wx},${wz}: ended ${b.x.toFixed(1)},${b.y.toFixed(1)},${b.z.toFixed(1)}`);
  }
  say('a body hops a wall into the field', stuck.length === 0, stuck.length ? stuck.join('; ') : `${walked} walked in over a wall`);
  say('and no double jump lands on a hedge or over one', got.length === 0,
      got.length ? got.slice(0, 6).join('; ') : `${attempts} double jumps at the hedges, from both sides and off the walls beside them`);
  const gm = GOLDEN_SEEDS.find((g) => g.nm === 'meadow'), gg = makeGen(gm.seed, gm.force);
  const gn = gg.meadowIn(gm.ox - 128, gm.oz - 128, gm.ox + 128, gm.oz + 128);
  say('and round the golden meadow window too', gn >= 2, `${gn} enclosures within 128 m of ${gm.seed}'s window`);
  return out;
}

/**
 * Nothing stands against a feature (#84): a ruin's pillars stand three
 * metres from its site and its walls and fences run further, a landmark's
 * standing stones four, and a tree or a boulder rooted just past an apron
 * leans back over it — each of them a step onto a mesa, a hedge or a
 * thicket.
 *
 * Every golden seed, its biome forced, searched region by region out from
 * its window for sites within nine metres of a feature's face. Each is
 * built, and no solid prop voxel that is not the feature's own stands more
 * than a metre over the ground within two metres of the feature's face.
 */
const faceOf = (c) => (c.mesa === 1 || c.mesa === 2) || c.basalt === 1 || c.cliff === 2 || c.cliff === 3
  || c.thorn === 2 || c.thorn === 3 || (c.rime >= 1 && c.rime <= 4) || c.spore === 1 || c.spore === 2
  || c.glass === 2 || c.glass === 3 || c.glass === 5 || c.hedge === 1 || c.hedge === 2;
export function stampSuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });
  const near = [], bad = [];
  let looked = 0, voxels = 0;
  for (const g of GOLDEN_SEEDS) {
    if (g.force === null) continue;
    const G = makeGen(g.seed, g.force), rx0 = regionOf(g.ox), rz0 = regionOf(g.oz);
    let found = 0;
    for (let d = 0; d <= 2 && found < 2; d++) for (let a = -d; a <= d && found < 2; a++) for (let b = -d; b <= d && found < 2; b++) {
      if (Math.max(Math.abs(a), Math.abs(b)) !== d) continue;
      for (const [sx, sz] of regionAt(G, rx0 + a, rz0 + b).sites) {
        looked++;
        let close = false;
        for (let i = -9; i <= 9 && !close; i++) for (let j = -9; j <= 9 && !close; j++) if (faceOf(G.cell(sx + i, sz + j))) close = true;
        if (!close) continue;
        near.push(`${g.nm} ${sx},${sz}`); found++;
        const w = buildWorld({ seed: g.seed, force: g.force, size: 64, ox: sx, oz: sz });
        const cellAt = (x, z) => w.cells[Math.round(x + 32) * w.M + Math.round(z + 32)];
        const face = (x, z) => { const i = Math.round(x + 32), j = Math.round(z + 32);
          return i >= 0 && j >= 0 && i < w.M && j < w.M && faceOf(w.cells[i * w.M + j]); };
        /* Any feature ground, apron included: a stamp near one keeps off all of
           it, and what stands there is the feature's own. */
        const feat = (x, z) => { const c = cellAt(x, z);
          return !!(c.mesa || c.basalt || c.cliff || c.thorn || c.rime || c.spore || c.glass || c.hedge); };
        const ps = w.propStart === undefined ? w.pos.length / 3 : w.propStart;
        let hits = 0;
        for (let q = ps; q < w.pos.length / 3; q++) {
          const m = w.mat[q];
          if (m === MAT.LEAF || m === MAT.SNOW) continue;
          const x = w.pos[q * 3], y = w.pos[q * 3 + 1], z = w.pos[q * 3 + 2];
          /* A prop voxel snaps a quarter-metre toward +x and +z on a tie, so the
             feature's own can sit just over its cell's edge. */
          if (Math.abs(x) > 30 || Math.abs(z) > 30 || feat(x, z) || feat(x - 0.26, z) || feat(x, z - 0.26)) continue;
          /* Over the surface under it, a voxel column at a time, not the cell's
             whole-metre height: a pebble on a ramp is not a step. */
          const gi = Math.floor((x + 32) / V), gj = Math.floor((z + 32) / V);
          const sy = gi >= 0 && gj >= 0 && gi < w.NX && gj < w.NZ ? w.Hs[gi * w.NZ + gj] : cellAt(x, z).H;
          if (y < sy + 1) continue;
          let by = false;
          for (let i = -2; i <= 2 && !by; i++) for (let j = -2; j <= 2 && !by; j++) if (face(x + i, z + j)) by = true;
          if (by) { hits++; voxels++; }
        }
        if (hits) bad.push(`${g.nm} site ${sx},${sz}: ${hits} voxels`);
      }
    }
  }
  say('nothing built or grown stands against a feature: no solid prop over a metre within two of a face', near.length >= 4 && bad.length === 0,
      bad.length ? bad.slice(0, 6).join('; ') : `${near.length} sites near a feature of ${looked} looked at, none with a foothold`);

  /* Nothing of stone floats. A ruin's pillar, a hut's wall, a landmark's
     standing stone or a boulder was stood on the ground at its centre, and at
     a canyon's lip or a terrace's edge the rest of it hung over the drop — a
     ring of stones six metres over a canyon floor at QUARTERSTONE -342,-441.
     A stone voxel with nothing under it — no stone in the nine places below,
     no ground within a voxel of its underside across the columns it spans,
     no wall beside it at its height, as a foothold has — is floating. Over
     the golden seeds, a window at the place that was reported, and the
     self-test: a stone lifted two metres off a boulder is found. */
  const floating = (w) => {
    const n = w.pos.length / 3, ps = w.propStart === undefined ? n : w.propStart, found = [], solid = new Set();
    const key = (x, y, z) => Math.round(x / V) + ',' + Math.round(y / V) + ',' + Math.round(z / V);
    for (let q = 0; q < n; q++) solid.add(key(w.pos[q * 3], w.pos[q * 3 + 1], w.pos[q * 3 + 2]));
    const top = (x, z) => { const i = Math.floor((x + w.half) / V), j = Math.floor((z + w.half) / V);
      return i < 0 || j < 0 || i >= w.NX || j >= w.NZ ? NaN : w.Hs[i * w.NZ + j]; };
    for (let q = ps; q < n; q++) {
      const m = w.mat[q]; if (m !== MAT.ROCK && m !== MAT.BASALT) continue;
      const x = w.pos[q * 3], y = w.pos[q * 3 + 1], z = w.pos[q * 3 + 2];
      let held = false;
      for (let a = -1; a <= 1 && !held; a++) for (let b = -1; b <= 1 && !held; b++) if (solid.has(key(x + a * V, y - V, z + b * V))) held = true;
      if (held) continue;
      let g = -Infinity, wall = false, off = false;
      for (const dx of [-0.1, 0.1]) for (const dz of [-0.1, 0.1]) { const t = top(x + dx, z + dz); if (t !== t) off = true; else g = Math.max(g, t); }
      for (const [dx, dz] of [[-0.3, 0], [0.3, 0], [0, -0.3], [0, 0.3]]) if (top(x + dx, z + dz) >= y) wall = true;
      if (off || wall || y - V / 2 <= g + V + 0.01) continue;
      found.push(`${(x + w.OX).toFixed(2)},${(y - V / 2 - g).toFixed(2)},${(z + w.OZ).toFixed(2)}`);
    }
    return found;
  };
  const fl = [];
  const flw = GOLDEN_SEEDS.map((g) => [g.nm, buildWorld({ seed: g.seed, force: g.force, size: 64, ox: g.ox, oz: g.oz })]);
  flw.push(['QUARTERSTONE -342,-441', buildWorld({ seed: 'QUARTERSTONE', size: 64, ox: -340, oz: -440 })]);
  for (const [nm, w] of flw) { const f = floating(w); if (f.length) fl.push(`${nm}: ${f.length} (${f.slice(0, 2).join(' ')})`); }
  const [, w0] = flw.find(([, w]) => { const ps = w.propStart === undefined ? w.pos.length / 3 : w.propStart;
    for (let q = ps; q < w.pos.length / 3; q++) if (w.mat[q] === MAT.ROCK) return true; return false; });
  const lift = { ...w0, pos: w0.pos.slice(), mat: w0.mat.slice() };
  { const ps = lift.propStart === undefined ? lift.pos.length / 3 : lift.propStart;
    for (let q = ps; q < lift.pos.length / 3; q++) if (lift.mat[q] === MAT.ROCK) { lift.pos[q * 3 + 1] += 8; break; } }
  say('nothing of stone floats: every pillar, wall, standing stone and boulder stands on the ground under it',
      fl.length === 0 && floating(lift).length === 1,
      fl.length ? fl.join('; ') : `none over ${flw.length} windows; a stone lifted eight metres is found`);
  return out;
}

/* ---------------------------------------------------------------- grass ---- */

/**
 * Grass is each biome's own (#99): how much ground it covers, how tall, how
 * dry, and whether it grows as a carpet or in tufts. Measured over two forced
 * worlds per biome, on cells at least 80% one biome, from the blades the
 * generator emits — which is what every renderer draws from.
 */
export async function grassBiomeSuite() {
  const { BIOMES, BIO } = await import('../../src/gen/biomes.mjs');
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });
  const st = BIOMES.map(() => ({ cells: 0, n: 0, h: 0, dry: 0, green: 0, occ: new Set() }));
  for (let f = 0; f < BIOMES.length; f++) for (const s of ['a', 'b']) {
    const w = buildWorld({ seed: s + f, size: 64, force: f });
    const M = w.M, half = w.half, g = w.grass;
    for (const c of w.cells) if (c.w[c.dom] > 0.8) st[c.dom].cells++;
    for (let i = 0; i < g.sc.length; i++) {
      const a = Math.floor(g.p[i * 3] + half), b = Math.floor(g.p[i * 3 + 2] + half);
      if (a < 0 || b < 0 || a >= M || b >= M) continue;
      const c = w.cells[a * M + b]; if (c.w[c.dom] <= 0.8) continue;
      const t = st[c.dom], j = i * 3, col = g.ti[i] ? g.dc : g.c;
      t.n++; t.h += g.sc[i]; t.dry += g.ti[i];
      t.green += col[j + 1] - Math.max(col[j], col[j + 2]);
      t.occ.add(s + f + ':' + Math.floor(g.p[j] * 2) + ',' + Math.floor(g.p[j + 2] * 2));
    }
  }
  const m = st.map((t) => ({ per: t.n / Math.max(1, t.cells), h: t.h / Math.max(1, t.n), dry: t.dry / Math.max(1, t.n),
                            green: t.green / Math.max(1, t.n), cover: t.occ.size / Math.max(1, t.cells * 4) }));
  const f2 = (v) => v.toFixed(2);
  const row = (k) => `${k} ${m[BIO[k.toUpperCase()]].per.toFixed(1)}/m², ${f2(m[BIO[k.toUpperCase()]].h)} tall, `
    + `${Math.round(m[BIO[k.toUpperCase()]].cover * 100)}% of ground`;
  const me = m[BIO.MEADOW], mesa = m[BIO.MESA], ash = m[BIO.ASH], rime = m[BIO.RIME], glass = m[BIO.GLASS];
  say('the desert is sparse, dry, straw-coloured and long, in tufts over bare ground',
      mesa.per < me.per * 0.25 && mesa.h > me.h * 1.2 && mesa.dry > 0.6 && mesa.green < 0 && mesa.cover < me.cover * 0.35,
      `${row('mesa')}; ${Math.round(mesa.dry * 100)}% dry, green ${f2(mesa.green)} — against ${row('meadow')}`);
  say('the scars barely grow: ash and glass almost bare, the Rimewaste thin and short',
      ash.per < me.per * 0.06 && glass.per < me.per * 0.06 && rime.per < me.per * 0.35 && rime.h < me.h * 0.7,
      `${row('ash')}; ${row('glass')}; ${row('rime')}`);
  say('meadow is the green carpet the palette is calibrated against',
      me.per > 60 && me.green > 0.05 && me.cover > 0.8 && me.dry < 0.3, `${row('meadow')}, green ${f2(me.green)}`);
  const hs = new Set(m.map((t) => Math.round(t.h * 20)));
  say('and the biomes differ in height, not only in colour', hs.size >= 5,
      m.map((t, i) => `${BIOMES[i].k} ${f2(t.h)}`).join(', '));
  return out;
}

/**
 * Contact shadows (#99): a prop darkens the ground it stands on. Measured on
 * the top faces within a quarter-metre of a prop's foot — the same chunk
 * meshed with and without its props counted — and nowhere else changes.
 */
export function contactShadeSuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });
  const w = buildWorld({ seed: 'QUARTERSTONE', size: 64, force: null });
  const bare = Object.assign({}, w, { propStart: w.pos.length / 3 });
  const a = meshChunk(w, 0, 0), b = meshChunk(bare, 0, 0);
  /* Mean occlusion per top-face vertex, keyed by where it is. */
  const tops = (m) => {
    const map = new Map();
    for (let v = 0; v < m.pos.length / 3; v++) {
      if (m.nor[v * 3 + 1] < 0.5) continue;
      const k = Math.round(m.pos[v * 3] * 4) + ',' + Math.round(m.pos[v * 3 + 1] * 4) + ',' + Math.round(m.pos[v * 3 + 2] * 4);
      map.set(k, m.ao[v]);
    }
    return map;
  };
  const ta = tops(a), tb = tops(b);
  let darker = 0, lighter = 0, same = 0;
  for (const [k, ao] of ta) {
    if (!tb.has(k)) continue;
    const d = tb.get(k) - ao;
    if (d > 0) darker++; else if (d < 0) lighter++; else same++;
  }
  say('the ground darkens where props stand on it, and nowhere does it lighten',
      darker > 50 && lighter === 0 && a.faces === b.faces,
      `${darker} ground corners darker beside a prop, ${lighter} lighter, ${same} unchanged; `
      + `${a.faces} faces either way, ${a.quads} quads against ${b.quads}`);
  return out;
}

/* -------------------------------------------------------------- crossings ---- */

/**
 * Two ways across that #55 left open. Ashfall's magma cut its trail network in
 * pieces, and a route that could not lay a deck waded; now the one is crossed
 * on a causeway of rock at the banks' height and the other on stepping stones.
 * Over the nine golden seeds, as windows see them.
 */
export async function crossingSuite() {
  const { GOLDEN_SEEDS } = await import('./harness.mjs');
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });
  let stones = 0, wet = 0, far = 0, high = 0, paved = 0, magmaLeft = 0, pavedSteps = 0;
  const bad = [];
  for (const s of GOLDEN_SEEDS) {
    const w = buildWorld({ seed: s.seed, size: 64, force: s.force, ox: s.ox, oz: s.oz });
    const M = w.M, half = w.half, OX = s.ox || 0, OZ = s.oz || 0, idx = (x, z) => { const i = Math.round(x + half), j = Math.round(z + half);
      return i >= 0 && j >= 0 && i < M && j < M ? i * M + j : -1; };
    /* The stones the regions under this window laid, in its frame. */
    const G = makeGen(s.seed, s.force), list = [];
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const r = regionAt(G, regionOf(OX) + a, regionOf(OZ) + b);
      for (const t of r.stones || []) list.push([t[0] - OX, t[1] - OZ, t[2]]);
    }
    /* Each placed stone's top, read back from the props the window emitted:
       the highest prop voxel over the column at its middle. */
    const V2 = 0.25, NX = w.NX, NZ = w.NZ, tops = new Map();
    for (let q = w.propStart; q < w.pos.length / 3; q++) {
      const ci = Math.round((w.pos[q * 3] + half) / V2), cj = Math.round((w.pos[q * 3 + 2] + half) / V2), kk = ci * NZ + cj;
      const t = w.pos[q * 3 + 1] + V2 / 2; if (!tops.has(kk) || t > tops.get(kk)) tops.set(kk, t);
    }
    const col = (x, z) => Math.min(NX - 1, Math.max(0, Math.round((x + half) / V2))) * NZ + Math.min(NZ - 1, Math.max(0, Math.round((z + half) / V2)));
    const placed = new Map();
    for (const t of list) {
      const k = col(t[0], t[1]);
      if (idx(t[0], t[1]) < 0 || !(w.FLG[k] & 1) || !tops.has(k)) continue;
      /* Under a deck there are no stones: the bridge is the crossing. */
      if (w.bridges.some((bb) => Math.abs((t[0] - bb[0]) * bb[2] + (t[1] - bb[1]) * bb[3]) <= bb[4] / 2 + 0.5
                                 && Math.abs((t[0] - bb[0]) * bb[3] - (t[1] - bb[1]) * bb[2]) <= 1.25)) continue;
      placed.set(t[0] + ',' + t[1], { x: t[0], z: t[1], top: tops.get(k), wl: w.WL[k] });
    }
    for (const t of placed.values()) {
      stones++;
      if (t.top - t.wl < 0.1 || t.top - t.wl > 0.45) { wet++; bad.push(`${s.nm} stone at ${t.x},${t.z} top ${t.top.toFixed(2)} over water ${t.wl.toFixed(2)}`); }
      let next = 0;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const o = placed.get((t.x + dx) + ',' + (t.z + dz));
        if (o) { if (Math.abs(o.top - t.top) <= MOVE.climb2) next++; continue; }
        const nk = col(t.x + dx, t.z + dz);
        if (!(w.FLG[nk] & 1) && Math.abs(w.Hs[nk] - t.top) <= MOVE.climb2) next++;
      }
      if (!next) { far++; bad.push(`${s.nm} stone at ${t.x},${t.z} leads nowhere`); }
    }
    for (let k = 0; k < w.cells.length; k++) {
      const c = w.cells[k];
      if (!c.paved) continue;
      paved++;
      if (c.magma) magmaLeft++;
      const i = (k / M) | 0, j = k % M;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= M || b >= M) continue;
        const n = w.cells[a * M + b];
        if (w.trail[a * M + b] && w.trail[k] && !n.water && Math.abs(n.H - c.H) > MOVE.climb2) pavedSteps++;
      }
    }
  }
  say('a route that wades crosses on stepping stones, each clear of the water and a step from the next',
      stones > 5 && wet === 0 && far === 0,
      `${stones} stones over nine seeds; ${wet} awash or too tall, ${far} leading nowhere${bad.length ? ' — ' + bad.slice(0, 3).join('; ') : ''}`);
  /* And the network it joins: Ashfall's 3x3 block of regions was in pieces. */
  const ashS = GOLDEN_SEEDS.find((q) => q.nm === 'ash');
  const ashN = netShape(trailNet(makeGen(ashS.seed, ashS.force), regionOf(ashS.ox), regionOf(ashS.oz)));
  say('and Ashfall\'s trail is one network across a 3x3 block of regions, magma and all',
      ashN.pieces === 1, `${ashN.pieces} piece${ashN.pieces === 1 ? '' : 's'} over ${ashN.cells} trail cells`);
  say('where Ashfall\'s magma cuts a route, a causeway of rock carries it across',
      paved > 0 && magmaLeft === 0 && pavedSteps === 0,
      `${paved} causeway cells in the windows, ${magmaLeft} still magma, ${pavedSteps} trail steps onto it past the budget`);
  return out;
}

/**
 * Marshes (#102): low, flat, wet ground in the meadow and the thornwood,
 * a place rather than a biome. Measured, not looked at: how much of those
 * biomes it takes, that its water is wadeable and one level to a marsh,
 * that the water knows it is a marsh (the build draws it murky), and that
 * it is dressed — reeds, which a body walks through.
 */
export async function marshSuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });
  /* How common: a share of the meadow and the thornwood, over four fields. */
  const shares = [];
  for (const sd of ['QUARTERSTONE', 'ALDER-RUN', 'X1', 'X2']) {
    const G = makeGen(sd); let m = 0, mt = 0;
    for (let x = -600; x < 600; x += 4) for (let z = -600; z < 600; z += 4) {
      const c = G.cell(x, z); if (c.dom === 0 || c.dom === 3) mt++; if (c.marsh) m++; }
    G.forget(); shares.push(100 * m / Math.max(1, mt));
  }
  say('marshes take a little of the meadow and the thornwood in every field, not none and not most of it',
      shares.every((p) => p > 0.4 && p < 8), shares.map((p) => p.toFixed(1) + '%').join(', ') + ' of meadow and thorn');
  /* In the golden thorn window: wadeable, one level to each body of it. */
  const s = GOLDEN_SEEDS.find((q) => q.nm === 'thorn');
  const w = buildWorld({ seed: s.seed, size: 64, force: s.force, ox: s.ox, oz: s.oz });
  const M = w.M || Math.round(Math.sqrt(w.cells.length));
  let wet = 0, deep = 0, over = 0, levels = 0; const seen = new Uint8Array(M * M);
  for (let k = 0; k < M * M; k++) {
    const c = w.cells[k]; if (!c.marsh || !c.water) continue; wet++;
    /* Half a metre as the field lays it; where a bank drains the surface a
       quarter, the bed is carved in whole metres (containWater), so a cell
       beside a low bank can reach a metre. */
    if (c.wl - c.H > MOVE.wade + 1e-6) deep++;
    if (c.wl - c.H > 1 + 1e-6) over++;
    if (seen[k]) continue;
    const lv = new Set(), q = [k]; seen[k] = 1;
    while (q.length) { const a = q.pop(), ai = (a / M) | 0, aj = a % M; lv.add(w.cells[a].wl);
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const bi = ai + di, bj = aj + dj;
        if (bi < 0 || bj < 0 || bi >= M || bj >= M) continue; const b = bi * M + bj, cb = w.cells[b];
        if (!seen[b] && cb.marsh && cb.water) { seen[b] = 1; q.push(b); } } }
    /* The banks drain a surface a quarter at a time (containWater), never a step. */
    const l = [...lv]; if (Math.max(...l) - Math.min(...l) >= 0.4) levels++;
  }
  say('a marsh is wadeable water — most of it, and none of it past a metre — and each body of it one level',
      wet > 0 && deep <= wet * 0.25 && over === 0 && levels === 0,
      `${wet} marsh water cells in the thorn window; ${deep} deeper than a wade, ${over} past a metre; ${levels} bodies with a step in them`);
  let murk = 0; for (const v of w.water.m) if (v > 0.9) murk++;
  let reeds = 0;
  for (let q = w.propStart; q < w.pos.length / 3; q++) {
    if (w.mat[q] !== MAT.LEAF) continue;
    const ci = Math.round(w.pos[q * 3] + w.half), cj = Math.round(w.pos[q * 3 + 2] + w.half);
    const c = w.cells[Math.min(M - 1, Math.max(0, ci)) * M + Math.min(M - 1, Math.max(0, cj))]; if (c && c.marsh) reeds++;
  }
  say('its water is marked murky for the build to draw, and reeds stand in it that a body walks through',
      murk > 0 && reeds > 0, `${murk} murky water vertices; ${reeds} reed voxels, foliage`);
  return out;
}

/* ------------------------------------------------------------- survival ---- */

/**
 * The combat-number targets (#114, docs/DECISIONS.md §3) as assertions, so the
 * numbers cannot drift off them one tuning pass at a time, and the two rules
 * that are new with them: health that comes back, and a partner who stands
 * you up. "About eight hits" is the target, and the check says what it
 * counts — hits of the archetype's damage against a bare frame's health.
 */
export function survivalSuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });
  const hitsToKill = (c) => Math.ceil(CB.PLAYER_HP / c.damage);
  const swingsToKill = (c) => Math.ceil(c.hp / CB.SWING_DAMAGE);
  const S = EN.SENTRY, M = EN.MORTAR, H = EN.HOUND;

  /* 1. Lethality: about eight hits from any one machine. */
  {
    const n = [S, M, H].map(hitsToKill);
    say('one machine takes about eight hits to kill a bare player, whichever it is',
        n.every((v) => v >= 8 && v <= 9), `sentry ${n[0]}, mortar ${n[1]}, hound ${n[2]}`);
  }

  /* 2. Fight length is the roster's: hounds fast, the sentry a wall. */
  {
    const n = [H, M, S].map(swingsToKill);
    say('fights run by archetype: a hound in two swings, a mortar in three, a sentry in four',
        n.join(',') === '2,3,4', `hound ${n[0]}, mortar ${n[1]}, sentry ${n[2]}`);
  }

  /* 3. Stamina is rarely the limit: four swings and a dodge from a full bar. */
  say('stamina is rarely empty: four swings and a dodge from a full bar',
      4 * CB.SWING_COST + CB.DODGE_COST <= CB.STAMINA_MAX,
      `${4 * CB.SWING_COST + CB.DODGE_COST} of ${CB.STAMINA_MAX}`);

  /* 4. A module is worth about a quarter; four of one kind are worth double. */
  {
    const one = (m) => { const s = CB.baseStats(); LT.MODULES[m].apply(s); return s; };
    const b = CB.baseStats();
    const r = {
      damage: one(LT.MOD.KEEN).damage / b.damage, reach: one(LT.MOD.SIGIL).reach / b.reach,
      dodge: one(LT.MOD.BLINK).dodgeDist / b.dodgeDist, hp: one(LT.MOD.PLATING).maxHp / b.maxHp,
      stamina: one(LT.MOD.GOVERNOR).maxStamina / b.maxStamina, recover: b.recover / one(LT.MOD.SERVO).recover,
      cost: b.swingCost / one(LT.MOD.THEW).swingCost,
    };
    const ok = Object.values(r).every((v) => v >= 1.2 && v <= 1.35);
    say('a module is worth about a quarter of what it improves',
        ok, Object.entries(r).map(([k, v]) => `${k} ×${v.toFixed(2)}`).join(', '));
    const s = CB.baseStats(); for (let i = 0; i < 4; i++) LT.MODULES[LT.MOD.KEEN].apply(s);
    say('a full line of one kind roughly doubles it', Math.abs(s.damage / b.damage - 2) < 0.01, `damage ×${(s.damage / b.damage).toFixed(2)}`);
  }

  /* 5. The Reel is utility: its blows are a third to a half of a swing. */
  {
    const y = CB.REEL.yankScale, k = CB.REEL.strikeScale;
    say('the Reel hits for a third to a half of a blade swing',
        y >= 1 / 3 - 1e-9 && y <= 0.5 && k >= 1 / 3 && k <= 0.5 + 1e-9, `yank ${(y * 100).toFixed(0)}%, strike ${(k * 100).toFixed(0)}%`);
  }

  const c = pen();
  const hurtTo = (p, hp) => { p.hp = hp; };

  /* 6. Health comes back once nothing has hunted you, and not before. */
  {
    const p = placeOnGround(c, 0, 0);
    CB.hurt(p, 40, 'struck');
    const hp0 = p.hp;
    let t = 0;
    for (; t < (CB.REGEN_DELAY - 0.5) / TICK; t++) RV.upkeep([p], TICK);
    const held = p.hp === hp0;
    for (let i = 0; i < Math.round(10 / TICK); i++) RV.upkeep([p], TICK);
    const got = p.hp - hp0;
    const full = placeOnGround(c, 3, 0); hurtTo(full, 10); full.hunted = 0;
    for (let i = 0; i < Math.round(60 / TICK); i++) RV.upkeep([full], TICK);
    say('health holds for five seconds after a blow, then comes back at two a second',
        held && Math.abs(got - CB.REGEN_RATE * (10 - 0.5)) < 1.2 && full.hp === full.maxHp,
        `held ${held}, ${got.toFixed(1)} back in 10 s, a minute fills it to ${full.hp}`);
  }

  /* 7. A machine that has its eye on you keeps you hunted, so you do not heal. */
  {
    const cfg = GOLDEN_SEEDS[0], world = buildWorld(cfg), col = colliderForWorld(world);
    const enc = EN.makeEncounter(col, world, []);
    const sx = world.spawn[0], sz = world.spawn[2], sy = world.spawn[1] + 2;
    const near = placeOnGround(col, sx, sz, sy), far = placeOnGround(col, sx + 40, sz + 40, sy + 20);
    const e = enc.add(sx + 2, sz, sy, EN.KIND.SENTRY);
    e.ai.state = EN.EST.CLOSE; e.ai.tgt = near;
    near.hp = 50; far.hp = 50; near.hunted = 0; far.hunted = 0;
    enc.step([near, far]);
    say('a player a machine has its eye on is hunted and does not heal; one nothing hunts does',
        near.hunted > 0 && far.hunted === 0 && far.hp > 50 && near.hp <= 50,
        `hunted ${near.hunted.toFixed(1)} s at ${near.hp} hp, the other ${far.hp.toFixed(2)} hp`);
  }

  /* 8. Alone, a blow kills; with a partner standing, it puts you down. */
  {
    const a = placeOnGround(c, 0, 0);
    CB.hurt(a, 999, 'struck'); RV.upkeep([a], TICK);
    const solo = a.dead === 'struck' && !a.down;
    const p = placeOnGround(c, 0, 0), q = placeOnGround(c, 6, 0);
    p.swing = { t: 0.1, hit: 0 };
    CB.hurt(p, 999, 'struck'); RV.upkeep([p, q], TICK);
    say('alone a blow kills; with a partner standing it puts you down instead',
        solo && !p.dead && p.down > 0 && p.hp === 0 && !p.swing, `solo dead ${solo}, partnered down ${p.down.toFixed(1)} s`);
    const hp = p.hp;
    const hit = CB.hurt(p, 10, 'struck');
    say('a downed player cannot be hurt again, and the lattice cannot heal them',
        !hit && p.hp === hp && CB.heal(p, 20) === 0, `hurt ${hit}, healed ${CB.heal(p, 20)}`);
  }

  /* 9. Magma, a fall and the void are not a blow: they kill even with a partner. */
  {
    const p = placeOnGround(c, 0, 0), q = placeOnGround(c, 6, 0);
    p.dead = 'magma'; RV.upkeep([p, q], TICK);
    say('magma is lethal even with a partner standing', p.dead === 'magma' && !p.down, `dead ${p.dead}, down ${p.down}`);
  }

  /* 10. A downed player does nothing: no swing, no jump, no step. */
  {
    const p = placeOnGround(c, 0, 0), q = placeOnGround(c, 6, 0);
    CB.hurt(p, 999, 'struck'); RV.upkeep([p, q], TICK);
    const x0 = p.x, y0 = p.y;
    for (let i = 0; i < 20; i++) { step(c, p, { mx: 1, mz: 0, attack: true, jump: true, dodge: true }, null); }
    say('a downed player cannot walk, swing, jump or dodge',
        p.x === x0 && p.y === y0 && !p.swing && !p.dodge, `moved ${(p.x - x0).toFixed(3)} m, swing ${!!p.swing}`);
  }

  /* 11. Machines pass a downed player by. */
  {
    const p = placeOnGround(c, 0, 0), q = placeOnGround(c, 15, 15);
    CB.hurt(p, 999, 'struck'); RV.upkeep([p, q], TICK);
    const e = EN.makeSentry(c, 3, 0), foes = [e];
    for (let i = 0; i < Math.round(3 / TICK); i++) EN.stepEnemy(c, e, [p, q], TICK, { left: 1, party: 2 }, foes);
    say('a machine does not wake for, chase or strike a downed player',
        e.ai.state === EN.EST.DORMANT && p.hp === 0, `machine ${e.ai.state}, hp ${p.hp}`);
  }

  /* 12. A partner within reach stands you up, on two fifths of your health. */
  {
    const p = placeOnGround(c, 0, 0), q = placeOnGround(c, 1, 0);
    CB.hurt(p, 999, 'struck'); RV.upkeep([p, q], TICK);
    let t = 0;
    for (; t < Math.round((RV.REVIVE_TIME + 0.5) / TICK) && p.down; t++) RV.upkeep([p, q], TICK);
    say('a partner within reach stands you up in about a second and a half, on two fifths of your health',
        !p.down && !p.dead && Math.abs(p.hp - p.maxHp * RV.REVIVE_HP) < 1e-9 && Math.abs(t * TICK - RV.REVIVE_TIME) < 0.1,
        `up after ${(t * TICK).toFixed(2)} s on ${p.hp} hp`);
    /* Progress is lost when the partner steps away, and not kept for later. */
    const a = placeOnGround(c, 0, 0), b = placeOnGround(c, 1, 0);
    CB.hurt(a, 999, 'struck'); RV.upkeep([a, b], TICK);
    for (let i = 0; i < Math.round(1.0 / TICK); i++) RV.upkeep([a, b], TICK);
    const mid = a.reviveT; b.x = 9;
    for (let i = 0; i < Math.round(1.2 / TICK); i++) RV.upkeep([a, b], TICK);
    say('stepping away loses the progress made', mid > 0.9 && a.reviveT === 0 && a.down > 0, `progress ${mid.toFixed(2)} → ${a.reviveT}`);
  }

  /* 13. Left alone you are lost; when nobody stands everyone downed is lost. */
  {
    const p = placeOnGround(c, 0, 0), q = placeOnGround(c, 12, 0);
    CB.hurt(p, 999, 'struck'); RV.upkeep([p, q], TICK);
    for (let i = 0; i < Math.round((RV.DOWN_TIME + 1) / TICK) && !p.dead; i++) RV.upkeep([p, q], TICK);
    const bled = p.dead === 'struck';
    const a = placeOnGround(c, 0, 0), b = placeOnGround(c, 6, 0);
    CB.hurt(a, 999, 'struck'); RV.upkeep([a, b], TICK);
    CB.hurt(b, 999, 'struck'); RV.upkeep([a, b], TICK);
    say('left alone you are lost after the window, and when both are down both are lost at once',
        bled && a.dead === 'struck' && b.dead === 'struck' && !a.down && !b.down,
        `bled out ${bled}, both down → ${a.dead}/${b.dead}`);
  }

  /* 14. The downed state crosses the wire, in both forms. */
  {
    const p = placeOnGround(c, 0, 0), q = placeOnGround(c, 1, 0);
    CB.hurt(p, 999, 'struck'); RV.upkeep([p, q], TICK); RV.upkeep([p, q], TICK);
    const s = snapshot(p), r = placeOnGround(c, 5, 5); restore(r, s);
    const d = display(p), v = placeOnGround(c, 5, 5); applyDisplay(v, d);
    const back = NS.unpackState ? NS.unpackState(NS.packState(s)) : s;
    say('downed, with its seconds and its revive progress, crosses the wire in both forms',
        r.down === p.down && v.down > 0 && Math.abs(v.reviveT - p.reviveT) < 0.01 && back.down === p.down,
        `snapshot ${r.down.toFixed(2)}, display ${d.dn}/${d.rv}`);
  }
  return out;
}

/* ----------------------------------------------------------------- site ---- */

/**
 * The weapon site's ground (#7, first slice: the tech furnace): where it
 * stands, that it is the same ground however it is asked for, and that it is
 * the shape the record says — a floor in a wall, a gate that is a plug until
 * it is opened, a core, footholds, and a road that a body can walk.
 */
export function siteSuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });
  const SEEDS = ['QUARTERSTONE', 'ALDER-RUN', 'DRY-KETTLE', 'CLOUDPINE-2', 'BRIARWICK', 'FEN-BARROW-75', 'RED-REACH-65', 'NORTHWIND-1'];

  /* 1. One furnace to a seed, a long way out; a plate forced to a biome has none. */
  {
    const found = SEEDS.map((sd) => makeGen(sd, null).site());
    const far = found.every((S) => S && hyp(S.cx, S.cz) >= ST.MIN_DIST && hyp(S.cx, S.cz) <= ST.MAX_DIST + 1);
    const plate = makeGen('CINDERWAKE', 4).site();
    say('every seed lays one furnace, 430 to 1300 m from the origin, and a plate lays none',
        far && plate === null,
        found.map((S, i) => `${SEEDS[i].slice(0, 5)} ${S ? Math.round(hyp(S.cx, S.cz)) : 'none'}`).join(', ') + `; plate ${plate}`);
  }

  /* 2. Pure: a second generator, with no caches, answers with the same site. */
  {
    const sig = (S) => { let h = 0; S.cells.forEach((v, k) => { h = (h * 31 + k * 7 + v.h * 13 + v.k) % 1000000007; }); return `${S.cx},${S.cz},${S.hf},${S.cells.size},${h}`; };
    const a = sig(makeGen('QUARTERSTONE', null).site());
    clearRegionCache();
    const b = sig(makeGen('QUARTERSTONE', null).site());
    say('the site is a pure function of the seed', a === b, a);
  }

  /* 3. The arena, in a built window centred on it. */
  const sd = 'QUARTERSTONE', S = makeGen(sd, null).site(), hf = S.hf;
  const build = (ox, oz) => buildWorld({ seed: sd, force: null, size: 64, ox, oz });
  const win = (w) => (x, z) => w.cells[(x - w.OX + w.half) * w.M + (z - w.OZ + w.half)];
  const w0 = build(S.cx, S.cz), at0 = win(w0);
  {
    let floor = 0, flat = 0, dry = 0, bare = 0, wall = 0, tall = 0, gate = 0, plug = 0;
    const cosG = Math.cos(ST.GATE_HALF / (ST.ARENA_R + ST.WALL_W / 2));
    for (let x = S.cx - 25; x <= S.cx + 25; x++) for (let z = S.cz - 25; z <= S.cz + 25; z++) {
      const c = at0(x, z), r = hyp(x - S.cx, z - S.cz);
      if (r <= ST.ARENA_R && (c.site === ST.SITE_K.FLOOR)) { floor++; if (c.H === hf) flat++; if (!c.water && !c.magma) dry++; if (!c.basalt && !c.cliff && !c.mesa) bare++; }
      if (c.site === ST.SITE_K.WALL) { wall++; if (c.H - hf >= ST.WALL_H) tall++; }
      if (c.site === ST.SITE_K.GATE) { gate++; if (c.H - hf >= ST.WALL_H) plug++; }
    }
    say('the floor is level, dry and bare, and the wall round it stands four metres over it',
        floor > 1000 && flat === floor && dry === floor && bare === floor && wall > 300 && tall === wall,
        `${floor} floor cells (${flat} at ${hf} m, ${dry} dry, ${bare} bare), ${wall} wall cells (${tall} tall)`);
    say('the gate is a four-metre plug in the wall until it is opened',
        gate >= 10 && plug === gate && S.gateCells.length === gate, `${gate} cells, ${plug} as tall as the wall, ${S.gateCells.length} listed`);
    const core = at0(S.core.x, S.core.z), stones = S.stones.map((p) => at0(p[0], p[1]).H);
    say('the core stands a metre over the floor on the far side from the gate, with four footholds on the floor',
        core.H === hf + ST.CORE_H && core.site === ST.SITE_K.CORE && stones.length === 4 && stones.every((h) => h === hf + ST.STONE_H)
          && (S.core.x - S.cx) * S.ux + (S.core.z - S.cz) * S.uz < 0,
        `core ${core.H}, footholds ${stones.join(',')} over a floor of ${hf}`);
  }

  /* 4. A bowl: nothing on foot leaves it while the gate is shut, and opening
        the gate lets a body out to the road. A flood over the window's cells
        with the budget's own rule, a metre a step. */
  {
    const flood = (open) => {
      const seen = new Set(), key = (x, z) => x * 100000 + z, q = [[S.cx, S.cz]];
      seen.add(key(S.cx, S.cz));
      const gateSet = new Set(S.gateCells.map((p) => key(p[0], p[1])));
      let escaped = 0, reachedRoad = 0, far = 0;
      while (q.length) {
        const [x, z] = q.pop(); const c = at0(x, z);
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, nz = z + dz;
          if (Math.abs(nx - S.cx) > 30 || Math.abs(nz - S.cz) > 30 || seen.has(key(nx, nz))) continue;
          const n = at0(nx, nz);
          if (n.water || n.magma) continue;
          const nh = open && gateSet.has(key(nx, nz)) ? hf : n.H;
          if (Math.abs(nh - c.H) > MOVE.climb) continue;
          seen.add(key(nx, nz)); q.push([nx, nz]);
          const r = hyp(nx - S.cx, nz - S.cz);
          if (r > ST.ARENA_R + ST.WALL_W + 0.5) { escaped++; if (n.site === ST.SITE_K.ROAD) reachedRoad++; }
          far = Math.max(far, r);
        }
      }
      return { escaped, reachedRoad, far };
    };
    const shut = flood(false), open = flood(true);
    say('the arena is a bowl: nothing on foot leaves it with the gate shut, and opening it lets a body out to the road',
        shut.escaped === 0 && open.reachedRoad > 0, `shut: ${shut.escaped} cells out, reached ${shut.far.toFixed(1)} m; open: ${open.reachedRoad} road cells reached`);
  }

  /* 5. Two windows that overlap agree on every cell of the site they share. */
  {
    const w1 = build(S.cx + 24, S.cz + 10), at1 = win(w1);
    let shared = 0, same = 0;
    for (let x = S.cx - 8; x <= S.cx + 56 - 32; x++) for (let z = S.cz - 20; z <= S.cz + 40 - 2; z++) {
      const a = at0(x, z), b = at1(x, z);
      if (!a || !b || a.site === undefined) continue;
      shared++; if (a.H === b.H && a.site === b.site && a.water === b.water) same++;
    }
    say('two windows that overlap agree on every cell of the site they share', shared > 500 && same === shared, `${same} of ${shared} cells`);
  }

  /* 6. The road, a metre at a time along its whole length: every step is
        ground a body can take, dry and bare, in windows that each see a part. */
  {
    const wins = new Map(), key2 = (x, z) => `${Math.round(x / 48)},${Math.round(z / 48)}`;
    let steps = 0, ok = 0, bad = '';
    let prev = null;
    for (let t = 0; t < S.path.length; t += 3) {
      const [px, pz, ph] = S.path[t], k = key2(px, pz);
      if (!wins.has(k)) wins.set(k, build(Math.round(px / 48) * 48, Math.round(pz / 48) * 48));
      const w = wins.get(k), c = win(w)(px, pz);
      steps++;
      const good = c && c.site === ST.SITE_K.ROAD && Math.abs(c.H - ph) <= 1 && !c.water && !c.magma && (!prev || Math.abs(ph - prev) <= 2);
      if (good) ok++; else if (!bad) bad = `t=${t} at ${px},${pz}: ${c ? `site ${c.site} H ${c.H} want ${ph}` : 'outside'}`;
      prev = ph;
    }
    say('the road runs the whole 330 m, on the heights it says to a metre, dry, and never steeper than a metre a step',
        steps > 100 && ok === steps, `${ok} of ${steps} sampled points${bad ? '; first bad ' + bad : ''}; ${wins.size} windows`);
  }
  return out;
}
