/**
 * Driving the character controller without a player.
 *
 * Six things live here, and none is part of the game: a suite of micro-worlds
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
import { placeOnGround, step, embedded, snapshot, restore, ACTOR, TICK, RUN } from '../../src/sim/actor.mjs';
import { makeCamera, moveFrom, project, aimFromStick, aimFromPointer,
         START_YAW, QUARTER, snap } from '../../src/sim/camera.mjs';
import { makeInput, defaultBindings, ACTIONS } from '../../src/sim/input.mjs';
import * as CB from '../../src/sim/combat.mjs';
import * as EN from '../../src/sim/enemy.mjs';
import * as LT from '../../src/sim/lattice.mjs';
import * as LO from '../../src/sim/loot.mjs';
import { makeLoopback } from '../../src/net/transport.mjs';
import { makeHost, makeGuest, ACT } from '../../src/net/session.mjs';
import { buildWorld, makeGen } from '../../src/gen/index.mjs';
import { regionAt, clearRegionCache } from '../../src/gen/region.mjs';
import { meshChunk } from '../../src/mesh/greedy.mjs';
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
    const hostCol = colliderForWorld(world), guestCol = colliderForWorld(buildWorld(cfg));
    WORLDS.set(seedName, {
      cfg, world, spawn: world.spawn, hostCol, guestCol,
      /* Derived on each side from its own world, never sent. If the two ends
         disagreed about where the posts are, a swing would land on one and not
         the other and the exact-agreement tests would say so. */
      hostTargets: CB.practicePosts(hostCol, world.spawn),
      guestTargets: CB.practicePosts(guestCol, world.spawn),
    });
  }
  return WORLDS.get(seedName);
}

function twoPlayers(seedName, wire, withFoes) {
  const w = sides(seedName || 'meadow');
  /* Fresh every time: the machines in it die, and a suite that shared them
     would be testing whatever the previous case left standing. */
  const encounter = withFoes ? EN.makeEncounter(w.hostCol, w.world, w.hostTargets) : null;
  const host = makeHost({ col: w.hostCol, spawn: w.spawn, transport: wire.a, cfg: w.cfg,
                          targets: encounter ? encounter.targets : w.hostTargets, encounter });
  const guest = makeGuest({
    transport: wire.b,
    build: () => ({ col: w.guestCol, spawn: w.spawn }),
  });
  return { host, guest, wire, col: w.hostCol, encounter };
}

/**
 * A deterministic wander, so both players move without anyone driving them —
 * swinging and dodging on the way, which is how the combat state gets dragged
 * through snapshot, restore and replay rather than only the position.
 */
