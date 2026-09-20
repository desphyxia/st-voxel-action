/**
 * Which chunk to build next, how many at once, and when to let one go —
 * issue #13.
 *
 * `src/sim/chunks.mjs` answers what is solid across the chunks that are
 * loaded. It does not decide *which* those are beyond "everything within a
 * radius, right now, synchronously". This decides that, and deliberately does
 * not build anything itself: it hands out work and takes delivery. A main
 * thread, a pool of workers and a test with a fake clock are then the same
 * shape of caller, which is the only way the thing that runs in the browser is
 * the thing node asserts.
 *
 * ## The measurement that decides the design
 *
 * One 40 m window costs **57 ms at the median and 292 ms at the ninetieth
 * percentile** to generate (node 22, six golden seeds, nine chunks each). A
 * 60 Hz frame is 16.7 ms.
 *
 * So a chunk does not fit in a frame — not at the median, not at the best case
 * measured, not by a factor of three. The "frame budget" #13 asks for cannot be
 * a budget that generation is fitted into, because the smallest indivisible
 * unit of generation is already four frames wide. There are two honest
 * responses and this module is built for the second:
 *
 * - make generation resumable, so a window can be built a slice at a time;
 * - move it off the main thread and keep the main thread's share to adopting
 *   the result.
 *
 * ## What is not actually a problem
 *
 * Outrunning the loader. A body runs at `RUN` 4 m/s and a chunk is 32 m, so
 * crossing one takes eight seconds; entering a new chunk at load radius 2 makes
 * a column of five chunks newly wanted, which is under 1.5 s of generation even
 * at the p90 cost. The front of decided ground stays tens of metres ahead at
 * every moment. The soak below measures it rather than assuming it.
 *
 * The problem is entirely one of *smoothness*: on the main thread the same work
 * arrives as a 57–406 ms freeze every eight seconds. That is why generation
 * leaves the main thread — not because it is too slow, but because it is too
 * lumpy.
 *
 * ## Hysteresis
 *
 * Wanted and unwanted are two different radii. With one radius, a body standing
 * on a chunk boundary and stepping back and forth drops and regenerates a whole
 * column every few steps, which is the most expensive thing it is possible to
 * do and looks like nothing at all. `keepR` is larger than `loadR`, so a chunk
 * has to be properly left behind before it is let go.
 *
 * No DOM, no three.js, no timers: the caller owns the clock.
 */
import { chunkAt } from './chunks.mjs';

/**
 * Defaults, in chunks. `loadR` 2 puts decided ground at least 48 m away in
 * every direction, which at `RUN` is twelve seconds of warning. `keepR` one
 * larger is the cheapest hysteresis that works: a body has to cross a whole
 * chunk to undo its own last decision.
 */
export const STREAM = { loadR: 2, keepR: 3, flight: 2 };

/* Not `key`: chunks.mjs already declares one at top level and the bundle is
   one flat scope, so the second would win everywhere. */
const ckey = (cx, cz) => cx + ',' + cz;

/**
 * A scheduler over a chunk field.
 *
 * The caller's loop is: `want(centres)` when the players move, then take work
 * with `next()` and return it with `deliver()`. `pump()` is the shorthand for a
 * caller that builds on its own thread.
 */
