/**
 * One enemy: a **sentry automaton**, a tech war machine still holding a
 * position against an enemy that left (docs/DECISIONS.md §1, §6).
 *
 * Issue #24 asks for one archetype, and issue #6 asks four questions of every
 * archetype. For this one:
 *
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
 *                burns exactly as a player would. It does **not** vault: a
 *                heavy machine goes around, which is what `canVault = false`
 *                and the side-stepping below are for.
 *
 * No AI architecture, as the issue says — a state machine and a steering
 * direction. No spawn rules and no repopulation; a machine does now leave
 * behind the discipline it was built from, which is the other half of "a fight
 * previews its loot" (§6) and lives in src/sim/loot.mjs.
 */
import { MOVE } from '../gen/constants.mjs';
import { hyp, cos } from '../gen/exact.mjs';
import { EPS } from './collider.mjs';
import { TICK, ACTOR, placeOnGround, step } from './actor.mjs';
import { inArc, hurt, applyHits } from './combat.mjs';
import { makeLootField } from './loot.mjs';
import { findPath } from './nav.mjs';

export const SENTRY = {
  hp: 60,
  /** How far it notices you. Deliberately short: it holds a position. */
  sight: 13,
  /** Where it decides you are close enough to be worth swinging at. */
  range: 2.1,
  /** Longer than the player's and slower — methodical, and it telegraphs. */
  reach: 2.4,
  arc: 1.4,
  span: 2.0,
  damage: 18,
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
/** How long it commits to going around something before trying forward again. */
export const SIDESTEP_TIME = 0.5;
/** How often a path is worked out again while it is being followed (#15). */
export const REPATH_TIME = 0.5;
/** Nodes a single search may open: bounded, because the host pays for it. */
const PATH_NODES = 900;

export function makeSentry(col, x, z) {
  const e = placeOnGround(col, x, z, undefined, SENTRY.rad);
  e.hp = SENTRY.hp; e.maxHp = SENTRY.hp;
  e.canVault = false;
  e.kind = 'sentry';
  e.ai = { state: EST.DORMANT, t: 0, side: 0, sideT: 0,
           /* Where it holds (#6), and the path it is following, if any (#15). */
           post: { x: e.x, y: e.y, z: e.z }, path: null, wp: 0, pathT: 0 };
  return e;
}

/** Is it in a state where a player's hit should interrupt it? */
function staggerable(st) {
  return st === EST.CLOSE || st === EST.WAKE || st === EST.TELEGRAPH;
}

/**
 * Where to walk. Straight at the target while nothing is in the way; once a
 * wall or a drop is, along a path round it (#15) — worked out for its own
 * width, without vaults or jumps, because it does neither — and only when no
 * path exists, sideways for a while. A machine that walks off a ledge to reach
 * you is not menacing, and one that hovers over the gap is worse.
 */
function steer(col, e, tx, tz, budget) {
  const ai = e.ai;
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
                         { rad: e.rad, canVault: false, canJump: false, maxNodes: PATH_NODES });
      ai.path = p && p.length > 1 ? p : null; ai.wp = 1; ai.pathT = REPATH_TIME;
    }
  }
  const along = followPath(e);
  if (along) return along;

  if (ai.sideT > 0) {
    ai.sideT -= TICK;
    /* Perpendicular, and the same way each time it commits — deterministic,
       because both machines in a co-op session have to agree on where this
       thing walked. */
    const px = -dz * ai.side, pz = dx * ai.side;
    return { mx: (dx * 0.35 + px) * SENTRY.speed, mz: (dz * 0.35 + pz) * SENTRY.speed };
  }

  /* Look one step ahead: a drop it would not survive, or nothing at all. */
  const ax = e.x + dx * 0.9, az = e.z + dz * 0.9;
  const g = col.supportUnder(ax, az, e.rad, e.y + MOVE.step + EPS);
  const cliff = g === -Infinity || e.y - g > MOVE.fall - 1;
  if ((cliff || e.blocked) && plan(budget)) {
    const p = findPath(col, e, { x: tx, z: tz },
                       { rad: e.rad, canVault: false, canJump: false, maxNodes: PATH_NODES });
    if (p && p.length > 1) {
      ai.path = p; ai.wp = 1; ai.pathT = REPATH_TIME;
      const first = followPath(e);
      if (first) return first;
    }
    ai.side = ai.side === 0 ? 1 : -ai.side;      /* alternate, never random */
    ai.sideT = SIDESTEP_TIME;
  }
  return { mx: dx * SENTRY.speed, mz: dz * SENTRY.speed };
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
function followPath(e) {
  const ai = e.ai;
  if (!ai.path) return null;
  while (ai.wp < ai.path.length - 1 && hyp(ai.path[ai.wp].x - e.x, ai.path[ai.wp].z - e.z) < 0.35) ai.wp++;
  const w = ai.path[ai.wp], wx = w.x - e.x, wz = w.z - e.z, wl = hyp(wx, wz);
  if (wl < 0.35) { ai.path = null; return null; }
  return { mx: (wx / wl) * SENTRY.speed, mz: (wz / wl) * SENTRY.speed };
}

