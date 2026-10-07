/**
 * The war machines: tech, magic and biological weapons still holding positions
 * against an enemy that left (docs/DECISIONS.md §1, §6). Three are built — the
 * sentry (#24), the mortar crawler and the grafted hounds (#106) — of the four
 * the roster in §6 names; the warden obelisk is still to come.
 *
 * Every archetype answers the four questions #6 asked, and inherits the rule
 * the sentry produced: **the tell goes on the surface the camera can see.**
 *
 * **Sentry automaton** (tech, bruiser)
 *   Silhouette   Squat and wide. From 45 degrees you mostly see the top of
 *                things, so the readable surface is its top plate — and that is
 *                where the tell goes.
 *   Telegraph    It stops dead, rises, and its plate flares. Three tells, and
 *                the first one is the one that works from above: everything
 *                else in a fight is moving, so a machine that suddenly is not
 *                reads instantly at any zoom. The rise changes its footprint,
 *                which is the one silhouette change an overhead view can see.
 *   Opening      A 0.9 s recovery — longer than the player's whole swing, so
 *                the reward for dodging through the strike is a free hit and
 *                not merely survival.
 *   Movement     It walks the same movement budget the player does, through
 *                the same `step`, so it steps up a metre, falls, drowns and
 *                burns exactly as a player would. It does **not** jump or climb: a
 *                heavy machine goes around, which is what `canJump = false`
 *                and the side-stepping below are for.
 *
 * **Mortar crawler** (tech, artillery)
 *   Silhouette   Low and spider-legged, with a barrel on its back.
 *   Telegraph    The barrel plate glows and a ring appears on the ground where
 *                each shell of the volley will land — before any leaves. Ranged
 *                attacks are only ever ground-marked (§6): from above you always
 *                see where danger will be.
 *   Opening      After a volley it vents for two seconds, top open. It is weak
 *                up close — it backs away from anyone near and cannot fire at
 *                them — so the answer to a mortar is to rush it.
 *   Movement     Walks the budget; cannot jump.
 *
 * **Grafted hounds** (biological, flankers, always two)
 *   Silhouette   Low, long and fast, with a spined back.
 *   Telegraph    The spines rise and the line it will lunge along is drawn on
 *                the ground. The line is fixed when the tell starts: step off
 *                it and the lunge goes by.
 *   Opening      The lunge carries past where you stood, and the hound stumbles.
 *   Movement     Faster than a player at a run, circles rather than closing
 *                head on, jumps a 1 m face like you do, and will not go into
 *                water too deep to wade: it cannot swim.
 *
 * **The sources fight each other** (§6). A machine that is awake takes the
 * nearest target it can see — a player, or a machine of another tradition —
 * and every strike, shell and lunge hurts whatever it reaches of another
 * tradition, never its own. A dormant machine wakes for a player, or for a
 * rival that is already awake: so nothing fights until a player starts it, and
 * a player who leads hounds into a tech post has started the fight they meant
 * to.
 *
 * **Party scaling** (§6): a second player brings each group's reserve member
 * out, and a machine that wakes with two players present has a little more
 * health. Damage is not scaled, so a tell reads the same alone or together.
 *
 * No AI architecture — a state machine and a steering direction per machine,
 * stepped in a fixed order so a host and a replay agree.
 */
import { MOVE, CHUNK } from '../gen/constants.mjs';
import { hyp, cos, sin } from '../gen/exact.mjs';
import { EPS, LIQUID } from './collider.mjs';
import { TICK, placeOnGround, step } from './actor.mjs';
import { inArc, hurt, applyHits, WINDUP, REGEN_DELAY } from './combat.mjs';
import { upkeep } from './revive.mjs';
import { makeFurnaceRun, installDoors } from './furnace.mjs';
import { TRAD } from './lattice.mjs';
import { makeLootField } from './loot.mjs';
import { findPath } from './nav.mjs';

export const SENTRY = {
  hp: 80,
  /** How far it notices you. Deliberately short: it holds a position. */
  sight: 13,
  /** Where it decides you are close enough to be worth swinging at. */
  range: 2.1,
  /** Longer than the player's and slower — methodical, and it telegraphs. */
  reach: 2.4,
  arc: 1.4,
  span: 2.0,
  damage: 13,
  /** Fraction of the player's run speed. It should never simply outrun you. */
  speed: 0.58,
  /** Half its drawn width (1.35 m): it collides as wide as it looks (#37),
      not as a 0.7 m human. A doorway a player fits through, it does not. */
  rad: 0.675,
  /** How far from its post it will follow you (#6). Past this it gives up and
      walks back: these things hold a position, they do not hunt. */
  leash: 16,
};
const COS_HALF = cos(SENTRY.arc / 2);

/** The mortar crawler (#106). Every number here is a placeholder for #9. */
export const MORTAR = {
  hp: 50,
  /** It sees further than the sentry: it is the one that shoots first. */
  sight: 16,
  /** It fires at anything between `near` and `range`, and backs away from
      anything nearer than `near` — it cannot fire that close. */
  range: 13,
  near: 5,
  /** A volley of three, in a line across the target, this far apart. */
  shells: 3,
  spread: 1.8,
  /** The ring each shell lands in, and what landing in it costs. */
  ringR: 1.3,
  damage: 13,
  speed: 0.45,
  rad: 0.55,
  leash: 14,
};

/** The grafted hounds (#106). Placeholders for #9 too. */
export const HOUND = {
  hp: 25,
  sight: 14,
  /** It circles at about this distance before it commits. */
  circle: 3.2,
  /** And lunges from no further than this. */
  range: 3.6,
  /** The lunge: this fast (as a fraction of the player's run) for LUNGE_TIME,
      which carries it about 4.2 m — past someone it started 3.6 m from. */
  lunge: 3.5,
  /** Whatever the lunge passes within this of, it hits. */
  bite: 0.75,
  damage: 12,
  /** Faster than a player at a run: you cannot simply walk away from hounds. */
  speed: 1.05,
  rad: 0.45,
  leash: 20,
};

/** Which archetype a machine is, on the wire as one small integer. */
export const KIND = { SENTRY: 0, MORTAR: 1, HOUND: 2 };
export const KIND_NAMES = ['sentry', 'mortar', 'hound'];

export const EST = {
  DORMANT: 0, WAKE: 1, CLOSE: 2, TELEGRAPH: 3, STRIKE: 4, RECOVER: 5, STAGGER: 6, DEAD: 7,
  /** Walking back to its post, having lost you or been drawn too far (#6). */
  RETURN: 8,
};

export const WAKE_TIME = 0.45;
/** Long on purpose. This is the thing the whole issue is about. */
export const TELEGRAPH_TIME = 0.65;
export const STRIKE_TIME = 0.12;
/** Longer than a whole player swing (0.77 s), so the dodge buys a free hit. */
export const RECOVER_TIME = 0.90;
export const STAGGER_TIME = 0.28;
/** The mortar's rings are on the ground this long before a shell leaves… */
export const MORTAR_AIM_TIME = 1.1;
/** …and the shells are in the air this long. Nearly two seconds of warning. */
export const MORTAR_FLIGHT_TIME = 0.7;
/** The vent: the mortar's opening, longer than two whole swings. */
export const MORTAR_VENT_TIME = 2.0;
/** A hound's tell is short — it is a fast thing — but the line is on the
    ground for all of it. */
