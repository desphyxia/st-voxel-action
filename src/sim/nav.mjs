/**
 * Navigation: where a body of a given width can go, and how to get there
 * (issue #15).
 *
 * A graph over the collider itself, not over the generator's cells — so it is
 * the same question the controller answers every tick, asked ahead of time,
 * and it works unchanged over one window's collider or a streamed field of
 * chunks. Nodes are places a box can stand, on a NAV_STEP lattice; edges are
 * the verbs of the movement budget (docs/DECISIONS.md §3):
 *
 *   walk    to a neighbour no more than a step up, or down by less than a
 *           fall that would hurt
 *   vault   onto a ledge above a step and within the vault height — only for
 *           a body that vaults (a sentry does not; it goes around)
 *   jump    across a gap to ground at about the same height, no wider than the
 *           jump budget — a link, not a neighbour
 *
 * Every edge is per radius (#37): a wide machine does not fit through a gap a
 * player does, and `2 * radius` of any jump is crossed by standing on the
 * lips. The search is lazy — nodes are evaluated as A* reaches them, inside a
 * bound — because a streamed world has no whole to build a graph over;
 * `navGraph` builds the explicit one for a box, for tools and tests.
 *
 * Deterministic: the open set breaks ties by node order, never by insertion
 * luck, because both machines in a co-op session must agree on where a
 * machine walked. No Math.sin and friends, like the rest of src/.
 */
import { MOVE } from '../gen/constants.mjs';
import { hyp } from '../gen/exact.mjs';
import { EPS, LIQUID } from './collider.mjs';
import { ACTOR } from './actor.mjs';

/** Metres between lattice points. Half a metre: finer than any gap that matters. */
export const NAV_STEP = 0.5;
/** A drop a path will take on purpose: short of one that hurts. */
const SAFE_DROP = MOVE.fall - 1;
const DIRS8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

function opts0(o) {
  o = o || {};
  return {
    rad: o.rad === undefined ? ACTOR.radius : o.rad,
    height: o.height === undefined ? ACTOR.height : o.height,
    canVault: o.canVault !== false,
    canJump: o.canJump !== false,
    maxNodes: o.maxNodes || 6000,
  };
}

/**
 * Where a box stands at (x, z), reached from a body at height `fromY`: the
 * highest surface no more than `reach` above it. null if there is none, if the
 * box would not fit there, if it is magma, or if the water is over its head.
 */
function standAt(col, x, z, fromY, reach, o) {
  const y = col.supportUnder(x, z, o.rad, fromY + reach + EPS);
  if (y === -Infinity) return null;
  if (col.overlaps(x, z, o.rad, y + EPS, y + o.height - EPS)) return null;
  const liq = col.liquidAt(x, z);
  if (liq.kind === LIQUID.MAGMA && y <= liq.level + 0.35) return null;
  if (liq.kind === LIQUID.WATER && liq.level - y > MOVE.wade) return null;
  return y;
}

/**
 * standAt, remembered for one search. The same lattice point is asked about
 * from each of its neighbours — eight times over, and twice more for every
 * diagonal — and the answer depends only on where, from what height and how
 * far up it may reach. Measured: a sentry's search on ash went from 30 ms
 * median to a fraction of that once the repeats were not recomputed.
 */
function memoStand(col, o) {
  const seen = new Map();
  return (i, j, fromY, reach) => {
    const k = i + ',' + j + ',' + Math.round(fromY * 4) + ',' + reach;
    let v = seen.get(k);
    if (v === undefined) { v = standAt(col, posOf(i), posOf(j), fromY, reach, o); seen.set(k, v); }
    return v;
  };
}

/** Lattice index for a world coordinate, and back. */
const cellOf = (p) => Math.round(p / NAV_STEP);
const posOf = (i) => i * NAV_STEP;