function scripted(phase) {
  return (t) => {
    const a = t * 0.017 + phase;
    return { mx: cos(a), mz: sin(a),
             jump: t % 131 === 0, attack: t % 73 === 0, dodge: t % 109 === 0 };
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

  /* 8b. And swing. Combat state is part of the actor, so it rides the same
         snapshot and the same replay — if it did not, a guest would watch its
         own sword pass through nothing on the host's copy. */
  {
    const p = twoPlayers('meadow', makeLoopback({ latency: 5 }));
    run(p, 20, null, null);
    let hostSawSwing = 0, hostSawDodge = 0;
    run(p, 400, scripted(0), scripted(2), () => {
      if (p.host.peer.swing) hostSawSwing++;
      if (p.host.peer.dodge) hostSawDodge++;
    });
    settle(p, 150);
    say('a swing on one machine happens on the other', hostSawSwing > 30 && hostSawDodge > 10,
        `${hostSawSwing} ticks swinging, ${hostSawDodge} dodging, as the host saw it`);

    /* Stamina is the one thing that does *not* end up equal, and should not:
       it is still moving while position has settled, so the guest — predicting
       a round trip ahead — reads a little higher. That lead is the invariant
       worth pinning. Asserting equality here would be asserting that prediction
       had stopped working. */
    const lead = p.guest.me.stamina - p.host.peer.stamina;
    const roundTrip = CB.STAMINA_REGEN * (5 + 4) * TICK;
    say('stamina leads by a round trip and no more', lead >= 0 && lead <= roundTrip,
        `guest is ${lead.toFixed(2)} ahead, a round trip is worth ${roundTrip.toFixed(2)}`);
  }

  /* 8c. The world is the host's. A guest is sent what the machines look like
         and simulates none of it — so if the host's copy stops moving, so does
         the guest's, and if the host kills one it is dead on both. */
  {
    const p = twoPlayers('meadow', makeLoopback({ latency: 4 }), true);
    run(p, 40, scripted(0), scripted(2));
    const sawFoes = (p.guest.foes || []).length;
    const first = p.encounter.enemies[0];
    /* Reach over and kill one the way a hit would. */
    first.hp = 0; first.dead = 'struck';
    run(p, 60, scripted(0), scripted(2));
    const guestFoe = (p.guest.foes || [])[0];
    say('the guest is sent the machines and simulates none of them',
        sawFoes === p.encounter.enemies.length && !!guestFoe,
        `${sawFoes} of ${p.encounter.enemies.length}`);
    say('a machine the host killed is dead on the guest too',
        !!guestFoe && guestFoe.h === 0 && guestFoe.s === EN.EST.DEAD,
        guestFoe ? `hp ${guestFoe.h}, state ${guestFoe.s}` : 'no machine arrived');
  }

  /* 8d. And the wire still fits, with three machines in it. */
  {
    const wire = makeLoopback({});
    const p = twoPlayers('meadow', wire, true);
    run(p, 600, scripted(0), scripted(2));
    const kbs = wire.stat.bytes / (600 / 60) / 1024;
    say('three machines on the wire still fit the budget', kbs < 30,
        `${kbs.toFixed(1)} kB/s with two players and ${p.encounter.enemies.length} machines`);
  }

  /* 8e. Gear is not an input, so it takes the other path: a guest asks, the
         host decides, and the snapshot is the answer. What has to hold is that
         the answer arrives and that both ends then agree, because `step` reads
         the lattice and a replay against the wrong one lands nowhere real. */
  {
    const p = twoPlayers('meadow', makeLoopback({ latency: 5 }));
    run(p, 40, scripted(0), scripted(2));
    /* The host is where a module would arrive from — it owns pickups too. */
    LT.takeModule(p.host.peer.gear, LT.MOD.SIGIL);
    run(p, 20, scripted(0), scripted(2));
    const carried = p.guest.me.gear.carried.slice();
    p.guest.act(ACT.SOCKET, 1, 0);
    run(p, 40, scripted(0), scripted(2));
    settle(p, 60);
    const hostSeated = p.host.peer.gear.slots[1] === LT.MOD.SIGIL;
    const guestSeated = p.guest.me.gear.slots[1] === LT.MOD.SIGIL;
    const d = dist2(p.guest.me, p.host.peer);
    say('a lattice the guest changes is the host\'s to apply, and then both agree',
        carried.length === 1 && hostSeated && guestSeated && d < 1e-9,
        `carried ${carried.length}, host ${hostSeated ? 'seated' : 'EMPTY'}, ` +
        `guest ${guestSeated ? 'seated' : 'EMPTY'}, ${d.toFixed(9)} m apart`);
    say('and the reach it grants crossed with it',
        Math.abs(p.guest.me.st.reach - p.host.peer.st.reach) < 1e-12
          && p.guest.me.st.reach > CB.REACH,
        `${p.guest.me.st.reach} m on the guest, ${p.host.peer.st.reach} m on the host`);
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

/* ---------------------------------------------------------------- combat ---- */

/** A flat floor and an actor standing on it, facing +x. */
function arena() {
  const c = makeCollider(20, V);
  c.addBox(-19.9, 19.9, -19.9, 19.9, -2, 0);
  c.finish();
  const a = placeOnGround(c, 0, 0);
  a.faceX = 1; a.faceZ = 0;
  return { col: c, a };
}
const FACE = { mx: 0, mz: 0, aimX: 1, aimZ: 0 };
const swing = () => Object.assign({ attack: true }, FACE);
const hold = () => Object.assign({}, FACE);

/** Run `n` ticks of the same input and hand back the phases seen, in order. */
function phaseTrace(col, a, n, input, targets) {
  const seen = [];
  for (let t = 0; t < n; t++) {
    step(col, a, t === 0 ? input : hold(), targets);
    const p = CB.phase(a);
    if (!seen.length || seen[seen.length - 1][0] !== p) seen.push([p, 1]);
    else seen[seen.length - 1][1]++;
  }
  return seen;
}

/**
 * The first combat verb. Issue #23 is explicit that none of these numbers are
 * balance — what is being pinned is the *shape*: that a swing is committed,
 * that it costs something, and that the arc is an arc rather than a circle.
 */
export function combatSuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });
  const ticks = (sec) => Math.round(sec / TICK);

  /* 1. Three windows, in order, for as long as they say. */
  {
    const { col, a } = arena();
    const trace = phaseTrace(col, a, ticks(CB.SWING_TIME) + 4, swing());
    const order = trace.map((p) => p[0]).join(',');
    const want = [CB.PHASE.WINDUP, CB.PHASE.ACTIVE, CB.PHASE.RECOVER, CB.PHASE.NONE].join(',');
    say('a swing runs wind-up, active, recovery', order === want, order);
    const active = (trace.find((p) => p[0] === CB.PHASE.ACTIVE) || [0, 0])[1];
    say('the active window is the short one',
        active > 0 && active <= ticks(CB.ACTIVE) + 1 && active < ticks(CB.WINDUP),
        `${active} ticks of ${ticks(CB.SWING_TIME)}`);
  }

  /* 2. Committed. Not "slowed" — during the active window you go nowhere, and
        you cannot cancel into a jump or a vault either. */
  {
    const { col, a } = arena();
    step(col, a, swing());
    let windup = 0, activeMoved = 0, recover = 0, x = a.x;
    for (let t = 1; t < ticks(CB.SWING_TIME); t++) {
      const before = a.x;
      step(col, a, Object.assign({ mx: 1 }, FACE, { mx: 1 }));
      const d = a.x - before;
      const p = CB.phase(a);
      if (p === CB.PHASE.WINDUP) windup += d;
      else if (p === CB.PHASE.ACTIVE) activeMoved += d;
      else recover += d;
    }
    const free = RUN * TICK;
    say('the active window pins you in place', Math.abs(activeMoved) < 1e-9,
        `${activeMoved.toFixed(6)} m`);
    say('wind-up and recovery cost speed, not all of it',
        windup > 0 && recover > 0 && windup < ticks(CB.WINDUP) * free * 0.6
          && recover < ticks(CB.RECOVER) * free * 0.8,
        `${windup.toFixed(2)} m of wind-up, ${recover.toFixed(2)} m of recovery`);
  }

  /* 3. Stamina is the reason a swing is a decision. */
  {
    const { col, a } = arena();
    const before = a.stamina;
    step(col, a, swing());
    say('a swing costs stamina', a.stamina === before - CB.SWING_COST,
        `${before} → ${a.stamina}`);

    a.stamina = CB.SWING_COST - 1; a.swing = null; a.staminaHold = 0;
    step(col, a, swing());
    say('an empty pool refuses the swing', a.swing === null, a.swing ? 'it swung anyway' : '');
  }

  /* 4. ...and it comes back on a delay, so it cannot be drip-fed. */
  {
    const { col, a } = arena();
    step(col, a, swing());
    const spent = a.stamina;
    for (let t = 0; t < ticks(CB.STAMINA_HOLD) - 2; t++) step(col, a, hold());
    const held = a.stamina;
    for (let t = 0; t < ticks(1); t++) step(col, a, hold());
    say('stamina waits, then comes back', held === spent && a.stamina > spent + 20,
        `${spent.toFixed(0)} held to ${held.toFixed(0)}, then ${a.stamina.toFixed(0)}`);
  }

  /* 5. An arc, not a circle: in front is cut, behind is not, and reach is what
        it says on the frame. */
  {
    const { col, a } = arena();
    const targets = [
      { x: 1.2, y: a.y, z: 0, r: 0 },        /* in front, inside reach   */
      { x: -1.2, y: a.y, z: 0, r: 0 },       /* behind                   */
      { x: 0, y: a.y, z: 1.2, r: 0 },        /* square on, outside 100°  */
      { x: CB.REACH + 0.8, y: a.y, z: 0, r: 0 }, /* in front, too far    */
    ];
    let mask = 0;
    step(col, a, swing(), targets);
    for (let t = 1; t < ticks(CB.SWING_TIME); t++) { step(col, a, hold(), targets); mask |= a.hits; }
    say('the arc cuts what is in front of it', (mask & 1) !== 0, `mask ${mask}`);
    say('and nothing behind or beyond', (mask & ~1) === 0,
        ['behind', 'to the side', 'out of reach'].filter((_, i) => mask & (2 << i)).join(', ') || '');
  }

  /* 6. Once per swing. A three-tick active window is not three hits. */
  {
    const { col, a } = arena();
    const targets = [{ x: 1.0, y: a.y, z: 0, r: 0 }];
    let hits = 0;
    step(col, a, swing(), targets);
    for (let t = 1; t < ticks(CB.SWING_TIME) + 2; t++) {
      step(col, a, hold(), targets);
      if (a.hits) hits++;
    }
    say('a target is cut once per swing', hits === 1, `${hits} hits`);
  }

  /* 7. The dodge: a distance, not a nudge, and it costs. */
  {
    const { col, a } = arena();
    const x0 = a.x, st0 = a.stamina;
    step(col, a, Object.assign({ dodge: true }, FACE));
    let n = 1;
    while (a.dodge) { step(col, a, hold()); n++; }
    const d = a.x - x0;
    say('a dodge covers the distance it claims',
        Math.abs(d - CB.DODGE_DIST) < CB.DODGE_DIST * 0.12,
        `${d.toFixed(2)} m of ${CB.DODGE_DIST} in ${n} ticks`);
    say('a dodge costs stamina', st0 - a.stamina >= CB.DODGE_COST, `${st0 - a.stamina}`);
  }

  /* 8. The invulnerability ends before the dodge does — the tail is where a
        dodge is punished, and without it the verb has no downside. */
  {
    const { col, a } = arena();
    step(col, a, Object.assign({ dodge: true }, FACE));
    let inv = 0, total = 0;
    while (a.dodge) { if (CB.invulnerable(a)) inv++; total++; step(col, a, hold()); }
    say('invulnerability ends before the dodge does', inv > 0 && inv < total,
        `${inv} of ${total} ticks`);
  }

  /* 9. A dodge is the way out of a recovery, and the way out of nothing else. */
  {
    const { col, a } = arena();
    step(col, a, swing());
    for (let t = 1; CB.phase(a) !== CB.PHASE.ACTIVE; t++) step(col, a, hold());
    step(col, a, Object.assign({ dodge: true }, FACE));
    const duringActive = !a.dodge;
    while (CB.phase(a) !== CB.PHASE.RECOVER && a.swing) step(col, a, hold());
    a.stamina = CB.STAMINA_MAX; a.staminaHold = 0;
    step(col, a, Object.assign({ dodge: true }, FACE));
    const duringRecovery = !!a.dodge && a.swing === null;
    say('a dodge cancels recovery but never the swing itself',
        duringActive && duringRecovery,
        `${duringActive ? 'active held' : 'ACTIVE CANCELLED'}, ` +
        `${duringRecovery ? 'recovery cancelled' : 'recovery stuck'}`);
  }

  return out;
}