export function makeStream(field, opts) {
  const o = Object.assign({}, STREAM, opts || {});
  const flight = new Map();          /* key -> {cx, cz} begun and not yet delivered */
  let wanted = new Map();            /* key -> {cx, cz, d2} nearest-centre distance */
  let centres = [{ x: 0, z: 0 }];
  let delivered = 0, failed = 0, released = 0;

  /**
   * Two distances, and they are not interchangeable.
   *
   * `near2` is squared Euclidean and orders the queue: the chunk you are
   * standing on comes before the one at the corner of the same square, which
   * is what "nearest first" should mean to someone walking.
   *
   * `ring` is Chebyshev, and it is what decides whether a chunk is wanted or
   * let go, because the region `want` fills is a **square** — `loadR` chunks
   * on each axis. Testing that square for membership with a radius measured
   * as a circle was the first version, and the hysteresis silently did almost
   * nothing: at `loadR` 1 the four corners of a neighbour's square sit at
   * Euclidean distance sqrt(5), outside a keep radius of 2, so every crossing
   * dropped and rebuilt them. 20 crossings cost 48 builds where 12 was the
   * whole point. A square region needs a square keep.
   */
  function near2(cx, cz) {
    let best = Infinity;
    for (const p of centres) {
      const c = chunkAt(p.x, p.z);
      const dx = cx - c.cx, dz = cz - c.cz, d2 = dx * dx + dz * dz;
      if (d2 < best) best = d2;
    }
    return best;
  }

  function ring(cx, cz) {
    let best = Infinity;
    for (const p of centres) {
      const c = chunkAt(p.x, p.z);
      const d = Math.max(Math.abs(cx - c.cx), Math.abs(cz - c.cz));
      if (d < best) best = d;
    }
    return best;
  }

  /**
   * Recompute what should exist. Chunks within `loadR` of a centre are wanted;
   * chunks past `keepR` are let go; the ring between is kept if it is already
   * there and not built if it is not. That gap is the hysteresis.
   */
  function want(cs) {
    if (cs && cs.length) centres = cs.map((p) => ({ x: p.x, z: p.z }));
    const next = new Map();
    for (const p of centres) {
      const c = chunkAt(p.x, p.z);
      for (let dx = -o.loadR; dx <= o.loadR; dx++) {
        for (let dz = -o.loadR; dz <= o.loadR; dz++) {
          const cx = c.cx + dx, cz = c.cz + dz, k = ckey(cx, cz);
          if (!next.has(k)) next.set(k, { cx, cz, d2: near2(cx, cz) });
        }
      }
    }
    wanted = next;
    for (const e of field.live()) {
      if (wanted.has(ckey(e.cx, e.cz))) continue;
      if (ring(e.cx, e.cz) <= o.keepR) continue;
      field.drop(e.cx, e.cz); released++;
    }
    /* Work in flight for ground nobody wants any more is abandoned rather than
       delivered into a field that would have to drop it again. */
    for (const [k, w] of [...flight]) if (ring(w.cx, w.cz) > o.keepR) flight.delete(k);
    return wanted.size;
  }

  /** The most urgent chunk that is missing and not already being built. */
  function next() {
    let best = null;
    for (const w of wanted.values()) {
      const k = ckey(w.cx, w.cz);
      if (flight.has(k) || field.has(w.cx, w.cz)) continue;
      if (!best || w.d2 < best.d2) best = w;
    }
    if (!best || flight.size >= o.flight) return null;
    flight.set(ckey(best.cx, best.cz), { cx: best.cx, cz: best.cz });
    return { cx: best.cx, cz: best.cz };
  }

  /** Ground that has been generated, from wherever. */
  function deliver(cx, cz, w) {
    flight.delete(ckey(cx, cz));
    if (ring(cx, cz) > o.keepR) return false;
    field.adopt(cx, cz, w);
    delivered++;
    return true;
  }

  /** A build that did not happen. The chunk goes back in the queue. */
  function fail(cx, cz) { flight.delete(ckey(cx, cz)); failed++; }

  return {
    want, next, deliver, fail,

    /**
     * Change how far the world reaches. Spawning settles a small radius
     * synchronously — a loading screen's worth — and then widens, because
     * settling the playing radius before the first frame is several seconds of
     * nothing. The wider ring fills in a window at a time while you play.
     */
    radius(loadR, keepR) {
      o.loadR = loadR;
      if (keepR !== undefined) o.keepR = keepR;
      want(null);
    },

    /**
     * Build on this thread until `budgetMs` is spent, and report the overrun.
     *
     * A chunk cannot be abandoned half-built, so the last one always finishes:
     * the budget decides how many are *started*, never how long the call takes.
     * With the measured per-chunk cost and a frame's budget this returns after
     * one chunk and roughly four frames, which is the whole argument for the
     * worker and is why the overrun is reported rather than swallowed.
     */
    pump(build, budgetMs, clock) {
      const now = clock || (() => performance.now());
      const t0 = now();
      let n = 0;
      for (;;) {
        const spent = now() - t0;
        if (n && spent >= budgetMs) break;
        const j = next();
        if (!j) break;
        deliver(j.cx, j.cz, build(j.cx, j.cz));
        n++;
      }
      const took = now() - t0;
      return { built: n, ms: took, over: Math.max(0, took - budgetMs) };
    },

    /** Everything wanted is there: nothing queued and nothing in flight. */
    get settled() { return this.pending === 0 && flight.size === 0; },
    get pending() {
      let k = 0;
      for (const w of wanted.values()) if (!field.has(w.cx, w.cz) && !flight.has(ckey(w.cx, w.cz))) k++;
      return k;
    },
    get inFlight() { return flight.size; },
    get wanted() { return wanted.size; },
    get delivered() { return delivered; },
    get failed() { return failed; },
    get released() { return released; },
  };
}
