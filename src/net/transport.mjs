/**
 * The wire, as an interface and one test double.
 *
 * The decision (docs/DECISIONS.md §7) is host-authoritative peer-to-peer over
 * Steam Networking. None of that exists yet and none of it needs to, because
 * the thing worth getting right now is the *shape*: who decides, what crosses,
 * and what happens when it arrives late or not at all. Steam Networking, a
 * WebRTC data channel and two browser windows shouting at each other through
 * postMessage are all the same three methods.
 *
 *   send(msg)        fire and forget, unreliable and unordered by assumption
 *   onMessage(fn)    register a receiver; may fire at any time
 *   close()
 *
 * Anything above that — reliability, ordering, retries — is the session's
 * problem, and the session is written not to need them. Nothing here knows what
 * a message means.
 *
 * makeLoopback is the double: a connected pair, driven by an explicit pump
 * rather than by timers, with latency measured in ticks and loss from a seeded
 * stream. That is what lets a five-hundred-tick desync test be a test rather
 * than a coin toss.
 */
import { mulberry32, xmur3 } from '../gen/rng.mjs';

/**
 * Two endpoints, wired to each other.
 *
 *   latency  extra ticks on top of the one tick nothing can travel faster than
 *   loss     0..1, applied per message per direction
 *   jitter   up to this many more ticks, drawn per message — so messages
 *            overtake each other, which is what a real network does (#95)
 *   dup      0..1, the chance a message arrives twice
 *   seed     names the loss stream, so a failing case can be re-run
 */
export function makeLoopback(opts) {
  const o = opts || {};
  const latency = o.latency || 0;
  const loss = o.loss || 0;
  const jitter = o.jitter || 0;
  const dup = o.dup || 0;
  const rnd = mulberry32(xmur3(String(o.seed === undefined ? 'loopback' : o.seed))());

  let clock = 0;
  const queues = { a: [], b: [] };     /* messages waiting to arrive at each side */
  const handlers = { a: [], b: [] };
  const stat = { sent: 0, dropped: 0, delivered: 0, bytes: 0, duplicated: 0 };

  function endpoint(self, other) {
    let open = true;
    return {
      send(msg) {
        if (!open) return;
        stat.sent++;
        /* Serialised on the way in, exactly as a real transport would: this is
           what catches a message that smuggled a live object reference across
           and then mutated under the receiver. */
        const wire = JSON.stringify(msg);
        stat.bytes += wire.length;
        if (loss > 0 && rnd() < loss) { stat.dropped++; return; }
        const late = () => (jitter ? Math.floor(rnd() * (jitter + 1)) : 0);
        queues[other].push({ due: clock + 1 + latency + late(), wire });
        if (dup > 0 && rnd() < dup) { stat.duplicated++; queues[other].push({ due: clock + 1 + latency + late(), wire }); }
      },
      onMessage(fn) { handlers[self].push(fn); },
      close() { open = false; },
    };
  }

  const a = endpoint('a', 'b'), b = endpoint('b', 'a');

  /** One tick of wire time. Deliver whatever is due, then move on. */
  function pump() {
    clock++;
    for (const side of ['a', 'b']) {
      const keep = [];
      for (const item of queues[side]) {
        if (item.due > clock) { keep.push(item); continue; }
        stat.delivered++;
        const msg = JSON.parse(item.wire);
        for (const fn of handlers[side]) fn(msg);
      }
      queues[side] = keep;
    }
  }

  return { a, b, pump, stat, get clock() { return clock; } };
}

/**
 * A real transport made worse on purpose (#93): what this end sends is held
 * back `delay` ms plus up to `jitter` more — so messages overtake each other —
 * and a `loss` fraction of it never goes. Set on both ends, it is a bad
 * network both ways; on one, a bad uplink. `set` changes it live.
 *
 * `env` supplies the clock and the dice — `{ later(fn, ms), rnd() }` — so a
 * test can drive it. The page uses setTimeout and Math.random: none of this is
 * simulation, and a debug switch has no business being deterministic.
 */
export function conditioned(t, opts, env) {
  const e = env || { later: (fn, ms) => setTimeout(fn, ms), rnd: Math.random };
  let o = { delay: 0, jitter: 0, loss: 0 };
  const stat = { sent: 0, dropped: 0, held: 0 };
  const set = (p) => { o = Object.assign({}, o, p || {}); return o; };
  set(opts);
  return {
    stat,
    get conditions() { return o; },
    set,
    send(m) {
      stat.sent++;
      if (o.loss > 0 && e.rnd() < o.loss) { stat.dropped++; return; }
      const ms = o.delay + (o.jitter ? e.rnd() * o.jitter : 0);
      if (ms <= 0) { t.send(m); return; }
      stat.held++;
      e.later(() => { stat.held--; t.send(m); }, ms);
    },
    onMessage(fn) { t.onMessage(fn); },
    close() { t.close(); },
  };
}
