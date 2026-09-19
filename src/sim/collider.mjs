/**
 * The world as the controller can touch it: one column of solid spans for every
 * 25 cm of ground.
 *
 * Built from the generator's **spans**, not from its voxels. `buildVoxels`
 * emits a shell — the surface, a skirt down to the lowest neighbour, and the
 * top two voxels of anything below — because that is all a renderer needs. A
 * collider made from those would let a player drop into the hollow inside of a
 * hill. `cell.sp` is the actual solid volume, and `Hs` refines the top of it to
 * 25 cm.
 *
 * The voxels go in as well, on top of the spans. Props are the reason: a
 * bridge, a canyon arc, a wall and a fallen trunk are in no span at all, and a
 * crossing you cannot stand on is not a crossing. Terrain voxels are already
 * inside their own spans, so adding them costs nothing but the pass.
 *
 * No DOM, no three.js, no generator import beyond the constants — this runs in
 * node, which is what lets tools/smoke.mjs assert the movement budget without a
 * browser.
 */
import { V, CEIL, clamp } from '../gen/constants.mjs';
import { MAT } from '../gen/materials.mjs';

/** Nothing counts as touching unless it overlaps by more than this. */
export const EPS = 1e-6;

export const LIQUID = { NONE: 0, WATER: 1, MAGMA: 2 };

/** Prop materials a body walks through rather than into. Indexed by MAT. */
const SOFT = [];
SOFT[MAT.LEAF] = 1;
SOFT[MAT.SNOW] = 1;

/**
 * An empty column grid covering [-half, half] on both axes, `v` metres a side.
 * Fill it with addSpan/addVoxel/setLiquid, then call finish() once.
 */
export function makeCollider(half, v) {
  const n = Math.max(1, Math.round((2 * half) / v));
  const cols = new Array(n * n);
  const liq = new Uint8Array(n * n);
  const lev = new Float32Array(n * n);
  let sealed = false;

  /** Column index for a world coordinate, or -1 outside the grid. */
  const ax = (p) => {
    const i = Math.floor((p + half) / v);
    return i < 0 || i >= n ? -1 : i;
  };
  /** Same, clamped — for queries that only need the nearest column. */
  const axc = (p) => clamp(Math.floor((p + half) / v), 0, n - 1);
  /** Does this footprint reach past the edge of the window? */
  const outside = (x, z, r) =>
    x - r < -half || x + r > half || z - r < -half || z + r > half;

  function push(i, j, lo, hi) {
    if (i < 0 || j < 0 || hi - lo <= EPS) return;
    const k = i * n + j;
    (cols[k] || (cols[k] = [])).push(lo, hi);
  }

  return {
    n, v, half,

    addSpan(x, z, lo, hi) { push(ax(x), ax(z), lo, hi); },

    /** One voxel, by its centre. Nearest column: a prop's lattice is offset
        half a voxel from the terrain's, and widening it to both would fatten
        every trunk and railing by 25 cm. */
    addVoxel(x, y, z) {
      const i = Math.round((x + half) / v - 0.5), j = Math.round((z + half) / v - 0.5);
      if (i < 0 || j < 0 || i >= n || j >= n) return;
      push(i, j, y - v / 2, y + v / 2);
    },

    /** Every column whose centre falls in the rectangle. Tests build worlds
        out of these; the generator never uses it. */
    addBox(x0, x1, z0, z1, lo, hi) {
      this.forColumns(x0, x1, z0, z1, (i, j) => push(i, j, lo, hi));
    },

    /** One column, by a point inside it. What colliderForWorld uses. */
    setLiquidAt(x, z, kind, level) {
      const i = ax(x), j = ax(z);
      if (i < 0 || j < 0) return;
      liq[i * n + j] = kind; lev[i * n + j] = level;
    },

    setLiquid(x0, x1, z0, z1, kind, level) {
      this.forColumns(x0, x1, z0, z1, (i, j) => { liq[i * n + j] = kind; lev[i * n + j] = level; });
    },

    forColumns(x0, x1, z0, z1, fn) {
      for (let i = 0; i < n; i++) {
        const cx = -half + (i + 0.5) * v;
        if (cx < x0 || cx > x1) continue;
        for (let j = 0; j < n; j++) {
          const cz = -half + (j + 0.5) * v;
          if (cz < z0 || cz > z1) continue;
          fn(i, j);
        }
      }
    },

    /** Sort and merge every column. Queries assume this has run. */
    finish() {
      for (let k = 0; k < cols.length; k++) {
        const flat = cols[k];
        if (!flat) continue;
        const runs = [];
        for (let q = 0; q < flat.length; q += 2) runs.push([flat[q], flat[q + 1]]);
        runs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        const out = [];
        for (const r of runs) {
          const last = out.length ? out[out.length - 1] : null;
          if (last && r[0] <= last[1] + EPS) { if (r[1] > last[1]) last[1] = r[1]; }
          else out.push([r[0], r[1]]);
        }
        cols[k] = out;
      }
      sealed = true;
      return this;
    },

    spansAt(x, z) { return cols[axc(x) * n + axc(z)] || null; },

    liquidAt(x, z) {
      const k = axc(x) * n + axc(z);
      return { kind: liq[k], level: lev[k] };
    },

    /**
     * The highest solid surface at or below `ceilY` anywhere under the box of
     * half-width `r` centred on (x, z). -Infinity if the box is over nothing.
     * This is what "the ground" means to the controller: the foot rests on the
     * highest thing it covers, so a ledge holds you by a toe.
     */
    supportUnder(x, z, r, ceilY) {
      let best = -Infinity;
      const i0 = axc(x - r), i1 = axc(x + r), j0 = axc(z - r), j1 = axc(z + r);
      /* Columns outside the window are skipped, not clamped: clamping would
         smear the rim column outwards and give a player ground to walk on
         past the edge of the world. */
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const sp = cols[i * n + j];
          if (!sp) continue;
          for (let q = sp.length - 1; q >= 0; q--) {
            if (sp[q][1] <= ceilY + EPS) { if (sp[q][1] > best) best = sp[q][1]; break; }
          }
        }
      }
      return best;
    },

    /** Does the box of half-width `r`, from lo to hi, touch anything solid? */
    overlaps(x, z, r, lo, hi) {
      if (hi - lo <= EPS) return false;
      /* The window is bounded, and its edge is a wall. Without this a player
         walks off the map and falls forever. */
      if (outside(x, z, r)) return true;
      const i0 = axc(x - r), i1 = axc(x + r), j0 = axc(z - r), j1 = axc(z + r);
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const sp = cols[i * n + j];
          if (!sp) continue;
          for (let q = 0; q < sp.length; q++) {
            if (sp[q][0] >= hi - EPS) break;
            if (sp[q][1] > lo + EPS) return true;
          }
        }
      }
      return false;
    },

    /** The lowest solid underside above `y`. Infinity if there is open sky. */
    ceilingOver(x, z, r, y) {
      let best = Infinity;
      const i0 = axc(x - r), i1 = axc(x + r), j0 = axc(z - r), j1 = axc(z + r);
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const sp = cols[i * n + j];
          if (!sp) continue;
          for (let q = 0; q < sp.length; q++) {
            if (sp[q][0] >= y - EPS) { if (sp[q][0] < best) best = sp[q][0]; break; }
          }
        }
      }
      return best;
    },

    get ready() { return sealed; },
  };
}

