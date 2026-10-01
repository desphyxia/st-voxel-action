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
 * Sentries and mortars are tech and grafted hounds are bio (#106), so a world
 * with both kinds of pack can give you two traditions by fighting alone — but
 * never the third, which is still what the caches are for.
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
 * The generator already floods the world under the walk/climb/jump/fall rules
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

  function place(cx, cz, ceilY, around) {
    const rg = around || ring;
    for (let r = 0; r < rg.length; r++) {
      const x = cx + rg[r][0], z = cz + rg[r][1];
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

  /* A mesa's top first (#75): its stones are a climb, and a climb wants a
     reason. On the top itself, near the middle — a top can be eight metres
     across, which the ring above would step straight off. */
  const mesas = world.mesas || [], onTop = [[0, 0], [1.5, 0], [0, 1.5], [-1.5, 0], [0, -1.5]];
  for (let i = 0; i < mesas.length && out.length < CACHES; i++) {
    place(mesas[i][0], mesas[i][2], mesas[i][1] + MOVE.climb2, onTop);
  }

  if (world.lmPos) place(world.lmPos[0], world.lmPos[2], world.lmPos[1] + MOVE.climb2);

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
    place(lamps[i][0], lamps[i][2], lamps[i][1] + MOVE.climb2);
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

/** At most this many spoils lie on the ground at once; the oldest goes first. */
export const SPOILS_MAX = 16;

/**
 * Everything on the ground, and who has taken what.
 *
 * A **cache** is derived from the world on both machines and taken is one bit
 * each, so its whole state crosses the wire as an integer.
 *
 * A **spoil** exists from the moment a machine falls and until somebody picks
 * it up. It used to be index-aligned with the encounter's machines, which
 * capped a world at fifteen of them and assumed the list of machines never
 * changed; in a streamed world (#108) machines come and go with the ground, so
 * spoils are a list of their own now, sent while they lie there (`spoilWire`)
 * and taken off it when taken. `trad` is the tradition a spoil is made of
 * when its machine does not say, for a test that drops one by hand.
 */
export function makeLootField(col, world, spoilCount, trad) {
  const caches = cacheSites(col, world);
  const spoils = [];
  let taken = 0;
  const fallen = new Set();

  function open() {
    const out = [];
    for (let i = 0; i < caches.length; i++) {
      if (!(taken & (1 << i))) out.push({ kind: 'cache', i, item: caches[i] });
    }
    for (let i = 0; i < spoils.length; i++) out.push({ kind: 'spoil', i, item: spoils[i] });
    return out;
  }

  function lay(x, y, z, mod, of) {
    if (spoils.length >= SPOILS_MAX) spoils.shift();
    spoils.push({ x, y, z, mod, down: 1, of });
  }

  return {
    caches, spoils,
    get taken() { return taken; },
    open,

    /**
     * Host: that machine has fallen, so what it was made of is on the ground —
     * once. `key` names the machine for good: its id in a streamed world, its
     * index in a window, and it is also what decides which module it was.
     */
    drop(key, e) {
      if (fallen.has(key)) return;
      fallen.add(key);
      const t = e.trad === undefined ? (Array.isArray(trad) ? trad[key] : trad) : e.trad;
      lay(e.x, e.y, e.z, spoilModule(world, key, t), key);
    },

    /** Host: something put on the ground by hand — the debug dialog's (#92). */
    lay(x, y, z, mod) { lay(x, y, z, mod, -1); },

    /**
     * Host: hand anything a living player is standing on to that player.
     *
     * A cache is all or nothing — its recipe comes with its module, so a full
     * inventory leaves the whole thing where it is rather than taking the
     * knowledge and dropping the goods. Walk back when you have room.
     */
    collect(players) {
      const got = [];
      const items = open(), gone = [];
      for (let q = 0; q < items.length; q++) {
        const o = items[q], it = o.item;
        for (let p = 0; p < players.length; p++) {
          const a = players[p];
          if (!a || a.dead || !a.gear) continue;
          if (hyp(a.x - it.x, a.z - it.z) > PICKUP_R) continue;
          if (Math.abs(a.y - it.y) > PICKUP_Y) continue;
          if (!takeModule(a.gear, it.mod)) break;         /* full: leave it there */
          const learned = o.kind === 'cache' ? learnFusion(a.gear, it.fus) : false;
          if (o.kind === 'cache') taken |= 1 << o.i; else gone.push(it);
          a.picked = (a.picked || 0) + 1;
          got.push({ who: p, kind: o.kind, mod: it.mod, fus: learned ? it.fus : -1 });
          break;
        }
      }
      for (const it of gone) spoils.splice(spoils.indexOf(it), 1);
      return got;
    },

    /** What of the caches has been taken, as one integer. */
    wire() { return taken; },
    applyWire(m) { taken = m | 0; },

    /** Every spoil on the ground, as [x, y, z, module] — usually none. */
    spoilWire() {
      const r2 = (v) => Math.round(v * 100) / 100;
      return spoils.map((s) => [r2(s.x), r2(s.y), r2(s.z), s.mod]);
    },
    /** Guest: what is on the ground is what the host says. */
    applySpoils(list) {
      spoils.length = 0;
      for (const q of list || []) spoils.push({ x: q[0], y: q[1], z: q[2], mod: q[3], down: 1, of: -1 });
    },
  };
}
