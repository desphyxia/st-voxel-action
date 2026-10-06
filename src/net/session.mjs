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
import { packFoes, unpackFoes } from '../sim/enemy.mjs';

/** Snapshots per second is this divided into the tick rate: 60 / 3 = 20 Hz. */
export const SEND_EVERY = 3;
/** How often the host re-announces itself until a guest answers. */
export const HELLO_EVERY = 20;
/** Longest replay after a correction. Four seconds of input at 60 Hz. */
export const MAX_PENDING = 240;
/** How far behind the latest the guest *draws* what it only draws — the
    host's character and the machines — in ticks, on top of however late the
    snapshots have lately been arriving: one snapshot's interval and a tick,
    so there is nearly always one on each side of the moment being drawn and
    the picture is a blend between them rather than a hop to each as it
    lands. */
export const INTERP = SEND_EVERY + 1;
/** Snapshots kept for that, which is well over a second of them. */
const PAST = 24;
/** How many of its latest inputs the guest sends in every message, so one
    lost message loses nothing: a real network drops them one at a time. */
export const REDUNDANT = 3;
/** Inputs the host will hold before it starts consuming two a tick. Two
    machines' 60 Hz are never quite the same 60 Hz, and a guest whose clock
    runs fast would otherwise build a queue — and a lag — without bound. */
export const CATCHUP = 8;
/** Two seconds without a word and the partner is lost: drawn standing where
    they were, driven by nothing, until they come back. */
export const STALE = 120;

export const HOST = 0, GUEST = 1;

const IDLE = { mx: 0, mz: 0, jump: false, attack: false, dodge: false, aimX: 0, aimZ: 0, hold: false, swap: false };
/* `rise` and `sink` are jump and dodge *held*, which only flight reads. */
const copyInput = (i) => ({ mx: i.mx || 0, mz: i.mz || 0, jump: !!i.jump,
                            attack: !!i.attack, dodge: !!i.dodge,
                            aimX: i.aimX || 0, aimZ: i.aimZ || 0,
                            rise: !!i.rise, sink: !!i.sink,
                            /* The attack button still down, and a frame swap
                               (#112): the Reel fires on release. */
                            hold: !!i.hold, swap: !!i.swap });
/* An input on the wire: five numbers. The stick is kept to 1/10000 on *both*
   ends — the guest predicts with the same rounded value the host will apply,
   so the rounding costs nothing in agreement and a third of the bytes. */
const q4 = (v) => Math.round((v || 0) * 1e4) / 1e4;
export function packInput(i) {
  return [q4(i.mx), q4(i.mz),
          (i.jump ? 1 : 0) | (i.attack ? 2 : 0) | (i.dodge ? 4 : 0) | (i.rise ? 8 : 0) | (i.sink ? 16 : 0)
            | (i.hold ? 32 : 0) | (i.swap ? 64 : 0),
          q4(i.aimX), q4(i.aimZ)];
}
export function unpackInput(w) {
  return { mx: w[0], mz: w[1], jump: !!(w[2] & 1), attack: !!(w[2] & 2), dodge: !!(w[2] & 4),
           aimX: w[3], aimZ: w[4], rise: !!(w[2] & 8), sink: !!(w[2] & 16),
           hold: !!(w[2] & 32), swap: !!(w[2] & 64) };
}

/**
 * What the debug dialog changes about the simulation, in a game of two (#93).
 *
 * Only the host sets them. A switch that one side flipped alone would make the
 * two simulations disagree, and the guest would be snapped back for ever. So
 * they are the host's, sent as their own message — versioned, so a peer that
 * does not know a version ignores it rather than guessing — and numbered, so a
 * guest keeps the newest. Sent when they change and again every RULES_EVERY
 * ticks, which is the whole of their reliability: the next copy replaces a
 * lost one.
 *
 *   fly     metres a second of flight for both players, or 0
 *   fall    fall damage on for both, whatever the world's default
 *   inv     neither can be hurt
 *   pause   the simulation stands still on both machines
 *   speed   how fast time runs, which each page applies to its own clock
 *   spoils  things the host has put on the ground: [x, y, z, module], in order
 */