export const HOUND_TELL_TIME = 0.6;
export const LUNGE_TIME = 0.3;
/** The stumble after an overshot lunge: the hound's opening. */
export const STUMBLE_TIME = 0.85;
/** How long a hound circles before it will commit to a lunge. */
const CIRCLE_TIME = 0.6;
/** A second player: each group's reserve comes out, and a machine that wakes
    then has this much more health. Damage is untouched (§6). */
export const PARTY_HP = 1.15;
/** How long it commits to going around something before trying forward again. */
export const SIDESTEP_TIME = 0.5;
/** How often a path is worked out again while it is being followed (#15). */
export const REPATH_TIME = 0.5;
/** Nodes a single search may open: bounded, because the host pays for it. */
const PATH_NODES = 900;

/** Each archetype's constants, timings and tradition, by kind. */
const SPEC = [
  /* `weight` is what the Reel reads (#112): 1 is light — hauled to you — and 2
     is heavy — you are hauled to it. A property of the archetype, not a number
     compared at the moment. */
  { k: KIND.SENTRY, c: SENTRY, trad: TRAD.TECH, canJump: false, weight: 2,
    tell: TELEGRAPH_TIME, strike: STRIKE_TIME, recover: RECOVER_TIME },
  { k: KIND.MORTAR, c: MORTAR, trad: TRAD.TECH, canJump: false, weight: 2,
    tell: MORTAR_AIM_TIME, strike: MORTAR_FLIGHT_TIME, recover: MORTAR_VENT_TIME },
  { k: KIND.HOUND, c: HOUND, trad: TRAD.BIO, canJump: true, weight: 1,
    tell: HOUND_TELL_TIME, strike: LUNGE_TIME, recover: STUMBLE_TIME },
];
const specOf = (e) => SPEC[e.k] || SPEC[0];

/** The archetype table by kind — what a guest, which is sent only `k`, reads
 *  an archetype's numbers from. */
export const ARCHETYPES = SPEC.map((s) => s.c);

function makeMachine(col, k, x, z, fromY) {
  const s = SPEC[k], c = s.c;
  const e = placeOnGround(col, x, z, fromY, c.rad);
  e.hp = c.hp; e.maxHp = c.hp;
  e.canJump = s.canJump;
  e.k = k; e.kind = KIND_NAMES[k]; e.trad = s.trad; e.weight = s.weight;
  e.ai = { state: EST.DORMANT, t: 0, side: 0, sideT: 0,
           /* Where it holds (#6), and the path it is following, if any (#15). */
           post: { x: e.x, y: e.y, z: e.z }, path: null, wp: 0, pathT: 0,
           /* The mortar's rings, as x, z pairs; a hound's orbit and lunge. */
           marks: null, orbit: 1, lx: 0, lz: 0, bit: 0,
           /* How it moves and thinks (#110): its eased input, what it is in
              the middle of, and the clocks that pace it. */
           mx: 0, mz: 0, mode: null, wait: 0, backT: 0, backCD: 0, combo: 0,
           reloc: 0, dartT: 0, peelT: 0, retreatT: 0, feintT: -1,
           ring: HOUND.circle, ringT: 0, tgt: null, pattern: 0 };
  return e;
}

export function makeSentry(col, x, z, fromY) { return makeMachine(col, KIND.SENTRY, x, z, fromY); }
export function makeMortar(col, x, z, fromY) { return makeMachine(col, KIND.MORTAR, x, z, fromY); }
export function makeHound(col, x, z, fromY) { return makeMachine(col, KIND.HOUND, x, z, fromY); }
const MAKE = [makeSentry, makeMortar, makeHound];

/** Is it in a state where a hit should interrupt it? */
function staggerable(st) {
  return st === EST.CLOSE || st === EST.WAKE || st === EST.TELEGRAPH;
}

/** Deep enough water that something which cannot swim will not go in. */
function tooDeep(col, x, z, y) {
  const l = col.liquidAt(x, z);
  return l.kind === LIQUID.WATER && l.level - y > MOVE.wade;
}

/**
 * Where to walk. Straight at the target while nothing is in the way; once a
 * wall or a drop is, along a path round it (#15) — worked out for its own
 * width, with climbs only for something that jumps — and only when no path
 * exists, sideways for a while. A machine that walks off a ledge to reach
 * you is not menacing, and one that hovers over the gap is worse.
 */
function steer(col, e, tx, tz, budget, speed) {
  const m = steerAny(col, e, tx, tz, budget, speed);
  /* Whatever the step came from — a straight line, a path's cut corner, a
     sidestep — a hound does not take it into deep water. It waits on the bank. */
  if (e.k === KIND.HOUND && (m.mx || m.mz)) {
    const l = hyp(m.mx, m.mz), ax = e.x + (m.mx / l) * (e.rad + 0.3), az = e.z + (m.mz / l) * (e.rad + 0.3);
    if (tooDeep(col, ax, az, col.supportUnder(ax, az, 0.05, e.y + MOVE.step + EPS))) {
      e.ai.sideT = 0;
      return { mx: 0, mz: 0 };
    }
  }
  return m;
}

function steerAny(col, e, tx, tz, budget, speed) {
  const ai = e.ai, spd = speed === undefined ? specOf(e).c.speed : speed;
  let dx = tx - e.x, dz = tz - e.z;
  const l = hyp(dx, dz);
  if (l < 1e-6) return { mx: 0, mz: 0 };
  dx /= l; dz /= l;

  /* A path that has run its time is worked out again, not dropped: dropping
     it sent the machine straight back at the wall it was going round. */
  if (ai.path) {
    ai.pathT -= TICK;
    if (ai.pathT <= 0 && plan(budget)) {
      const p = findPath(col, e, { x: tx, z: tz },
                         { rad: e.rad, canJump: e.canJump, maxNodes: PATH_NODES });
      ai.path = p && p.length > 1 ? p : null; ai.wp = 1; ai.pathT = REPATH_TIME;
    }
  }
  const along = followPath(e, spd);
  if (along) return along;

  if (ai.sideT > 0) {
    ai.sideT -= TICK;
    /* Perpendicular, and the same way each time it commits — deterministic,
       because both machines in a co-op session have to agree on where this
       thing walked. */
    const px = -dz * ai.side, pz = dx * ai.side;
    return { mx: (dx * 0.35 + px) * spd, mz: (dz * 0.35 + pz) * spd };
  }

  /* Look one step ahead: a drop it would not survive, nothing at all, or —
     for something that cannot swim — water. */
  const ax = e.x + dx * 0.9, az = e.z + dz * 0.9;
  const g = col.supportUnder(ax, az, e.rad, e.y + MOVE.step + EPS);
  const cliff = g === -Infinity || e.y - g > MOVE.fall - 1
    || (e.k === KIND.HOUND && tooDeep(col, ax, az, g));
  /* Something that jumps meets a 1 m face with a jump, not a path. */
  if (e.blocked && !cliff && e.canJump) return { mx: dx * spd, mz: dz * spd, jump: true };
  if ((cliff || e.blocked) && plan(budget)) {
    const p = findPath(col, e, { x: tx, z: tz },
                       { rad: e.rad, canJump: e.canJump, maxNodes: PATH_NODES });
    if (p && p.length > 1) {
      ai.path = p; ai.wp = 1; ai.pathT = REPATH_TIME;
      const first = followPath(e, spd);
      if (first) return first;
    }
    ai.side = ai.side === 0 ? 1 : -ai.side;      /* alternate, never random */
    ai.sideT = SIDESTEP_TIME;
  }
  if (cliff) return { mx: 0, mz: 0 };
  return { mx: dx * spd, mz: dz * spd };
}

