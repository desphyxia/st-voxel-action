/**
 * The region pass: where the things bigger than a window get decided.
 *
 * Issue #16. Until now the generator chose sites, routed trails between them,
 * placed crossings and picked a landmark *inside the window it happened to be
 * generating*. Two windows overlapping the same ground would each decide for
 * themselves, and disagree — a trail in one and not the other, an obelisk that
 * exists depending on where you were standing when the world was made. That is
 * the reason the generator could only ever produce one window at a time.
 *
 * So these decisions move up a level. A **region** is 4 x 4 chunks (128 m), and
 * everything here is a pure function of the seed and the region's coordinates:
 * generate it from a window, from a worker, or twice in a row, and it answers
 * the same. A window is then only a *view* — it reports the sites, trail,
 * crossings and landmark that happen to fall inside it, and it never decides
 * anything about them.
 *
 * Two properties this rests on, both of which had to be built first:
 *
 *   - `G.cell(x, z)` was already a pure function of world position.
 *   - Erosion is now one too (erosion.mjs). It was not: it drew from a stream
 *     and skipped the window's border ring, so the same square metre had two
 *     heights depending on how it was looked at. A route is chosen over those
 *     heights, so nothing here could be deterministic until that was.
 *
 * What is deliberately *not* here yet: props, clutter, grass and the span
 * undercuts are still decided per window from the ordered stream, so two
 * windows agree on where the trail goes and disagree about which boulder sits
 * beside it. That is the same class of bug and the same fix, and streaming
 * (#13) will need it — but it is a great deal of call sites and it is not what
 * #16 asks for.
 */
import { MOVE, DIRS4, CEIL, clamp } from './constants.mjs';
import { erodeAt } from './erosion.mjs';

/** Region edge, metres. */
export const REGION = 64;
/** Keep chosen sites this far off the region edge, in metres. */
const MARGIN = 6;
/** One cell of slack so a cell on the region edge still has its neighbours. */
const PAD = 1;

/** Which region a world coordinate falls in. Centred on the origin, so the
    prototype's default window is exactly one region rather than a quarter of
    each of four. */
export function regionOf(v) { return Math.floor((v + REGION / 2) / REGION); }

/* ---------- the region's own grid ----------
   Held in world coordinates, because that is the only frame in which two
   different windows can be asked the same question. */

function makeGrid(G, rx, rz) {
  var x0 = rx * REGION - REGION / 2 - PAD, z0 = rz * REGION - REGION / 2 - PAD;
  var N = REGION + 1 + PAD * 2;
  var cells = new Array(N * N), i, j;
  for (i = 0; i < N; i++) {
    for (j = 0; j < N; j++) {
      var c = G.cell(x0 + i, z0 + j);
      cells[i * N + j] = c;
    }
  }
  /* Erosion reads un-eroded neighbours, so it is applied from a snapshot —
     the same order-free shape the window pass uses. */
  var Hn = new Int16Array(N * N);
  for (i = 0; i < N; i++) for (j = 0; j < N; j++) {
    Hn[i * N + j] = erodeAt(G, x0 + i, z0 + j, cells[i * N + j]);
  }
  for (i = 0; i < N * N; i++) cells[i].H = clamp(Hn[i], 0, CEIL);
  return { cells: cells, N: N, x0: x0, z0: z0 };
}

/* ---------- routing ----------
   Lifted from routes.mjs unchanged in behaviour; the difference is the frame it
   runs in. `b.sp` is never set this early — spans are cut later — so that term
   has always been inert. Kept, and marked, rather than quietly dropped: it is
   what the cost *means* once spans move ahead of routing. */

function passCost(a, b) {
  if (b.magma) return -1;
  var dh = b.H - a.H;
  if (dh > MOVE.vault) return -1;
  var c = 1 + (dh > 0 ? dh * 3.2 : (-dh) * 1.1);
  if (b.water) c += ((b.wl - b.H) > MOVE.wade) ? 34 : 6;
  if (b.sp && b.sp.length > 1) c += 2;            /* inert until spans precede routing */
  return c;
}

