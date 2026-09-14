/**
 * Where modules come from, and the first reason to walk anywhere.
 *
 * §4 names three sources — landmark caches, enemy drops, and holdout traders.
 * The first two are here; there are no holdouts yet. A machine drops the
 * discipline it was built from, so a fight previews its loot (§6); a cache sits
 * at the **landmark, the routed sites, or a lamp on the trail** — the places the
 * generator already thought were somewhere — holds a module *and* a fusion
 * recipe, and is the answer to the complaint that this world had nowhere worth
 * going.
 *
 * Recipes are the interesting half. A module you find makes you slightly
 * better on its own; a recipe you find makes two modules you already had into
 * something else, which means the walk pays off in the lattice rather than in
 * the inventory. That is "fusion knowledge is learned from the world" (§4)
 * made into a verb.
 *
 * **Nothing here crosses the wire except a bitmask.** Caches are derived from
 * the world, which both machines grew from the same seed; a machine's spoil is
 * derived from its index, and appears where that machine fell, which the guest
 * is already told. So what is left to send is which of them have been picked
 * up — one integer. That is the shape §7 promised for edits, enemies and loot:
 * deltas against something both ends already have.
 */
import { MOVE } from '../gen/constants.mjs';
import { hyp } from '../gen/exact.mjs';
import { EPS } from './collider.mjs';
import { TRAD, MODULES, MODS_BY_TRAD, FUSIONS, takeModule, learnFusion } from './lattice.mjs';

/** How close is close enough. Generous: this is not a precision verb. */
export const PICKUP_R = 1.2;
/** And how far above or below, so a drop on a ledge is not taken from beneath. */
export const PICKUP_Y = 1.4;
/** At most this many caches in one window — four recipes of the six. */
export const CACHES = 4;
/** Anything nearer than this to the spawn is not a walk, so it is not a cache. */
const CACHE_MIN_WALK = 9;

/**
 * A small integer stream with no state and no float arithmetic, so a host and a
 * guest reading the same site get the same module without any of it crossing.
 * Positions are quantised to 25 cm first, because they arrive as floats.
 */
function siteHash(x, z, salt) {
  let h = Math.imul(2166136261 ^ salt, 16777619);
  h = Math.imul(h ^ Math.round(x * 4), 16777619);
  h = Math.imul(h ^ Math.round(z * 4), 16777619);
  h ^= h >>> 13;
  return (h >>> 0);
}

/**
 * One number that differs between seeds.
 *
 * Not the spawn: it is chosen near the middle of the window, so it is (0, 0)
 * on every golden seed and anything keyed off it is the same world to world.
 * The landmark and the routed sites are where the seed actually shows.
 */
export function worldKey(world) {
  let h = siteHash(world.spawn[0], world.spawn[2], (world.size || 0) & 255);
  if (world.lmPos) h = siteHash(world.lmPos[0], world.lmPos[2], h & 255);
  const sites = world.sites || [];
  for (let i = 0; i < sites.length; i++) h = siteHash(sites[i][0], sites[i][1], (h + i) & 255);
  return h >>> 0;
}

/**
 * What the machine with this index was built out of, and therefore drops.
 *
 * Its **own** discipline, which is the rule in §6 — a fight previews its loot.
 * The consequence is the interesting part: every machine in this world is tech,
 * so fighting alone can never give you two traditions, and fusion needs
 * something fighting cannot provide. That is what the caches are for.
 */
export function spoilModule(world, i, trad) {
  const pool = MODS_BY_TRAD[trad === undefined ? TRAD.TECH : trad];
  return pool[(worldKey(world) + i) % pool.length];
}

/** Ground under (x, z) that a 0.4 m box can stand on, or -Infinity. */
function standing(col, x, z, ceilY) {
  const y = col.supportUnder(x, z, 0.4, ceilY === undefined ? Infinity : ceilY);
  if (y === -Infinity) return -Infinity;
  if (col.overlaps(x, z, 0.4, y + EPS, y + 1.2 - EPS)) return -Infinity;
  return y;
}

/**
 * Can the movement budget get there?
 *
 * The generator already floods the world under the step/vault/jump/fall rules
 * and marks what it never touched (src/gen/reach.mjs). A cache on a ruin's roof
 * is a cache nobody collects, and the flood is the only thing that knows.
 */
function reachable(world, x, z) {
  const R = world.reach, M = world.M, half = world.half;
  if (!R || !M) return true;
  const a = Math.min(M - 1, Math.max(0, Math.round(x + half)));
  const b = Math.min(M - 1, Math.max(0, Math.round(z + half)));
  return !!R[a * M + b];
}

/**
 * Where the caches are: the landmark first, because it is the thing you can see
 * from anywhere, then the lit sites along the trail. Derived from the world, in
 * a fixed order, so both machines agree without being told.
 */