/**
 * May this machine work out a path this tick? A search is a few milliseconds
 * on rugged ground and three machines deciding to at once is a dropped frame,
 * so an encounter hands out one per tick, first come first served in the
 * order the machines are stepped — which is fixed, so the host and a replay
 * agree. A machine stepped on its own (a test) has no budget and always may.
 */
function plan(budget) {
  if (!budget) return true;
  if (budget.left <= 0) return false;
  budget.left--;
  return true;
}

/** The next step along the path it is following, or null if it has none left. */
function followPath(e, spd) {
  const ai = e.ai;
  if (!ai.path) return null;
  while (ai.wp < ai.path.length - 1 && hyp(ai.path[ai.wp].x - e.x, ai.path[ai.wp].z - e.z) < 0.35) ai.wp++;
  const w = ai.path[ai.wp], wx = w.x - e.x, wz = w.z - e.z, wl = hyp(wx, wz);
  if (wl < 0.35) { ai.path = null; return null; }
  return { mx: (wx / wl) * spd, mz: (wz / wl) * spd };
}

/** Is this machine one a rival should count as a target? */
function upright(m) {
  return !!m && !m.dead && !m.reserve;
}
function awake(m) {
  return m.ai.state !== EST.DORMANT && m.ai.state !== EST.RETURN;
}

/**
 * The nearest target within sight, or null: a living player, or a machine of
 * another tradition. Only one it would be allowed to chase — someone standing
 * further from its post than the leash is someone it has already given up on,
 * and turning back for them would have it pace the edge of its leash for ever.
 * A dormant machine is woken by a player or by a rival already awake, never
 * by a rival asleep at its own post: nothing fights until a player starts it.
 */
function pick(e, players, foes) {
  const c = specOf(e).c, post = e.ai.post, asleep = e.ai.state === EST.DORMANT;
  let best = null, bd = c.sight;
  const consider = (p) => {
    if (post && hyp(p.x - post.x, p.z - post.z) > c.leash + c.range) return;
    const d = hyp(p.x - e.x, p.z - e.z);
    if (d < bd) { bd = d; best = p; }
  };
  for (const p of players) if (p && !p.dead && !p.down) consider(p);
  if (foes) {
    for (const m of foes) {
      if (m === e || !upright(m) || m.trad === e.trad) continue;
      if (asleep && !awake(m)) continue;
      consider(m);
    }
  }
  return best;
}

/** Is it further from its post than the leash lets it go? */
function strayed(e) {
  const post = e.ai.post;
  return !!post && hyp(e.x - post.x, e.z - post.z) > specOf(e).c.leash;
}

/** Everything this machine's blow may land on: players, and rival machines. */
function victims(e, players, foes) {
  const out = [];
  for (const p of players) if (p && !p.dead && !p.down) out.push(p);
  if (foes) for (const m of foes) if (m !== e && upright(m) && m.trad !== e.trad) out.push(m);
  return out;
}

/** A blow landing: the damage, and on a machine the stagger a hit brings. */
function land(v, dmg, cause) {
  if (hurt(v, dmg, cause) && v.ai) jolt(v);
}

/* ---------- how they move and think (#110) ----------
   They were turrets on legs: straight at you, stop, one attack, wait, again,
   starting, stopping and turning in a single tick. Now each has weight —
   it eases into and out of a walk, and turns no faster than its body could —
   and a small repertoire chosen on dice of its own: a sentry stalks before it
   steps in, backs off a swing it sees coming and sometimes swings twice; a
   mortar shifts between volleys, leads you and varies its pattern; hounds take
   turns, flank from opposite sides and feint. None of it touches the tells:
   whatever hurts is still marked first, on the surface the camera sees. */

/** Per kind: how fast its walk can change (in run-speeds a second) and how
    fast it can turn (radians a second). The sentry is heavy, the hound is not. */
export const MOTION = [
  { accel: 2.6, turn: 4.0 },
  { accel: 2.0, turn: 2.6 },
  { accel: 8.0, turn: 11 },
];

export const SENTRY_AI = {
  /** Inside this it stops closing and stalks you round this ring… */
  stalk: 3.8, ring: 2.8,
  /** …for a while drawn from this, then steps in. */
  wait: [0.5, 1.6],
  /** Seeing a swing wound up within 3.2 m, it steps back this long, this fast,
      this often — and not again for `backCool` seconds. */
  back: 0.28, backSpeed: 1.7, backChance: 0.45, backCool: 2.4,
  /** How often a strike that leaves you in reach is followed by a second one,
      and how short that second wind-up is. */
  combo: 0.5, comboTell: 0.42,
};

export const MORTAR_AI = {
  /** It would rather be this far from you; outside it, it closes. */
  band: [7, 11],
  /** After venting it scuttles sideways this long before aiming again. */
  relocate: [1.4, 2.4],
  /** It aims where you will be: your velocity over this share of the shells'
      time aloft, never more than `leadMax` metres ahead. */
  lead: 0.6, leadMax: 4,
  /** The triangle volley's radius: centre safe, each ring 1.7 m out. */
  triR: 1.7,
};

export const HOUND_AI = {
  /** Between feints, and how long a dart in and a peel away last. */
  feint: [0.9, 2.0], dart: 0.35, peel: 0.45,
  /** The ring it circles on wanders between these. */
  ring: [2.6, 4.2],
  /** Below this share of its health, a hound breaks off after a stumble. */
  retreat: 1.3, hurt: 0.5,
};

/** A machine's own dice, seeded from what it is: a host and a replay roll the same. */
function roll(e) {
  const ai = e.ai;
  if (!ai.seed) {
    const h = Math.imul((e.id === undefined ? 0 : e.id) | 0, 2654435761 | 0)
      ^ Math.imul(Math.round(ai.post.x * 97), 73856093) ^ Math.imul(Math.round(ai.post.z * 131), 19349663) ^ (e.k << 24);
    ai.seed = (h >>> 0) || 0x9e3779b9;
  }
  let x = ai.seed;
  x ^= x << 13; x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5; x >>>= 0;
  ai.seed = x || 0x9e3779b9;
  return ai.seed / 4294967296;
}
const between = (e, r) => r[0] + (r[1] - r[0]) * roll(e);

/** Ease its walk toward what it wants, at its kind's rate. A committed burst
    — a lunge, a backstep, stopping dead for a tell — snaps instead. */
function ease(e, mx, mz, dt, snap) {
  const ai = e.ai;
  if (snap) { ai.mx = mx; ai.mz = mz; return; }
  const a = MOTION[e.k].accel * dt, dx = mx - ai.mx, dz = mz - ai.mz, l = hyp(dx, dz);
  if (l <= a) { ai.mx = mx; ai.mz = mz; } else { ai.mx += (dx / l) * a; ai.mz += (dz / l) * a; }
}

