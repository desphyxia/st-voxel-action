/**
 * The world as loaded chunks, and the four questions the controller asks of it
 * — issue #13.
 *
 * ## Why not one collider over the loaded region
 *
 * `colliderForWorld` builds one bounded grid whose edge is a wall, and that is
 * right for a single window: the world ends there, and without the wall a
 * player walks off the map and falls forever. It is exactly wrong for a chunk,
 * whose edge is where the ground continues.
 *
 * One collider spanning everything loaded would have to be rebuilt every time a
 * chunk arrives or leaves, which is the one thing streaming must not do. So
 * each chunk keeps its own collider in **its own local coordinates**, built
 * unwalled, and this field routes a query to every chunk its footprint touches
 * and combines the answers. A chunk arriving or leaving is a Map entry, not a
 * rebuild.
 *
 * ## Where the wall went
 *
 * It moved here, because only this layer knows where the world actually ends.
 * A footprint that reaches a chunk which is not loaded is **blocked**. That is
 * deliberate and it is not a placeholder: a body may not walk into ground that
 * has not been decided yet, and the load radius is what keeps it from ever
 * meeting that boundary. A radius too small does not produce a fall through the
 * floor — it produces an invisible wall, which is a bug you can see.
 *
 * ## What one chunk holds
 *
 * The generated window is 40 m — the chunk plus the 4 m skirt `src/gen/chunk.mjs`
 * explains. The **collider covers the 32 m chunk proper only**. The skirt exists
 * so the generator's edge effects fall outside the ground this chunk owns, and
 * so the mesher has a ring to shade its seam against; letting it into the
 * collider would give every boundary two sets of spans, one from each side.
 *
 * No DOM, no three.js, and no renderer: this decides what is solid, not what is
 * drawn.
 */
import { V, CHUNK, CEIL } from '../gen/constants.mjs';
import { chunkWorld, SKIRT } from '../gen/chunk.mjs';
import { makeCollider, LIQUID, softProp } from './collider.mjs';

/** Which chunk a world coordinate falls in. */
export function chunkAt(x, z) {
  return { cx: Math.floor(x / CHUNK + 0.5), cz: Math.floor(z / CHUNK + 0.5) };
}

/** The chunk's centre in world metres — the same convention chunkWorld uses. */
function centreOf(cx, cz) { return { x: cx * CHUNK, z: cz * CHUNK }; }

const key = (cx, cz) => cx + ',' + cz;

/**
 * One chunk's collider, in coordinates local to that chunk's centre, holding
 * only the ground the chunk owns.
 */
function colliderForChunk(w) {
  const c = makeCollider(CHUNK / 2, V, false);
  const pad = Math.round(SKIRT / V);
  const NZ = w.NZ, M = w.M, half = w.half;
  const cell = (p) => Math.min(M - 1, Math.max(0, Math.round(p + half)));
  for (let i = pad; i < w.NX - pad; i++) {
    const wx = -half + i * V + V / 2, lx = wx;
    for (let j = pad; j < NZ - pad; j++) {
      const wz = -half + j * V + V / 2, lz = wz, k = i * NZ + j;
      const cl = w.cells[cell(wx) * M + cell(wz)], sp = cl.sp;
      for (let q = 0; q < sp.length - 1; q++) c.addSpan(lx, lz, sp[q][0], sp[q][1]);
      c.addSpan(lx, lz, sp[sp.length - 1][0], Math.min(w.Hs[k], CEIL));
      const f = w.FLG[k];
      if (f & 2) c.setLiquidAt(lx, lz, LIQUID.MAGMA, w.Hs[k]);
      else if (f & 1) c.setLiquidAt(lx, lz, LIQUID.WATER, cl.wl);
    }
  }
  /* Props, but only the ones standing on ground this chunk owns. A trunk whose
     anchor is in the skirt belongs to the neighbour and will be added there. */
  const lim = CHUNK / 2;
  const ps = w.propStart === undefined ? w.pos.length / 3 : w.propStart;
  for (let q = 0; q < w.pos.length / 3; q++) {
    const x = w.pos[q * 3], y = w.pos[q * 3 + 1], z = w.pos[q * 3 + 2];
    if (x < -lim || x >= lim || z < -lim || z >= lim) continue;
    if (softProp(w.mat[q], q, ps)) continue;
    c.addVoxel(x, y, z);
  }
  return c.finish();
}