export const RULES_VERSION = 1;
export const RULES_EVERY = 30;
export const RULES = { v: RULES_VERSION, n: 0, fly: 0, fall: false, inv: false, pause: false, speed: 1, spoils: [] };

/** A session's rules, on an actor it steps. */
function ruleActor(a, r) {
  a.fly = r.fly || 0;
  a.fallDamage = r.fall ? true : undefined;
  a.invincible = r.inv || undefined;
}

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
/** How often, in ticks, a guest sends again a lattice change the host has not
    yet confirmed. Everything else on the wire can be lost and the next
    message covers it; a click that is lost is simply gone (#95). */
export const ACT_RESEND = 10;

function applyAct(a, m) {
  return m.k === ACT.SOCKET ? seatOn(a, m.s, m.c) : pullFrom(a, m.s);
}

/* The guest's own state goes over the wire every snapshot at full precision,
   because prediction replays from it and must land on the host's bits. Its
   thirty key names were most of what it weighed, so it goes as values in a
   fixed order, with anything not in the list riding behind in an object —
   which is what made room for a streamed world's machines (#108). */
const STATE_KEYS = ['x', 'y', 'z', 'vx', 'vy', 'vz', 'grounded', 'apex', 'airJumps', 'jumps',
  'airJumped', 'inWater', 'swimming', 'kick', 'faceX', 'faceZ', 'dead', 'hp', 'maxHp', 'hurtT',
  'stamina', 'staminaHold', 'gear', 'picked', 'swing', 'dodge', 'hits', 'ticks', 'travelled', 'blocked', 'down'];

export function packState(s) {
  const a = STATE_KEYS.map((k) => (s[k] === undefined ? null : s[k]));
  let rest = null;
  for (const k in s) if (STATE_KEYS.indexOf(k) < 0) (rest || (rest = {}))[k] = s[k];
  if (rest) a.push(rest);
  return a;
}