/* ----------------------------------------------------------------- enemy ---- */

/** A flat arena with one sentry in it and a player facing it. */
function duel(gap) {
  const c = makeCollider(20, V);
  c.addBox(-19.9, 19.9, -19.9, 19.9, -2, 0);
  c.finish();
  const p = placeOnGround(c, 0, 0);
  p.faceX = 1; p.faceZ = 0;
  const e = EN.makeSentry(c, gap === undefined ? 4 : gap, 0);
  return { col: c, p, e, targets: [e] };
}

/** Step both, with the player holding still and facing the machine. */
function watch(d, ticks, playerInput, onTick) {
  for (let t = 0; t < ticks; t++) {
    const dx = d.e.x - d.p.x, dz = d.e.z - d.p.z, l = hyp(dx, dz) || 1;
    const inp = Object.assign({ aimX: dx / l, aimZ: dz / l },
                              playerInput ? playerInput(t, d) : null);
    step(d.col, d.p, inp, d.targets);
    CB.applyHits(d.p, d.targets, CB.SWING_DAMAGE);
    EN.stepSentry(d.col, d.e, [d.p]);
    if (onTick) onTick(t);
    if (d.p.dead || d.e.dead) break;
  }
  return d;
}

/** Run until the machine is in `state`, or give up. */
function until(d, state, cap) {
  let n = 0;
  while (d.e.ai.state !== state && n < (cap || 2000)) { watch(d, 1); n++; }
  return n < (cap || 2000);
}

/**
 * One enemy that closes, telegraphs, swings and dies — issue #24. The telegraph
 * is the part that matters: from 45 degrees you see the top of things, and a
 * wind-up you cannot read is a fight you cannot learn.
 */
