/**
 * Driving the character controller without a player.
 *
 * Four things live here, and none is part of the game: a suite of micro-worlds
 * that pin each clause of the movement budget, a five-minute soak that turns a
 * wanderer loose on a generated world and watches for it to fall through, and a
 * suite for the camera and the input table, and a pair of networked sessions
 * talking over a wire with whatever latency and loss the case calls for.
 *
 * The soak's wanderer is deliberately cautious — it turns away from magma and
 * from drops it would not survive — because the soak is asking whether the world
 * and the controller hold together, not whether an idiot can kill itself. The
 * ways to die are pinned by the budget suite instead, where they can be exact.
 */
import { V, MOVE } from '../../src/gen/constants.mjs';
import { sin, cos, hyp } from '../../src/gen/exact.mjs';
import { mulberry32, xmur3 } from '../../src/gen/rng.mjs';
import { makeCollider, colliderForWorld, LIQUID, EPS } from '../../src/sim/collider.mjs';
import { placeOnGround, step, embedded, ACTOR, TICK, RUN } from '../../src/sim/actor.mjs';
import { makeCamera, moveFrom, project, aimFromStick, aimFromPointer,
         START_YAW, QUARTER, snap } from '../../src/sim/camera.mjs';
import { makeInput, defaultBindings, ACTIONS } from '../../src/sim/input.mjs';
import { makeLoopback } from '../../src/net/transport.mjs';
import { makeHost, makeGuest } from '../../src/net/session.mjs';
import { buildWorld } from '../../src/gen/index.mjs';
import { GOLDEN_SEEDS } from './harness.mjs';

/** Five minutes, the bar in docs/PROTOTYPE.md. */
export const SOAK_TICKS = Math.round(300 / TICK);

/* ---------------------------------------------------------------- budget ---- */

const RIM = 19.9;
const slab = (c, x0, x1, top) => c.addBox(x0, x1, -3, 3, top - 2, top);

function march(col, a, ticks, jump) {
  for (let t = 0; t < ticks && !a.dead; t++) step(col, a, { mx: 1, mz: 0, jump: jump ? jump(col, a) : false });
  return a;
}

/**
 * True on the last tick before the footprint runs out of ground. A jump is
 * worth exactly MOVE.jump only if it leaves from the lip, so both the budget
 * suite and the wanderer wait for this.
 */
const atTheLip = (col, a, hx, hz) =>
  a.grounded && col.supportUnder(a.x + hx * RUN * TICK, a.z + hz * RUN * TICK,
                                 ACTOR.radius, a.y + EPS) === -Infinity;

function ledge(h) {
  const c = makeCollider(20, V);
  slab(c, -RIM, 0, 0); slab(c, 0.3, RIM, h);
  return march(c.finish(), placeOnGround(c, -3, 0), 600);
}

function gap(g) {
  const c = makeCollider(20, V);
  slab(c, -RIM, 0, 0); slab(c, g, RIM, 0);
  return march(c.finish(), placeOnGround(c, -5, 0), 900, (col, a) => atTheLip(col, a, 1, 0));
}

function drop(d) {
  const c = makeCollider(20, V);
  slab(c, -RIM, 0, d); slab(c, 0.3, RIM, 0);
  return march(c.finish(), placeOnGround(c, -3, 0), 900);
}

function pool(kind, level) {
  const c = makeCollider(20, V);
  slab(c, -RIM, RIM, 0);
  c.setLiquid(0, RIM, -3, 3, kind, level);
  return march(c.finish(), placeOnGround(c, -3, 0), 400);
}

/**
 * One assertion per clause of the budget. Each returns { label, ok, detail } so
 * that smoke.mjs can print them without knowing what any of them mean.
 */