/**
 * The nearest living player within sight, or null — and only one it would be
 * allowed to chase: someone standing further from its post than the leash is
 * someone it has already given up on, and turning back for them would have it
 * pace the edge of its leash for ever.
 */
function pick(e, players) {
  let best = null, bd = SENTRY.sight;
  const post = e.ai.post;
  for (const p of players) {
    if (!p || p.dead) continue;
    if (post && hyp(p.x - post.x, p.z - post.z) > SENTRY.leash + SENTRY.range) continue;
    const d = hyp(p.x - e.x, p.z - e.z);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

/** Is it further from its post than the leash lets it go? */
function strayed(e) {
  const post = e.ai.post;
  return !!post && hyp(e.x - post.x, e.z - post.z) > SENTRY.leash;
}

/**
 * One tick of one sentry. It produces an input and hands it to the same `step`
 * the player uses, which is what keeps it honest about the movement budget.
 */
export function stepSentry(col, e, players, dt = TICK, budget) {
  const ai = e.ai;

  if (e.dead) {
    if (ai.state !== EST.DEAD) { ai.state = EST.DEAD; ai.t = 0; }
    ai.t += dt;
    return e;
  }

  ai.t += dt;
  const target = pick(e, players);
  let mx = 0, mz = 0, face = null;

  switch (ai.state) {
    case EST.DORMANT:
      if (target) { ai.state = EST.WAKE; ai.t = 0; }
      break;

    case EST.WAKE:
      if (target) face = target;
      if (ai.t >= WAKE_TIME) { ai.state = target ? EST.CLOSE : EST.DORMANT; ai.t = 0; }
      break;

    case EST.CLOSE: {
      if (!target || strayed(e)) { ai.state = EST.RETURN; ai.t = 0; ai.path = null; break; }
      face = target;
      const d = hyp(target.x - e.x, target.z - e.z);
      if (d <= SENTRY.range) { ai.state = EST.TELEGRAPH; ai.t = 0; break; }
      const s = steer(col, e, target.x, target.z, budget);
      mx = s.mx; mz = s.mz;
      break;
    }

    case EST.TELEGRAPH:
      /* Stopped dead, and still turning to face you — the turn is what makes
         running around it during the wind-up not free. */
      if (target) face = target;
      if (ai.t >= TELEGRAPH_TIME) { ai.state = EST.STRIKE; ai.t = 0; e.swungAt = 0; }
      break;

    case EST.STRIKE:
      /* Facing is locked: what it telegraphed is what it swings at. */
      if (ai.t >= STRIKE_TIME) { ai.state = EST.RECOVER; ai.t = 0; }
      break;

    case EST.RECOVER:
      if (ai.t >= RECOVER_TIME) { ai.state = target ? EST.CLOSE : EST.RETURN; ai.t = 0; }
      break;

    case EST.STAGGER:
      if (ai.t >= STAGGER_TIME) { ai.state = target ? EST.CLOSE : EST.RETURN; ai.t = 0; }
      break;

    case EST.RETURN: {
      /* Back to where it holds, the way round if it must. Someone walking
         into sight on the way turns it round again — inside the leash. */
      if (target && !strayed(e)) { ai.state = EST.CLOSE; ai.t = 0; ai.path = null; break; }
      const post = ai.post, d = hyp(post.x - e.x, post.z - e.z);
      if (d < 0.6) { ai.state = EST.DORMANT; ai.t = 0; ai.path = null; break; }
      const s = steer(col, e, post.x, post.z, budget);
      mx = s.mx; mz = s.mz;
      break;
    }

    default:
      break;
  }

  const input = { mx, mz, jump: false, attack: false, dodge: false, aimX: 0, aimZ: 0 };
  if (face) {
    const dx = face.x - e.x, dz = face.z - e.z, l = hyp(dx, dz);
    if (l > 1e-6) { input.aimX = dx / l; input.aimZ = dz / l; }
  }
  step(col, e, input, null, dt);

  /* The strike itself: one arc, once, on the tick the window opens. */
  if (ai.state === EST.STRIKE && !e.swungAt) {
    e.swungAt = 1;
    for (const p of players) {
      if (p && !p.dead && inArc(e, p, SENTRY.reach, SENTRY.arc, SENTRY.span, COS_HALF)) {
        hurt(p, SENTRY.damage, 'struck');
      }
    }
  }
  return e;
}

/** Tell it that it has been hit — staggering it if it was not already committed. */
export function jolt(e) {
  if (e.dead) return;
  if (staggerable(e.ai.state)) { e.ai.state = EST.STAGGER; e.ai.t = 0; }
}

/* Posts: where the machines hold (#6, #42). Beyond sight from the spawn, so
   they are found rather than met, and not so far that the window has none. */
const POST_MIN = SENTRY.sight + 2, POST_MAX = 34, POST_APART = 10, POSTS = 3;
const POST_RANK = { cover: 0, vantage: 1, arena: 2 };

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
  const stand = (x, z) => {
    const y = col.supportUnder(x, z, SENTRY.rad, Infinity);
    return y !== -Infinity && !col.overlaps(x, z, SENTRY.rad, y + EPS, y + 1.8 - EPS);
  };
  const ok = (x, z) => {
    const d = hyp(x - spawn[0], z - spawn[2]);
    if (d < POST_MIN || d > POST_MAX || !stand(x, z)) return false;
    for (const p of out) if (hyp(p[0] - x, p[1] - z) < POST_APART) return false;
    return true;
  };
  const cands = (world.affordances || []).filter((a) => a.k in POST_RANK).slice()
    .sort((a, b) => POST_RANK[a.k] - POST_RANK[b.k] || b.s - a.s || a.x - b.x || a.z - b.z);
  for (const a of cands) {
    if (out.length >= POSTS) break;
    if (ok(a.x, a.z)) out.push([a.x, a.z]);
  }
  for (const [dx, dz] of [[14, 3], [-11, -13], [5, 19]]) {
    if (out.length >= POSTS) break;
    const x = spawn[0] + dx, z = spawn[2] + dz;
    const y = col.supportUnder(x, z, SENTRY.rad, spawn[1] + MOVE.vault);
    if (y !== -Infinity && ok(x, z)) out.push([x, z]);
  }
  return out;
}

/**
 * Everything in the world that can be swung at, and the thing that steps it.
 *
 * One unit so the host and a solo build drive identical code, and so that the
 * bit the guest does *not* run is obvious: it draws what the host sends and
 * simulates none of it.
 */
export function makeEncounter(col, world, posts) {
  const spawn = world.spawn;
  const enemies = [];
  for (const p of postsFor(col, world)) enemies.push(makeSentry(col, p[0], p[1]));
  const targets = (posts || []).concat(enemies);
  const postCount = (posts || []).length;
  /* Derived from the same world the machines were placed in, and index-aligned
     with them — see src/sim/loot.mjs for why that means nothing has to be sent. */
  const loot = makeLootField(col, world, enemies.length);

  return {
    enemies, targets, postCount, loot,

    /** One tick: the machines act, then whatever the players cut takes it. */
    step(players, dt = TICK) {
      const budget = { left: 1 };
      for (const e of enemies) stepSentry(col, e, players, dt, budget);
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
      for (let i = 0; i < enemies.length; i++) if (enemies[i].dead) loot.drop(i, enemies[i]);
      return loot.collect(players);
    },

    /**
     * Guest: fold an authoritative snapshot back into the copy this end derived
     * for itself. The machines are drawn from `foes`; a fallen one is standing
     * over its own spoil, so where the loot is needs no message of its own, and
     * `takenBits` — one integer — is the whole of what has been picked up.
     */
    observeWire(foes, takenBits) {
      loot.observe(foes, EST.DEAD);
      if (takenBits !== undefined && takenBits !== null) loot.applyWire(takenBits);
    },

    /**
     * What a guest needs to draw them, and nothing else — it does not simulate
     * enemies, so it does not need the state that simulating them requires.
     * Rounded, because these are pixels and not a trajectory anyone replays.
     */
    wire() {
      const r3 = (v) => Math.round(v * 1000) / 1000;
      return enemies.map((e) => ({
        x: r3(e.x), y: r3(e.y), z: r3(e.z),
        fx: r3(e.faceX), fz: r3(e.faceZ),
        s: e.ai.state, t: Math.round(e.ai.t * 100) / 100,
        h: e.hp, u: Math.round(e.hurtT * 100) / 100,
      }));
    },
  };
}