export function enemySuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });
  const ticks = (sec) => Math.round(sec / TICK);

  /* 1. It stands on the world like anything else does. */
  {
    const d = duel();
    say('a sentry spawns standing on the ground',
        d.e.grounded && !embedded(d.col, d.e) && d.e.hp === EN.SENTRY.hp,
        `y ${d.e.y.toFixed(2)}, ${d.e.hp} hp`);
  }

  /* 2. It notices, closes, and gets into range under its own steam. */
  {
    const d = duel(9);
    const start = hyp(d.e.x - d.p.x, d.e.z - d.p.z);
    let floated = 0;
    watch(d, 600, null, () => { if (!d.e.grounded && d.e.vy === 0) floated++; });
    const end = hyp(d.e.x - d.p.x, d.e.z - d.p.z);
    say('it closes the distance on foot', end < start - 5 && floated === 0,
        `${start.toFixed(1)} m to ${end.toFixed(1)} m, ${floated} ticks hovering`);
  }

  /* 3. The telegraph: a window before anything can hurt you, and nothing lands
        during it. This is the assertion the whole issue is about. */
  {
    const d = duel(3);
    const ok = until(d, EN.EST.TELEGRAPH);
    const hpAtTell = d.p.hp;
    let hurtDuringTell = false;
    let n = 0;
    while (d.e.ai.state === EN.EST.TELEGRAPH && n < 200) {
      watch(d, 1);
      /* The tick that ends the tell is the tick the strike opens on, and the
         blow lands inside it — so only count damage that arrived while the
         machine was still winding up. */
      if (d.e.ai.state === EN.EST.TELEGRAPH && d.p.hp < hpAtTell) hurtDuringTell = true;
      n++;
    }
    say('it telegraphs, and the telegraph is the long part',
        ok && !hurtDuringTell && n >= ticks(EN.TELEGRAPH_TIME) - 1 && n > ticks(EN.STRIKE_TIME) * 3,
        `${n} ticks of tell, ${ticks(EN.STRIKE_TIME)} of strike`);
  }

  /* 4. And then it actually hits you. */
  {
    const d = duel(2.0);
    const before = d.p.hp;
    until(d, EN.EST.STRIKE);
    watch(d, 4);
    say('the strike lands on someone standing in it', d.p.hp === before - EN.SENTRY.damage,
        `${before} → ${d.p.hp}`);
  }

  /* 5. The one that matters for #23: dodge through it and it costs nothing.
        Not "less" — nothing, because the dodge's invulnerability is the whole
        reason the verb exists. */
  {
    const d = duel(2.0);
    until(d, EN.EST.TELEGRAPH);
    const before = d.p.hp;
    let dodged = false;
    watch(d, 200, (t, dd) => {
      /* Dodge just before the blow, so the i-frames cover the strike tick. */
      if (!dodged && dd.e.ai.state === EN.EST.TELEGRAPH
          && EN.TELEGRAPH_TIME - dd.e.ai.t <= CB.DODGE_IFRAMES * 0.5) {
        dodged = true;
        return { dodge: true, mx: -1, mz: 0 };
      }
      return null;
    }, () => {});
    say('a dodge through the strike costs nothing', dodged && d.p.hp === before,
        dodged ? `${before} → ${d.p.hp}` : 'never got the timing');
  }

  /* 6. The opening. A recovery longer than a whole player swing is the
        difference between "you survived" and "you got something for it". */
  {
    const d = duel(2.0);
    until(d, EN.EST.RECOVER);
    let n = 0;
    while (d.e.ai.state === EN.EST.RECOVER && n < 300) { watch(d, 1); n++; }
    say('the recovery is long enough to punish', n >= ticks(CB.SWING_TIME),
        `${n} ticks of opening, a whole swing is ${ticks(CB.SWING_TIME)}`);
  }

  /* 7. It dies, in the number of hits the numbers say, and stays dead. */
  {
    const d = duel(1.3);
    const want = Math.ceil(EN.SENTRY.hp / CB.SWING_DAMAGE);
    let landed = 0;
    watch(d, 2000, (t, dd) => {
      const l = hyp(dd.e.x - dd.p.x, dd.e.z - dd.p.z);
      return l > 1.3 ? { mx: (dd.e.x - dd.p.x) / l, mz: (dd.e.z - dd.p.z) / l }
                     : { attack: !dd.p.swing };
    }, () => { if (d.p.hits) landed++; });
    const restedAt = { x: d.e.x, z: d.e.z };
    watch(d, 120);
    say('it dies in the hits the numbers say, and stays dead',
        d.e.dead === 'struck' && landed === want
          && hyp(d.e.x - restedAt.x, d.e.z - restedAt.z) < 1e-9,
        `${landed} hits of ${want}, ${d.e.dead || 'alive'}`);
  }

  /* 8. It is heavy: it does not pull itself over a ledge the way a player can.
        Going *around* is #15's navigation graph; not walking up a wall is this
        issue's problem, and is the half that would look like a bug. */
  {
    const c = makeCollider(20, V);
    c.addBox(-19.9, 0, -6, 6, -2, 0);
    c.addBox(0.3, 19.9, -6, 6, -2, MOVE.vault);     /* a ledge a player vaults */
    c.finish();
    const p = placeOnGround(c, 6, 0);                /* up on the ledge */
    const e = EN.makeSentry(c, -3, 0);
    let sidestepped = false;
    for (let t = 0; t < 900; t++) {
      EN.stepSentry(c, e, [p]);
      if (e.ai.sideT > 0) sidestepped = true;
      if (e.vaults > 0) break;
    }
    say('a sentry does not vault, it goes around',
        e.vaults === 0 && e.y < MOVE.vault - 0.1 && sidestepped,
        `${e.vaults} vaults, y ${e.y.toFixed(2)}, ${sidestepped ? 'stepped aside' : 'pressed into it'}`);
  }

  /* 9. A hit interrupts a machine that has not committed yet — but never one
        that has, which is the same rule the player plays by. */
  {
    const d = duel(2.0);
    until(d, EN.EST.CLOSE);
    const enc = { targets: d.targets };
    EN.jolt(d.e);
    const staggered = d.e.ai.state === EN.EST.STAGGER;
    until(d, EN.EST.STRIKE);
    EN.jolt(d.e);
    const heldThrough = d.e.ai.state === EN.EST.STRIKE;
    say('a hit staggers it, unless it has already committed', staggered && heldThrough,
        `${staggered ? 'staggered' : 'shrugged'}, ${heldThrough ? 'held the strike' : 'STRIKE CANCELLED'}`);
  }

  return out;
}

/* ------------------------------------------------------------------ gear ---- */

/** A flat arena, an actor on it, and a target a fixed distance in front. */
function bench() {
  const c = makeCollider(20, V);
  c.addBox(-19.9, 19.9, -19.9, 19.9, -2, 0);
  c.finish();
  const a = placeOnGround(c, 0, 0);
  a.faceX = 1; a.faceZ = 0;
  return { col: c, a };
}

