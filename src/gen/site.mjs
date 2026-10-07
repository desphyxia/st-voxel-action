/**
 * The weapon site (#7, docs/DECISIONS.md §6): the first slice, the tech
 * furnace, laid out as ground.
 *
 * What is decided here is only *where* and *what shape*: one arena in a bowl
 * of wall, a gate cut through the wall, a dais for the core, four footholds
 * on the floor, and a road that climbs away from the gate for about three
 * hundred metres. Nothing here knows about machines, the fusion gate or the
 * guardian. Those are the simulation's (src/sim/site.mjs), and they read this
 * descriptor to learn where things are.
 *
 * It is a pure function of the seed, like everything in src/gen. A site is
 * larger than the 64 m region the generator decides things in, so the
 * descriptor is made once per seed and each region then takes the cells of it
 * that it owns (region.mjs), which is how a trail already crosses region
 * edges without two regions disagreeing.
 *
 * Two phases, because the ground the site stands on is itself changed by it:
 *
 *   1. `planSite` picks the place from the raw ashfall noise alone. The site
 *      then raises the ashfall around itself (`siteBoost`), so what stands
 *      there is a scar and not a hole in the meadow.
 *   2. `shapeSite` measures the boosted ground and writes the geometry: the
 *      floor's height, the road's profile, and every cell the site owns.
 *
 * No Math.sin, cos, atan2 or hypot in here (the rule across src/): directions
 * are vectors, never angles read back.
 */
import { clamp, CEIL } from './constants.mjs';
import { sin, cos, hyp } from './exact.mjs';

/** The arena's floor radius, the wall round it, and how tall the wall stands
    over the floor. 3 m or more is a wall to the movement budget (§3). */
export const ARENA_R = 20;
export const WALL_W = 3;
export const WALL_H = 4;
/** Half the gate's width in metres: a four-metre opening. */
export const GATE_HALF = 2;
/** The core's dais, how far from the middle it stands on the far side from
    the gate, how wide it is, and how far it stands over the floor. */
export const CORE_AT = 11;
export const CORE_R = 3.5;
export const CORE_H = 1;
/** Footholds: raised squares a metre over the floor, to reposition on. */
export const STONE_AT = 12;
export const STONE_H = 1;
/** The road: how long, how wide each side of its line, and how steeply its
    height may change, in metres of height per metre of road. */
export const PATH_LEN = 330;
export const PATH_HALF = 2.5;
export const PATH_SLOPE = 0.5;
/** Where a site may stand, in metres from the world's origin. Far enough that
    no default window and no spawn's streamed ring ever reaches the ash it
    raises (the boost's outer edge is BOOST_R from the middle). */
export const MIN_DIST = 430;
export const MAX_DIST = 1300;
/** The ash raised round the site: full strength to BOOST_FULL, gone by BOOST_R. */
export const BOOST_FULL = 150;
export const BOOST_R = 260;
/** The noise level the ashfall is at full strength from (field.mjs: its
    threshold plus 1/SCAR_GAIN), which the boost lifts the field towards. */
const ASH_FULL = 0.95;

/** What a cell the site owns is, as the code a window reads off it. */
export const SITE_K = { FLOOR: 1, WALL: 2, GATE: 3, CORE: 4, STONE: 5, ROAD: 6 };

/** Whole metres of height, rounded half away from zero the same on every engine. */
const rnd = (v) => Math.floor(v + 0.5);

/**
 * Phase one: where. `ashNoise(x, z)` is the raw ashfall noise, `waterAt(x, z)`
 * whether the field has water there before the site changes anything, and
 * `rand(x, z, salt)` a positional draw. Returns null when no place suits.
 */
export function planSite(ashNoise, waterAt, rand) {
  /* The best of every 32 m square in the annulus, by noise and then by place
     so that two equal values do not depend on which was visited first. */
  const cands = [];
  const R = MAX_DIST, S = 32;
  for (let x = -R; x <= R; x += S) {
    for (let z = -R; z <= R; z += S) {
      const d = hyp(x, z);
      if (d < MIN_DIST || d > MAX_DIST) continue;
      cands.push({ x, z, f: ashNoise(x, z), d });
    }
  }
  cands.sort((a, b) => (b.f - a.f) || (a.x - b.x) || (a.z - b.z));
  /* The strongest ash first, and of those the first few whose arena is dry and
     whose road wets its feet least. A road may cross water (it becomes a
     causeway, `shapeSite`), an arena may not. */
  let best = null, bestWet = 1e9;
  const tries = Math.min(80, cands.length);
  for (let q = 0; q < tries && bestWet > 0; q++) {
    const c = cands[q];
    /* Out towards where a player comes from, a little off true so that two
       seeds do not all face the origin. */
    const a = (rand(c.x, c.z, 0x5171) - 0.5) * 0.8, ca = cos(a), sa = sin(a);
    const bx = -c.x / c.d, bz = -c.z / c.d;
    const S0 = { cx: c.x, cz: c.z, ux: bx * ca - bz * sa, uz: bx * sa + bz * ca,
                 sway: 18 + 14 * rand(c.x, c.z, 0x5172), phase: rand(c.x, c.z, 0x5173) * 6.283185307179586 };
    if (!dryArena(S0, waterAt)) continue;
    const wet = wetRoad(S0, waterAt);
    if (wet < bestWet) { best = S0; bestWet = wet; }
  }
  return best;
}