function aStar(g, ai, aj, bi, bj) {
  var N = g.N, cells = g.cells, n = N * N;
  var dist = new Float32Array(n), prev = new Int32Array(n), seen = new Uint8Array(n), q;
  for (q = 0; q < n; q++) { dist[q] = 1e9; prev[q] = -1; }
  var st = ai * N + aj, gl = bi * N + bj, heap = [];
  function push(pr, v) {
    heap.push([pr, v]);
    var i = heap.length - 1;
    while (i > 0) {
      var p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      var t = heap[p]; heap[p] = heap[i]; heap[i] = t; i = p;
    }
  }
  function pop() {
    var top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      var i = 0;
      for (;;) {
        var l = i * 2 + 1, r = l + 1, sm = i;
        if (l < heap.length && heap[l][0] < heap[sm][0]) sm = l;
        if (r < heap.length && heap[r][0] < heap[sm][0]) sm = r;
        if (sm === i) break;
        var t = heap[sm]; heap[sm] = heap[i]; heap[i] = t; i = sm;
      }
    }
    return top;
  }
  dist[st] = 0; push(0, st);
  while (heap.length) {
    var cu = pop()[1];
    if (seen[cu]) continue;
    seen[cu] = 1;
    if (cu === gl) break;
    var cx = (cu / N) | 0, cz = cu % N;
    for (var d = 0; d < 4; d++) {
      var nx = cx + DIRS4[d][0], nz = cz + DIRS4[d][1];
      if (nx < PAD || nz < PAD || nx >= N - PAD || nz >= N - PAD) continue;
      var nk = nx * N + nz;
      if (seen[nk]) continue;
      var cst = passCost(cells[cu], cells[nk]);
      if (cst < 0) continue;
      var nd = dist[cu] + cst;
      if (nd < dist[nk]) { dist[nk] = nd; prev[nk] = cu; push(nd, nk); }
    }
  }
  if (gl !== st && prev[gl] < 0) return null;
  var path = [], p = gl, guard = 0;
  while (p >= 0 && guard++ < 20000) { path.push(p); if (p === st) break; p = prev[p]; }
  return path.reverse();
}

/* ---------- the pass ---------- */