/** Seat `mod` in `slot` directly, the way a pickup and a socket would. */
function seat(a, slot, mod) {
  LT.takeModule(a.gear, mod);
  LT.socketModule(a.gear, slot, a.gear.carried.length - 1);
  a.st = a.gear.st;
  a.maxHp = a.st.maxHp;
  return a;
}

/**
 * Modules, sockets, fusion and loot — the spine of progression (§4).
 *
 * Same terms as combat: none of these numbers are balance. What is pinned is
 * the shape — that a lattice is adjacency and not a list, that knowledge is
 * something you go and get, and that what is on the ground is derived rather
 * than sent.
 */
export function gearSuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });

  /* 1. An empty frame plays exactly the game that was here before it. */
  {
    const g = LT.makeGear();
    const b = CB.baseStats();
    const drift = Object.keys(b).filter((k) => g.st[k] !== b[k]);
    say('an empty lattice is exactly the numbers in combat.mjs',
        drift.length === 0 && g.slots.length === 4 && LT.FRAMES[g.frame].edges.length === 5,
        drift.length ? drift.join(', ')
                     : `${g.slots.length} sockets, ${LT.FRAMES[g.frame].edges.length} edges`);
  }

  /* 2. Carried is not equipped. The lattice is the only thing that plays. */
  {
    const { a } = bench();
    const before = a.st.reach;
    LT.takeModule(a.gear, LT.MOD.SIGIL);
    const carried = a.gear.st.reach;
    LT.socketModule(a.gear, 0, 0);
    a.st = a.gear.st;
    say('a module in the pack does nothing; the same module in a socket does',
        carried === before && a.st.reach > before + 0.4 && a.gear.carried.length === 0,
        `${before} m carried ${carried} m, seated ${a.st.reach} m`);
  }

  /* 3. ...and it reaches what it says it reaches, through the same sweep the
        blade always used. This is the end of the wire, not a stat readout. */
  {
    const far = { x: CB.REACH + 0.35, y: 0, z: 0, r: 0 };
    const bare = bench(), kit = bench();
    seat(kit.a, 0, LT.MOD.SIGIL);
    let bareHit = 0, kitHit = 0;
    for (const [w, tally] of [[bare, 'bare'], [kit, 'kit']]) {
      const t = [{ x: far.x, y: w.a.y, z: 0, r: 0 }];
      step(w.col, w.a, { mx: 0, mz: 0, aimX: 1, aimZ: 0, attack: true }, t);
      for (let q = 1; q < 80; q++) {
        step(w.col, w.a, { mx: 0, mz: 0, aimX: 1, aimZ: 0 }, t);
        if (w.a.hits) { if (tally === 'bare') bareHit++; else kitHit++; }
      }
    }
    say('a sigil cuts what the bare blade cannot reach', bareHit === 0 && kitHit === 1,
        `bare ${bareHit} hits at ${far.x.toFixed(2)} m, with the sigil ${kitHit}`);
  }

  /* 4. Fusion wants both halves of its bargain: a shared edge *and* the recipe
        for it. Either alone is two modules sitting next to each other. */
  {
    const near = LT.makeGear();                    /* slots 0 and 1 share an edge */
    LT.takeModule(near, LT.MOD.GOVERNOR); LT.socketModule(near, 0, 0);
    LT.takeModule(near, LT.MOD.KEEN); LT.socketModule(near, 1, 0);
    const unlearned = near.fused.length;
    /* Sitting on a fusion you have not found yet is the thing that is supposed
       to send you looking, so the lattice has to be able to say so. */
    const latent = LT.latentFusions(near);
    LT.learnFusion(near, LT.FUS.REGULATED);
    const learned = near.fused.length;
    const spent = LT.latentFusions(near).length;

    const apart = LT.makeGear();                   /* slots 0 and 3 do not */
    apart.known = (1 << LT.FUS.REGULATED);
    LT.takeModule(apart, LT.MOD.GOVERNOR); LT.socketModule(apart, 0, 0);
    LT.takeModule(apart, LT.MOD.KEEN); LT.socketModule(apart, 3, 0);

    say('a fusion needs a shared edge and a recipe, and takes neither on trust',
        unlearned === 0 && learned === 1 && apart.fused.length === 0
          && near.st.damage > apart.st.damage,
        `unlearned ${unlearned}, learned ${learned}, not adjacent ${apart.fused.length}, `
        + `${near.st.damage} damage against ${apart.st.damage}`);
    say('and an adjacency you cannot yet close is visible as one',
        latent.length === 1 && latent[0] === LT.FUS.REGULATED && spent === 0
          && LT.latentFusions(apart).length === 0,
        `${latent.length} latent before the recipe, ${spent} after, `
        + `${LT.latentFusions(apart).length} across a non-edge`);
  }

  /* 5. The three schools never combined, so two of a kind never fuse — however
        good each of them is on its own. */
  {
    const g = LT.makeGear();
    g.known = 0x3f;                                /* every recipe there is */
    LT.takeModule(g, LT.MOD.GOVERNOR); LT.socketModule(g, 0, 0);
    LT.takeModule(g, LT.MOD.SERVO); LT.socketModule(g, 1, 0);
    const cross = FUSIONS_CROSS();
    say('same-tradition neighbours never fuse', g.fused.length === 0 && cross,
        `${g.fused.length} fusions from two tech modules, `
        + `${cross ? 'every recipe crosses' : 'A RECIPE DOES NOT CROSS'}`);
  }

  /* 6. Limited carried slots, stash at camp — and there is no camp. */
  {
    const g = LT.makeGear();
    let took = 0;
    for (let i = 0; i < LT.CARRY + 3; i++) if (LT.takeModule(g, LT.MOD.KEEN)) took++;
    say('the pack is limited, and says no rather than dropping something',
        took === LT.CARRY && g.carried.length === LT.CARRY, `${took} of ${LT.CARRY + 3} taken`);
  }

  /* 7. A machine leaves the discipline it was built from where it fell, and it
        is picked up once — by whoever was standing there. */
  {
    const { col, a } = bench();
    const field = LO.makeLootField(col, { spawn: [0, 0, 0], lamps: [], lmPos: null }, 1);
    const machine = { x: 6, y: a.y, z: 0 };
    const early = field.collect([a]).length;
    field.drop(0, machine);
    const away = field.collect([a]).length;
    a.x = machine.x; a.z = machine.z;
    const got = field.collect([a]);
    const again = field.collect([a]).length;
    say('a fallen machine leaves its discipline on the ground, taken once',
        early === 0 && away === 0 && got.length === 1 && again === 0
          && a.gear.carried.length === 1,
        `before it fell ${early}, standing off it ${away}, on it ${got.length}, again ${again}`);
  }

  /* 8. A cache is knowledge, and knowledge is somewhere you have to go. Derived
        from the world on both machines, which is why none of it is sent. */
  {
    const w = sides('meadow');
    const mine = LO.cacheSites(w.hostCol, w.world);
    const theirs = LO.cacheSites(w.guestCol, w.world);
    const same = JSON.stringify(mine) === JSON.stringify(theirs);
    let nearest = Infinity, grounded = true;
    for (const c of mine) {
      nearest = Math.min(nearest, hyp(c.x - w.spawn[0], c.z - w.spawn[2]));
      if (!Number.isFinite(c.y)) grounded = false;
    }
    say('caches are derived from the world, identically on both machines',
        mine.length > 0 && same && grounded,
        `${mine.length} caches, ${same ? 'identical' : 'DIFFERENT'}`);
    /* And somewhere the budget can actually get to. A cache on a ruin's roof
       is a cache nobody collects, and the generator's reach flood is the only
       thing that knows the difference. */
    let unreachable = 0;
    for (const c of mine) {
      const ai = Math.round(c.x + w.world.half), bj = Math.round(c.z + w.world.half);
      if (!w.world.reach[ai * w.world.M + bj]) unreachable++;
    }
    say('and every one of them is a walk away, on ground the budget can reach',
        mine.length > 0 && nearest >= 9 && unreachable === 0,
        `nearest is ${Number.isFinite(nearest) ? nearest.toFixed(1) : '-'} m, `
        + `${unreachable} out of reach`);

    /* And what is in one is a module *and* the recipe that makes it worth
       more than a module — the whole reason the landmark is worth the walk. */
    const { a } = bench();
    const before = a.gear.known;
    const field = LO.makeLootField(w.hostCol, w.world, 0);
    const c0 = field.caches[0];
    a.x = c0.x; a.y = c0.y; a.z = c0.z;
    const got = field.collect([a]);
    say('a cache holds a module and the recipe that makes two of them worth more',
        got.length === 1 && got[0].fus >= 0 && a.gear.carried.length === 1
          && a.gear.known !== before,
        got.length ? `${LT.MODULES[got[0].mod].name} and ${LT.FUSIONS[got[0].fus].name}`
                   : 'nothing was there');
  }

  /* 9. The lattice has to survive the round trip, or a guest replays its inputs
        against numbers the host never had. */
  {
    const { a } = bench();
    seat(a, 0, LT.MOD.GOVERNOR);
    seat(a, 1, LT.MOD.KEEN);
    LT.learnFusion(a.gear, LT.FUS.REGULATED);
    a.st = a.gear.st;
    LT.takeModule(a.gear, LT.MOD.BLOOM);
    const b = placeOnGround(bench().col, 0, 0);
    restore(b, snapshot(a));
    const fields = ['damage', 'maxStamina', 'swingCost', 'reach', 'recover', 'speed'];
    const drift = fields.filter((k) => a.st[k] !== b.st[k]);
    say('a lattice survives snapshot and restore, fusions and all',
        drift.length === 0 && b.gear.fused.length === 1
          && b.gear.carried.length === 1 && b.gear.known === a.gear.known,
        drift.length ? drift.join(', ')
                     : `${b.gear.fused.length} fusion, ${b.gear.carried.length} carried`);
  }

  /* 10. And it is paid for. A module that makes the swing cheaper has to make
         the swing cheaper, through the same stamina pool as everything else. */
  {
    const bare = bench(), kit = bench();
    seat(kit.a, 0, LT.MOD.THEW);
    step(bare.col, bare.a, { mx: 0, mz: 0, aimX: 1, aimZ: 0, attack: true });
    step(kit.col, kit.a, { mx: 0, mz: 0, aimX: 1, aimZ: 0, attack: true });
    const cheap = (CB.STAMINA_MAX - kit.a.stamina) < (CB.STAMINA_MAX - bare.a.stamina);
    say('a module that says it is cheaper is cheaper, out of the same pool',
        cheap && kit.a.swing !== null,
        `${(CB.STAMINA_MAX - bare.a.stamina).toFixed(0)} stamina bare, `
        + `${(CB.STAMINA_MAX - kit.a.stamina).toFixed(0)} with the cord`);
  }

  return out;
}