/** The road's centre at `t` metres out from the wall. */
export function pathPoint(S, t) {
  const edge = ARENA_R + WALL_W;
  const off = S.sway * sin(t / 70 + S.phase) * Math.min(1, t / 40) - S.sway * sin(S.phase) * Math.min(1, t / 40);
  const vx = -S.uz, vz = S.ux;
  return [S.cx + S.ux * (edge + t) + vx * off, S.cz + S.uz * (edge + t) + vz * off];
}

/** No water on the floor or the wall: the centre and the rim first, which is
    where nearly every failure shows, then every third metre. */
function dryArena(S0, waterAt) {
  const rr = ARENA_R + WALL_W + 2;
  if (waterAt(S0.cx, S0.cz)) return false;
  for (let k = 0; k < 8; k++) {
    const a = k * 0.7853981633974483;
    if (waterAt(rnd(S0.cx + rr * cos(a)), rnd(S0.cz + rr * sin(a)))) return false;
  }
  for (let dx = -rr; dx <= rr; dx += 4) for (let dz = -rr; dz <= rr; dz += 4) {
    if (hyp(dx, dz) > rr) continue;
    if (waterAt(S0.cx + dx, S0.cz + dz)) return false;
  }
  return true;
}

/** How many sampled places along the road stand in water. */
function wetRoad(S0, waterAt) {
  let wet = 0;
  const vx = -S0.uz, vz = S0.ux;
  for (let t = 0; t <= PATH_LEN; t += 10) {
    const p = pathPoint(S0, t);
    for (let o = -3; o <= 3; o += 3) if (waterAt(rnd(p[0] + vx * o), rnd(p[1] + vz * o))) wet++;
  }
  return wet;
}

/**
 * The ash noise, lifted towards full strength by how near a cell is to the
 * site: `f` in, `f` out. The field calls this on the ashfall row only.
 */
export function siteBoost(S0, x, z, f) {
  if (!S0) return f;
  const d = hyp(x - S0.cx, z - S0.cz);
  if (d >= BOOST_R) return f;
  let t = d <= BOOST_FULL ? 1 : 1 - (d - BOOST_FULL) / (BOOST_R - BOOST_FULL);
  t = t * t * (3 - 2 * t);
  return f + (ASH_FULL - f) * t;
}

/**
 * Phase two: the geometry. `heightAt(x, z)` is the field's ground height with
 * the boost applied. Returns the descriptor, with `cells` as a Map from a
 * world cell's integer key to `{ k, h }` for every cell the site owns.
 * `waterLevelAt(x, z)` is the surface of the water over a cell, or -1 when
 * there is none: a road that crosses a river is raised out of it.
 */