export function unpackState(a) {
  if (!Array.isArray(a)) return a;
  const s = {};
  for (let i = 0; i < STATE_KEYS.length; i++) s[STATE_KEYS[i]] = a[i];
  if (a.length > STATE_KEYS.length) Object.assign(s, a[STATE_KEYS.length]);
  return s;
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
  let t = 0, joined = false, seen = 0, heard = 0, starved = 0, caught = 0, stale = 0;
  /* Which guest is talking, and the newest input queued from it. A guest that
     reloads is a new guest with its count back at one; without its id the
     host would discard every input it sent as old. */
  let gid = null, newest = 0;
  /* The last lattice change applied, by the guest's own count. Each is applied
     once and in order: a repeat is ignored, and one that overtook the change
     before it waits to be sent again. */
  let acted = 0;
  let rules = Object.assign({}, RULES), once = false, beat = 0;
  const sendRules = () => transport.send(Object.assign({ t: 'rules' }, rules));

  transport.onMessage((m) => {
    if (!m || typeof m !== 'object') return;
    heard = t;
    if (m.g !== undefined && m.g !== gid) { gid = m.g; inbox.length = 0; newest = 0; acted = 0; }
    if (m.t === 'join') { joined = true; return; }
    /* The guest asking for its own lattice to change. Authority is not shared:
       it is applied here or it does not happen, and the next snapshot is how
       the guest finds out which. */
    if (m.t === 'act') {
      if (m.a === undefined) { applyAct(peer, m); return; }
      if (m.a === acted + 1) { applyAct(peer, m); acted = m.a; }
      return;
    }
    if (m.t === 'in') {
      seen++;
      /* The last few inputs, newest last. Anything already queued or applied
         is a duplicate, and anything older than that arrived out of order and
         was covered by a later message: both are dropped, so the queue is
         always in order and holds each input once. */
      const first = m.seq - m.i.length + 1;
      for (let k = 0; k < m.i.length; k++) {
        const s = first + k;
        if (s <= newest || inbox.length >= MAX_PENDING) continue;
        inbox.push({ seq: s, input: unpackInput(m.i[k]) });
        newest = s;
      }
    }
  });

  function announce() { transport.send({ t: 'hello', cfg, spawn, id: GUEST }); }
  announce();

  return {
    role: 'host', me, peer, cfg,
    get connected() { return joined; },
    /** Joined, and then silent for two seconds. */
    get lost() { return joined && t - heard > STALE; },
    get tick() { return t; },
    /** Drawn from the same data that is sent, so a gap in one shows in both. */
    get foes() { return encounter ? encounter.wire() : null; },
    /** What is still on the ground, as the bitmask that goes over the wire. */
    get loot() { return encounter && encounter.loot ? encounter.loot.wire() : 0; },

    /** This machine's own player seats a module. No wire: it is the authority. */
    act(kind, slot, carriedIndex) {
      return applyAct(me, { k: kind, s: slot, c: carriedIndex });
    },
    get stats() { return { t, joined, queued: inbox.length, inputs: seen, starved, caught, stale, quiet: t - heard }; },
    /** The rules both simulations run under (#93). Only the host has this. */
    get rules() { return rules; },
    setRules(patch) {
      rules = Object.assign({}, rules, patch, { v: RULES_VERSION, n: rules.n + 1 });
      sendRules();
      return rules;
    },
    /** Run the next tick even while paused: the dialog's single step. */
    stepOnce() { once = true; },

    /** One authoritative tick. `localInput` is this machine's own player. */
    step(localInput) {
      /* Paused, nothing moves and the clock stands, but the host still speaks:
         the rules go out, so the guest learns it is paused, and the hello
         still goes out to a guest that has not joined. */
      beat++;
      if (rules.pause && !once) {
        if (beat % RULES_EVERY === 0) { sendRules(); if (!joined) announce(); }
        return this;
      }
      once = false;
      t++;
      if (t % RULES_EVERY === 0) sendRules();
      ruleActor(me, rules); ruleActor(peer, rules);
      const quiet = t - heard > STALE;
      /* Announced until someone answers, and again whenever the answer stops:
         a guest that reloaded is waiting for a hello to grow the world from. */
      if ((!joined || quiet) && t % HELLO_EVERY === 0) announce();

      /* A starved tick repeats the last input, so a stutter keeps running. A
         partner gone quiet does not: they are stood still, not run off a cliff
         on the last direction they happened to be holding. */
      let next;
      if (inbox.length) next = inbox.shift();
      else if (quiet) { next = { seq: last.seq, input: copyInput(IDLE) }; stale++; }
      else { next = last; starved++; }
      last = next;

      step(col, me, copyInput(localInput || IDLE), targets);
      step(col, peer, next.input, targets);
      /* A queue that has grown past the jitter it is for is a guest whose
         clock runs fast: one more of its inputs this tick, in order. */
      if (inbox.length > CATCHUP) {
        last = inbox.shift(); caught++;
        step(col, peer, last.input, targets);
      }
      /* The world acts after the players do, and it is the host's world: a
         guest predicts its own movement and nothing else. */
      if (encounter) encounter.step([me, peer]);

      if (t % sendEvery === 0) {
        transport.send({
          t: 'snap', tick: t, ack: last.seq,
          /* Full state for the guest's own character, because it replays from
             it. Display state for everything it only draws. */
          you: packState(snapshot(peer)),
          them: display(me),
          foes: encounter ? packFoes(encounter.wire()) : null,
          /* Every drop in the world, as one integer — see src/sim/loot.mjs. */
          lt: encounter && encounter.loot ? encounter.loot.wire() : 0,
          /* What machines have left on the ground, while it lies there (#108). */
          sp: encounter && encounter.loot && encounter.loot.spoils.length ? encounter.loot.spoilWire() : undefined,
          /* The last lattice change applied, so the guest stops sending it. */
          ak: acted,
        });
      }
      return this;
    },
  };
}

/* ----------------------------------------------------------------- guest ---- */

/** Position and facing between two drawn states, `f` of the way from a to b.
    Facing is blended and put back to unit length; opposite facings, which
    blend to nothing, take the nearer one's. */
function blend(a, b, f) {
  const fx = a.fx + (b.fx - a.fx) * f, fz = a.fz + (b.fz - a.fz) * f;
  const l = Math.sqrt(fx * fx + fz * fz);
  const n = f < 0.5 ? a : b;
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f,
           fx: l > 1e-6 ? fx / l : n.fx, fz: l > 1e-6 ? fz / l : n.fz };
}