export function budgetSuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });

  const s1 = ledge(MOVE.step);
  say(`steps ${MOVE.step} m free`, s1.y >= MOVE.step - 0.01 && s1.vaults === 0,
      `y ${s1.y.toFixed(2)}, ${s1.vaults} vaults`);

  const v1 = ledge(MOVE.vault);
  say(`vaults ${MOVE.vault} m`, v1.y >= MOVE.vault - 0.01 && v1.vaults === 1,
      `y ${v1.y.toFixed(2)}, ${v1.vaults} vaults`);

  const v2 = ledge(MOVE.vault + 0.25);
  say(`stops at ${(MOVE.vault + 0.25).toFixed(2)} m`, v2.y < 0.5, `y ${v2.y.toFixed(2)}`);

  const g1 = gap(MOVE.jump);
  say(`clears a ${MOVE.jump} m gap`, g1.dead === null && g1.x > MOVE.jump,
      `x ${g1.x.toFixed(2)}, ${g1.dead || 'alive'}`);

  const g2 = gap(MOVE.jump + 0.5);
  say(`falls into a ${MOVE.jump + 0.5} m gap`, g2.dead === 'void', g2.dead || 'crossed it');

  const d1 = drop(MOVE.fall);
  say(`survives a ${MOVE.fall} m drop`, d1.dead === null, d1.dead || 'alive');

  const d2 = drop(MOVE.fall + 0.5);
  say(`dies on ${MOVE.fall + 0.5} m`, d2.dead === 'fall', d2.dead || 'walked away');

  const w1 = pool(LIQUID.WATER, MOVE.wade);
  say(`wades ${MOVE.wade} m`, w1.inWater && !w1.swimming && w1.x > 5,
      `x ${w1.x.toFixed(2)}, ${w1.swimming ? 'swimming' : 'on foot'}`);

  const w2 = pool(LIQUID.WATER, MOVE.wade + 0.25);
  say(`swims deeper`, w2.swimming, w2.swimming ? '' : 'still walking');

  const m1 = pool(LIQUID.MAGMA, 0);
  say('magma is lethal', m1.dead === 'magma', m1.dead || 'survived it');

  return out;
}

/* ------------------------------------------------------------------ soak ---- */

/**
 * Turn a wanderer loose on a generated world for five minutes of simulated
 * time and report what happened. Seeded from the world's own seed, so the walk
 * is the same every run.
 */
