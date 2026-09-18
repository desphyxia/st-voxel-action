/**
 * Erosion. Talus gathers at the foot of a cliff and high banks get cut back,
 * so the macro height field stops looking like noise and starts looking like
 * ground that weather has been at.
 *
 * A pure function of a world coordinate, in two senses that both matter for
 * issue #16:
 *
 *   - The draw is positional (rng.mjs `posRand`), not a step in a stream. A
 *     stream gives the same square metre a different answer depending on how
 *     much of the window was walked before reaching it.
 *   - A cell's four neighbours come from the field when they fall outside the
 *     window, rather than the border ring being skipped. Skipping it meant a
 *     cell was eroded when it was interior to one window and not when it was
 *     on the edge of another — the same coordinate, two heights.
 *
 * Reads the un-eroded heights and writes a snapshot, so the pass is order-free
 * as well as position-keyed.
 */
import { CEIL, DIRS4, clamp } from './constants.mjs';

/** Erosion is decided by a cell and its four neighbours, and nothing else. */
export function erodeAt(G, x, z, c0) {
  if (c0.water || c0.magma) return c0.H;
  var hi = 0, nearW = false, d0, cn;
  for (d0 = 0; d0 < 4; d0++) {
    cn = G.cell(x + DIRS4[d0][0], z + DIRS4[d0][1]);
    if (cn.H - c0.H > hi) hi = cn.H - c0.H;
    if (cn.water) nearW = true;
  }
  if (hi >= 3 && G.prand(x, z, 1) < 0.5) return c0.H + 1;
  if (hi === 2 && G.prand(x, z, 2) < 0.2) return c0.H + 1;
  if (nearW && c0.H >= 3 && G.prand(x, z, 3) < 0.3) return c0.H - 1;
  return c0.H;
}

export function erode(w) {
  var M = w.M, cells = w.cells, G = w.G, half = w.half, OX = w.OX, OZ = w.OZ;
  var Hn = new Int16Array(M * M), a, b;
  for (a = 0; a < M; a++) for (b = 0; b < M; b++) {
    Hn[a * M + b] = erodeAt(G, -half + a + OX, -half + b + OZ, cells[a * M + b]);
  }
  for (a = 0; a < M * M; a++) cells[a].H = clamp(Hn[a], 0, CEIL);
}
