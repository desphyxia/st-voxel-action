/**
 * Modules, sockets and fusion — the spine of progression (docs/DECISIONS.md §4).
 *
 * A frame is a hex socket lattice. Frames never level up and never change; what
 * changes is what is seated in them. A module seated in a socket modifies the
 * numbers in combat.mjs, and two modules **from different traditions sharing a
 * hex edge** can fuse into something neither of them does alone — which is the
 * whole premise of the fiction (§1): tech, magic and biological were rival
 * schools that never combined, so combining them is the new thing.
 *
 * Three rules make the lattice a decision rather than a list:
 *
 *   1. **Adjacency is the currency.** A module in the wrong socket is a module
 *      that only does its own small thing. The rhombus below has four sockets
 *      and five edges, so every placement is a choice about what it touches.
 *   2. **Only across traditions.** Two tech modules side by side do nothing
 *      extra, however good each one is.
 *   3. **Knowledge is learned from the world**, not known from the start. An
 *      adjacency you have no recipe for is inert, and stays inert until you
 *      have walked to somewhere that had the recipe in it. That is what makes
 *      the landmark on the horizon worth the walk — see src/sim/loot.mjs.
 *
 * One frame of eight and nine modules, which is the whole set §4 asks for; the
 * other seven frames are not here, in the same way eleven of the twelve enemy
 * archetypes are not. The data model is the general one: a frame is a list of
 * axial hex cells, and everything else falls out of the adjacency that implies.
 *
 * Plain data and pure functions, like the rest of src/sim: no DOM, no renderer,
 * and no wall clock. `recomputeGear` is the only thing that writes stats, so a
 * host and a guest holding the same lattice hold the same numbers exactly.
 */
import { baseStats } from './combat.mjs';

export const TRAD = { TECH: 0, MAGIC: 1, BIO: 2 };
export const TRADITIONS = ['tech', 'magic', 'biological'];

export const MOD = {
  GOVERNOR: 0, SERVO: 1, PLATING: 2,
  KEEN: 3, SIGIL: 4, BLINK: 5,
  SINEW: 6, THEW: 7, BLOOM: 8,
};

/**
 * Nine modules, three per tradition. Each `apply` mutates a stats block from
 * `baseStats()`; they are applied in socket order, which is fixed, so two
 * machines holding the same lattice compute the same bits.
 *
 * The numbers are placeholders on exactly the same terms as everything in
 * combat.mjs: #9 decides what a hit is worth, and it will decide what a module
 * is worth at the same time. What is being built here is the *shape* — that
 * gear is a lattice and not a list, and that the interesting part is which
 * edges you can close.
 */
export const MODULES = [
  { key: 'GOVERNOR', name: 'governor', trad: TRAD.TECH, says: '+30 stamina',
    apply(s) { s.maxStamina += 30; } },
  { key: 'SERVO', name: 'servo', trad: TRAD.TECH, says: 'recovery −30%',
    apply(s) { s.recover *= 0.70; } },
  { key: 'PLATING', name: 'plating', trad: TRAD.TECH, says: '+40 hp',
    apply(s) { s.maxHp += 40; } },
  { key: 'KEEN', name: 'keening edge', trad: TRAD.MAGIC, says: '+8 damage',
    apply(s) { s.damage += 8; } },
  { key: 'SIGIL', name: 'lengthening sigil', trad: TRAD.MAGIC, says: '+0.5 m reach',
    apply(s) { s.reach += 0.5; } },
  { key: 'BLINK', name: 'blink rune', trad: TRAD.MAGIC, says: '+1 m dodge',
    apply(s) { s.dodgeDist += 1.0; } },
  { key: 'SINEW', name: 'sinew', trad: TRAD.BIO, says: '+12% run',
    apply(s) { s.speed += 0.12; } },
  { key: 'THEW', name: 'thewed cord', trad: TRAD.BIO, says: '−8 swing cost',
    apply(s) { s.swingCost -= 8; } },
  { key: 'BLOOM', name: 'bloom', trad: TRAD.BIO, says: '+1.5 hp/s',
    apply(s) { s.regen += 1.5; } },
];

/** The modules each tradition is made of, in id order. A machine drops from
    its own school's pool, which is why fusing needs more than fighting. */
export const MODS_BY_TRAD = (function () {
  const t = [[], [], []];
  for (let i = 0; i < MODULES.length; i++) t[MODULES[i].trad].push(i);
  return t;
})();