export function soak(world, name, ticks = SOAK_TICKS, onTick = null) {
  const col = colliderForWorld(world);
  const rnd = mulberry32(xmur3('soak:' + name)());
  const a = placeOnGround(col, world.spawn[0], world.spawn[2]);
  const x0 = a.x, z0 = a.z;

  let hx = 1, hz = 0, hold = 0, jumps = 0, insideTicks = 0, turns = 0, sinceTurn = 99;
  let minY = a.y, maxY = a.y;

  const face = (c, s2) => {
    hx = c; hz = s2;
    hold = 30 + ((rnd() * 90) | 0);
    turns++; sinceTurn = 0;
  };
  /** A fresh direction, for when the hold timer runs out. */
  const repick = () => { const ang = rnd() * 6.283185307179586; face(cos(ang), sin(ang)); };
  /** Turn back the way it came, give or take. What a wall or a hazard gets —
      re-rolling at random can point straight back at the thing, and on a shore
      of magma that is eventually fatal. */
  const veer = () => {
    const ang = 2.094 + rnd() * 2.094;                 /* 120 to 240 degrees */
    const c = cos(ang), s2 = sin(ang);
    face(hx * c - hz * s2, hx * s2 + hz * c);
  };
  repick();

  const probe = (d) => {
    const px = a.x + hx * d, pz = a.z + hz * d;
    return {
      g: col.supportUnder(px, pz, ACTOR.radius, a.y + MOVE.step + EPS),
      liq: col.liquidAt(px, pz).kind,
    };
  };
  /* A jump commits the actor for half a second and carries it well past the
     0.7 m the walk looks ahead, so the whole arc has to be checked before
     leaving the ground. Landing in magma was how the ash seed kept dying. */
  const arcIsClear = () => {
    for (let d = 0.6; d <= MOVE.jump + 0.4; d += 0.5)
      if (probe(d).liq === LIQUID.MAGMA) return false;
    return true;
  };

  for (let t = 0; t < ticks; t++) {
    let jump = false;
    sinceTurn++;
    if (!a.vault) {
      if (--hold <= 0) repick();
      else if (a.blocked && sinceTurn > 8) veer();
      if (a.grounded) {
        const near = probe(0.7);
        /* Any drop worth not taking on foot: a step down is free, anything
           deeper is a gap to jump or a reason to turn around. Using the fall
           limit here instead meant the wanderer walked off every canyon rim it
           met and never once jumped. */
        const nothingThere = near.g === -Infinity || a.y - near.g > MOVE.step;
        /* No cooldown on a hazard turn. The cooldown exists to stop a wall
           being re-rolled every tick; applying it here let a fresh heading
           picked beside a magma pool walk straight into it before the turn
           was allowed. */
        if (near.liq === LIQUID.MAGMA) veer();
        else if (nothingThere) {
          const far = probe(MOVE.jump - 0.4);
          const jumpable = far.g !== -Infinity && far.liq !== LIQUID.MAGMA
            && Math.abs(far.g - a.y) <= MOVE.step;
          if (jumpable && arcIsClear() && atTheLip(col, a, hx, hz)) { jump = true; jumps++; }
          else veer();
        } else if (rnd() < 0.008 && arcIsClear()) {
          /* An idle hop. Generated terrain turns out to contain very few gaps
             narrow enough to need a jump - canyons are 3-5 m and the budget
             clears 2.5 - so without this the soak would never exercise the
             verb at all. */
          jump = true; jumps++;
        }
      }
    }
    step(col, a, { mx: hx, mz: hz, jump });
    if (onTick) onTick(a, t, col);
    if (a.y < minY) minY = a.y;
    if (a.y > maxY) maxY = a.y;
    if (embedded(col, a)) insideTicks++;
    if (a.dead) break;
  }

  const dx = a.x - x0, dz = a.z - z0;
  return {
    seed: name,
    ticks: a.ticks,
    survived: a.dead === null && a.ticks >= ticks,
    dead: a.dead,
    travelled: +a.travelled.toFixed(1),
    displaced: +Math.sqrt(dx * dx + dz * dz).toFixed(1),
    vaults: a.vaults, jumps, turns,
    insideTicks,
    minY: +minY.toFixed(2), maxY: +maxY.toFixed(2),
  };
}

/* ------------------------------------------------------------------ view ---- */


const VP = { w: 1200, h: 800 };
const near = (a, b, eps) => Math.abs(a - b) <= (eps === undefined ? 1e-9 : eps);

/** Screen-space displacement of one tick of a given input, at a given yaw. */
function screenStep(cam, ix, iy) {
  const m = moveFrom(cam, ix, iy);
  const a = project(cam, { x: 0, y: 0, z: 0 }, VP);
  const b = project(cam, { x: m.mx, y: 0, z: m.mz }, VP);
  return { dx: b.x - a.x, dy: b.y - a.y };
}

/**
 * The camera and the input table: the two things in #21 that are easy to get
 * subtly wrong and impossible to see in a screenshot.
 */