/** The edges out of a node, as { i, j, y, cost, kind }. */
function edges(col, n, o, st) {
  const out = [];
  const x = posOf(n.i), z = posOf(n.j);
  for (let d = 0; d < 8; d++) {
    const di = DIRS8[d][0], dj = DIRS8[d][1], diag = di && dj;
    const ni = n.i + di, nj = n.j + dj, nx = posOf(ni), nz = posOf(nj);
    const len = diag ? NAV_STEP * 1.4142135623730951 : NAV_STEP;
    /* Diagonals only where both straight neighbours are open: a corner cut
       through a wall is not a move the controller can make. */
    if (diag) {
      if (st(n.i + di, n.j, n.y, MOVE.step) === null) continue;
      if (st(n.i, n.j + dj, n.y, MOVE.step) === null) continue;
    }
    const w = st(ni, nj, n.y, MOVE.step);
    if (w !== null && n.y - w <= SAFE_DROP + EPS) {
      const up = Math.max(0, w - n.y), down = Math.max(0, n.y - w);
      out.push({ i: ni, j: nj, y: w, cost: len + up * 1.5 + (down > MOVE.step ? down * 0.5 : 0), kind: 'walk' });
      continue;
    }
    if (diag) continue;
    /* Blocked by something above a step: a vault, if this body vaults. */
    if (o.canVault) {
      const v = st(ni, nj, n.y, MOVE.vault);
      if (v !== null && v - n.y > MOVE.step + EPS && v - n.y <= MOVE.vault + EPS
          && !col.overlaps(x, z, o.rad, n.y + EPS, v + o.height - EPS)) {
        out.push({ i: ni, j: nj, y: v, cost: len + 2.5, kind: 'vault' });
        continue;
      }
    }
    /* A gap: nothing within a safe drop straight ahead. Look across it for
       ground at about this height, no further than the jump budget. */
    if (o.canJump && w === null) {
      const gapBelow = col.supportUnder(nx, nz, o.rad, n.y + EPS);
      if (gapBelow !== -Infinity && n.y - gapBelow <= SAFE_DROP) continue;
      for (let k = 2; k * NAV_STEP <= MOVE.jump + EPS; k++) {
        const li = n.i + di * k, lj = n.j + dj * k;
        const l = st(li, lj, n.y, MOVE.step);
        if (l === null) continue;
        if (Math.abs(l - n.y) > MOVE.step + EPS) break;
        if (col.overlaps(posOf(n.i + di * (k >> 1)), posOf(n.j + dj * (k >> 1)), o.rad, n.y + 0.5, n.y + o.height)) break;
        out.push({ i: li, j: lj, y: l, cost: k * NAV_STEP + 2, kind: 'jump' });
        break;
      }
    }
  }
  return out;
}

const keyOf = (i, j, y) => i + ',' + j + ',' + Math.round(y * 4);

/** A binary heap on (f, order), so equal costs pop in a fixed order. */
function heap() {
  const a = [];
  const less = (p, q) => p.f < q.f || (p.f === q.f && p.o < q.o);
  return {
    get size() { return a.length; },
    push(v) {
      a.push(v);
      for (let c = a.length - 1; c > 0;) {
        const p = (c - 1) >> 1;
        if (!less(a[c], a[p])) break;
        [a[c], a[p]] = [a[p], a[c]]; c = p;
      }
    },
    pop() {
      const top = a[0], last = a.pop();
      if (a.length) {
        a[0] = last;
        for (let p = 0; ;) {
          const l = 2 * p + 1, r = l + 1;
          let m = p;
          if (l < a.length && less(a[l], a[m])) m = l;
          if (r < a.length && less(a[r], a[m])) m = r;
          if (m === p) break;
          [a[p], a[m]] = [a[m], a[p]]; p = m;
        }
      }
      return top;
    },
  };
}

