/**
 * Two players in one world, host-authoritative.
 *
 * The host owns the simulation. It runs both characters, and what it says
 * happened is what happened. The guest runs its own character immediately from
 * its own input — otherwise every step would cost a round trip — and then
 * reconciles: when an authoritative snapshot arrives it is restored wholesale,
 * and every input the host had not yet seen is replayed on top. What the player
 * feels is their own latency-free movement; what they get is the host's answer.
 *
 * That only works because the controller is deterministic. Fixed timestep, no
 * randomness, no wall clock, and arithmetic that returns the same bits on every
 * engine (src/gen/exact.mjs) — replaying the same inputs from the same state
 * reproduces the host exactly rather than approximately. This is what #20 and
 * the pinned-math work were really for.
 *
 * Nothing about the terrain crosses the wire. The world is a pure function of
 * its seed, so the host sends the seed once and the guest grows the same world
 * itself. That is what makes edits, enemies and loot affordable: they are
 * deltas against something both ends already have. Loot is the first one to
 * take the promise up — the caches are derived from the world on both machines
 * and a machine's spoil lies where that machine fell, so the whole of what is
 * on the ground travels as **one integer** of what has been picked up.
 *
 * Gear is the exception that proves the rule: it rides the *snapshot*, because
 * a lattice is not derivable from anything and because `step` reads it. A
 * guest replaying inputs after a correction has to replay them with the host's
 * lattice, or the replay lands somewhere the host never was.
 *
 * The transport is an interface (src/net/transport.mjs). Steam Networking
 * implements the same three methods later; the prototype uses two browser
 * windows and a loopback pair in the tests.
 */
import { TICK, placeOnGround, step, snapshot, restore, display, applyDisplay,
         embedded, ACTOR } from '../sim/actor.mjs';
import { seatOn, pullFrom } from '../sim/lattice.mjs';

/** Snapshots per second is this divided into the tick rate: 60 / 3 = 20 Hz. */
export const SEND_EVERY = 3;
/** How often the host re-announces itself until a guest answers. */
export const HELLO_EVERY = 20;
/** Longest replay after a correction. Four seconds of input at 60 Hz. */
export const MAX_PENDING = 240;
/** How hard the guest pulls its picture of the host toward the last snapshot. */
export const SMOOTH = 0.25;

export const HOST = 0, GUEST = 1;

const IDLE = { mx: 0, mz: 0, jump: false, attack: false, dodge: false, aimX: 0, aimZ: 0 };
const copyInput = (i) => ({ mx: i.mx || 0, mz: i.mz || 0, jump: !!i.jump,
                            attack: !!i.attack, dodge: !!i.dodge,
                            aimX: i.aimX || 0, aimZ: i.aimZ || 0 });

/**
 * Seating and unseating a module is **not** an input.
 *
 * Inputs are replayed — that is the whole point of them — and replaying "put
 * the module I am carrying into slot 2" four times is not the same as doing it
 * once. So gear changes go as their own message, the host applies each exactly
 * once, and the result comes back in the next snapshot. A menu click can afford
 * the round trip; the reconciliation cannot afford a non-idempotent input.
 */
export const ACT = { SOCKET: 0, UNSOCKET: 1 };

function applyAct(a, m) {
  return m.k === ACT.SOCKET ? seatOn(a, m.s, m.c) : pullFrom(a, m.s);
}

/**
 * Somewhere to put the second player: near the first, but not inside a tree.
 * A ring of offsets, then the spawn itself if none of them is clear.
 */
export function spawnNear(col, x, z) {
  const ring = [[1.5, 0], [0, 1.5], [-1.5, 0], [0, -1.5], [2.5, 2.5], [-2.5, -2.5]];
  for (const [dx, dz] of ring) {
    const a = placeOnGround(col, x + dx, z + dz);
    if (a.grounded && !embedded(col, a)) return a;
  }
  return placeOnGround(col, x, z);
}

/* ------------------------------------------------------------------ host ---- */

export function makeHost(opts) {
  const { col, spawn, transport, cfg, targets, encounter } = opts;
  const sendEvery = opts.sendEvery || SEND_EVERY;
  const me = placeOnGround(col, spawn[0], spawn[2]);
  const peer = spawnNear(col, spawn[0], spawn[2]);

  /* Inputs arrive in bursts or not at all; they are consumed one a tick, which
     is the jitter buffer. A starved tick repeats the last input rather than
     dropping to idle — a player who stutters should keep running, not stop. */
  const inbox = [];
  let last = { seq: 0, input: copyInput(IDLE) };
  let t = 0, joined = false, seen = 0;

  transport.onMessage((m) => {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'join') { joined = true; return; }
    /* The guest asking for its own lattice to change. Authority is not shared:
       it is applied here or it does not happen, and the next snapshot is how
       the guest finds out which. */
    if (m.t === 'act') { applyAct(peer, m); return; }
    if (m.t === 'input') {
      seen++;
      if (inbox.length < MAX_PENDING) inbox.push({ seq: m.seq, input: copyInput(m) });
    }
  });

  function announce() { transport.send({ t: 'hello', cfg, spawn, id: GUEST }); }
  announce();

  return {
    role: 'host', me, peer, cfg,
    get connected() { return joined; },
    get tick() { return t; },
    /** Drawn from the same data that is sent, so a gap in one shows in both. */
    get foes() { return encounter ? encounter.wire() : null; },
    /** What is still on the ground, as the bitmask that goes over the wire. */
    get loot() { return encounter && encounter.loot ? encounter.loot.wire() : 0; },

    /** This machine's own player seats a module. No wire: it is the authority. */
    act(kind, slot, carriedIndex) {
      return applyAct(me, { k: kind, s: slot, c: carriedIndex });
    },
    get stats() { return { t, joined, queued: inbox.length, inputs: seen }; },

    /** One authoritative tick. `localInput` is this machine's own player. */
    step(localInput) {
      t++;
      if (!joined && t % HELLO_EVERY === 0) announce();

      const next = inbox.length ? inbox.shift() : last;
      last = next;

      step(col, me, copyInput(localInput || IDLE), targets);
      step(col, peer, next.input, targets);
      /* The world acts after the players do, and it is the host's world: a
         guest predicts its own movement and nothing else. */
      if (encounter) encounter.step([me, peer]);

      if (t % sendEvery === 0) {
        transport.send({
          t: 'snap', tick: t, ack: next.seq,
          /* Full state for the guest's own character, because it replays from
             it. Display state for everything it only draws. */
          you: snapshot(peer),
          them: display(me),
          foes: encounter ? encounter.wire() : null,
          /* Every drop in the world, as one integer — see src/sim/loot.mjs. */
          lt: encounter && encounter.loot ? encounter.loot.wire() : 0,
        });
      }
      return this;
    },
  };
}