/** Turn toward (dx, dz) no faster than its kind can. */
function turnToward(e, dx, dz, dt) {
  const l = hyp(dx, dz);
  if (l < 1e-6) return;
  dx /= l; dz /= l;
  const fx = e.faceX, fz = e.faceZ, most = MOTION[e.k].turn * dt;
  if (fx * dx + fz * dz >= cos(most)) { e.faceX = dx; e.faceZ = dz; return; }
  const s = fx * dz - fz * dx >= 0 ? most : -most, c = cos(s), n = sin(s);
  const nx = fx * c - fz * n, nz = fx * n + fz * c, nl = hyp(nx, nz) || 1;
  e.faceX = nx / nl; e.faceZ = nz / nl;
}

/** Wake it — and, with two players about, make it a little tougher (§6). */
function rouse(m, budget) {
  m.ai.state = EST.WAKE; m.ai.t = 0;
  const c = specOf(m).c;
  if (budget && budget.party > 1 && !m.scaled && m.hp === m.maxHp) {
    m.scaled = true; m.maxHp = Math.round(c.hp * PARTY_HP); m.hp = m.maxHp;
  }
}

/** A point on a ring of radius r round (tx, tz), `lead` radians round from
    where e stands now, in direction `dir`. */
function ringPoint(e, tx, tz, r, lead, dir) {
  const d = hyp(e.x - tx, e.z - tz) || 1;
  const rx = (e.x - tx) / d, rz = (e.z - tz) / d, a = lead * dir;
  const ca = cos(a), sa = sin(a);
  return { x: tx + (rx * ca - rz * sa) * r, z: tz + (rx * sa + rz * ca) * r };
}

/** Where the volley will come down, fixed now: where you will be, in one of
    three patterns — a line across your path, a line along it, or a triangle
    round you that leaves its centre safe. */
const COS120 = cos(2.0943951023931953), SIN120 = sin(2.0943951023931953);
function aimVolley(e, target) {
  let dx = target.x - e.x, dz = target.z - e.z;
  const l = hyp(dx, dz) || 1;
  dx /= l; dz /= l;
  const T = (MORTAR_AIM_TIME + MORTAR_FLIGHT_TIME) * MORTAR_AI.lead;
  let lx = (target.vx || 0) * T, lz = (target.vz || 0) * T;
  const ll = hyp(lx, lz);
  if (ll > MORTAR_AI.leadMax) { lx *= MORTAR_AI.leadMax / ll; lz *= MORTAR_AI.leadMax / ll; }
  const cx = target.x + lx, cz = target.z + lz;
  const pattern = Math.floor(roll(e) * 3);
  e.ai.pattern = pattern;
  const marks = [];
  if (pattern === 2) {
    let ux = dx, uz = dz;
    for (let i = 0; i < 3; i++) {
      marks.push(cx + ux * MORTAR_AI.triR, cz + uz * MORTAR_AI.triR);
      const nx = ux * COS120 - uz * SIN120, nz = ux * SIN120 + uz * COS120;
      ux = nx; uz = nz;
    }
    return marks;
  }
  const ax = pattern === 0 ? -dz : dx, az = pattern === 0 ? dx : dz;
  for (let i = 0; i < MORTAR.shells; i++) {
    const o = (i - (MORTAR.shells - 1) / 2) * MORTAR.spread;
    marks.push(cx + ax * o, cz + az * o);
  }
  return marks;
}

const HOUND_BUSY = (m) => m.ai.state === EST.TELEGRAPH || m.ai.state === EST.STRIKE;

/**
 * One tick of one machine. It produces an input and hands it to the same `step`
 * the player uses, which is what keeps it honest about the movement budget.
 * `foes` is every machine in the encounter, so it can see rivals and its own
 * pack; `budget` carries how many paths may be searched this tick and how many
 * players there are (the party, for scaling).
 */
