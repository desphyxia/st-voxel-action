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
 * Is this voxel one a body walks through? One definition, exported, because
 * the chunked field in chunks.mjs builds colliders too and a second copy of
 * this rule went wrong immediately: it was written as an empty table, every
 * leaf stayed solid, and a chunk disagreed with the same ground through the
 * ordinary collider by the height of a conifer.
 */
export function softProp(mat, index, propStart) {
  return index >= propStart && !!SOFT[mat];
}

/**
 * An empty column grid covering [-half, half] on both axes, `v` metres a side.
 * Fill it with addSpan/addVoxel/setLiquid, then call finish() once.
 */
export function makeCollider(half, v, bounded, origin) {
  const n = Math.max(1, Math.round((2 * half) / v));
  /* Where the grid sits in the world, per axis. Zero for a window, which is
     centred on the origin of its own coordinates; a chunk's centre for a
     streamed chunk, which is queried in world coordinates so that nothing has
     to be converted at query time. Two numbers and not one: chunk (1, -1) is
     centred at x 32 and z -32, and sharing one origin between the axes put
     every query of it a kilometre off its own grid. */
  const orgX = origin ? origin.x : 0, orgZ = origin ? origin.z : 0;
  const cols = new Array(n * n);
  const liq = new Uint8Array(n * n);
  const lev = new Float32Array(n * n);
  let sealed = false;

  /**
   * Column index for a world coordinate, or -1 outside the grid.
   *
   * **Divide first, then offset by a whole number of cells.** Both halves of
   * that matter, and both were learned from a body that stopped dead in a lake
   * and would not move again.
   *
   * `floor((p + half) / v)` makes the answer depend on `half`, because
   * `p + half` is rounded to a double before the division:
   *
   *     p = -3.7500000000000013
   *     (p + 20) / 0.25 = 65                    → column 65, i.e. 49 of a chunk
   *     (p + 16) / 0.25 = 48.99999999999999     → column 48
   *
   * One column of a box's footprint — and it cost the body its support. A
   * chunk collider (half 16) and a window collider (half 20) over *identical*
   * ground answered `supportUnder` 4.875 and 5.000 at the same point, because
   * the window saw one more column and that column was a quarter-metre higher.
   *
   * The second half is worse, and is why the grid is placed in the world
   * rather than in its own coordinates. A field of chunks used to convert a
   * world coordinate to the owning chunk's local one before asking, and
   * `(32 + -10.6) - 32` is not `-10.6`, it is `-10.600000000000001`. Divided
   * by 0.25 that is a hair under an integer, and `floor` drops a whole column.
   * At a cliff that is **3.125 m** of support appearing or vanishing at one
   * position, from an error in the sixteenth decimal place.
   *
   * So a chunk's grid is built and queried in world coordinates and nothing is
   * converted at all. `(org - half) / v` is an exact integer for every
   * collider here, so subtracting it after the division leaves the grid where
   * it was and makes the column depend only on `p`. Colliders of different
   * sizes and different places now agree column for column, which is what
   * makes a streamed chunk answerable against the window it came from.
   */
  const hcX = Math.round((orgX - half) / v), hcZ = Math.round((orgZ - half) / v);
  const cellX = (p) => Math.floor(p / v) - hcX;
  const cellZ = (p) => Math.floor(p / v) - hcZ;
  const ax = (p) => { const i = cellX(p); return i < 0 || i >= n ? -1 : i; };
  const az = (p) => { const j = cellZ(p); return j < 0 || j >= n ? -1 : j; };
  /** Same, clamped — for queries that only need the nearest column. */
  const axc = (p) => clamp(cellX(p), 0, n - 1);
  const azc = (p) => clamp(cellZ(p), 0, n - 1);
  /**
   * Does this footprint reach past the edge of the window?
   *
   * For a single bounded window the answer is a wall, and that is right: the
   * world ends there and without it a player walks off the map and falls
   * forever. For one chunk of a streamed world it is exactly wrong — the ground
   * continues, in the chunk next door. A chunked field passes `bounded: false`
   * and imposes the world's real boundary itself, because only it knows where
   * that is. Default stays walled, so nothing that exists today changes. */
  const walled = bounded !== false;
  const outside = (x, z, r) =>
    walled && (x - r < orgX - half || x + r > orgX + half
            || z - r < orgZ - half || z + r > orgZ + half);

  function push(i, j, lo, hi) {
    if (i < 0 || j < 0 || hi - lo <= EPS) return;
    const k = i * n + j;
    (cols[k] || (cols[k] = [])).push(lo, hi);
  }

  return {
    n, v, half,

    addSpan(x, z, lo, hi) { push(ax(x), az(z), lo, hi); },

    /** One voxel, by its centre. Nearest column: a prop's lattice is offset
        half a voxel from the terrain's, and widening it to both would fatten
        every trunk and railing by 25 cm. */
    addVoxel(x, y, z) {
      /* Through the same `ax`/`az` as everything else. It had its own copy of
         the index arithmetic — `round((x + half) / v - 0.5)` — which is the
         same answer for a grid centred on the origin and the wrong column for
         one placed in the world. Every prop of every streamed chunk went in
         four metres from where it stood, or off the grid entirely: 446 of a
         chunk's 16,384 columns disagreed with the window they came from, by up
         to the height of a tree. Two copies of one rule, again. */
      const i = ax(x), j = az(z);
      if (i < 0 || j < 0) return;
      push(i, j, y - v / 2, y + v / 2);
    },

    /** Every column whose centre falls in the rectangle. Tests build worlds
        out of these; the generator never uses it. */
    addBox(x0, x1, z0, z1, lo, hi) {
      this.forColumns(x0, x1, z0, z1, (i, j) => push(i, j, lo, hi));
    },

    /** One column, by a point inside it. What colliderForWorld uses. */
    setLiquidAt(x, z, kind, level) {
      const i = ax(x), j = az(z);
      if (i < 0 || j < 0) return;
      liq[i * n + j] = kind; lev[i * n + j] = level;
    },

    setLiquid(x0, x1, z0, z1, kind, level) {
      this.forColumns(x0, x1, z0, z1, (i, j) => { liq[i * n + j] = kind; lev[i * n + j] = level; });
    },

    forColumns(x0, x1, z0, z1, fn) {
      for (let i = 0; i < n; i++) {
        const cx = orgX - half + (i + 0.5) * v;
        if (cx < x0 || cx > x1) continue;
        for (let j = 0; j < n; j++) {
          const cz = orgZ - half + (j + 0.5) * v;
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

    spansAt(x, z) { return cols[axc(x) * n + azc(z)] || null; },

    liquidAt(x, z) {
      const k = axc(x) * n + azc(z);
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
      const i0 = axc(x - r), i1 = axc(x + r), j0 = azc(z - r), j1 = azc(z + r);
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
      const i0 = axc(x - r), i1 = axc(x + r), j0 = azc(z - r), j1 = azc(z + r);
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
      const i0 = axc(x - r), i1 = axc(x + r), j0 = azc(z - r), j1 = azc(z + r);
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
export function colliderForWorld(world, origin) {
  const half = world.half, M = world.M, NX = world.NX, NZ = world.NZ;
  /* `origin` places the grid in the world instead of at its own centre, so a
     window can be compared against a streamed chunk **at the same world
     coordinate** rather than at a local one reconstructed from it. Those are
     not the same real number once doubles are involved, and a test that
     converts between them measures its own arithmetic as much as the code's. */
  const c = makeCollider(half, V, undefined, origin);
  const ox = origin ? origin.x : 0, oz = origin ? origin.z : 0;
  const ci = (p) => clamp(Math.round(p + half), 0, M - 1);

  /* Terrain. The top span is refined to the 25 cm height field; everything
     below it stays at the 1 m resolution the spans were cut at. */
  for (let i = 0; i < NX; i++) {
    const x = -half + i * V + V / 2, wx = x + ox;
    for (let j = 0; j < NZ; j++) {
      const z = -half + j * V + V / 2, wz = z + oz, k = i * NZ + j;
      const cell = world.cells[ci(x) * M + ci(z)], sp = cell.sp;
      for (let q = 0; q < sp.length - 1; q++) c.addSpan(wx, wz, sp[q][0], sp[q][1]);
      c.addSpan(wx, wz, sp[sp.length - 1][0], Math.min(world.Hs[k], CEIL));

      const f = world.FLG[k];
      if (f & 2) c.setLiquidAt(wx, wz, LIQUID.MAGMA, world.Hs[k]);
      else if (f & 1) c.setLiquidAt(wx, wz, LIQUID.WATER, cell.wl);
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
    if (softProp(world.mat[q], q, propStart)) continue;
    c.addVoxel(world.pos[q * 3] + ox, world.pos[q * 3 + 1], world.pos[q * 3 + 2] + oz);
  }

  return c.finish();
}