/** Every recipe joins two different traditions. The rule, checked rather than
    trusted: a same-tradition recipe would make case 5 above pass by accident. */
function FUSIONS_CROSS() {
  for (const f of LT.FUSIONS) {
    if (LT.MODULES[f.pair[0]].trad === LT.MODULES[f.pair[1]].trad) return false;
  }
  return true;
}

/* ---------------------------------------------------------------------------
 * REGION — two views of the same ground agree.
 *
 * Issue #16's bar, stated as it states it: "two separately generated adjacent
 * chunks agree on every trail, crossing, site and landmark that crosses their
 * boundary."
 *
 * The method is the only one that can prove it: build the same world twice at
 * different window offsets and compare what they say about the ground they
 * share. Everything is converted to world coordinates first, because that is
 * the only frame in which the two windows are talking about the same place.
 *
 * This is what could not have passed before. The old generator chose its sites,
 * routed its trails and picked its landmark inside whatever window it happened
 * to be filling, and erosion drew from a stream that depended on how much of
 * the window had already been walked — so the same square metre had a different
 * height depending on where the window started.
 * ------------------------------------------------------------------------- */

/** World coordinate to cell index in a window built at (ox, oz), or -1. */
function cellAtWorld(w, ox, oz, x, z) {
  const i = x - ox + w.half, j = z - oz + w.half;
  if (i < 0 || j < 0 || i > w.M - 1 || j > w.M - 1) return -1;
  return i * w.M + j;
}