export const FUS = {
  REGULATED: 0, SLIPDRIVE: 1, IRONTHEW: 2, VINE: 3, WELL: 4, BLOODEDGE: 5,
};

/**
 * Six fusions, two per pair of traditions. Every one crosses a tradition
 * boundary, because that is the only kind there is.
 */
export const FUSIONS = [
  { key: 'REGULATED', name: 'regulated edge', pair: [MOD.GOVERNOR, MOD.KEEN],
    says: '+6 damage, −5 swing cost', apply(s) { s.damage += 6; s.swingCost -= 5; } },
  { key: 'SLIPDRIVE', name: 'slipdrive', pair: [MOD.SERVO, MOD.BLINK],
    says: '+0.06 s i-frames, +0.6 m dodge',
    apply(s) { s.iframes += 0.06; s.dodgeDist += 0.6; } },
  { key: 'IRONTHEW', name: 'ironthew', pair: [MOD.PLATING, MOD.SINEW],
    says: '+25 hp, +5% run', apply(s) { s.maxHp += 25; s.speed += 0.05; } },
  { key: 'VINE', name: 'reaching vine', pair: [MOD.SIGIL, MOD.SINEW],
    says: '+0.30 rad of arc', apply(s) { s.arc += 0.30; } },
  { key: 'WELL', name: 'deep well', pair: [MOD.THEW, MOD.GOVERNOR],
    says: '+20 stamina/s', apply(s) { s.staminaRegen += 20; } },
  { key: 'BLOODEDGE', name: 'bloodedge', pair: [MOD.BLOOM, MOD.KEEN],
    says: '+4 hp per target cut', apply(s) { s.lifesteal += 4; } },
];

/** Unordered pair of module ids as one small integer, so the table is a lookup. */
function pairKey(a, b) { return a < b ? a * 16 + b : b * 16 + a; }

const RECIPES = (function () {
  const t = {};
  for (let i = 0; i < FUSIONS.length; i++) t[pairKey(FUSIONS[i].pair[0], FUSIONS[i].pair[1])] = i;
  return t;
})();

/** The fusion these two modules make, or -1. Says nothing about knowing it. */
export function recipeFor(a, b) {
  const k = RECIPES[pairKey(a, b)];
  return k === undefined ? -1 : k;
}

/* ------------------------------------------------------------------- hex ---- */

/** The six axial directions. Two cells share an edge iff their difference is one. */
export const HEXDIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

export function hexAdjacent(a, b) {
  const dq = b[0] - a[0], dr = b[1] - a[1];
  for (let i = 0; i < 6; i++) if (HEXDIRS[i][0] === dq && HEXDIRS[i][1] === dr) return true;
  return false;
}

/** sqrt is exactly rounded by the spec, unlike the transcendentals — see exact.mjs. */
const SQRT3 = Math.sqrt(3);

/** Axial to flat-top pixel centres, in units of the hex's circumradius. */
export function hexXY(cell) {
  return { x: 1.5 * cell[0], y: SQRT3 * (cell[1] + cell[0] / 2) };
}

/* ----------------------------------------------------------------- frame ---- */

export const FRAME = { WARDEN: 0 };

/**
 * One of eight. A rhombus of four sockets — two triangles sharing an edge —
 * which is five edges between four cells: the two ends of the long diagonal
 * touch two neighbours each and not each other, so where a module goes is
 * always a question.
 */
export const FRAMES = [
  { key: 'WARDEN', name: 'warden frame', blade: 'longblade',
    cells: [[0, 0], [1, 0], [0, 1], [1, 1]] },
];

for (let fi = 0; fi < FRAMES.length; fi++) {
  const cells = FRAMES[fi].cells, edges = [];
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) if (hexAdjacent(cells[i], cells[j])) edges.push([i, j]);
  }
  FRAMES[fi].edges = edges;
}

/* ------------------------------------------------------------------ gear ---- */

/** Carried slots, stash at camp — and there is no camp yet, so this is the lot. */
export const CARRY = 4;

export function makeGear(frameId) {
  const g = { frame: frameId === undefined ? FRAME.WARDEN : frameId,
              slots: [], carried: [], known: 0, fused: [], st: null };
  for (let i = 0; i < FRAMES[g.frame].cells.length; i++) g.slots.push(-1);
  recomputeGear(g);
  return g;
}

/**
 * Everything the lattice means, as one stats block. The only writer, so that
 * "what am I playing with" has exactly one answer and both ends compute it the
 * same way from the same lattice.
 */
