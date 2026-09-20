/**
 * Props, without the faces nobody can see — issue #51.
 *
 * ## Why props were the most expensive thing on screen
 *
 * `src/mesh/greedy.mjs` exists because a voxel world drawn as boxes draws six
 * faces per voxel whether or not anything can see them. It solved that for
 * *terrain* and terrain is now 15% of a frame. Props were left as instanced
 * boxes on purpose — #12's reasoning was that felling a tree must not cost a
 * chunk remesh — and nobody counted them again once the world grew from one
 * window to twenty-five chunks. Measured there, props are **62% of every
 * triangle drawn**, and of the faces they draw:
 *
 *     381,378 prop faces over four chunks and four seeds
 *     289,786 of them — 76.0% — are against another solid voxel
 *      91,592 — 24.0% — can actually be seen
 *
 * A trunk draws its own interior. This emits the 24% and drops the rest.
 *
 * ## What it deliberately does not do
 *
 * **It does not merge.** Adjacent coplanar faces of the same colour could be
 * one quad, which is what the greedy pass does for terrain, and that would cut
 * further. Culling alone is the larger and simpler half — four times fewer
 * triangles — and it is worth knowing what it buys on its own before adding a
 * second mechanism whose failure mode is a seam.
 *
 * **It does not touch what a prop looks like.** Each face carries its own
 * voxel's resolved colour, exactly as the instanced box did: `palR/palG/palB`
 * of that voxel's palette index and shade byte. Nothing is re-lit, nothing is
 * occluded, nothing merges across a colour. The only difference on screen
 * should be the absence of surfaces that were inside solid rock. The LOOK
 * gate is what holds that claim to account.
 *
 * **It does not decide what is solid.** Foliage is drawn and is not collidable
 * (#46); that split lives in `src/sim/collider.mjs` and is none of this file's
 * business. Everything a prop emits is drawn.
 *
 * No DOM, no three.js.
 */
import { V } from '../gen/constants.mjs';
import { palR, palG, palB } from '../gen/palette.mjs';

/**
 * The six faces of a voxel, each as four corners in units of half a voxel,
 * wound counter-clockwise seen from outside so the default front face is the
 * one pointing away from the solid.
 */
const FACES = [
  { n: [1, 0, 0], c: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
  { n: [-1, 0, 0], c: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
  { n: [0, 1, 0], c: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
  { n: [0, -1, 0], c: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
  { n: [0, 0, 1], c: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
  { n: [0, 0, -1], c: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
];

/** A voxel centre as an integer grid key. */
function gkey(x, y, z) {
  return Math.round(x / V) + ',' + Math.round(y / V) + ',' + Math.round(z / V);
}

/**
 * Every prop voxel this world holds, as a set of grid keys — *and every
 * terrain voxel too*.
 *
 * Both, because a face is hidden by whatever is next to it and a trunk sunk
 * into a hillside is hidden by the hill. Taking only props would leave the
 * buried half of every boulder on screen.
 */
export function solidKeys(w) {
  const n = w.pos.length / 3, set = new Set();
  for (let q = 0; q < n; q++) set.add(gkey(w.pos[q * 3], w.pos[q * 3 + 1], w.pos[q * 3 + 2]));
  return set;
}

/**
 * The visible faces of this world's props, as buffers a renderer can upload.
 *
 * `clip` is a half-extent: only props standing on the ground a streamed chunk
 * owns are emitted, the same rule `src/sim/chunks.mjs` uses for its collider.
 * A neighbour's prop is still in `w` and still *hides* faces, which is what
 * keeps a seam from opening along a chunk edge — it is counted as solid and
 * drawn by the chunk that owns it.
 */
export function meshProps(w, clip) {
  const n = w.pos.length / 3;
  const start = w.propStart === undefined ? n : w.propStart;
  const solid = solidKeys(w);
  const pos = [], nor = [], col = [], idx = [];
  let faces = 0, culled = 0, vbase = 0;

  for (let q = start; q < n; q++) {
    const x = w.pos[q * 3], y = w.pos[q * 3 + 1], z = w.pos[q * 3 + 2];
    if (clip !== undefined && (x < -clip || x >= clip || z < -clip || z >= clip)) continue;
    const r = palR(w.pal[q], w.shd[q]), g = palG(w.pal[q], w.shd[q]), b = palB(w.pal[q], w.shd[q]);
    for (let f = 0; f < 6; f++) {
      const d = FACES[f];
      if (solid.has(gkey(x + d.n[0] * V, y + d.n[1] * V, z + d.n[2] * V))) { culled++; continue; }
      faces++;
      for (let k = 0; k < 4; k++) {
        const c = d.c[k];
        pos.push(x + c[0] * V / 2, y + c[1] * V / 2, z + c[2] * V / 2);
        nor.push(d.n[0], d.n[1], d.n[2]);
        col.push(r, g, b);
      }
      idx.push(vbase, vbase + 1, vbase + 2, vbase, vbase + 2, vbase + 3);
      vbase += 4;
    }
  }
  return { pos, nor, col, idx, faces, culled, voxels: vbase / 4 };
}