export function stepEnemy(col, e, players, dt = TICK, budget, foes) {
  const ai = e.ai, s = specOf(e), c = s.c;

  if (e.dead) {
    if (ai.state !== EST.DEAD) { ai.state = EST.DEAD; ai.t = 0; ai.marks = null; }
    ai.t += dt;
    return e;
  }
  if (e.reserve) return e;
  /* A machine of a scar that has been put out stays where it is (#7). */
  if (e.calmed) return e;

  ai.t += dt;
  const target = pick(e, players, foes);
  ai.tgt = target;
  let mx = 0, mz = 0, face = null, jump = false, snap = false;
  const d = target ? hyp(target.x - e.x, target.z - e.z) : Infinity;
  const ux = target ? (target.x - e.x) / (d || 1) : 0, uz = target ? (target.z - e.z) / (d || 1) : 0;
  const go = (tx, tz, sp) => {
    const sm = steer(col, e, tx, tz, budget, sp);
    mx = sm.mx; mz = sm.mz; jump = !!sm.jump;
  };

  switch (ai.state) {
    case EST.DORMANT:
      if (target) {
        rouse(e, budget);
        /* A group wakes as one: the pack it was placed with comes too. */
        for (const m of e.pack || []) {
          if (m !== e && !m.dead && !m.reserve && m.ai.state === EST.DORMANT) rouse(m, budget);
        }
      }
      break;

    case EST.WAKE:
      if (target) face = target;
      if (ai.t >= WAKE_TIME) { ai.state = target ? EST.CLOSE : EST.DORMANT; ai.t = 0; }
      break;

    case EST.CLOSE: {
      if (!target || strayed(e)) { ai.state = EST.RETURN; ai.t = 0; ai.path = null; ai.mode = null; break; }
      face = target;

      if (e.k === KIND.MORTAR) {
        const M = MORTAR_AI;
        if (ai.reloc > 0) {
          /* Shifting position after a volley: sideways round you, still facing you. */
          ai.reloc -= dt;
          const p = ringPoint(e, target.x, target.z, Math.max(M.band[0], Math.min(M.band[1], d)), 0.8, ai.orbit);
          go(p.x, p.z, c.speed * 1.25);
          break;
        }
        if (d < c.near) {
          /* Too close to fire: back off, away from it. */
          go(e.x - ux * 4, e.z - uz * 4, c.speed * 1.15);
        } else if (d <= c.range && ai.t >= 0.4) {
          ai.state = EST.TELEGRAPH; ai.t = 0; ai.marks = aimVolley(e, target);
        } else if (d > M.band[1]) {
          go(target.x, target.z);
        } else if (d < M.band[0]) {
          go(e.x - ux * 3, e.z - uz * 3, c.speed * 0.8);
        }
        break;
      }

      if (e.k === KIND.HOUND) {
        const H = HOUND_AI;
        if (ai.retreatT > 0) {
          ai.retreatT -= dt;
          go(e.x - ux * 4, e.z - uz * 4, c.speed * 1.1);
          break;
        }
        if (ai.dartT > 0) {
          /* A feint: in fast, no tell and no bite — and out again. */
          ai.dartT -= dt;
          go(target.x, target.z, c.speed * 1.6);
          if (d < 2.1) { ai.dartT = 0; ai.peelT = H.peel; }
          break;
        }
        if (ai.peelT > 0) {
          ai.peelT -= dt;
          const p = ringPoint(e, target.x, target.z, 4.5, 0.9, ai.orbit);
          go(p.x, p.z, c.speed * 1.3);
          break;
        }
        /* The pack takes turns: while one is committed to a lunge at this
           target, the other holds the far side of it. */
        let lunger = null, partner = null;
        if (foes) {
          for (const m of foes) {
            if (m === e || m.k !== KIND.HOUND || m.dead || m.ai.tgt !== target) continue;
            if (HOUND_BUSY(m)) lunger = m;
            if (!partner || hyp(m.x - e.x, m.z - e.z) < hyp(partner.x - e.x, partner.z - e.z)) partner = m;
          }
        }
        /* A pincer: from the far side of you from its partner, or — if the
           partner never gets round — after a while from wherever it is. */
        let across = true;
        if (partner) {
          const ax = e.x - target.x, az = e.z - target.z, bx = partner.x - target.x, bz = partner.z - target.z;
          across = (ax * bx + az * bz) / ((hyp(ax, az) * hyp(bx, bz)) || 1) < -0.2 || ai.t > 2.5;
        }
        /* A feint that is due comes before a lunge: in, out, and only then
           the real thing — so a hound that darts at you is not a hound that
           is about to bite, and you learn to wait for the line. */
        if (ai.feintT < 0) ai.feintT = between(e, H.feint);
        ai.feintT -= dt;
        if (!lunger && ai.feintT <= 0 && d < 5.5 && d > 2.4) {
          ai.feintT = between(e, H.feint); ai.dartT = H.dart;
          break;
        }
        if (!lunger && across && d <= c.range && ai.t >= CIRCLE_TIME) {
          /* The line is fixed now, and drawn: the tell is where it will go. */
          ai.state = EST.TELEGRAPH; ai.t = 0;
          ai.lx = ux; ai.lz = uz;
          snap = true;
          break;
        }
        ai.ringT -= dt;
        if (ai.ringT <= 0) {
          ai.ringT = 0.9 + roll(e);
          ai.ring = between(e, H.ring);
          if (roll(e) < 0.3) ai.orbit = -ai.orbit;
        }
        const other = lunger || partner;
        if (other) {
          /* Round to the far side of you from the other one. */
          const ox = target.x - other.x, oz = target.z - other.z, ol = hyp(ox, oz) || 1;
          const p = { x: target.x + (ox / ol) * ai.ring, z: target.z + (oz / ol) * ai.ring };
          /* Not through you: round, on the ring, toward that point. */
          const way = (e.x - target.x) * (p.z - target.z) - (e.z - target.z) * (p.x - target.x) >= 0 ? 1 : -1;
          const q = hyp(p.x - e.x, p.z - e.z) > 2 ? ringPoint(e, target.x, target.z, ai.ring, 0.8, way) : p;
          go(q.x, q.z, c.speed * (lunger ? 1.35 : 1));
        } else {
          const p = ringPoint(e, target.x, target.z, ai.ring, 0.7, ai.orbit);
          go(p.x, p.z);
        }
        break;
      }

      /* The sentry. */
      const S = SENTRY_AI;
      if (ai.backT > 0) {
        ai.backT -= dt;
        mx = -ux * S.backSpeed; mz = -uz * S.backSpeed; snap = true;
        break;
      }
      if (ai.backCD > 0) ai.backCD -= dt;
      if (target.swing && target.swing.t < WINDUP && d < 3.2 && ai.backCD <= 0) {
        /* It saw that coming. Sometimes. */
        ai.backCD = S.backCool;
        if (roll(e) < S.backChance) {
          ai.backT = S.back;
          mx = -ux * S.backSpeed; mz = -uz * S.backSpeed; snap = true;
          break;
        }
      }
      if (d <= c.range) { ai.state = EST.TELEGRAPH; ai.t = 0; ai.mode = null; snap = true; break; }
      if (ai.mode === 'stalk') {
        ai.wait -= dt;
        if (d > S.stalk + 1.2) ai.mode = null;
        else if (ai.wait <= 0) ai.mode = 'in';
        else {
          const p = ringPoint(e, target.x, target.z, S.ring, 0.55, ai.orbit);
          go(p.x, p.z, c.speed * 0.8);
          break;
        }
      } else if (ai.mode !== 'in' && d < S.stalk) {
        ai.mode = 'stalk'; ai.wait = between(e, S.wait); ai.orbit = roll(e) < 0.5 ? 1 : -1;
      }
      go(target.x, target.z);
      break;
    }

    case EST.TELEGRAPH:
      snap = true;
      if (e.k === KIND.HOUND) {
        /* Facing its line, and not turning: the line is what you read. */
        face = { x: e.x + ai.lx, z: e.z + ai.lz };
      } else if (target && e.k === KIND.SENTRY) {
        /* Stopped dead, and still turning to face you — at its own rate, which
           is what makes running round it during the wind-up worth doing. */
        face = target;
      }
      if (ai.t >= s.tell) { ai.state = EST.STRIKE; ai.t = 0; e.swungAt = 0; ai.bit = 0; }
      break;

    case EST.STRIKE:
      if (e.k === KIND.HOUND) {
        face = { x: e.x + ai.lx, z: e.z + ai.lz };
        mx = ai.lx * c.lunge; mz = ai.lz * c.lunge; snap = true;
      } else snap = true;
      if (ai.t >= s.strike) {
        if (e.k === KIND.MORTAR) {
          /* The shells come down where the rings were, and only there. */
          const vs = victims(e, players, foes), m = ai.marks || [];
          for (const v of vs) {
            for (let i = 0; i < m.length; i += 2) {
              if (hyp(v.x - m[i], v.z - m[i + 1]) <= MORTAR.ringR) { land(v, MORTAR.damage, 'shelled'); break; }
            }
          }
          ai.marks = null;
        }
        if (e.k === KIND.SENTRY && !ai.combo && target && d <= SENTRY.reach + 0.6 && roll(e) < SENTRY_AI.combo) {
          /* A second swing, re-aimed and quicker to come — then the long recovery. */
          ai.combo = 1; ai.state = EST.TELEGRAPH; ai.t = TELEGRAPH_TIME - SENTRY_AI.comboTell; e.swungAt = 0;
          break;
        }
        ai.combo = 0;
        ai.state = EST.RECOVER; ai.t = 0;
      }
      break;

    case EST.RECOVER:
      snap = e.k === KIND.HOUND && ai.t < 0.1;
      if (ai.t >= s.recover) {
        ai.state = target ? EST.CLOSE : EST.RETURN; ai.t = 0; ai.orbit = -ai.orbit; ai.mode = null;
        if (e.k === KIND.MORTAR) { ai.reloc = between(e, MORTAR_AI.relocate); ai.orbit = roll(e) < 0.5 ? 1 : -1; }
        if (e.k === KIND.HOUND && e.hp < e.maxHp * HOUND_AI.hurt) ai.retreatT = HOUND_AI.retreat;
      }
      break;

    case EST.STAGGER:
      if (ai.t >= STAGGER_TIME) { ai.state = target ? EST.CLOSE : EST.RETURN; ai.t = 0; ai.marks = null; ai.mode = null; ai.combo = 0; }
      break;

    case EST.RETURN: {
      /* Back to where it holds, the way round if it must. Someone walking
         into sight on the way turns it round again — inside the leash. */
      if (target && !strayed(e)) { ai.state = EST.CLOSE; ai.t = 0; ai.path = null; break; }
      const post = ai.post, dp = hyp(post.x - e.x, post.z - e.z);
      if (dp < 0.6) { ai.state = EST.DORMANT; ai.t = 0; ai.path = null; break; }
      go(post.x, post.z);
      break;
    }

    default:
      break;
  }

  /* Weight: the walk eases toward what it wants, and the body turns toward
     what it faces — or where it is going — no faster than it can. */
  ease(e, mx, mz, dt, snap);
  if (face) turnToward(e, face.x - e.x, face.z - e.z, dt);
  else if (hyp(ai.mx, ai.mz) > 0.05) turnToward(e, ai.mx, ai.mz, dt);
  const input = { mx: ai.mx, mz: ai.mz, jump, attack: false, dodge: false, aimX: e.faceX, aimZ: e.faceZ };
  /* One jump per time off the ground: a hound jumps a 1 m face, never 2 m. */
  e.airJumps = 0;
  step(col, e, input, null, dt);
  e.airJumps = 0;

  if (ai.state === EST.STRIKE && e.k === KIND.SENTRY && !e.swungAt) {
    /* The strike itself: one arc, once, on the tick the window opens. */
    e.swungAt = 1;
    for (const v of victims(e, players, foes)) {
      if (inArc(e, v, SENTRY.reach, SENTRY.arc, SENTRY.span, COS_HALF)) land(v, SENTRY.damage, 'struck');
    }
  }
  if (ai.state === EST.STRIKE && e.k === KIND.HOUND) {
    /* Whatever the lunge passes close to, once each. */
    const vs = victims(e, players, foes);
    for (let i = 0; i < vs.length && i < 30; i++) {
      const v = vs[i], id = 1 << i;
      if (ai.bit & id) continue;
      if (hyp(v.x - e.x, v.z - e.z) <= HOUND.bite + (v.rad || 0) && Math.abs(v.y - e.y) < 1.4) {
        ai.bit |= id; land(v, HOUND.damage, 'bitten');
      }
    }
  }
  return e;
}