export function regionSuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });
  const SEED = 'QUARTERSTONE', SIZE = 64;

  /* Three offsets, so the overlap is not always the same shape: one chunk
     apart, two chunks apart, and a diagonal that crosses a region corner. */
  const pairs = [[[0, 0], [32, 0]], [[0, 0], [64, 0]], [[0, 0], [32, 32]]];
  let compared = 0, hBad = 0, tBad = 0;
  const featureBad = [];

  for (const [[ax, az], [bx, bz]] of pairs) {
    const A = buildWorld({ seed: SEED, size: SIZE, force: null, ox: ax, oz: az });
    const B = buildWorld({ seed: SEED, size: SIZE, force: null, ox: bx, oz: bz });

    const lo = (a, b) => Math.max(a - SIZE / 2, b - SIZE / 2);
    const hi = (a, b) => Math.min(a + SIZE / 2, b + SIZE / 2);
    for (let x = lo(ax, bx); x <= hi(ax, bx); x++) {
      for (let z = lo(az, bz); z <= hi(az, bz); z++) {
        const ia = cellAtWorld(A, ax, az, x, z), ib = cellAtWorld(B, bx, bz, x, z);
        if (ia < 0 || ib < 0) continue;
        compared++;
        if (A.cells[ia].H !== B.cells[ib].H) hBad++;
        if (A.trail[ia] !== B.trail[ib]) tBad++;
      }
    }

    /* Features, in world coordinates, restricted to the ground both can see. */
    const seen = (w, ox, oz, x, z) => cellAtWorld(w, ox, oz, x, z) >= 0;
    const sitesOf = (w, ox, oz) => w.sites.map(([i, j]) => [i - w.half + ox, j - w.half + oz]);
    const bridgesOf = (w, ox, oz) => w.bridges.map((b) => [b[0] + ox, b[1] + oz, b[2], b[3], b[4], b[5]]);
    const shared = (list, other, oox, ooz) =>
      list.filter(([x, z]) => seen(other, oox, ooz, Math.round(x), Math.round(z)))
        .map((v) => v.map((n) => +(+n).toFixed(4)).join(',')).sort();

    const sA = shared(sitesOf(A, ax, az), B, bx, bz), sB = shared(sitesOf(B, bx, bz), A, ax, az);
    if (sA.join('|') !== sB.join('|')) featureBad.push(`sites ${ax},${az} vs ${bx},${bz}`);
    const bA = shared(bridgesOf(A, ax, az), B, bx, bz), bB = shared(bridgesOf(B, bx, bz), A, ax, az);
    if (bA.join('|') !== bB.join('|')) featureBad.push(`crossings ${ax},${az} vs ${bx},${bz}`);

    /* A landmark both windows can see must be the same landmark. */
    const lmOf = (w, ox, oz) => (w.lmPos ? [w.lmPos[0] + ox, w.lmPos[1], w.lmPos[2] + oz] : null);
    const la = lmOf(A, ax, az), lb = lmOf(B, bx, bz);
    if (la && lb && seen(B, bx, bz, Math.round(la[0]), Math.round(la[2]))
        && seen(A, ax, az, Math.round(lb[0]), Math.round(lb[2]))) {
      if (la.map((v) => +v.toFixed(4)).join(',') !== lb.map((v) => +v.toFixed(4)).join(',')) {
        featureBad.push(`landmark ${ax},${az} vs ${bx},${bz}`);
      }
    }
  }

  say('overlapping windows agree on the ground between them',
      hBad === 0, `${compared} cells compared, ${hBad} height mismatches`);
  say('and on where the trail runs across it',
      tBad === 0, `${tBad} trail mismatches over ${compared} cells`);
  say('and on the sites, crossings and landmarks they can both see',
      featureBad.length === 0,
      featureBad.length ? featureBad.join('; ') : 'every shared feature identical');

  /* ---- the voxels themselves (issue #41) ----------------------------------
     Agreeing on heights and on where the trail runs is the region pass. This
     is the rest of it: two windows onto the same ground must emit the same
     voxels, the same props and the same grass, down to the shade of each box.

     MARGIN is a measured number, not a guess. A stamp is placed from its
     anchor cell and reaches past it — a canopy, a wall run, the arms of a
     landmark — and it reads the surface through a lookup that clamps at the
     window edge, so a band around the rim is wrong in any window and right in
     its neighbour. Sweeping seven seeds and six offsets, 4 m is clean over 2.4
     million voxels and 3 m fails by eight. That band is exactly the skirt
     chunk streaming (#13) will have to generate and discard. */
  const MARGIN = 4;
  const voxPairs = [[[0, 0], [16, 0]], [[0, 0], [16, 16]], [[0, 0], [32, 32]]];
  const fx = (n) => (+n).toFixed(4);
  let voxBad = 0, voxSeen = 0, grassBad = 0, grassSeen = 0, capped = 0;

  for (const [[ax, az], [bx, bz]] of voxPairs) {
    const A = buildWorld({ seed: SEED, size: SIZE, force: null, ox: ax, oz: az });
    const B = buildWorld({ seed: SEED, size: SIZE, force: null, ox: bx, oz: bz });
    capped += (A.capped || 0) + (B.capped || 0);
    const x0 = Math.max(ax, bx) - SIZE / 2 + MARGIN, x1 = Math.min(ax, bx) + SIZE / 2 - MARGIN;
    const z0 = Math.max(az, bz) - SIZE / 2 + MARGIN, z1 = Math.min(az, bz) + SIZE / 2 - MARGIN;
    const inBox = (x, z) => x >= x0 && x <= x1 && z >= z0 && z <= z1;

    /* A voxel is its place, its palette entry, its shade and its material —
       the whole record. Colour left that record in issue #28; comparing the
       index and the shade byte is comparing strictly more than the three
       floats did, because two entries can resolve to the same colour. */
    const voxOf = (w, ox, oz) => {
      const out = [];
      for (let i = 0; i < w.pos.length; i += 3) {
        const x = w.pos[i] + ox, z = w.pos[i + 2] + oz;
        if (!inBox(x, z)) continue;
        out.push([fx(x), fx(w.pos[i + 1]), fx(z),
                  w.pal[i / 3], w.shd[i / 3], w.mat[i / 3]].join(','));
      }
      return out.sort();
    };
    /* A blade is its place and every attribute the renderer instances it with,
       the per-biome dry colour included (issue #39). */
    const grassOf = (w, ox, oz) => {
      const g = w.grass, out = [];
      for (let i = 0; i < g.ph.length; i++) {
        const x = g.p[i * 3] + ox, z = g.p[i * 3 + 2] + oz;
        if (!inBox(x, z)) continue;
        out.push([fx(x), fx(g.p[i * 3 + 1]), fx(z), fx(g.ph[i]), g.ti[i],
                  fx(g.sc[i]), fx(g.yw[i]), fx(g.c[i * 3]), fx(g.dc[i * 3])].join(','));
      }
      return out.sort();
    };
    const diff = (a, b) => {
      const sa = new Set(a), sb = new Set(b);
      return a.filter((k) => !sb.has(k)).length + b.filter((k) => !sa.has(k)).length;
    };
    const va = voxOf(A, ax, az), vb = voxOf(B, bx, bz);
    voxSeen += va.length; voxBad += diff(va, vb);
    const ga = grassOf(A, ax, az), gb = grassOf(B, bx, bz);
    grassSeen += ga.length; grassBad += diff(ga, gb);
  }

  say('and on every voxel and prop between them',
      voxBad === 0, `${voxSeen} voxels compared, ${voxBad} mismatches (${MARGIN} m skirt)`);
  say('and on every blade of grass, dry ones included',
      grassBad === 0, `${grassSeen} blades compared, ${grassBad} mismatches`);
  /* The per-window prop budgets are inert at every size the generator is run
     at. The day one bites, a prop's existence starts depending on how much
     world you are looking at, and this is the assertion that says so. */
  say('no prop was dropped by a per-window budget',
      capped === 0, capped ? `${capped} props suppressed by a cap` : 'no cap bit');

  /* The pass is pure, not merely cached: a second generator built from the same
     seed string is a different object and must still answer the same. */
  {
    const G1 = makeGen(SEED, null), G2 = makeGen(SEED, null);
    const r1 = regionAt(G1, 3, -2);
    /* Without this the cache answers, and the test proves only that a Map
       returns what was put in it. */
    clearRegionCache();
    const r2 = regionAt(G2, 3, -2);
    const shape = (r) => JSON.stringify({
      sites: r.sites, bridges: r.bridges, landmark: r.landmark,
      trail: [...r.trail].sort(), grade: [...r.grade.entries()].sort(),
    });
    say('a region is the same wherever it is asked from',
        shape(r1) === shape(r2) && r1 !== r2,
        `${r1.trail.size} trail cells, ${r1.grade.size} graded, ${r1.bridges.length} crossings`);
  }

  return out;
}