/**
 * `build(cfg)` is handed the host's world config and must return
 * `{ col, spawn }` — the guest grows the world itself rather than being sent
 * it. Until that happens the session is not `ready` and stepping it does
 * nothing.
 */
export function makeGuest(opts) {
  const { transport, build } = opts;
  /* Who this guest is, for the host to tell a reload from a late message. Not
     simulation state — nothing steps from it — so any source will do. */
  const gid = opts.gid !== undefined ? opts.gid : Math.floor(Math.random() * 0x7fffffff);
  let quiet = 0;
  let col = null, me = null, peer = null, cfg = null, encounter = null;
  let foes = null, lootBits = 0;
  let seq = 0, ready = false, corrections = 0, replayed = 0, lastAck = 0, hostTick = 0;
  const pending = [];
  let target = null;                       /* last authoritative host state */
  let lastYou = null;                      /* ...and the last word on us */
  /* What is only drawn — the host's character and the machines — as the last
     second or so of snapshots, stamped with the host tick each was sent at,
     and the host's clock as this end reckons it: its own tick count plus an
     offset learned from the stamps. The offset follows a *late* snapshot
     quickly and an early one slowly, so it settles on how late they have
     lately been — which is how far back the picture has to sit for the
     snapshot after the moment it draws to have arrived already. */
  const past = [];
  let local = 0, offset = null, view = null;
  /* Lattice changes asked for and not yet confirmed by a snapshot. */
  const acts = [];
  let actN = 0;
  /* The host's rules as last heard (#93), and the round trip as this end
     measures it: from sending an input to the snapshot that says the host
     applied it, in ticks, eased. */
  let rules = Object.assign({}, RULES), rtt = null;

  transport.onMessage((m) => {
    if (!m || typeof m !== 'object') return;
    quiet = 0;

    /* The host's rules. A version this end does not know is not guessed at;
       an older copy, arriving after a newer one, is not kept. */
    if (m.t === 'rules') {
      if (m.v === RULES_VERSION && m.n > rules.n) { rules = Object.assign({}, m); delete rules.t; }
      return;
    }

    if (m.t === 'hello') {
      if (ready) { transport.send({ t: 'join', g: gid }); return; }   /* a repeat beacon */
      cfg = m.cfg;
      const world = build(m.cfg);
      col = world.col;
      /* Optional, and only ever drawn: if this end derived an encounter of its
         own, the snapshots are folded into it rather than into a second list. */
      encounter = world.encounter || null;
      me = spawnNear(col, m.spawn[0], m.spawn[2]);
      peer = placeOnGround(col, m.spawn[0], m.spawn[2]);
      ready = true;
      transport.send({ t: 'join', g: gid });
      return;
    }

    /* A snapshot older than the last one arrived out of order, and one equal
       to it is a duplicate: restoring either would put the guest back in time
       and replay inputs the host has already answered. */
    if (m.t === 'snap' && ready && m.tick > hostTick) {
      /* Wholesale, not a nudge: the host's word replaces ours, and then every
         input it had not seen yet is put back on top. Skipping the replay is
         what makes a corrected client feel like it is being dragged backwards. */
      lastYou = unpackState(m.you);
      restore(me, lastYou);
      hostTick = m.tick;
      lastAck = m.ack;
      corrections++;
      for (const p of pending) if (p.seq === m.ack) {
        const sample = local - p.at;
        rtt = rtt === null ? sample : rtt + (sample - rtt) * 0.1;
        break;
      }
      while (pending.length && pending[0].seq <= m.ack) pending.shift();
      if (me) ruleActor(me, rules);
      /* Replayed without targets: movement is predicted, damage is not. A guest
         that guessed at hits would flash things the host never agreed were hit,
         which is worse than the round trip it saves. */
      for (const p of pending) { step(col, me, p.input, null); replayed++; }
      target = m.them;
      foes = unpackFoes(m.foes);
      past.push({ tick: m.tick, them: m.them, foes });
      if (past.length > PAST) past.shift();
      const sample = m.tick - local;
      if (offset === null || Math.abs(sample - offset) > 60) offset = sample;
      else offset += (sample - offset) * (sample < offset ? 0.3 : 0.01);
      lootBits = m.lt || 0;
      while (acts.length && acts[0].a <= (m.ak || 0)) acts.shift();
      if (encounter && encounter.observeWire) encounter.observeWire(foes, lootBits, m.sp || []);
    }
  });

  return {
    role: 'guest',
    get ready() { return ready; },
    get me() { return me; },
    get peer() { return peer; },
    get cfg() { return cfg; },
    get connected() { return ready; },
    /** Ready, and then two seconds without a word from the host. */
    get lost() { return ready && quiet > STALE; },
    /** The host's tick as of its last snapshot: the one clock both windows
        can agree on, which is what the sky (#30) is read from. */
    get tick() { return hostTick; },
    get stats() { return { seq, pending: pending.length, corrections, replayed, lastAck, quiet, acts: acts.length,
                           rtt: rtt === null ? null : Math.round(rtt * 10) / 10 }; },
    /** What the host has set (#93): read here, never written. */
    get rules() { return rules; },
    /** Whatever the host said was in the world, as of the moment being drawn —
        blended between the snapshots either side of it. Drawn, never stepped. */
    get foes() { return view || foes; },
    /** And what of it has been picked up, by either of them. */
    get loot() { return lootBits; },

    /** Ask the host to seat a module. It decides; the next snapshot answers. */
    act(kind, slot, carriedIndex) {
      if (!ready) return false;
      const a = { t: 'act', g: gid, a: ++actN, k: kind, s: slot, c: carriedIndex };
      acts.push(a);
      transport.send(a);
      return true;
    },
    /** The last thing the host said about us, before any replay on top of it.
        The gap between this and `me` is exactly what prediction is buying. */
    get authoritative() { return target ? lastYou : null; },

    /** One predicted tick. Sends the input, applies it locally straight away. */
    step(localInput) {
      quiet++;
      if (!ready) return this;
      /* Paused by the host: this end stands still too, sending nothing, so
         nothing is predicted that the host will not run. */
      if (rules.pause) return this;
      ruleActor(me, rules);
      if (acts.length && local % ACT_RESEND === 0) for (const a of acts) transport.send(a);
      seq++;
      const w = packInput(localInput || IDLE), input = unpackInput(w);
      pending.push({ seq, input, w, at: local });
      if (pending.length > MAX_PENDING) pending.shift();
      /* This input and the few before it, so a message lost on the way costs
         nothing as long as one of the next few arrives. */
      const from = Math.max(0, pending.length - REDUNDANT);
      transport.send({ t: 'in', g: gid, seq, i: pending.slice(from).map((p) => p.w) });
      step(col, me, input, null);

      local++;
      /* The other player and the machines arrive at 20 Hz, late by a varying
         amount, and are drawn, not simulated. So they are drawn INTERP ticks
         in the past, between the two snapshots either side of that moment:
         steady motion looks steady, whatever the wire did to when each one
         landed. Past the newest they hold rather than guess. */
      if (past.length) {
        const at = local + offset - INTERP;
        let i = past.length - 1;
        while (i > 0 && past[i].tick > at) i--;
        const a = past[i], b = past[i + 1] || a;
        const f = b === a ? 0 : Math.max(0, Math.min(1, (at - a.tick) / (b.tick - a.tick)));
        const near = f < 0.5 ? a : b;
        const t = blend(a.them, b.them, f);
        applyDisplay(peer, near.them);
        peer.x = t.x; peer.y = t.y; peer.z = t.z; peer.faceX = t.fx; peer.faceZ = t.fz;
        if (a.them.sw >= 0 && b.them.sw >= a.them.sw) peer.swing = { t: a.them.sw + (b.them.sw - a.them.sw) * f, hit: 0 };
        view = a.foes && b.foes && a.foes.length === b.foes.length
          ? a.foes.map((fa, k) => Object.assign({}, f < 0.5 ? fa : b.foes[k], blend(fa, b.foes[k], f)))
          : (near.foes || null);
      }
      return this;
    },
  };
}