/** The sentry's own step, kept by name for whatever steps one alone. */
export function stepSentry(col, e, players, dt = TICK, budget, foes) {
  return stepEnemy(col, e, players, dt, budget, foes);
}

/** Tell it that it has been hit — staggering it if it was not already committed. */
export function jolt(e) {
  /* The furnace's guardian is a target and not a machine: it has no clock to stagger (#7). */
  if (e.dead || !e.ai) return;
  if (staggerable(e.ai.state)) { e.ai.state = EST.STAGGER; e.ai.t = 0; e.ai.marks = null; }
}

/* Posts: where the machines hold (#6, #42). Beyond sight from the spawn, so
   they are found rather than met, and not so far that the window has none. */
const POST_MIN = SENTRY.sight + 2, POST_MAX = 34, POST_APART = 10, POSTS = 3;
const POST_RANK = { cover: 0, vantage: 1, arena: 2 };

/**
 * Who holds each post (#106, §6): mixed small groups whose roles combine. A
 * tech post is a sentry to pin you and a mortar behind it to shell you; a
 * biological post is a pair of hounds. The last of each list is the group's
 * reserve, out only when a second player is (§6).
 */
export const PACKS = [
  { members: [KIND.SENTRY, KIND.MORTAR], reserve: KIND.SENTRY },
  { members: [KIND.HOUND, KIND.HOUND], reserve: KIND.HOUND },
  { members: [KIND.SENTRY, KIND.MORTAR], reserve: KIND.SENTRY },
];

/** Where a machine this wide can stand at (x, z), near ground height h, or null. */
function roomAt(col, x, z, h, rad) {
  const y = col.supportUnder(x, z, rad, h + MOVE.step);
  if (y === -Infinity || y < h - MOVE.step) return null;
  return col.overlaps(x, z, rad, y + EPS, y + 1.8 - EPS) ? null : y;
}

/**
 * Where to put the machines, from the ground the region pass annotated (#42):
 * cover first — something to hold behind — then the high ground, then open
 * ground big enough to fight on. Never two within POST_APART of each other,
 * and never where a machine this wide cannot stand. Only when the ground
 * offers too few does it fall back to the fixed ring it used to use, which
 * was offsets from the spawn chosen against nothing (noted on #6: one of them
 * stood on a graded trail and walked down it to the practice posts).
 */
export function postsFor(col, world) {
  const spawn = world.spawn, out = [];
  /* Ground, not whatever is highest. Support used to be asked for from
     infinitely high, and a post beside cover under a tree put its machine on
     the canopy, 2.9 m over a character who could never reach it (#3 moved
     one there). So support is sought from a step above the ground the post
     was chosen on, and must be that ground. The answer is the height a
     machine is placed from, returned as the post's third element. */
  const ok = (x, z, h) => {
    const d = hyp(x - spawn[0], z - spawn[2]);
    if (d < POST_MIN || d > POST_MAX) return null;
    for (const p of out) if (hyp(p[0] - x, p[1] - z) < POST_APART) return null;
    return roomAt(col, x, z, h, SENTRY.rad);
  };
  const cands = (world.affordances || []).filter((a) => a.k in POST_RANK).slice()
    .sort((a, b) => POST_RANK[a.k] - POST_RANK[b.k] || b.s - a.s || a.x - b.x || a.z - b.z);
  for (const a of cands) {
    if (out.length >= POSTS) break;
    const y = ok(a.x, a.z, a.h);
    if (y !== null) out.push([a.x, a.z, y]);
  }
  for (const [dx, dz] of [[14, 3], [-11, -13], [5, 19]]) {
    if (out.length >= POSTS) break;
    const x = spawn[0] + dx, z = spawn[2] + dz;
    const g = col.supportUnder(x, z, SENTRY.rad, spawn[1] + MOVE.climb2);
    const y = g === -Infinity ? null : ok(x, z, g);
    if (y !== null) out.push([x, z, y]);
  }
  return out;
}

/* Where the rest of a group stands, round its post: behind it (away from the
   spawn) first, which is where a mortar belongs, then either side. */
const ROUND = [[0, 3.5], [2.2, 1.2], [-2.2, 1.2], [2.6, -1.4], [-2.6, -1.4], [0, -2.6]];

/**
 * A group at one post, in a fixed order: the members, then the reserve. The
 * first member stands on the post; each of the others takes the first free
 * place round it where a machine its width can stand, and falls back to the
 * post itself only if none is free.
 */
function placeGroup(col, spawn, post, g, idBase) {
  const [px, pz, py] = post;
  let bx = px - spawn[0], bz = pz - spawn[2];
  const bl = hyp(bx, bz) || 1;
  bx /= bl; bz /= bl;                                  /* away from the spawn */
  const sx = -bz, sz = bx;
  const kinds = g.members.concat([g.reserve]);
  const out = [], used = [];
  for (let i = 0; i < kinds.length; i++) {
    const k = kinds[i], rad = SPEC[k].c.rad;
    let at = null;
    if (i === 0) at = [px, pz, py];
    for (let q = 0; !at && q < ROUND.length; q++) {
      if (used.indexOf(q) >= 0) continue;
      const [a, b] = ROUND[q];
      const x = px + sx * a + bx * b, z = pz + sz * a + bz * b;
      const y = roomAt(col, x, z, py, rad);
      if (y !== null) { at = [x, z, y]; used.push(q); }
    }
    if (!at) at = [px, pz, py];
    const e = MAKE[k](col, at[0], at[1], at[2] + EPS);
    if (idBase !== undefined) e.id = idBase + i;
    if (i === kinds.length - 1) e.reserve = true;
    e.pack = out;
    out.push(e);
  }
  return out;
}