/* ----------------------------------------------------------------- guest ---- */

/**
 * `build(cfg)` is handed the host's world config and must return
 * `{ col, spawn }` — the guest grows the world itself rather than being sent
 * it. Until that happens the session is not `ready` and stepping it does
 * nothing.
 */
export function makeGuest(opts) {
  const { transport, build } = opts;
  let col = null, me = null, peer = null, cfg = null, encounter = null;
  let foes = null, lootBits = 0;
  let seq = 0, ready = false, corrections = 0, replayed = 0, lastAck = 0, hostTick = 0;
  const pending = [];
  let target = null;                       /* last authoritative host state */
  let lastYou = null;                      /* ...and the last word on us */

  transport.onMessage((m) => {
    if (!m || typeof m !== 'object') return;

    if (m.t === 'hello') {
      if (ready) { transport.send({ t: 'join' }); return; }   /* a repeat beacon */
      cfg = m.cfg;
      const world = build(m.cfg);
      col = world.col;
      /* Optional, and only ever drawn: if this end derived an encounter of its
         own, the snapshots are folded into it rather than into a second list. */
      encounter = world.encounter || null;
      me = spawnNear(col, m.spawn[0], m.spawn[2]);
      peer = placeOnGround(col, m.spawn[0], m.spawn[2]);
      ready = true;
      transport.send({ t: 'join' });
      return;
    }

    if (m.t === 'snap' && ready) {
      /* Wholesale, not a nudge: the host's word replaces ours, and then every
         input it had not seen yet is put back on top. Skipping the replay is
         what makes a corrected client feel like it is being dragged backwards. */
      restore(me, m.you);
      lastYou = m.you;
      hostTick = m.tick;
      lastAck = m.ack;
      corrections++;
      while (pending.length && pending[0].seq <= m.ack) pending.shift();
      /* Replayed without targets: movement is predicted, damage is not. A guest
         that guessed at hits would flash things the host never agreed were hit,
         which is worse than the round trip it saves. */
      for (const p of pending) { step(col, me, p.input, null); replayed++; }
      target = m.them;
      foes = m.foes;
      lootBits = m.lt || 0;
      if (encounter && encounter.observeWire) encounter.observeWire(foes, lootBits);
    }
  });

  return {
    role: 'guest',
    get ready() { return ready; },
    get me() { return me; },
    get peer() { return peer; },
    get cfg() { return cfg; },
    get connected() { return ready; },
    /** The host's tick as of its last snapshot: the one clock both windows
        can agree on, which is what the sky (#30) is read from. */
    get tick() { return hostTick; },
    get stats() { return { seq, pending: pending.length, corrections, replayed, lastAck }; },
    /** Whatever the host last said was in the world. Drawn, never stepped. */
    get foes() { return foes; },
    /** And what of it has been picked up, by either of them. */
    get loot() { return lootBits; },

    /** Ask the host to seat a module. It decides; the next snapshot answers. */
    act(kind, slot, carriedIndex) {
      if (!ready) return false;
      transport.send({ t: 'act', k: kind, s: slot, c: carriedIndex });
      return true;
    },
    /** The last thing the host said about us, before any replay on top of it.
        The gap between this and `me` is exactly what prediction is buying. */
    get authoritative() { return target ? lastYou : null; },

    /** One predicted tick. Sends the input, applies it locally straight away. */
    step(localInput) {
      if (!ready) return this;
      seq++;
      const input = copyInput(localInput || IDLE);
      transport.send({ t: 'input', seq, mx: input.mx, mz: input.mz, jump: input.jump,
                       attack: input.attack, dodge: input.dodge,
                       aimX: input.aimX, aimZ: input.aimZ });
      pending.push({ seq, input });
      if (pending.length > MAX_PENDING) pending.shift();
      step(col, me, input, null);

      /* The other player arrives at 20 Hz and is drawn, not simulated, so it is
         eased rather than snapped. Proper snapshot interpolation on a delay
         buffer is a refinement; this is enough to see someone move. */
      if (target) {
        peer.x += (target.x - peer.x) * SMOOTH;
        peer.y += (target.y - peer.y) * SMOOTH;
        peer.z += (target.z - peer.z) * SMOOTH;
        applyDisplay(peer, target);
      }
      return this;
    },
  };
}