function buildRegion(G, rx, rz) {
  var g = makeGrid(G, rx, rz), N = g.N, cells = g.cells, x0 = g.x0, z0 = g.z0;
  /* One stream per region, seeded from the region's own coordinates. Ordered
     draws are fine *inside* here: the order is fixed by the region, not by
     which window asked. */
  var n = 0;
  var R = function () { return G.prand(rx, rz, 0x5100 + (n++)); };

  var trail = new Set(), grade = new Map(), bridges = [], sites = [];
  /* Trail cells in the order the routes laid them down. reach.mjs walks this to
     find somewhere to start a player, and "the first walkable cell along the
     path" is only meaningful if the path has an order. */
  var order = [];
  var mark = function (x, z) {
    var k = x + ',' + z;
    if (trail.has(k)) return;
    trail.add(k); order.push([x, z]);
  };
  var key = function (x, z) { return x + ',' + z; };
  var at = function (i, j) { return cells[i * N + j]; };

  function flatAt(i, j, r) {
    var cp = at(i, j);
    if (!cp || cp.water || cp.magma) return false;
    for (var a = -r; a <= r; a++) for (var b = -r; b <= r; b++) {
      var ci = i + a, cj = j + b;
      if (ci < 0 || cj < 0 || ci >= N || cj >= N) return false;
      var cq = at(ci, cj);
      if (!cq || cq.water || cq.magma || Math.abs(cq.H - cp.H) > 1) return false;
    }
    return true;
  }

  /* Everything reachable on foot from a start, over the budget. Used to tell a
     site across water from one merely far away — the far bank is the
     interesting second site, because getting there needs a crossing. */
  function dryFlood(start) {
    var seen = new Uint8Array(N * N), q = [start], head = 0;
    seen[start] = 1;
    while (head < q.length) {
      var cu = q[head++], cx = (cu / N) | 0, cz = cu % N;
      for (var d = 0; d < 4; d++) {
        var nx = cx + DIRS4[d][0], nz = cz + DIRS4[d][1];
        if (nx < PAD || nz < PAD || nx >= N - PAD || nz >= N - PAD) continue;
        var nk = nx * N + nz;
        if (seen[nk]) continue;
        var nc = cells[nk];
        if (nc.water || nc.magma) continue;
        if (Math.abs(nc.H - cells[cu].H) > MOVE.vault) continue;
        seen[nk] = 1; q.push(nk);
      }
    }
    return seen;
  }

  /* ---- two sites ---- */
  var lo = PAD + MARGIN, hi = N - PAD - MARGIN;
  var cands = [], i, j;
  for (i = lo; i < hi; i++) for (j = lo; j < hi; j++) if (flatAt(i, j, 2)) cands.push(i * N + j);
  if (cands.length) {
    var A = cands[(R() * cands.length) | 0], ai = (A / N) | 0, aj = A % N;
    sites.push([ai, aj]);
    var dry = dryFlood(A), across = [], apart = [], q1;
    for (q1 = 0; q1 < cands.length; q1++) {
      var idx = cands[q1], di = (idx / N) | 0, dj = idx % N;
      if (Math.abs(di - ai) + Math.abs(dj - aj) < 10) continue;
      if (dry[idx]) apart.push(idx); else across.push(idx);
    }
    var pool = across.length ? across : apart;
    if (pool.length) {
      var best = -1, bestLen = -1, tries = Math.min(10, pool.length), t;
      for (t = 0; t < tries; t++) {
        var cand = pool[(R() * pool.length) | 0];
        var rp = aStar(g, ai, aj, (cand / N) | 0, cand % N);
        if (!rp) continue;
        var wet = 0, q2;
        for (q2 = 0; q2 < rp.length; q2++) if (cells[rp[q2]].water) wet++;
        if (wet > 0) { best = cand; break; }
        if (rp.length > bestLen) { bestLen = rp.length; best = cand; }
      }
      if (best < 0) best = pool[(R() * pool.length) | 0];
      sites.push([(best / N) | 0, best % N]);
    }
  }

  /* ---- grade, mark, and cross ---- */
  function gradePath(path) {
    if (!path) return;
    var q, it, A2, B2;
    for (it = 0; it < 3; it++) {
      for (q = 1; q < path.length; q++) {
        A2 = cells[path[q - 1]]; B2 = cells[path[q]];
        if (A2.water || B2.water) continue;
        if (B2.H - A2.H > MOVE.step) B2.H = A2.H + MOVE.step;
        else if (A2.H - B2.H > MOVE.step) B2.H = A2.H - MOVE.step;
      }
      for (q = path.length - 2; q >= 0; q--) {
        A2 = cells[path[q + 1]]; B2 = cells[path[q]];
        if (A2.water || B2.water) continue;
        if (B2.H - A2.H > MOVE.step) B2.H = A2.H + MOVE.step;
        else if (A2.H - B2.H > MOVE.step) B2.H = A2.H - MOVE.step;
      }
    }
    /* Pull the shoulders in so the route is a cutting, not a trench. */
    for (q = 0; q < path.length; q++) {
      var pi = (path[q] / N) | 0, pj = path[q] % N, hp = cells[path[q]].H;
      for (var d = 0; d < 4; d++) {
        var ni = pi + DIRS4[d][0], nj = pj + DIRS4[d][1];
        if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue;
        var nc = at(ni, nj);
        if (!nc || nc.water || nc.magma) continue;
        if (nc.H - hp > 2) nc.H = hp + 2; else if (hp - nc.H > 2) nc.H = hp - 2;
      }
    }
  }

  /* Every height this pass moved, keyed by world coordinate, so a window can
     apply exactly the same cuttings without re-deciding them. */
  function recordGrades() {
    for (var a = 0; a < N; a++) for (var b = 0; b < N; b++) {
      var c = cells[a * N + b], h0 = G.cell(x0 + a, z0 + b);
      var eroded = erodeAt(G, x0 + a, z0 + b, h0);
      if (c.H !== clamp(eroded, 0, CEIL)) grade.set(key(x0 + a, z0 + b), c.H);
    }
  }

  function addBridge(bx, bz, di, dj, len, y) {
    if (bridges.length >= 2) return;
    for (var q = 0; q < bridges.length; q++) {
      if (Math.abs(bridges[q][0] - bx) + Math.abs(bridges[q][1] - bz) < 6) return;
    }
    bridges.push([bx, bz, di, dj, len, y]);
  }

  function markPath(path) {
    if (!path) return;
    for (var q = 0; q < path.length; q++) {
      var pi = (path[q] / N) | 0, pj = path[q] % N;
      if (!cells[path[q]].magma) mark(x0 + pi, z0 + pj);
      var pv = path[q > 0 ? q - 1 : q], di = pi - ((pv / N) | 0), dj = pj - (pv % N);
      var sx = pi + dj, sz = pj - di;
      if (sx > 0 && sz > 0 && sx < N - 1 && sz < N - 1 && !at(sx, sz).magma) {
        mark(x0 + sx, z0 + sz);
      }
    }
    /* A crossing only where the route actually meets water. */
    var w = 0;
    while (w < path.length) {
      if (!cells[path[w]].water) { w++; continue; }
      var st = w;
      while (w < path.length && cells[path[w]].water) w++;
      var len = w - st;
      if (len <= 12) {
        var pre = path[Math.max(0, st - 1)], post = path[Math.min(path.length - 1, w)];
        var pc = cells[pre], qc = cells[post];
        if (!pc.magma && !qc.magma && !pc.water && !qc.water) {
          var pi0 = (pre / N) | 0, pj0 = pre % N, pi1 = (post / N) | 0, pj1 = post % N;
          var di2 = (pi1 > pi0) ? 1 : ((pi1 < pi0) ? -1 : 0);
          var dj2 = (pj1 > pj0) ? 1 : ((pj1 < pj0) ? -1 : 0);
          if (di2 && dj2) dj2 = 0;
          if (!di2 && !dj2) di2 = 1;
          addBridge(x0 + (pi0 + pi1) / 2, z0 + (pj0 + pj1) / 2, di2, dj2, len + 3,
                    Math.max(pc.H, qc.H, cells[path[st]].wl + 0.5));
        }
      }
    }
  }

  function findFord() {
    var best = null, a, b, d;
    for (a = PAD + 1; a < N - PAD - 1; a++) for (b = PAD + 1; b < N - PAD - 1; b++) {
      var c0 = at(a, b);
      if (c0.water || c0.magma) continue;
      for (d = 0; d < 4; d++) {
        var di = DIRS4[d][0], dj = DIRS4[d][1], len = 0, x = a + di, z = b + dj;
        while (x > PAD && z > PAD && x < N - PAD && z < N - PAD && at(x, z).water && len < 8) {
          len++; x += di; z += dj;
        }
        if (len < 1 || len > 6) continue;
        var fc = at(x, z);
        if (!fc || fc.water || fc.magma || Math.abs(fc.H - c0.H) > 1) continue;
        var score = len * 10 + Math.abs(fc.H - c0.H) - (trail.has(key(x0 + a, z0 + b)) ? 25 : 0);
        if (!best || score < best.score) {
          best = { score: score, ai: a, aj: b, bi: x, bj: z, di: di, dj: dj, len: len };
        }
      }
    }
    return best;
  }

  /* The region's centre stands in for "where a player enters it" — the old
     pass routed from the window's middle, which is the same idea in the frame
     it had. */
  var mid = (N / 2) | 0;
  var r1 = sites.length > 0 ? aStar(g, mid, mid, sites[0][0], sites[0][1]) : null;
  var r2 = sites.length > 1 ? aStar(g, sites[0][0], sites[0][1], sites[1][0], sites[1][1]) : null;
  gradePath(r1); gradePath(r2); markPath(r1); markPath(r2);

  if (!bridges.length && sites.length) {
    var wet = 0, q3;
    for (q3 = 0; q3 < N * N; q3++) if (cells[q3].water) wet++;
    if (wet >= 20) {
      var fd = findFord();
      if (fd) {
        var r3 = aStar(g, sites[0][0], sites[0][1], fd.ai, fd.aj);
        gradePath(r3); markPath(r3);
        for (q3 = 0; q3 <= fd.len + 1; q3++) {
          var xx = fd.ai + fd.di * q3, zz = fd.aj + fd.dj * q3;
          if (xx < PAD || zz < PAD || xx >= N - PAD || zz >= N - PAD) break;
          if (!at(xx, zz).magma) mark(x0 + xx, z0 + zz);
        }
        for (q3 = 1; q3 <= 3; q3++) {
          var fx = fd.bi + fd.di * q3, fz = fd.bj + fd.dj * q3;
          if (fx < PAD || fz < PAD || fx >= N - PAD || fz >= N - PAD) break;
          if (!at(fx, fz).magma && !at(fx, fz).water) mark(x0 + fx, z0 + fz);
        }
        addBridge(x0 + (fd.ai + fd.bi) / 2, z0 + (fd.aj + fd.bj) / 2, fd.di, fd.dj, fd.len + 3,
                  Math.max(at(fd.ai, fd.aj).H, at(fd.bi, fd.bj).H,
                           at(fd.ai + fd.di, fd.aj + fd.dj).wl + 0.5));
      }
    }
  }

  /* ---- level the marked route ----
     gradePath caps the *path* at MOVE.step, but the trail mask is wider than
     the path: markPath adds a shoulder beside every step and a ford marks its
     own crossing, and neither was ever levelled against what it sits next to.
     That left cell-to-cell steps of 2 and 3 m inside the trail mask, which the
     voxel resample then rides faithfully however finely it samples.

     Symmetric, because lowering only would cut a route into the ground every
     time it met a rise: the high side comes down and the low side comes up by
     turns until no two adjacent marked cells are more than one step apart.
     Water and magma are left where they are — a crossing belongs at the
     waterline, and a ford that levelled itself would stop being one.

     Runs before recordGrades, so every metre it moves travels to a window as
     part of the region's grading rather than being re-decided there. */
  function levelTrail() {
    var pts = [];
    trail.forEach(function (k) {
      var p = k.split(','), a = +p[0] - x0, b = +p[1] - z0;
      if (a < 1 || b < 1 || a >= N - 1 || b >= N - 1) return;
      var c0 = at(a, b);
      if (!c0 || c0.water || c0.magma) return;
      pts.push(a * N + b);
    });
    /* Sorted, so the sweep order is the region's and not the Set's insertion
       order — which is the order the routes happened to be laid in. */
    pts.sort(function (p, q) { return p - q; });
    /* Four neighbours. Levelling the diagonals too was tried and measured: it
       moved not one voxel on any of the six seeds, because a trail cell's
       diagonal is either already within a step or is not a trail cell at all.
       The half-metre steps that remain are the second case — the outer edge of
       the route meeting ground that was never graded — and closing those means
       widening every cutting, which is a bigger change than they are worth. */
    for (var it = 0; it < 8; it++) {
      var moved = 0;
      for (var q2 = 0; q2 < pts.length; q2++) {
        var a2 = (pts[q2] / N) | 0, b2 = pts[q2] % N, c2 = at(a2, b2);
        for (var d2 = 0; d2 < 4; d2++) {
          var na = a2 + DIRS4[d2][0], nb = b2 + DIRS4[d2][1];
          if (!trail.has(key(x0 + na, z0 + nb))) continue;
          var nc2 = at(na, nb);
          if (!nc2 || nc2.water || nc2.magma) continue;
          var gap = c2.H - nc2.H;
          if (gap > MOVE.step) { c2.H -= 1; moved++; }
          else if (gap < -MOVE.step) { c2.H += 1; moved++; }
        }
      }
      if (!moved) break;
    }
  }
  levelTrail();

  recordGrades();

  /* ---- one landmark, on the region's highest flat ground off the trail ---- */
  var lm = null, bi = null;
  for (i = lo; i < hi; i += 2) for (j = lo; j < hi; j += 2) {
    var cq4 = at(i, j);
    if (cq4.water || cq4.magma || trail.has(key(x0 + i, z0 + j))) continue;
    if (!flatAt(i, j, 1)) continue;
    if (!bi || cq4.H > bi.h) bi = { i: i, j: j, h: cq4.H, dom: cq4.dom };
  }
  if (bi) {
    var kinds = (bi.dom === 3) ? [2, 0] : ((bi.dom === 1) ? [0, 3] : ((bi.dom === 4) ? [3, 0] : [1, 3]));
    var kind = kinds[Math.abs(Math.round(rx * 0.37 + rz * 0.11)) % kinds.length];
    lm = { x: x0 + bi.i, z: z0 + bi.j, h: bi.h, kind: kind, dom: bi.dom };
  }

  return {
    rx: rx, rz: rz, x0: x0, z0: z0,
    /* World-coordinate keys, every one of them. A window converts on the way in
       and on the way out; nothing in here knows a window exists. */
    trail: trail, order: order, grade: grade, bridges: bridges, landmark: lm,
    sites: sites.map(function (s) { return [x0 + s[0], z0 + s[1]]; }),
  };
}

/* ---------- cache ----------
   A 64 m window overlaps up to four regions and asks each the same questions;
   a streamed world will ask far more often than that. Keyed by the seed word
   so two seeds never share an entry. */
const CACHE = new Map();
const CACHE_MAX = 64;

/** Drop every cached region. A test seam: without it "the pass is pure" is
    unprovable, because the cache would answer the second question itself. */
export function clearRegionCache() { CACHE.clear(); }

export function regionAt(G, rx, rz) {
  var k = G.sw + ':' + rx + ':' + rz;
  var hit = CACHE.get(k);
  if (hit) return hit;
  var built = buildRegion(G, rx, rz);
  if (CACHE.size >= CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
  CACHE.set(k, built);
  return built;
}

/** Every region a world-space box touches, including the one-cell margin. */
export function regionsFor(x0, z0, x1, z1) {
  var out = [], rx, rz;
  for (rx = regionOf(x0 - 1); rx <= regionOf(x1 + 1); rx++) {
    for (rz = regionOf(z0 - 1); rz <= regionOf(z1 + 1); rz++) out.push([rx, rz]);
  }
  return out;
}