/**
 * A field of loaded chunks. `keep(centres, radius)` decides which chunks exist;
 * everything else is a wall.
 */
export function makeChunkField(seed, force) {
  const live = new Map();
  let built = 0, dropped = 0;

  function ensure(cx, cz) {
    const k = key(cx, cz);
    let e = live.get(k);
    if (e) return e;
    const w = chunkWorld(seed, cx, cz, force);
    e = { cx, cz, w, col: colliderForChunk(w) };
    live.set(k, e); built++;
    return e;
  }

  /** Every chunk a footprint touches, loaded or not. */
  function span(x, z, r) {
    const a = chunkAt(x - r, z - r), b = chunkAt(x + r, z + r);
    const out = [];
    for (let cx = a.cx; cx <= b.cx; cx++) for (let cz = a.cz; cz <= b.cz; cz++) out.push([cx, cz]);
    return out;
  }
  const got = (cx, cz) => live.get(key(cx, cz));
  const local = (e, x, z) => { const c = centreOf(e.cx, e.cz); return [x - c.x, z - c.z]; };

  return {
    /** Chunks within `radius` of any centre are loaded; the rest are let go. */
    keep(centres, radius) {
      const want = new Set();
      for (const p of centres) {
        const c = chunkAt(p.x, p.z);
        for (let dx = -radius; dx <= radius; dx++) {
          for (let dz = -radius; dz <= radius; dz++) want.add(key(c.cx + dx, c.cz + dz));
        }
      }
      for (const k of [...live.keys()]) if (!want.has(k)) { live.delete(k); dropped++; }
      for (const k of want) { const [cx, cz] = k.split(',').map(Number); ensure(cx, cz); }
      return live.size;
    },

    get loaded() { return live.size; },
    get built() { return built; },
    get dropped() { return dropped; },
    has(cx, cz) { return live.has(key(cx, cz)); },
    chunk(cx, cz) { return got(cx, cz); },

    /* ---- the four the controller asks ---- */

    /** Highest support anywhere under the box, across every chunk it touches. */
    supportUnder(x, z, r, ceilY) {
      let best = -Infinity;
      for (const [cx, cz] of span(x, z, r)) {
        const e = got(cx, cz);
        if (!e) continue;
        const [lx, lz] = local(e, x, z);
        const g = e.col.supportUnder(lx, lz, r, ceilY);
        if (g > best) best = g;
      }
      return best;
    },

    /** Solid if any loaded chunk says so — or if the box reaches one that is
        not loaded, which is the world's edge as far as anyone standing here is
        concerned. */
    overlaps(x, z, r, lo, hi) {
      for (const [cx, cz] of span(x, z, r)) {
        const e = got(cx, cz);
        if (!e) return true;
        const [lx, lz] = local(e, x, z);
        if (e.col.overlaps(lx, lz, r, lo, hi)) return true;
      }
      return false;
    },

    ceilingOver(x, z, r, y) {
      let best = Infinity;
      for (const [cx, cz] of span(x, z, r)) {
        const e = got(cx, cz);
        if (!e) continue;
        const [lx, lz] = local(e, x, z);
        const c = e.col.ceilingOver(lx, lz, r, y);
        if (c < best) best = c;
      }
      return best;
    },

    liquidAt(x, z) {
      const c = chunkAt(x, z), e = got(c.cx, c.cz);
      if (!e) return { kind: LIQUID.NONE, level: 0 };
      const [lx, lz] = local(e, x, z);
      return e.col.liquidAt(lx, lz);
    },
  };
}