export function viewSuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });

  /* 1. Camera-relative movement. The whole point of a snap-rotating view is
        that "up" keeps meaning up: the world direction changes, the picture
        does not. So the screen displacement must be *identical* at all four
        steps, not merely similar. */
  const CARDINALS = [['right', 1, 0], ['up', 0, 1], ['left', -1, 0], ['down', 0, -1],
                     ['up-right', 1, 1], ['down-left', -1, -1]];
  let drift = 0, where = '';
  const ref = {};
  for (let q = 0; q < 4; q++) {
    const cam = makeCamera({ yaw: START_YAW + q * QUARTER });
    for (const [nm, ix, iy] of CARDINALS) {
      const s = screenStep(cam, ix, iy);
      if (q === 0) { ref[nm] = s; continue; }
      const d = Math.abs(s.dx - ref[nm].dx) + Math.abs(s.dy - ref[nm].dy);
      if (d > drift) { drift = d; where = `${nm} at step ${q}`; }
    }
  }
  say('movement is identical at every view step', drift < 1e-9,
      drift < 1e-9 ? '4 steps x 6 headings' : `${where} drifts ${drift.toFixed(6)} px`);

  /* 2. And it points the way the key does: right is right, up is up, and a
        cardinal never leaks into the other axis. */
  const signOk = (v, want) => (want > 0 ? v > 0.5 : (want < 0 ? v < -0.5 : near(v, 0, 1e-9)));
  let wrong = null;
  for (let q = 0; q < 4 && !wrong; q++) {
    const cam = makeCamera({ yaw: START_YAW + q * QUARTER });
    for (const [nm, ix, iy] of CARDINALS.slice(0, 4)) {
      const s = screenStep(cam, ix, iy);
      /* Screen y grows downward, so "up the screen" is a negative dy. */
      if (!signOk(s.dx, ix) || !signOk(s.dy, -iy)) { wrong = `${nm} at step ${q}`; break; }
    }
  }
  say('up is up the screen, right is right', !wrong, wrong || 'every heading, every step');

  /* 3. Snapping is exactly a quarter, and four of them come back round. */
  const c2 = makeCamera({});
  for (let q = 0; q < 4; q++) snap(c2, 1);
  say('four snaps return to the start', near(c2.yawTo - START_YAW, 2 * Math.PI, 1e-9),
      `${(c2.yawTo - START_YAW).toFixed(6)} rad`);

  /* 4. The two aiming models. A stick direction and a mouse point that mean the
        same thing have to produce the same facing — the bar in #21 — and the
        only honest way to check that is to aim with one and read back the
        other. */
  const actor = { x: 3.25, y: 2.5, z: -4.75 };
  let aimErr = 0, aimAt = '';
  for (let q = 0; q < 4; q++) {
    const cam = makeCamera({ yaw: START_YAW + q * QUARTER });
    cam.tx = actor.x - 1.5; cam.ty = actor.y + 1; cam.tz = actor.z + 2;
    for (let a = 0; a < 8; a++) {
      const th = (a / 8) * Math.PI * 2;
      const ax = Math.cos(th), ay = Math.sin(th);
      const stick = aimFromStick(cam, ax, ay);
      if (!stick) continue;
      const p = project(cam, { x: actor.x + stick.x * 5, y: actor.y, z: actor.z + stick.z * 5 }, VP);
      const mouse = aimFromPointer(cam, p.x, p.y, VP, actor);
      const d = Math.abs(mouse.x - stick.x) + Math.abs(mouse.z - stick.z);
      if (d > aimErr) { aimErr = d; aimAt = `step ${q}, ${(th * 57.3) | 0} deg`; }
    }
  }
  say('mouse and stick aim agree', aimErr < 1e-9,
      aimErr < 1e-9 ? '4 steps x 8 directions' : `${aimAt} differs by ${aimErr.toFixed(9)}`);

  /* 5. The dead zone is a dead zone, not a direction. */
  const c3 = makeCamera({});
  say('a resting stick does not aim', aimFromStick(c3, 0.05, -0.02) === null,
      aimFromStick(c3, 0.05, -0.02) ? 'it aimed' : '');

  /* 6. Bindings. Every action reachable out of the box, rebinding takes effect
        and unbinds the old key, and an edge fires once. */
  const unbound = ACTIONS.filter((a) => !(defaultBindings()[a] || []).length);
  say('every action has a default binding', unbound.length === 0, unbound.join(', '));

  const inp = makeInput();
  inp.press('Space');
  const first = inp.took('jump'), second = inp.took('jump');
  say('a press fires once, not every tick', first && !second, `${first} then ${second}`);

  inp.bind('jump', ['KeyJ']);
  inp.release('Space'); inp.press('Space');
  const stale = inp.took('jump');
  inp.press('KeyJ');
  const fresh = inp.took('jump');
  say('rebinding moves the action', !stale && fresh, `old key ${stale}, new key ${fresh}`);

  const inp2 = makeInput();
  inp2.stick(0.9, 0.9);
  inp2.press('KeyA');
  const ax2 = inp2.axes();
  say('a held key beats a drifting stick', ax2.ix === -1 && ax2.iy === 0,
      `ix ${ax2.ix}, iy ${ax2.iy}`);

  return out;
}