/* ---------- a streamed world's machines (#108) ----------
   A window has its nine machines, placed once. A streamed world has no edge,
   so it cannot be placed once: each loaded chunk nominates at most one post
   from its own encounter ground, and the group there is brought into the
   simulation when a player comes near and put away again when everyone has
   gone and it has settled. What it was — which of it is dead — is
   remembered, so a group you cleared stays cleared for the session.

   `active` and `drop` are distances from the post. `max` bounds the machines
   simulated at once: it is what keeps two players inside the wire budget, and
   with the practice posts it keeps every target inside a swing's 32-bit hit
   mask. `edge` keeps a post this far inside its chunk, so two chunks' posts
   are never nearer each other than twice it. */
export const STREAM_ENC = { active: 40, drop: 56, max: 15, edge: 5, every: 15 };

/** Which pack holds a chunk's post: a hash of where it is, the same every time. */
function packAt(cx, cz) {
  const h = (Math.imul(cx, 73856093) ^ Math.imul(cz, 19349663)) >>> 0;
  return PACKS[h % PACKS.length];
}

/** A group's id, from its chunk; its machines are this times four plus their
    place. Small, because it is on the wire for every machine every snapshot:
    a thousand chunks either way of the origin is 32 km. */
const groupId = (cx, cz) => ((cx + 512) * 1024 + (cz + 512));

/**
 * The post one loaded chunk offers, or null: the best of its own encounter
 * ground by the same order the window uses — cover, the high ground, then
 * open ground — inside the chunk and off its edges, and not where a player
 * starting out would walk straight into it.
 */
function chunkPost(c, spawn) {
  const x0 = c.cx * CHUNK - CHUNK / 2, z0 = c.cz * CHUNK - CHUNK / 2, m = STREAM_ENC.edge;
  const cands = ((c.w && c.w.affordances) || []).filter((a) => a.k in POST_RANK
    && a.wx >= x0 + m && a.wx < x0 + CHUNK - m && a.wz >= z0 + m && a.wz < z0 + CHUNK - m
    && hyp(a.wx - spawn[0], a.wz - spawn[2]) >= POST_MIN);
  if (!cands.length) return null;
  cands.sort((a, b) => POST_RANK[a.k] - POST_RANK[b.k] || b.s - a.s || a.wx - b.wx || a.wz - b.wz);
  const a = cands[0];
  return { x: a.wx, z: a.wz, h: a.h };
}

/**
 * Everything in the world that can be swung at, and the thing that steps it.
 *
 * One unit so the host and a solo build drive identical code, and so that the
 * bit the guest does *not* run is obvious: it draws what the host sends and
 * simulates none of it.
 *
 * Given a chunk field for `col` — anything with `live()` — it is a streamed
 * world's encounter, and its machines come and go with the ground (#108).
 */