/* ------------------------------------------------------------------ mesh ----
 * Issue #12. The box renderer draws six faces per emitted voxel whether or not
 * anything can see them; the mesher draws the volume's exposed surface, merged.
 * The claims worth pinning are the ratio, that a seam does not double-draw or
 * tear, and that the same world meshes the same way twice.
 * ------------------------------------------------------------------------- */

export function meshSuite() {
  const out = [];
  const say = (label, ok, detail) => out.push({ label, ok, detail });
  const w = buildWorld({ seed: 'QUARTERSTONE', size: 64, force: null, ox: 0, oz: 0 });

  const chunks = [];
  let quads = 0, faces = 0, aoBad = 0, shapeBad = 0;
  for (let cx = 0; cx < 2; cx++) {
    for (let cz = 0; cz < 2; cz++) {
      const m = meshChunk(w, cx, cz);
      chunks.push(m); quads += m.quads; faces += m.faces;
      if (m.pos.length !== m.quads * 12 || m.nor.length !== m.quads * 12
          || m.mat.length !== m.quads * 4 || m.ao.length !== m.quads * 4
          || m.idx.length !== m.quads * 6) shapeBad++;
      for (let i = 0; i < m.ao.length; i++) if (!(m.ao[i] >= 0 && m.ao[i] <= 3)) aoBad++;
    }
  }

  const boxes = (w.pos.length / 3) * 6;
  say('a meshed chunk draws far less than a box per voxel',
      quads > 0 && boxes / quads > 5,
      `${boxes} box faces, ${faces} exposed, ${quads} quads after merging `
      + `— ${(boxes / quads).toFixed(1)}x fewer, ${(faces / quads).toFixed(2)}x from the merge alone`);

  say('every quad is four vertices, four corners of occlusion and six indices',
      shapeBad === 0 && aoBad === 0,
      shapeBad ? `${shapeBad} chunks with mismatched arrays` : `${quads} quads, occlusion within 0..3`);

  /* A face is a place and a direction. Two chunks emitting the same one would
     draw it twice; the pad ring exists so the boundary is culled against the
     neighbour rather than against nothing. */
  const seen = new Set();
  let dup = 0;
  for (const m of chunks) {
    for (let q = 0; q < m.quads; q++) {
      const v = q * 12;
      const k = [m.pos[v], m.pos[v + 1], m.pos[v + 2],
                 m.nor[v], m.nor[v + 1], m.nor[v + 2]].join(',');
      if (seen.has(k)) dup++; else seen.add(k);
    }
  }
  say('and no face is drawn by two chunks at once',
      dup === 0, dup ? `${dup} duplicated at a seam` : `${seen.size} distinct faces across four chunks`);

  const again = meshChunk(w, 0, 0);
  const first = chunks[0];
  const same = again.quads === first.quads
    && again.pos.every((v, i) => v === first.pos[i])
    && again.mat.every((v, i) => v === first.mat[i])
    && again.ao.every((v, i) => v === first.ao[i]);
  say('and meshing the same chunk twice gives the same mesh',
      same, `${again.quads} quads`);

  return out;
}