/* ------------------------------------------------------------------- net ---- */

const dist2 = (a, b) => hyp(a.x - b.x, a.z - b.z);

/**
 * One host and one guest on one seed, wired through a loopback with whatever
 * latency and loss the case wants. Returns both sessions plus the wire, so a
 * test can read the stats it cares about.
 */
/**
 * Host and guest each hold their own collider, built from their own copy of the
 * world — that separation is the claim, so the suite keeps it. It only builds
 * them once between them: a seed grows the same world every time, and nine
 * cases paying for eighteen generations would put the node half of the gate
 * back over the line it was split to get under.
 */
const WORLDS = new Map();
function sides(seedName) {
  if (!WORLDS.has(seedName)) {
    const cfg = GOLDEN_SEEDS.find((c) => c.nm === seedName);
    const world = buildWorld(cfg);
    WORLDS.set(seedName, {
      cfg, spawn: world.spawn,
      hostCol: colliderForWorld(world),
      guestCol: colliderForWorld(buildWorld(cfg)),
    });
  }
  return WORLDS.get(seedName);
}

function twoPlayers(seedName, wire) {
  const w = sides(seedName || 'meadow');
  const host = makeHost({ col: w.hostCol, spawn: w.spawn, transport: wire.a, cfg: w.cfg });
  const guest = makeGuest({
    transport: wire.b,
    build: () => ({ col: w.guestCol, spawn: w.spawn }),
  });
  return { host, guest, wire, col: w.hostCol };
}

/** A deterministic wander, so both players move without anyone driving them. */
function scripted(phase) {
  return (t) => {
    const a = t * 0.017 + phase;
    return { mx: cos(a), mz: sin(a), jump: t % 131 === 0 };
  };
}

function run(pair, ticks, hostIn, guestIn, onTick) {
  for (let t = 0; t < ticks; t++) {
    pair.wire.pump();
    pair.host.step(hostIn ? hostIn(t) : null);
    pair.guest.step(guestIn ? guestIn(t) : null);
    if (onTick) onTick(t);
  }
}

/** Everyone stops moving and the wire drains. Both ends must end up identical. */
function settle(pair, ticks) { run(pair, ticks || 120, () => ({}), () => ({})); }