export function recomputeGear(g) {
  const s = baseStats();
  const frame = FRAMES[g.frame];
  for (let i = 0; i < g.slots.length; i++) if (g.slots[i] >= 0) MODULES[g.slots[i]].apply(s);

  const fused = [];
  for (let e = 0; e < frame.edges.length; e++) {
    const a = g.slots[frame.edges[e][0]], b = g.slots[frame.edges[e][1]];
    if (a < 0 || b < 0) continue;
    /* The three schools never combined. Two of a kind side by side is two
       modules, not a fusion, however good each one is on its own. */
    if (MODULES[a].trad === MODULES[b].trad) continue;
    const r = recipeFor(a, b);
    if (r < 0 || !(g.known & (1 << r))) continue;
    fused.push(r);
  }
  for (let i = 0; i < fused.length; i++) FUSIONS[fused[i]].apply(s);

  g.fused = fused;
  g.st = s;
  return s;
}

/** An adjacency you could close if you knew how. What the HUD nags you with. */
export function latentFusions(g) {
  const frame = FRAMES[g.frame], out = [];
  for (let e = 0; e < frame.edges.length; e++) {
    const a = g.slots[frame.edges[e][0]], b = g.slots[frame.edges[e][1]];
    if (a < 0 || b < 0 || MODULES[a].trad === MODULES[b].trad) continue;
    const r = recipeFor(a, b);
    if (r >= 0 && !(g.known & (1 << r))) out.push(r);
  }
  return out;
}

export function knows(g, f) { return !!(g.known & (1 << f)); }

/** Pick one up. False when there is nowhere to put it — the carry limit bites. */
export function takeModule(g, mod) {
  if (!(mod >= 0 && mod < MODULES.length)) return false;
  if (g.carried.length >= CARRY) return false;
  g.carried.push(mod);
  return true;
}

export function learnFusion(g, f) {
  if (!(f >= 0 && f < FUSIONS.length)) return false;
  if (g.known & (1 << f)) return false;
  g.known |= (1 << f);
  recomputeGear(g);
  return true;
}

/** Seat carried module `carriedIndex` in `slot`. Sockets are never overwritten. */
export function socketModule(g, slot, carriedIndex) {
  if (!(slot >= 0 && slot < g.slots.length) || g.slots[slot] >= 0) return false;
  if (!(carriedIndex >= 0 && carriedIndex < g.carried.length)) return false;
  g.slots[slot] = g.carried.splice(carriedIndex, 1)[0];
  recomputeGear(g);
  return true;
}

/** Take it back out, if there is room to carry it. Nothing is destroyed. */
export function unsocketModule(g, slot) {
  if (!(slot >= 0 && slot < g.slots.length) || g.slots[slot] < 0) return false;
  if (g.carried.length >= CARRY) return false;
  g.carried.push(g.slots[slot]);
  g.slots[slot] = -1;
  recomputeGear(g);
  return true;
}

/**
 * The three fields an actor keeps in step with its lattice.
 *
 * One place, because there are three callers — the page playing solo, the host
 * applying its own click, and the host applying a guest's — and three copies of
 * "and don't forget the hit point ceiling" is two copies too many.
 */
export function refitGear(a) {
  a.st = a.gear.st;
  a.maxHp = a.st.maxHp;
  if (a.hp > a.maxHp) a.hp = a.maxHp;
  return a;
}

/** Seat a carried module, and make the actor play by the numbers that follow. */
export function seatOn(a, slot, carriedIndex) {
  if (!a || !a.gear || !socketModule(a.gear, slot, carriedIndex)) return false;
  refitGear(a);
  return true;
}

/** And take it back out again. */
export function pullFrom(a, slot) {
  if (!a || !a.gear || !unsocketModule(a.gear, slot)) return false;
  refitGear(a);
  return true;
}

/**
 * The lattice on the wire: a frame, four small ints, at most four more, and a
 * bitmask of what you know. Nine numbers, not a stats block — the stats are
 * recomputed from it on arrival, so the two ends can never disagree about what
 * a lattice means without disagreeing about the lattice.
 */
export function gearWire(g) {
  return g ? { f: g.frame, s: g.slots.slice(), c: g.carried.slice(), k: g.known } : null;
}

export function applyGearWire(g, m) {
  if (!g || !m) return g;
  g.frame = m.f;
  g.slots = m.s.slice();
  g.carried = m.c.slice();
  g.known = m.k;
  recomputeGear(g);
  return g;
}