/**
 * A collider for one generated window. Spans first, then every voxel the
 * generator emitted, then the liquid surfaces.
 */
export function colliderForWorld(world) {
  const half = world.half, M = world.M, NX = world.NX, NZ = world.NZ;
  const c = makeCollider(half, V);
  const ci = (p) => clamp(Math.round(p + half), 0, M - 1);

  /* Terrain. The top span is refined to the 25 cm height field; everything
     below it stays at the 1 m resolution the spans were cut at. */
  for (let i = 0; i < NX; i++) {
    const x = -half + i * V + V / 2;
    for (let j = 0; j < NZ; j++) {
      const z = -half + j * V + V / 2, k = i * NZ + j;
      const cell = world.cells[ci(x) * M + ci(z)], sp = cell.sp;
      for (let q = 0; q < sp.length - 1; q++) c.addSpan(x, z, sp[q][0], sp[q][1]);
      c.addSpan(x, z, sp[sp.length - 1][0], Math.min(world.Hs[k], CEIL));

      const f = world.FLG[k];
      if (f & 2) c.setLiquidAt(x, z, LIQUID.MAGMA, world.Hs[k]);
      else if (f & 1) c.setLiquidAt(x, z, LIQUID.WATER, cell.wl);
    }
  }

  /* Props: trunks, boulders, walls, bridges, arcs. Terrain voxels come along
     for the ride and land inside spans they are already part of.

     **Foliage is not solid.** A conifer beside a path puts its lower branches
     over the path at chest height, and they were a wall — every prop voxel went
     in, whatever it was made of. `MAT.LEAF` has the lowest hardness of anything
     that exists (0.10, against rock's 0.80), and until now nothing read that
     table for collision: the one place the distinction was already written down
     was the one place it did not apply.

     **Snow on a prop is foliage wearing a hat.** It is the ambiguous case the
     issue warns about — the same material id is canopy caps and ground
     accumulation — and propStart separates the two exactly: below it is terrain
     the world is made of, above it is something stamped on top. Ground snow
     stays solid, so a drift is still a drift; a snow-capped conifer branch is
     as soft as the branch under it. Measured: skipping leaf alone left most of
     the blocked trail still blocked, because on frost the branch at chest
     height is usually capped. */
  const propStart = world.propStart === undefined ? world.pos.length / 3 : world.propStart;
  for (let q = 0; q < world.pos.length / 3; q++) {
    if (q >= propStart && SOFT[world.mat[q]]) continue;
    c.addVoxel(world.pos[q * 3], world.pos[q * 3 + 1], world.pos[q * 3 + 2]);
  }

  return c.finish();
}