export function netSuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });

  /* 1. The handshake, and that a world is grown rather than shipped. */
  {
    const p = twoPlayers('meadow', makeLoopback({}));
    run(p, 30, scripted(0), scripted(2));
    say('a guest joins from a seed alone', p.host.connected && p.guest.ready,
        `host ${p.host.connected ? 'joined' : 'alone'}, guest ${p.guest.ready ? 'ready' : 'waiting'}`);
  }

  /* 2. What actually crosses. Terrain is a pure function of its seed, so the
        wire should carry a seed and two characters and nothing else — checked
        by looking at every message, not by assuming. */
  {
    const wire = makeLoopback({});
    const p = twoPlayers('meadow', wire);
    const msgs = [];
    for (const side of ['a', 'b']) {
      const ep = wire[side], send = ep.send.bind(ep);
      ep.send = (m) => { msgs.push(m); return send(m); };
    }
    run(p, 600, scripted(0), scripted(2));
    const bad = [];
    for (const m of msgs) {
      for (const [k, v] of Object.entries(m)) {
        if (Array.isArray(v) && v.length > 3) bad.push(`${m.t}.${k}[${v.length}]`);
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          for (const [k2, v2] of Object.entries(v)) {
            if (Array.isArray(v2) && v2.length > 3) bad.push(`${m.t}.${k}.${k2}[${v2.length}]`);
          }
        }
      }
    }
    const kbs = wire.stat.bytes / (600 / 60) / 1024;
    say('no terrain crosses the wire', bad.length === 0, bad.slice(0, 3).join(', '));
    say('the wire stays small', kbs < 30,
        `${kbs.toFixed(1)} kB/s of JSON — a packed format is worth roughly 100x of it`);
  }

  /* 3. With a perfect wire, prediction and authority are the same thing: once
        everyone stops and the last snapshot lands, the two ends must hold
        identical state, not merely similar. Anything else is a desync. */
  {
    const p = twoPlayers('meadow', makeLoopback({}));
    run(p, 400, scripted(0), scripted(2));
    settle(p, 120);
    const d = dist2(p.guest.me, p.host.peer);
    say('a clean wire ends in agreement, exactly', d === 0 && p.guest.me.y === p.host.peer.y,
        `${d.toFixed(9)} m apart, dy ${(p.guest.me.y - p.host.peer.y).toFixed(9)}`);
  }

  /* 4. The same, over a wire worth calling a wire. */
  {
    const p = twoPlayers('meadow', makeLoopback({ latency: 6 }));
    run(p, 400, scripted(0), scripted(2));
    settle(p, 150);
    const d = dist2(p.guest.me, p.host.peer);
    say('117 ms of latency ends in agreement', d < 1e-9, `${d.toFixed(9)} m apart`);
  }

  /* 5. And over a bad one. A lost input is never re-sent — the host repeats
        what it has and the next snapshot puts the guest right. */
  {
    const p = twoPlayers('meadow', makeLoopback({ latency: 6, loss: 0.2, seed: 'lossy' }));
    run(p, 500, scripted(0), scripted(2));
    settle(p, 200);
    const d = dist2(p.guest.me, p.host.peer);
    say('a fifth of the packets lost, still no desync', d < 1e-9,
        `${d.toFixed(9)} m apart, ${p.wire.stat.dropped} dropped`);
  }

  /* 6. Prediction is not a stale snapshot with a nice name. Under latency the
        guest's own character must sit ahead of the last thing the host said
        about it, by roughly the round trip — that gap *is* the replay. */
  {
    const p = twoPlayers('meadow', makeLoopback({ latency: 6 }));
    let lead = 0;
    run(p, 300, scripted(0), scripted(2), () => {
      const a = p.guest.authoritative;
      if (a) lead = Math.max(lead, dist2(p.guest.me, a));
    });
    say('the guest leads the last word from the host', lead > 0.15 && p.guest.stats.replayed > 0,
        `${lead.toFixed(2)} m ahead, ${p.guest.stats.replayed} inputs replayed`);
  }

  /* 7. Authority. A guest whose position is wrong — cheating, a bug, a bad
        merge — is corrected, not negotiated with. */
  {
    const p = twoPlayers('meadow', makeLoopback({ latency: 2 }));
    run(p, 120, scripted(0), scripted(2));
    const before = { x: p.host.peer.x, z: p.host.peer.z };
    p.guest.me.x += 40; p.guest.me.z -= 40;
    run(p, 40, scripted(0), scripted(2));
    const pulled = dist2(p.guest.me, p.host.peer);
    const hostMoved = dist2(p.host.peer, before);
    say('the host is authoritative', pulled < 0.5 && hostMoved < 5,
        `guest pulled back to ${pulled.toFixed(2)} m; host never saw the jump (${hostMoved.toFixed(2)} m)`);
  }

  /* 8. The point of all of it: each of them can see the other move. */
  {
    const p = twoPlayers('meadow', makeLoopback({ latency: 4 }));
    run(p, 10, scripted(0), scripted(2));          /* let the handshake finish */
    const g0 = { x: p.guest.peer.x, z: p.guest.peer.z };
    const h0 = { x: p.host.peer.x, z: p.host.peer.z };
    /* Furthest reached, not where they ended up: the scripted walk is a circle,
       so after a full turn both are back where they started and a displacement
       test would say nobody moved. */
    let sawHost = 0, sawGuest = 0;
    run(p, 400, scripted(0), scripted(2), () => {
      sawHost = Math.max(sawHost, dist2(p.guest.peer, g0));
      sawGuest = Math.max(sawGuest, dist2(p.host.peer, h0));
    });
    say('each player sees the other move', sawHost > 2 && sawGuest > 2,
        `guest saw ${sawHost.toFixed(1)} m, host saw ${sawGuest.toFixed(1)} m`);
  }

  return out;
}
