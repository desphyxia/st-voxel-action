/**
 * Routing, as seen from a window.
 *
 * The deciding moved to src/gen/region.mjs (issue #16): which two sites a
 * region has, where the trail between them runs, where it is graded into a
 * cutting, and where it crosses water are all answered per 128 m region, in
 * world coordinates, by a pure function of the seed and the region. This file
 * is what is left — the part that *reads* those answers for one window.
 *
 * It decides nothing. That is the whole point: a window is a view, and two
 * views of the same ground now agree because neither of them chose anything.
 *
 * Sets w.TRAIL, w.sites, w.bridges, w.trailPath.
 *
 * A site is [i, j, role]: window cell indices, plus its index within the
 * region, which is what props.mjs builds a ruin or a holding from.
 */
import { regionAt, regionsFor, keyX, keyZ, cellKey } from './region.mjs';

export function layRoutes(w) {
  var M = w.M, cells = w.cells, half = w.half, OX = w.OX, OZ = w.OZ, G = w.G;
  var TRAIL = new Uint8Array(M * M), sites = [], bridges = [], trailPath = [];

  /* The window's world-space box, in cell coordinates. */
  var wx0 = -half + OX, wz0 = -half + OZ, wx1 = wx0 + (M - 1), wz1 = wz0 + (M - 1);
  var regions = regionsFor(wx0, wz0, wx1, wz1).map(function (r) {
    return regionAt(G, r[0], r[1]);
  });

  /* World coordinate to window cell index, or -1 when it is not in this view. */
  function idx(x, z) {
    var i = x - OX + half, j = z - OZ + half;
    if (i < 0 || j < 0 || i > M - 1 || j > M - 1) return -1;
    return i * M + j;
  }
  function inside(x, z) { return idx(x, z) >= 0; }

  var q, k;

  /* 1. The cuttings. A graded trail moved the ground under it, and a window
        that did not apply the same moves would have a trail running along a
        hillside the region thinks was levelled. */
  for (q = 0; q < regions.length; q++) {
    regions[q].grade.forEach(function (h, key) {
      var x = keyX(key), z = keyZ(key), at = idx(x, z);
      if (at >= 0) cells[at].H = h;
    });
  }

  /* 2. The trail itself, in the order the region laid it — reach.mjs starts a
        player from the first walkable cell along it. */
  for (q = 0; q < regions.length; q++) {
    var ord = regions[q].order, rd = regions[q].roads;
    for (k = 0; k < ord.length; k++) {
      var at2 = idx(ord[k][0], ord[k][1]);
      if (at2 < 0) continue;
      if (!TRAIL[at2]) { TRAIL[at2] = 1; trailPath.push(at2); }
      /* 2 is road, 1 is path (#55 item 12). Anything that only asks "is this
         trail" still gets a truthy answer. */
      if (rd && rd.has(cellKey(ord[k][0], ord[k][1]))) TRAIL[at2] = 2;
    }
  }

  /* 3. Sites and crossings, converted to the window-local frame its consumers
        expect: sites as cell indices, a crossing as metres from the middle. */
  for (q = 0; q < regions.length; q++) {
    var rs = regions[q].sites;
    for (k = 0; k < rs.length; k++) {
      if (!inside(rs[k][0], rs[k][1])) continue;
      /* The third element is the site's role — its index within the region,
         which is what decides whether a ruin or a holding stands on it. A
         window that can see only the second site must still know it is the
         second, so the role travels with the site rather than being read off
         this list's length (issue #41). */
      sites.push([rs[k][0] - OX + half, rs[k][1] - OZ + half, k]);
    }
    var rb = regions[q].bridges;
    for (k = 0; k < rb.length; k++) {
      var b = rb[k];
      /* A crossing is placed at the midpoint of a span of water, so it can sit
         on a half-metre; round outward to the cell that holds it. */
      if (!inside(Math.round(b[0]), Math.round(b[1]))) continue;
      bridges.push([b[0] - OX, b[1] - OZ, b[2], b[3], b[4], b[5]]);
    }
  }

  /* 4. Encounter affordances (#42), clipped to the window like everything else
        here. x and z are metres from the window's middle, as a crossing's are;
        wx and wz keep the world place, which is what two windows agree on. */
  var affordances = [];
  for (q = 0; q < regions.length; q++) {
    var ra = regions[q].affordances || [];
    for (k = 0; k < ra.length; k++) {
      var af = ra[k];
      if (!inside(af.x, af.z)) continue;
      affordances.push({ k: af.k, x: af.x - OX, z: af.z - OZ, wx: af.x, wz: af.z, h: af.h, s: af.s });
    }
  }
  w.affordances = affordances;
  w.TRAIL = TRAIL; w.sites = sites; w.bridges = bridges; w.trailPath = trailPath;
  /* The regions this window is a view onto, so later passes can read the
     landmark without deciding one of their own. */
  w.regions = regions;
}
