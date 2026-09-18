/**
 * Taking a bite out of the world, and working out what has to be remeshed —
 * issue #12's "remeshes on a carve".
 *
 * A carve is three separate questions, and keeping them separate is the point:
 *
 *   - **What comes away.** Every solid voxel inside the bite whose material is
 *     soft enough to pay for. Hardness is the material table's (src/gen/
 *     materials.mjs): one bite cannot break basalt or worked metal, and magma
 *     is not carveable at all. The hardest thing that held is reported back, so
 *     a renderer can say *why* nothing happened.
 *   - **Where it is recorded.** `w.edits`, a Map from voxel to the material
 *     that used to be there. Sparse, because a world is mostly unedited, and
 *     keyed by voxel rather than by chunk so it survives rechunking.
 *   - **What is now stale.** Not just the chunk the voxel is in. The mesher
 *     reads a one-voxel ring past its own edge so a seam is shaded by the chunk
 *     beside it, which means a carve within one voxel of a boundary changes the
 *     *neighbour's* occlusion too. `chunksTouching` is that ring, and getting
 *     it wrong shows up as a bright crease along a chunk edge.
 *
 * **What this deliberately is not.** A carve recorded here changes what is
 * drawn and nothing else. Collision still reads the generated spans, so a hole
 * is a hole you can see and not one you can fall into, and nothing about an
 * edit crosses the wire. Both are real work and neither belongs to a meshing
 * issue: destructible ground has to be host-authoritative like everything else
 * in src/net, and it has to survive a save, which is the same delta format
 * chunk streaming needs. Until then this is a mesher hook, not a player verb,
 * and the build exposes it as one.
 *
 * No DOM and no three.js, like the rest of src/.
 */
import { V, CHUNK } from '../gen/constants.mjs';
import { MATERIALS } from '../gen/materials.mjs';
import { LEVELS, editKey, solidVox, surfaceAt } from './greedy.mjs';

/** What one bite can pay for. Rock yields, basalt and metal do not. */
export const BITE = 1.0;

/** The radius of a bite, in metres. Two and a half voxels — the plate's. */
export const BITE_R = 0.62;

/** How many chunks a side this world was meshed into. */
export function chunkGrid(w) { return Math.max(1, Math.round(w.size / CHUNK)); }

/**
 * Every chunk whose mesh reads this voxel: the one it is in, plus any whose
 * pad ring reaches it. Returned as `cx * grid + cz` so a caller can dedupe in a
 * Set without stringifying.
 */
export function chunksTouching(w, gi, gj, into) {
  var side = Math.round(CHUNK / V), g = chunkGrid(w);
  var set = into || new Set();
  for (var di = -1; di <= 1; di++) {
    for (var dj = -1; dj <= 1; dj++) {
      var cx = Math.floor((gi + di) / side), cz = Math.floor((gj + dj) / side);
      if (cx < 0 || cz < 0 || cx >= g || cz >= g) continue;
      set.add(cx * g + cz);
    }
  }
  return set;
}

/**
 * Bite a sphere out of the world at a point, in metres.
 *
 * Returns what came away, the hardest material that refused, and the chunks
 * whose meshes are now stale — in the order a caller should remesh them, which
 * is any order, because a chunk's mesh depends only on the world.
 */
export function carve(w, x, y, z, opts) {
  opts = opts || {};
  var r = opts.radius === undefined ? BITE_R : opts.radius;
  var bite = opts.bite === undefined ? BITE : opts.bite;
  if (!w.edits) w.edits = new Map();

  var half = w.half, r2 = r * r, g = chunkGrid(w);
  /* The voxel whose centre is at c is at index (c + half - V/2) / V. */
  var i0 = Math.ceil((x - r + half - V / 2) / V), i1 = Math.floor((x + r + half - V / 2) / V);
  var j0 = Math.ceil((z - r + half - V / 2) / V), j1 = Math.floor((z + r + half - V / 2) / V);
  var y0 = Math.ceil((y - r) / V - 0.5), y1 = Math.floor((y + r) / V - 0.5);
  var cut = 0, held = null, dirty = new Set(), removed = [];

  for (var gi = i0; gi <= i1; gi++) {
    var dx = (-half + gi * V + V / 2) - x;
    for (var gj = j0; gj <= j1; gj++) {
      var dz = (-half + gj * V + V / 2) - z;
      if (dx * dx + dz * dz >= r2) continue;
      for (var yy = Math.max(0, y0); yy <= Math.min(LEVELS - 1, y1); yy++) {
        var dy = (yy * V + V / 2) - y;
        if (dx * dx + dy * dy + dz * dz >= r2) continue;
        if (!solidVox(w, gi, gj, yy)) continue;
        var m = surfaceAt(w, gi, gj, yy).mat, mm = MATERIALS[m];
        if (mm.hard > bite) { if (!held || mm.hard > held.hard) held = mm; continue; }
        w.edits.set(editKey(w, gi, gj, yy), m);
        removed.push(gi, gj, yy);
        chunksTouching(w, gi, gj, dirty);
        cut++;
      }
    }
  }

  var chunks = [];
  dirty.forEach(function (k) { chunks.push([Math.floor(k / g), k % g]); });
  return { cut: cut, held: held, chunks: chunks, removed: removed };
}

/** Put everything back. The world is the generator's again. */
export function clearEdits(w) {
  var n = w.edits ? w.edits.size : 0;
  if (w.edits) w.edits.clear();
  return n;
}