export function makeEncounter(col, world, posts) {
  const enemies = [];
  const streamed = !!(col && typeof col.live === 'function');
  if (!streamed) {
    const ps = postsFor(col, world);
    for (let i = 0; i < ps.length; i++) {
      for (const e of placeGroup(col, world.spawn, ps[i], PACKS[i % PACKS.length])) enemies.push(e);
    }
    enemies.forEach((e, i) => { e.id = i; });
  }
  const targets = (posts || []).concat(enemies);
  const postCount = (posts || []).length;
  /* Each machine drops its own tradition (§6), so a hound drops biological. */
  const loot = makeLootField(col, world, 0);
  let nextId = -1, ticks = 0;   /* the debug dialog's machines count down */

  /* ---- streamed: which groups exist, and what is left of each ---- */
  const groups = new Map(), posted = new Map();
  let made = 0, putAway = 0;

  /* ---- the furnace (#7): the weapon site of a streamed world, if it has one ----
     The run is the host's. It is lent what it needs of the encounter and nothing
     more: a place to put machines, to hold the guardian among the things a swing
     can hit, a spoil to lay, and a way to put a scar out. */
  const siteDesc = streamed && world && world.G && world.G.site ? world.G.site() : null;
  let calmZone = null;
  if (siteDesc) { installDoors(col); col.setDoor(siteDesc.door, true); }
  const furnace = siteDesc ? makeFurnaceRun(siteDesc, {
    kinds: { sentry: KIND.SENTRY, mortar: KIND.MORTAR, hound: KIND.HOUND },
    spawn(kind, x, z) {
      const e = (MAKE[kind] || makeSentry)(col, x, z, siteDesc.hf + 1);
      e.id = nextId--;
      enemies.push(e); targets.push(e);
      return e;
    },
    alive(list) { let n = 0; for (const e of list) if (!e.dead) n++; return n; },
    /* The gate's door, in the collider every end walks (#7). */
    door(shut) { col.setDoor(siteDesc.door, shut); },
    /* Just after the posts, so that it keeps a place in the first thirty-two
       things a swing can reach however many machines are standing. */
    hold(t) { if (targets.indexOf(t) < 0) targets.splice(postCount, 0, t); },
    release(t) { const i = targets.indexOf(t); if (i >= 0) targets.splice(i, 1); },
    drop(key, t) { loot.drop(key, t); },
    calm(x, z, r) {
      calmZone = { x, z, r };
      for (const e of enemies) if (hyp(e.x - x, e.z - z) <= r) { e.calmed = true; e.ai.state = EST.DORMANT; e.ai.t = 0; e.ai.marks = null; }
    },
  }) : null;

  function remove(e) {
    const i = enemies.indexOf(e);
    if (i < 0) return;
    enemies.splice(i, 1);
    const ti = targets.indexOf(e);
    if (ti >= 0) targets.splice(ti, 1);
  }

  function sync(players) {
    const who = players.filter((p) => p);
    if (!who.length) return;
    const near = (x, z) => {
      let d = Infinity;
      for (const p of who) d = Math.min(d, hyp(p.x - x, p.z - z));
      return d;
    };
    const live = new Set(), want = [];
    for (const c of col.live()) {
      const ck = c.cx + ',' + c.cz;
      live.add(ck);
      if (!posted.has(ck)) posted.set(ck, chunkPost(c, world.spawn));
      const post = posted.get(ck);
      if (!post) continue;
      const gid = groupId(c.cx, c.cz);
      let g = groups.get(gid);
      if (!g) { g = { gid, ck, post, pack: packAt(c.cx, c.cz), members: [], dead: 0, cleared: false }; groups.set(gid, g); }
      const d = near(post.x, post.z);
      if (g.members.length) {
        const settled = g.members.every((e) => e.dead || e.reserve || e.ai.state === EST.DORMANT);
        if ((d > STREAM_ENC.drop && settled) || d > STREAM_ENC.drop + 40) putAwayGroup(g);
      } else if (!g.cleared && d < STREAM_ENC.active) want.push([d, g]);
    }
    /* Ground that went is ground nothing can stand on. */
    for (const g of groups.values()) if (g.members.length && !live.has(g.ck)) putAwayGroup(g);
    want.sort((a, b) => a[0] - b[0] || a[1].gid - b[1].gid);
    for (const [, g] of want) {
      const kinds = g.pack.members.length + 1;
      let left = 0;
      for (let i = 0; i < kinds; i++) if (!(g.dead & (1 << i))) left++;
      if (enemies.length + left > STREAM_ENC.max) continue;
      const y = roomAt(col, g.post.x, g.post.z, g.post.h, SENTRY.rad);
      if (y === null) continue;
      const all = placeGroup(col, world.spawn, [g.post.x, g.post.z, y], g.pack, g.gid * 4);
      g.members = all.filter((e, i) => !(g.dead & (1 << i)));
      for (const e of g.members) {
        e.group = g; enemies.push(e); targets.push(e);
        if (calmZone && hyp(e.x - calmZone.x, e.z - calmZone.z) <= calmZone.r) e.calmed = true;
      }
      made++;
    }
  }

  function putAwayGroup(g) {
    for (const e of g.members) remove(e);
    g.members = [];
    putAway++;
  }

  /** A machine has fallen: its spoil, and what its group remembers. */
  function fell(e) {
    loot.drop(e.id, e);
    const g = e.group;
    if (!g) return;
    g.dead |= 1 << (e.id - g.gid * 4);
    const kinds = g.pack.members.length + 1;
    let up = 0;
    for (let i = 0; i < kinds; i++) if (!(g.dead & (1 << i))) up++;
    /* Cleared when nothing that was out is still standing: a reserve nobody
       brought out does not hold a cleared post open. */
    g.cleared = g.members.every((m) => m.dead || m.reserve) && up < kinds;
  }

  /** Is the ground under a machine still loaded? A streamed machine on ground
      that has gone would fall forever, so it waits instead. */
  const grounded = (e) => !streamed || col.has(Math.floor(e.x / CHUNK + 0.5), Math.floor(e.z / CHUNK + 0.5));

  return {
    enemies, targets, postCount, loot, streamed,
    /** While set, no group comes or goes and no machine acts: for a gate
        that walks a streamed world to measure the streaming, not a fight. */
    held: false,

    /** The furnace's run (#7), or null where the world has no weapon site. */
    get site() { return furnace; },
    /** Host: the run as it crosses the wire, or null while there is nothing to say. */
    siteWire() { return furnace ? furnace.wire() : null; },
    /** Guest: the host's record of the run. */
    observeSite(w) { if (furnace) furnace.observe(w); },

    /** How a streamed world's groups stand, for tests and the readout. */
    get groups() {
      let active = 0, cleared = 0;
      for (const g of groups.values()) { if (g.members.length) active++; if (g.cleared) cleared++; }
      return { known: groups.size, active, cleared, made, putAway };
    },

    /** One more machine, standing where it is put — the debug dialog's (#92).
        It is a target like the rest, and drops what it is made of like them. */
    add(x, z, fromY, kind) {
      const e = (MAKE[kind] || makeSentry)(col, x, z, fromY);
      e.id = nextId--;
      enemies.push(e); targets.push(e);
      return e;
    },

    /** One tick: the machines act, then whatever the players cut takes it. */
    step(players, dt = TICK) {
      if (this.held) { upkeep(players, dt); return loot.collect(players); }
      if (streamed && ticks++ % STREAM_ENC.every === 0) sync(players);
      let party = 0;
      for (const p of players) if (p) party++;
      /* A second player brings each group's reserve out (§6). It stays out. */
      if (party > 1) for (const e of enemies) if (e.reserve) e.reserve = false;
      const budget = { left: 1, party };
      for (const e of enemies) if (grounded(e)) stepEnemy(col, e, players, dt, budget, enemies);
      /* Whoever a machine has its eye on is hunted, and does not heal (#114). */
      for (const e of enemies) {
        const g = e.ai && e.ai.tgt;
        if (g && !e.dead && !e.reserve && awake(e) && players.indexOf(g) >= 0) g.hunted = REGEN_DELAY;
      }
      for (const p of players) {
        if (!p || !p.hits) continue;
        const mask = p.hits;
        /* No damage argument: what a swing is worth is the swinger's business,
           and their lattice is what decides it. */
        applyHits(p, targets);
        /* A hit interrupts a machine that was not already committed. The posts
           are the first entries and feel nothing. */
        for (let i = postCount; i < targets.length; i++) if (mask & (1 << i)) jolt(targets[i]);
      }
      /* What is left of a machine, and then whoever walks over it. */
      for (const e of enemies) if (e.dead && !e.fell) { e.fell = 1; fell(e); }
      if (furnace) furnace.step(players, dt);
      upkeep(players, dt);
      return loot.collect(players);
    },

    /**
     * Guest: fold an authoritative snapshot back into the copy this end derived
     * for itself. The machines are drawn from `foes`; `takenBits` — one
     * integer — is which caches are gone, and `spoils` is what fallen machines
     * left on the ground that nobody has picked up yet.
     */
    observeWire(foes, takenBits, spoils) {
      if (takenBits !== undefined && takenBits !== null) loot.applyWire(takenBits);
      loot.applySpoils(spoils);
    },

    /**
     * What a guest needs to draw them, and nothing else — it does not simulate
     * enemies, so it does not need the state that simulating them requires.
     * Rounded, because these are pixels and not a trajectory anyone replays:
     * a centimetre is below what the view can show, and nine machines at
     * millimetres were what pushed two players past the wire budget — and a
     * streamed world's fifteen at centimetres nearly did again (#108).
     * `k` is the archetype, `i` which machine it is for good — a streamed
     * world's list changes as groups come and go (#108) — `mh` its most health when party scaling moved it
     * off the archetype's, `u` its hurt flash while it lasts, `r` set while it
     * is a reserve nobody has brought out, and `g` the mortar's rings while
     * they are down.
     */
    wire() {
      const r2 = (v) => Math.round(v * 100) / 100, r1 = (v) => Math.round(v * 10) / 10;
      return enemies.map((e) => {
        const still = e.ai.state === EST.DORMANT || e.ai.state === EST.DEAD;
        const o = {
          x: r2(e.x), y: r2(e.y), z: r2(e.z),
          /* A tenth is a few degrees, which a machine forty pixels tall does
             not show; and a sleeping or fallen machine's clock is not posed. */
          fx: r1(e.faceX), fz: r1(e.faceZ),
          s: e.ai.state, t: still ? 0 : r2(e.ai.t),
          h: r2(e.hp), k: e.k, i: e.id,
        };
        if (e.hurtT > 0) o.u = r2(e.hurtT);
        if (e.maxHp !== specOf(e).c.hp) o.mh = r2(e.maxHp);
        if (e.reserve) o.r = 1;
        if (e.ai.marks) o.g = e.ai.marks.map(r2);
        return o;
      });
    },
  };
}

/* On the wire the machines go as arrays, not keyed objects: nine machines
   spelled out key by key were the difference between two players fitting the
   budget and not (#106). The rarely-set fields ride in a trailing object only
   when one of them is present. */
const PACKED = ['x', 'y', 'z', 'fx', 'fz', 's', 't', 'h', 'k', 'i'];

/** `encounter.wire()` as it crosses the network. */
export function packFoes(foes) {
  if (!foes) return null;
  return foes.map((o) => {
    const a = PACKED.map((key) => o[key]);
    let rest = null;
    for (const key in o) {
      if (PACKED.indexOf(key) < 0) (rest || (rest = {}))[key] = o[key];
    }
    if (rest) a.push(rest);
    return a;
  });
}

/** And back into what `wire()` returned, on the far side. */
export function unpackFoes(packed) {
  if (!packed) return null;
  return packed.map((a) => {
    const o = {};
    for (let i = 0; i < PACKED.length; i++) o[PACKED[i]] = a[i];
    if (a.length > PACKED.length) Object.assign(o, a[PACKED.length]);
    return o;
  });
}