export function shapeSite(S0, heightAt, waterLevelAt, key) {
  const { cx, cz, ux, uz } = S0;
  const S = { cx, cz, ux, uz, sway: S0.sway, phase: S0.phase };

  /* The floor's height: the ground's own, averaged over the floor, and kept
     where a wall of WALL_H still fits under the ceiling. */
  let sum = 0, n = 0;
  for (let dx = -ARENA_R; dx <= ARENA_R; dx += 4) for (let dz = -ARENA_R; dz <= ARENA_R; dz += 4) {
    if (hyp(dx, dz) > ARENA_R) continue;
    sum += heightAt(cx + dx, cz + dz); n++;
  }
  S.hf = clamp(rnd(sum / n), 3, CEIL - WALL_H - 1);
  S.arenaR = ARENA_R; S.wallW = WALL_W; S.wallH = WALL_H;

  const cells = new Map(), gate = [];
  const edge = ARENA_R + WALL_W;
  /* The gate's half-angle as the cosine a cell's bearing must beat, taken at
     the wall's middle radius. */
  const cosGate = cos(GATE_HALF / (ARENA_R + WALL_W / 2));
  const put = (x, z, k, h) => cells.set(key(x, z), { k, h });

  for (let x = cx - edge; x <= cx + edge; x++) for (let z = cz - edge; z <= cz + edge; z++) {
    const dx = x - cx, dz = z - cz, r = hyp(dx, dz);
    if (r <= ARENA_R) put(x, z, SITE_K.FLOOR, S.hf);
    else if (r <= edge) {
      const inGate = (dx * ux + dz * uz) / r >= cosGate;
      put(x, z, inGate ? SITE_K.GATE : SITE_K.WALL, S.hf + WALL_H);
      if (inGate) gate.push([x, z]);
    }
  }
  S.gateCells = gate;
  S.gate = { x: rnd(cx + ux * (ARENA_R + WALL_W / 2)), z: rnd(cz + uz * (ARENA_R + WALL_W / 2)) };

  /* The core's dais on the far side from the gate. */
  const kx = rnd(cx - ux * CORE_AT), kz = rnd(cz - uz * CORE_AT);
  S.core = { x: kx, z: kz, h: S.hf + CORE_H, r: CORE_R };
  for (let x = kx - 4; x <= kx + 4; x++) for (let z = kz - 4; z <= kz + 4; z++) {
    if (hyp(x - kx, z - kz) <= CORE_R) put(x, z, SITE_K.CORE, S.hf + CORE_H);
  }

  /* Four footholds, a third of a turn either side of the core, a third of a
     turn either side of the gate: the vector u turned by an angle. */
  S.stones = [];
  for (const a of [1.2, -1.2, 2.2, -2.2]) {
    const ca = cos(a), sa = sin(a);
    const sx = rnd(cx + STONE_AT * (ux * ca - uz * sa)), sz = rnd(cz + STONE_AT * (ux * sa + uz * ca));
    S.stones.push([sx, sz]);
    for (let x = sx - 1; x <= sx + 1; x++) for (let z = sz - 1; z <= sz + 1; z++) put(x, z, SITE_K.STONE, S.hf + STONE_H);
  }

  /* The road. Its height starts at the floor's and follows the ground it
     crosses, smoothed, at no more than PATH_SLOPE a metre. Each cell within
     PATH_HALF of the line takes the height of the nearest step of it. */
  const steps = [];
  for (let t = 0; t <= PATH_LEN; t++) steps.push(pathPoint(S, t));
  const nat = steps.map((p) => heightAt(rnd(p[0]), rnd(p[1])));
  const prof = [S.hf];
  for (let t = 1; t <= PATH_LEN; t++) {
    let m = 0, c = 0;
    for (let q = Math.max(0, t - 12); q <= Math.min(PATH_LEN, t + 12); q++) { m += nat[q]; c++; }
    const target = m / c, prev = prof[t - 1];
    prof.push(clamp(prev + clamp(target - prev, -PATH_SLOPE, PATH_SLOPE), 1, CEIL - 2));
  }
  /* Where the road crosses water it stands a metre over the surface, and the
     rise to it is spread over the road on both sides so that it never climbs
     faster than PATH_SLOPE: raised to the floor each cell needs, then lifted
     wherever a neighbour is more than a slope's rise higher. */
  for (let t = 0; t <= PATH_LEN; t++) {
    const p = steps[t], vx = -uz, vz = ux;
    let top = -1;
    for (const o of [-2, 0, 2]) top = Math.max(top, waterLevelAt(rnd(p[0] + vx * o), rnd(p[1] + vz * o)));
    if (top >= 0) prof[t] = Math.max(prof[t], Math.ceil(top) + 1);
  }
  for (let t = 1; t <= PATH_LEN; t++) prof[t] = Math.max(prof[t], prof[t - 1] - PATH_SLOPE);
  for (let t = PATH_LEN - 1; t >= 0; t--) prof[t] = Math.max(prof[t], prof[t + 1] - PATH_SLOPE);
  for (let t = 0; t <= PATH_LEN; t++) prof[t] = Math.min(prof[t], CEIL - 2);
  S.path = [];
  const best = new Map();
  for (let t = 0; t <= PATH_LEN; t++) {
    const h = rnd(prof[t]), p = steps[t];
    S.path.push([rnd(p[0]), rnd(p[1]), h]);
    for (let x = rnd(p[0]) - 3; x <= rnd(p[0]) + 3; x++) for (let z = rnd(p[1]) - 3; z <= rnd(p[1]) + 3; z++) {
      const d = hyp(x - p[0], z - p[1]);
      if (d > PATH_HALF) continue;
      const k = key(x, z), cur = best.get(k);
      if (!cur || d < cur.d) best.set(k, { d, h });
    }
  }
  best.forEach((v, k) => { if (!cells.has(k)) cells.set(k, { k: SITE_K.ROAD, h: v.h }); });
  S.foot = { x: S.path[PATH_LEN][0], z: S.path[PATH_LEN][1], h: S.path[PATH_LEN][2] };
  S.cells = cells;
  return S;
}