/**
 * The cheapest way for a body to get from `from` ({x, y, z}) to near `to`
 * ({x, z}), as waypoints { x, y, z, kind } ending at the goal's lattice point
 * — or the way to the closest point it could reach, flagged `partial`, when
 * the goal cannot be reached inside the node budget. null if it cannot move.
 */
export function findPath(col, from, to, options) {
  const o = opts0(options);
  /* The lattice point nearest the body, or — when that one is inside a wall
     for a body this wide, which is exactly where a machine pressed against a
     wall stands — the nearest one within a metre that it can stand on. */
  let si = cellOf(from.x), sj = cellOf(from.z);
  let sy = standAt(col, posOf(si), posOf(sj), from.y, MOVE.step, o);
  if (sy === null) {
    const near = [];
    for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) {
      if (a || b) near.push([si + a, sj + b, hyp(posOf(si + a) - from.x, posOf(sj + b) - from.z)]);
    }
    near.sort((p, q) => p[2] - q[2] || p[0] - q[0] || p[1] - q[1]);
    for (const [ni, nj] of near) {
      const y = standAt(col, posOf(ni), posOf(nj), from.y, MOVE.step, o);
      if (y !== null) { si = ni; sj = nj; sy = y; break; }
    }
  }
  if (sy === null) return null;
  const gi = cellOf(to.x), gj = cellOf(to.z);
  const h = (i, j) => hyp(i - gi, j - gj) * NAV_STEP;
  const st = memoStand(col, o);
  const start = { i: si, j: sj, y: sy, g: 0, prev: null, kind: 'start' };
  const open = heap(), best = new Map();
  let order = 0, closest = start, closestH = h(si, sj), expanded = 0;
  best.set(keyOf(si, sj, sy), start);
  open.push({ f: closestH, o: order++, n: start });
  let goal = null;
  while (open.size && expanded < o.maxNodes) {
    const { n } = open.pop();
    if (n.closed) continue;
    n.closed = true; expanded++;
    const hn = h(n.i, n.j);
    if (hn < closestH) { closest = n; closestH = hn; }
    if (n.i === gi && n.j === gj) { goal = n; break; }
    for (const e of edges(col, n, o, st)) {
      const k = keyOf(e.i, e.j, e.y), g = n.g + e.cost, old = best.get(k);
      if (old && (old.closed || old.g <= g)) continue;
      const m = { i: e.i, j: e.j, y: e.y, g, prev: n, kind: e.kind };
      best.set(k, m);
      open.push({ f: g + h(e.i, e.j), o: order++, n: m });
    }
  }
  const end = goal || closest;
  const path = [];
  for (let n = end; n; n = n.prev) path.push({ x: posOf(n.i), y: n.y, z: posOf(n.j), kind: n.kind });
  path.reverse();
  path.partial = !goal;
  path.expanded = expanded;
  return path;
}

/**
 * The explicit graph over a box: every node a body can stand on and every
 * edge out of it, jump links included. What #15 asks to be exported, and what
 * a tool or the hookline frame can read without running a search.
 */
export function navGraph(col, box, options) {
  const o = opts0(options);
  const nodes = [], index = new Map(), links = [];
  for (let i = cellOf(box.x0); i <= cellOf(box.x1); i++) {
    for (let j = cellOf(box.z0); j <= cellOf(box.z1); j++) {
      const y = standAt(col, posOf(i), posOf(j), Infinity, 0, o);
      if (y === null) continue;
      index.set(keyOf(i, j, y), nodes.length);
      nodes.push({ i, j, x: posOf(i), y, z: posOf(j) });
    }
  }
  const st = memoStand(col, o);
  for (let a = 0; a < nodes.length; a++) {
    for (const e of edges(col, nodes[a], o, st)) {
      const b = index.get(keyOf(e.i, e.j, e.y));
      if (b !== undefined) links.push({ a, b, cost: e.cost, kind: e.kind });
    }
  }
  return { nodes, links, step: NAV_STEP, rad: o.rad };
}
