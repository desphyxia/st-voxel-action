/**
 * The world as chunks that can be generated and thrown away independently —
 * issue #13, the part everything else in it stands on.
 *
 * ## Why a chunk is a window and not a slice
 *
 * `buildWorld` generates a *window*: a square of ground centred on (ox, oz).
 * Streaming needs each chunk generated alone, at any time, in any order, on any
 * thread — and the result has to be the same ground the chunk beside it thinks
 * is there. Two things decide whether that is possible, and only one of them
 * was written down.
 *
 * **Same-size windows at different offsets agree.** That is the skirt result
 * #41 measured and `src/README.md` records: two windows onto the same ground
 * differ only within a few voxels of a rim.
 *
 * **Windows of different sizes do not.** This is not in the issue and was not
 * recorded anywhere. A 32 m window and a 64 m window centred on the same point
 * disagree on 14,184 of the 16,384 cells they share — 87% — and the
 * disagreement runs 15.75 m deep, nowhere near a rim. The generator is not
 * size-invariant, and a chunk cut from a small window would be a different
 * world from the same chunk cut from a large one.
 *
 * So the rule this module exists to enforce is: **every streamed window is the
 * same size, always.** Chunks differ by offset and by nothing else. That is not
 * a limitation to work around later; it is the condition under which the skirt
 * guarantee means anything at all.
 *
 * ## The numbers
 *
 * A chunk is 32 m (`CHUNK`). The window generated for it is 40 m — the chunk
 * plus a 4 m skirt on every side, generated and discarded. Measured across the
 * golden seeds, neighbouring 40 m windows 32 m apart are **identical on every
 * cell they share**: not "differ by eight voxels at the rim", zero. At 48 m and
 * 64 m the same test differs by 16 voxels within 0.25 m of a rim, which is the
 * ordinary skirt effect — 40 m avoids even that, because the overlap between
 * neighbours is exactly the two skirts and nothing of either chunk proper.
 *
 * No DOM, no three.js. This decides *what* to generate; it does not schedule,
 * cache or draw anything, and it knows nothing about a player.
 */
import { CHUNK } from './constants.mjs';
import { buildWorld } from './index.mjs';

/** The skirt generated on each side of a chunk and then thrown away, in metres. */
export const SKIRT = 4;

/**
 * The window generated for one chunk. Fixed for all time and for every chunk:
 * two windows of different sizes are two different worlds, so this number is
 * part of the world's identity in the way the seed is.
 */
export const WINDOW = CHUNK + 2 * SKIRT;

/** Where a chunk's centre sits in the world, in metres. */
export function chunkCentre(cx, cz) {
  return { ox: cx * CHUNK, oz: cz * CHUNK };
}

/**
 * Generate one chunk's window. The caller gets the whole 40 m of it — the skirt
 * included — because the mesher needs a ring of neighbours to shade a seam and
 * the collider needs somewhere to put the wall at the edge. What the caller
 * must not do is *keep* anything from the skirt: that ground belongs to the
 * neighbouring chunk, which will generate it identically.
 */
export function chunkWorld(seed, cx, cz, force, gdens) {
  const { ox, oz } = chunkCentre(cx, cz);
  return buildWorld({ seed, size: WINDOW, force: force === undefined ? null : force, ox, oz,
                      gdens: gdens === undefined ? 1 : gdens });
}

/**
 * Is this window cell part of the chunk proper, or is it skirt?
 *
 * The skirt is what two neighbours both generate, so keeping it from both is
 * how a voxel gets drawn twice and a column gets its spans doubled.
 */
export function inChunk(w, i, j) {
  const pad = Math.round(SKIRT / (2 * w.half / w.NX));
  return i >= pad && j >= pad && i < w.NX - pad && j < w.NZ - pad;
}
