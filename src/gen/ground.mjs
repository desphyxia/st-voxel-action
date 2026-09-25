/**
 * The ground at a world coordinate, whether or not this window can see it.
 *
 * Inside the window the cells array already carries erosion and the region's
 * grading, applied by erode() and layRoutes(). Outside it, both are reproduced
 * from the field and the region — which is only possible because both are now
 * pure functions of a world coordinate (issues #16 and #41).
 *
 * This is what lets a pass look at the neighbour of an edge cell instead of
 * skipping the window's border ring. Skipping it was erosion's original bug:
 * a cell treated one way when it was interior to one window and another way
 * when it was on the edge of the next. Height, water and magma are all a
 * neighbour is ever asked for, so that is all this returns.
 *
 * Named `groundCellAt` and not `groundAt` because `src/sim/camera.mjs` already
 * exports a `groundAt` — where a screen pixel meets the ground plane — and the
 * playable build concatenates src/gen and src/sim into one scope. The bundler
 * now fails on a collision like that rather than letting the later declaration
 * quietly win, which is how this one reached CI.
 */
import { CEIL, clamp } from './constants.mjs';
import { erodeAt } from './erosion.mjs';
import { regionAt, regionOf, cellKey } from './region.mjs';

export function groundCellAt(w, x, z) {
  var i = x - w.OX + w.half, j = z - w.OZ + w.half;
  if (i >= 0 && j >= 0 && i < w.M && j < w.M) return w.cells[i * w.M + j];
  var c = w.G.cell(x, z);
  var H = clamp(erodeAt(w.G, x, z, c), 0, CEIL);
  var g = regionAt(w.G, regionOf(x), regionOf(z)).grade.get(cellKey(x, z));
  if (g !== undefined) H = g;
  return { H: H, water: c.water, magma: c.magma, dom: c.dom, w: c.w };
}