export function cacheSites(col, world) {
  const spawn = world.spawn, out = [];
  const ring = [[5.5, 0], [0, 5.5], [-5.5, 0], [0, -5.5], [4, 4], [-4, -4]];

  function place(cx, cz, ceilY) {
    for (let r = 0; r < ring.length; r++) {
      const x = cx + ring[r][0], z = cz + ring[r][1];
      if (hyp(x - spawn[0], z - spawn[2]) < CACHE_MIN_WALK) continue;
      if (!reachable(world, x, z)) continue;
      const y = standing(col, x, z, ceilY);
      if (y === -Infinity) continue;
      /* Not on top of another one: two caches in one place is one cache. */
      let clash = false;
      for (let q = 0; q < out.length; q++) if (hyp(out[q].x - x, out[q].z - z) < 4) clash = true;
      if (clash) continue;
      out.push({ x, y, z, mod: 0, fus: 0, site: out.length });
      return true;
    }
    return false;
  }

  if (world.lmPos) place(world.lmPos[0], world.lmPos[2], world.lmPos[1] + MOVE.vault);

  /* The ruin and the holding the trails were routed to: the two places in the
     window that are already *somewhere*, rather than somewhere with a lamp on
     it. Cell indices, so they come back through the half-offset. */
  const sites = world.sites || [], half = world.size ? world.size / 2 : 0;
  for (let i = 0; i < sites.length && out.length < CACHES; i++) {
    place(-half + sites[i][0], -half + sites[i][1], undefined);
  }

  const lamps = world.lamps || [];
  /* Spread along the trail rather than taking the first few, which stand
     together at whichever end the route was laid from. */
  const stride = Math.max(1, Math.floor(lamps.length / CACHES));
  for (let i = 0; i < lamps.length && out.length < CACHES; i += stride) {
    place(lamps[i][0], lamps[i][2], lamps[i][1] + MOVE.vault);
  }

  /* What each one holds. Both walk their list from a seed-dependent start
     rather than being drawn independently, which is the difference between
     "four caches" and "four *different* caches": a second copy of a recipe you
     already know is not a reason to cross a valley, and four tech modules in a
     world whose machines are all tech is a world where nothing can fuse.
     Nine modules and a stride of four means no two caches hold the same one,
     and three of them always span at least two traditions. */
  const key = worldKey(world);
  for (let i = 0; i < out.length; i++) {
    out[i].mod = (key + i * 4) % MODULES.length;
    out[i].fus = (key + i) % FUSIONS.length;
  }
  return out;
}

/**
 * Everything on the ground, and who has taken what.
 *
 * `spoilCount` is how many machines are in the world: one spoil each, which
 * exists from the moment that machine falls. Index-aligned with the encounter's
 * enemies, which is what lets a guest place them from the machine wire it is
 * already receiving instead of being sent a second list.
 */
export function makeLootField(col, world, spoilCount, trad) {
  const caches = cacheSites(col, world);
  const spoils = [];
  for (let i = 0; i < (spoilCount || 0); i++) {
    spoils.push({ x: 0, y: 0, z: 0, mod: spoilModule(world, i, trad), down: 0, site: i });
  }
  let taken = 0;

  /* One bit each, caches from the bottom and spoils from bit 16 — which is the
     whole of what crosses the wire, and also a ceiling: sixteen caches and
     fifteen machines in one window. Both are far above what a window holds. */
  const bitOf = (kind, i) => 1 << (kind === 'cache' ? i : 16 + i);

  function open() {
    const out = [];
    for (let i = 0; i < caches.length; i++) {
      if (!(taken & bitOf('cache', i))) out.push({ kind: 'cache', i, item: caches[i] });
    }
    for (let i = 0; i < spoils.length; i++) {
      if (spoils[i].down && !(taken & bitOf('spoil', i))) out.push({ kind: 'spoil', i, item: spoils[i] });
    }
    return out;
  }

  return {
    caches, spoils,
    get taken() { return taken; },
    open,

    /** Host: that machine has fallen, so what it was made of is on the ground. */
    drop(i, e) {
      if (!spoils[i] || spoils[i].down) return;
      spoils[i].x = e.x; spoils[i].y = e.y; spoils[i].z = e.z; spoils[i].down = 1;
    },

    /**
     * Guest: the machines arrived in the snapshot, and a fallen one is standing
     * over its own spoil. Nothing extra had to be sent for this.
     */
    observe(foes, deadState) {
      if (!foes) return;
      for (let i = 0; i < foes.length && i < spoils.length; i++) {
        if (foes[i].s !== deadState || spoils[i].down) continue;
        spoils[i].x = foes[i].x; spoils[i].y = foes[i].y; spoils[i].z = foes[i].z;
        spoils[i].down = 1;
      }
    },

    /**
     * Host: hand anything a living player is standing on to that player.
     *
     * A cache is all or nothing — its recipe comes with its module, so a full
     * inventory leaves the whole thing where it is rather than taking the
     * knowledge and dropping the goods. Walk back when you have room.
     */
    collect(players) {
      const got = [];
      const items = open();
      for (let q = 0; q < items.length; q++) {
        const o = items[q], it = o.item;
        for (let p = 0; p < players.length; p++) {
          const a = players[p];
          if (!a || a.dead || !a.gear) continue;
          if (hyp(a.x - it.x, a.z - it.z) > PICKUP_R) continue;
          if (Math.abs(a.y - it.y) > PICKUP_Y) continue;
          if (!takeModule(a.gear, it.mod)) break;         /* full: leave it there */
          const learned = o.kind === 'cache' ? learnFusion(a.gear, it.fus) : false;
          taken |= bitOf(o.kind, o.i);
          a.picked = (a.picked || 0) + 1;
          got.push({ who: p, kind: o.kind, mod: it.mod, fus: learned ? it.fus : -1 });
          break;
        }
      }
      return got;
    },

    /** The whole state of the loot in the world, as one integer. */
    wire() { return taken; },
    applyWire(m) { taken = m | 0; },
  };
}
