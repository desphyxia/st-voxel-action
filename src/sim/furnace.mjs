/**
 * The furnace, run (#7, docs/DECISIONS.md §6): what happens in the arena that
 * src/gen/site.mjs lays out as ground.
 *
 * One state machine, the host's, stepped once a tick by the encounter:
 *
 *   SEALED  the gate is a plug until a player at it carries a seated fusion
 *           of the tech school, on either frame
 *   OPEN    the gate is a gap; the first player inside starts the guardian's
 *           stir, and when it ends the gate closes behind them
 *   FIGHT   the guardian: four moves, a new one at each quarter of its health,
 *           a beat between that changes the arena
 *   CORE    it is down, and the core shuts down while someone stands at it,
 *           with the site's machines coming in waves meanwhile
 *   DONE    the furnace is dark, and its scar's machines go quiet
 *
 * A wipe — nobody on their feet — opens the gate again and heals the guardian.
 * What the fight has done to the floor holds: a gate opened stays open, a
 * guardian's death stays, and the core's progress is kept.
 *
 * The guardian is a *target*, not a machine: it stands in the encounter's
 * list of things a swing can hit, as a practice post does, with the few
 * numbers a swing and a tether read (`r`, `hp`, `weight`, `invincible`). It
 * has no archetype in the roster and no wire record of a machine's; what
 * crosses the network is `wire()`, the run's own small record.
 *
 * Every number here is a first value, and the guardian's health is an
 * estimate from the pacing in the record, not a decision. No randomness: the
 * seed picks the order the moves arrive in, and everything after is a clock.
 */
import { hyp, sin, cos } from '../gen/exact.mjs';
import { ARENA_R, CORE_AT, CORE_R, BOOST_R } from '../gen/site.mjs';
import { hurt } from './combat.mjs';
import { TRAD, opensGate, fusionsOfSchool } from './lattice.mjs';
import { onFeet } from './revive.mjs';
import { REST_R } from './approach.mjs';

/** The run's stages. */
export const FSTAGE = { SEALED: 0, OPEN: 1, FIGHT: 2, CORE: 3, DONE: 4 };
/** The guardian's moves, in the order a seed may unlock them. */
export const FMOVE = { SLAM: 0, VOLLEY: 1, VENT: 2, SUMMON: 3 };
/** What a mark on the ground is: a wedge in front of the guardian, a ring on a
    player, a vent that will erupt and burn. */
export const FMARK = { WEDGE: 0, RING: 1, VENT: 2 };

export const FURNACE = {
  /** How near the gate a player must stand for it to read what they carry. */
  gateReach: 5,
  /** Seconds a player inside the arena, past the gate, before the guardian wakes. */
  stir: 4,
  /** The guardian: health (an estimate: five minutes at about nine damage a
      second a player, §6), its body's radius, its walk, and the beat between phases. */
  hp: 2000, rad: 2.4, speed: 3.0, beat: 2.5,
  /** Hit points of a party of two, as for every machine (§6). */
  party: 1.15,
  /** A heavy blow, and what standing in a burning vent costs each half second. */
  big: 25, burn: 4, burnTick: 0.5,
  /** The moves' clocks, in seconds: the tell, then the opening it leaves. */
  slam: { tell: 1.0, open: 2.5, reach: 5.0, cosArc: 0.5 },
  volley: { tell: 1.3, second: 0.4, open: 2.2, ring: 1.8 },
  vent: { tell: 1.4, open: 2.0, ring: 2.6, burn: 4.0, count: 3 },
  summon: { open: 3.0, cap: 3, count: 2 },
  /** A breath between one move's end and the next. */
  gap: 0.6,
  /** The core: seconds a player must stand at it, the wave's spacing and size,
      and how many of the site's machines may stand at once. */
  hold: 120, wave: 20, waveSize: 2, waveCap: 5,
};

/**
 * Does a door stop a body? The door is an oriented slab (`gen/site.mjs`): the
 * body's circle is tested against it grown by the radius, in the door's own
 * frame, and its height against the slab's.
 */
export function doorBlocks(d, x, z, r, lo, hi) {
  if (hi < d.y0 || lo > d.y1) return false;
  const dx = x - d.x, dz = z - d.z;
  const along = dx * d.ux + dz * d.uz, across = -dx * d.uz + dz * d.ux;
  return Math.abs(along) <= d.ht + r && Math.abs(across) <= d.hw + r;
}

/**
 * Give a collider a layer of doors, in place: wherever it is asked whether
 * something is solid, a shut door answers first. A door is what ground cannot
 * be, which is shut and then not, and every end of the game asks the same
 * collider, so a guest predicting its own walk meets the same door the host
 * does. Idempotent.
 */
export function installDoors(col) {
  if (!col || col.doors) return col;
  const was = col.overlaps;
  col.doors = [];
  col.overlaps = function (x, z, r, lo, hi) {
    for (let i = 0; i < col.doors.length; i++) {
      const d = col.doors[i];
      if (d.shut && doorBlocks(d.box, x, z, r, lo, hi)) return true;
    }
    return was.call(col, x, z, r, lo, hi);
  };
  col.setDoor = function (box, shut) {
    for (const d of col.doors) if (d.box === box) { d.shut = !!shut; return; }
    col.doors.push({ box, shut: !!shut });
  };
  return col;
}

/** The guardian's health thresholds, as shares of its most: a new move at each. */
const PHASES = [0.75, 0.5, 0.25];

/** The order the seed unlocks the moves in: a slam or a volley opens it, and
    never a summons alone. A fixed sequence from the site's place. */
function unlockOrder(S) {
  let h = (Math.imul(S.cx | 0, 73856093) ^ Math.imul(S.cz | 0, 19349663)) >>> 0;
  const next = () => { h = (Math.imul(h, 1664525) + 1013904223) >>> 0; return h / 4294967296; };
  const first = next() < 0.5 ? FMOVE.SLAM : FMOVE.VOLLEY;
  const rest = [FMOVE.SLAM, FMOVE.VOLLEY, FMOVE.VENT, FMOVE.SUMMON].filter((m) => m !== first);
  for (let i = rest.length - 1; i > 0; i--) { const j = (next() * (i + 1)) | 0; const t = rest[i]; rest[i] = rest[j]; rest[j] = t; }
  return [first, ...rest];
}

/**
 * Make the run for a site. `ctx` is what the encounter lends it: `spawn(kind,
 * x, z)` puts a machine of a kind in the arena and returns it (or null),
 * `kinds` names the ones it may use, `drop(key, thing)` lays a spoil, `calm(x,
 * z, r)` quiets the machines in a circle, and `alive(list)` counts the ones of
 * `list` still standing.
 */
export function makeFurnaceRun(S, ctx) {
  const F = FURNACE, order = unlockOrder(S);
  const cx = S.cx, cz = S.cz, ux = S.ux, uz = S.uz, hf = S.hf;
  const home = { x: cx - ux * 5, z: cz - uz * 5 };
  const R = ARENA_R - F.rad - 0.4;
  const kx = S.core.x, kz = S.core.z;

  const run = {
    stage: FSTAGE.SEALED,
    /** Seconds the stir has run, and what opened the gate (a player's index, for the page). */
    stirT: 0, openedBy: -1,
    /** The core's progress in seconds, and the wave clock. */
    hold: 0, waveT: 0, waves: 0,
    /** The guardian, once it has been woken; null before. */
    g: null,
    /** How the arena's hazard stands: one more at each phase. */
    hazard: 0,
    marks: [],
    spawned: [],
    wipes: 0,
    /** Has anyone walked up to the rest stone? Then it is where a respawn goes. */
    rest: false,
  };

  const standing = (players) => players.filter((p) => onFeet(p));
  const inArena = (p, slack) => hyp(p.x - cx, p.z - cz) <= ARENA_R + (slack || 0) && Math.abs(p.y - hf) < 3.5;

  /** The guardian as a target: what a swing and a tether read. */
  function makeGuardian(party) {
    const mh = F.hp * (party > 1 ? F.party : 1);
    return {
      guardian: true, x: home.x, y: hf, z: home.z, r: F.rad, rad: F.rad,
      hp: mh, maxHp: mh, dead: null, weight: 2, hurtT: 0, reserve: false,
      trad: TRAD.TECH, id: -9000,
      faceX: ux, faceZ: uz,
      /* The clock: a state, the seconds in it, and the move it is on. */
      st: 'wake', t: 0, move: -1, n: 0, phase: 0,
      invincible: false,
      aim: null,
    };
  }

  /** Where a respawn goes once the rest stone has been walked up to, or null. */
  run.restSpot = () => (run.rest && S.rest ? S.rest : null);

  /** The glyph on the gate: the fusions that would open it. */
  run.glyph = () => fusionsOfSchool(TRAD.TECH);

  /** Is the plug out of the gate? Open until the fight, and after it. */
  run.gateOpen = () => run.stage === FSTAGE.OPEN || run.stage === FSTAGE.CORE || run.stage === FSTAGE.DONE;

  /* ---------------------------------------------------------------- moves -- */

  /** The marks that are only warnings go; a vent that is burning stays until it is out. */
  function clearMarks() { run.marks = run.marks.filter((m) => m.burning > 0); }

  function startMove(g, who) {
    const unlocked = order.slice(0, g.phase + 1);
    let m = unlocked[g.n % unlocked.length];
    g.n++;
    /* A summons that cannot be made (they are all still up) is a volley. */
    if (m === FMOVE.SUMMON && ctx.alive(run.spawned) >= F.summon.cap) m = unlocked.find((x) => x !== FMOVE.SUMMON) ?? FMOVE.SLAM;
    g.move = m; g.t = 0;
    clearMarks();
    const target = nearest(g, who);
    if (m === FMOVE.SLAM) {
      g.st = target && hyp(target.x - g.x, target.z - g.z) > F.slam.reach + 1.5 ? 'close' : 'tell';
      if (g.st === 'tell') aimAt(g, target);
    } else if (m === FMOVE.VOLLEY) {
      g.st = 'tell';
      who.forEach((p, i) => run.marks.push({ k: FMARK.RING, x: p.x, z: p.z, r: F.volley.ring, at: F.volley.tell + i * F.volley.second, born: 0, who: i }));
    } else if (m === FMOVE.VENT) {
      g.st = 'tell';
      who.forEach((p) => run.marks.push({ k: FMARK.VENT, x: p.x, z: p.z, r: F.vent.ring, at: F.vent.tell, born: 0 }));
      const extra = F.vent.count - who.length;
      for (let q = 0; q < extra; q++) {
        /* The rest where the floor is least likely to be safe: a ring round
           the middle of the room, turned a little each time. */
        const a = (g.n * 2.1 + q * 2.3), rr = 6 + 4 * ((q + g.n) % 2);
        run.marks.push({ k: FMARK.VENT, x: cx + rr * cos(a), z: cz + rr * sin(a), r: F.vent.ring, at: F.vent.tell, born: 0 });
      }
    } else {
      g.st = 'open'; g.t = 0;
      for (let q = 0; q < F.summon.count && ctx.alive(run.spawned) < F.summon.cap; q++) {
        const a = 1.0 + q * 2.1 + g.n, e = ctx.spawn(q % 2 ? ctx.kinds.hound : ctx.kinds.sentry, cx + 15 * cos(a), cz + 15 * sin(a));
        if (e) run.spawned.push(e);
      }
    }
  }

  function aimAt(g, p) {
    if (!p) return;
    const dx = p.x - g.x, dz = p.z - g.z, l = hyp(dx, dz) || 1;
    g.faceX = dx / l; g.faceZ = dz / l;
    clearMarks();
    run.marks.push({ k: FMARK.WEDGE, x: g.x, z: g.z, r: F.slam.reach, at: F.slam.tell, born: 0, fx: g.faceX, fz: g.faceZ });
  }

  function nearest(g, who) {
    let best = null, bd = Infinity;
    for (const p of who) { const d = hyp(p.x - g.x, p.z - g.z); if (d < bd) { bd = d; best = p; } }
    return best;
  }

  /** The strike of the move, once its tell has run. */
  function strike(g, who) {
    const big = F.big;
    if (g.move === FMOVE.SLAM) {
      for (const p of who) {
        const dx = p.x - g.x, dz = p.z - g.z, d = hyp(dx, dz);
        if (d <= F.slam.reach + 0.5 && d > 0 && (dx * g.faceX + dz * g.faceZ) / d >= F.slam.cosArc) hurt(p, big, 'struck');
      }
    } else if (g.move === FMOVE.VOLLEY) {
      /* Each ring lands on its own clock, so the strike is the mark's, below. */
    } else if (g.move === FMOVE.VENT) {
      /* Ditto: each vent erupts, and burns. */
    }
  }

  /** Marks that are due: a ring or a vent whose clock has run lands. */
  function landMarks(g, who, dt) {
    for (const m of run.marks) {
      if (m.k === FMARK.WEDGE) continue;
      const was = m.born; m.born += dt;
      if (was < m.at && m.born >= m.at) {
        for (const p of who) if (hyp(p.x - m.x, p.z - m.z) <= m.r) hurt(p, F.big, 'struck');
        m.landed = true;
        if (m.k === FMARK.VENT) { m.burning = F.vent.burn; m.tick = 0; }
      }
      if (m.burning > 0) {
        m.burning -= dt; m.tick += dt;
        while (m.tick >= F.burnTick) {
          m.tick -= F.burnTick;
          for (const p of who) if (hyp(p.x - m.x, p.z - m.z) <= m.r) hurt(p, F.burn, 'struck');
        }
      }
    }
    /* A ring that has landed is spent, and so is a vent that has burned out. */
    run.marks = run.marks.filter((m) => m.k === FMARK.WEDGE || !m.landed || m.burning > 0);
  }

  /* ------------------------------------------------------------ the fight -- */

  function stepGuardian(players, dt) {
    const g = run.g, who = standing(players).filter((p) => inArena(p, 1));
    if (g.hurtT > 0) g.hurtT = Math.max(0, g.hurtT - dt);
    g.t += dt;
    landMarks(g, who, dt);

    /* A new phase at each quarter, and a beat in which the arena changes. */
    if (g.st !== 'beat' && g.phase < PHASES.length && g.hp <= g.maxHp * PHASES[g.phase]) {
      g.phase++; run.hazard = g.phase; g.st = 'beat'; g.t = 0; g.invincible = true; clearMarks();
      return;
    }
    if (g.st === 'beat') {
      if (g.t >= F.beat) { g.invincible = false; g.st = 'gap'; g.t = 0; }
      return;
    }
    if (g.st === 'wake') { if (g.t >= 1.5) { g.st = 'gap'; g.t = 0; } return; }
    if (g.st === 'gap') { if (g.t >= F.gap && who.length) startMove(g, who); return; }
    if (g.st === 'close') {
      const p = nearest(g, who);
      if (!p) { g.st = 'gap'; g.t = 0; return; }
      const dx = p.x - g.x, dz = p.z - g.z, d = hyp(dx, dz) || 1;
      g.faceX = dx / d; g.faceZ = dz / d;
      if (d > F.slam.reach - 0.5 && g.t < 3) {
        const step = Math.min(F.speed * dt, d - (F.slam.reach - 1));
        g.x += g.faceX * step; g.z += g.faceZ * step;
        const rr = hyp(g.x - cx, g.z - cz);
        if (rr > R) { g.x = cx + (g.x - cx) * R / rr; g.z = cz + (g.z - cz) * R / rr; }
      } else { g.st = 'tell'; g.t = 0; aimAt(g, p); }
      return;
    }
    if (g.st === 'tell') {
      const tell = g.move === FMOVE.SLAM ? F.slam.tell : g.move === FMOVE.VOLLEY ? F.volley.tell + (who.length > 1 ? F.volley.second : 0) : F.vent.tell;
      if (g.t >= tell) {
        strike(g, who);
        g.st = 'open'; g.t = 0;
      }
      return;
    }
    if (g.st === 'open') {
      const open = g.move === FMOVE.SLAM ? F.slam.open : g.move === FMOVE.VOLLEY ? F.volley.open : g.move === FMOVE.VENT ? F.vent.open : F.summon.open;
      if (g.t >= open) { g.st = 'gap'; g.t = 0; if (g.move === FMOVE.SLAM || g.move === FMOVE.SUMMON) clearMarks(); }
    }
  }

  /* ---------------------------------------------------------------- the run -- */

  function wipe() {
    run.wipes++;
    clearMarks();
    if (run.stage === FSTAGE.FIGHT) {
      run.stage = FSTAGE.OPEN; run.stirT = 0; run.hazard = 0;
      ctx.release(run.g);
      run.g = null;
    }
  }

  run.step = function (players, dt) {
    advance(players, dt);
    ctx.door(!run.gateOpen());
  };

  function advance(players, dt) {
    const live = players.filter((p) => p);
    const up = standing(live);
    if (!run.rest && S.rest) for (const p of up) if (hyp(p.x - S.rest.x, p.z - S.rest.z) <= REST_R) run.rest = true;

    if (run.stage === FSTAGE.SEALED) {
      for (let i = 0; i < live.length; i++) {
        const p = live[i];
        if (!onFeet(p) || hyp(p.x - S.gate.x, p.z - S.gate.z) > F.gateReach) continue;
        if (opensGate(p.gear, TRAD.TECH)) { run.stage = FSTAGE.OPEN; run.openedBy = i; break; }
      }
      return;
    }

    if (run.stage === FSTAGE.OPEN) {
      /* The stir runs while someone stands inside, past the gate. */
      const inside = up.some((p) => inArena(p, -2) && hyp(p.x - S.gate.x, p.z - S.gate.z) > 5);
      run.stirT = inside ? run.stirT + dt : Math.max(0, run.stirT - dt);
      if (run.stirT >= F.stir) {
        run.stage = FSTAGE.FIGHT;
        run.g = makeGuardian(live.length);
        ctx.hold(run.g);
      }
      return;
    }

    if (run.stage === FSTAGE.FIGHT) {
      if (!up.some((p) => inArena(p, 1))) { wipe(); return; }
      if (run.g.hp <= 0) {
        run.g.dead = 'struck'; run.g.st = 'dead'; clearMarks();
        ctx.drop(run.g.id, run.g);
        ctx.release(run.g);
        run.stage = FSTAGE.CORE; run.waveT = 0;
        return;
      }
      stepGuardian(live, dt);
      return;
    }

    if (run.stage === FSTAGE.CORE) {
      const at = up.filter((p) => hyp(p.x - kx, p.z - kz) <= CORE_R + 1.5);
      if (at.length) {
        run.hold += dt; run.waveT += dt;
        if (run.waveT >= F.wave) {
          run.waveT -= F.wave; run.waves++;
          const n = F.waveSize + (live.length > 1 ? 1 : 0);
          for (let q = 0; q < n && ctx.alive(run.spawned) < F.waveCap; q++) {
            const a = 1.9 * (q % 2 ? -1 : 1) + q * 0.35 + run.waves, kind = [ctx.kinds.sentry, ctx.kinds.hound, ctx.kinds.mortar][(run.waves + q) % 3];
            const e = ctx.spawn(kind, cx + (ARENA_R - 4) * cos(a), cz + (ARENA_R - 4) * sin(a));
            if (e) run.spawned.push(e);
          }
        }
        if (run.hold >= F.hold) {
          run.stage = FSTAGE.DONE;
          ctx.calm(cx, cz, BOOST_R);
        }
      }
      return;
    }
  }

  /** The run as it crosses the wire: only when there is something to say. */
  run.wire = function () {
    if (run.stage === FSTAGE.SEALED && !run.rest) return null;
    const r2 = (v) => Math.round(v * 100) / 100;
    const o = { s: run.stage, hz: run.hazard };
    if (run.rest) o.rf = 1;
    if (run.stage === FSTAGE.OPEN && run.stirT > 0) o.sr = r2(run.stirT);
    if (run.stage >= FSTAGE.CORE) o.hd = r2(run.hold);
    if (run.stage === FSTAGE.CORE) o.wv = run.waves;
    const g = run.g;
    if (g && run.stage === FSTAGE.FIGHT) {
      o.g = { x: r2(g.x), z: r2(g.z), fx: Math.round(g.faceX * 10) / 10, fz: Math.round(g.faceZ * 10) / 10,
              h: r2(g.hp), mh: r2(g.maxHp), p: g.phase, s: g.st, t: r2(g.t), m: g.move };
      if (g.hurtT > 0) o.g.u = r2(g.hurtT);
      if (g.invincible) o.g.iv = 1;
      if (run.marks.length) o.mk = run.marks.map((m) => [m.k, r2(m.x), r2(m.z), r2(m.r), r2(m.at), r2(m.born), m.k === FMARK.WEDGE ? m.fx : (m.burning > 0 ? 1 : 0), m.k === FMARK.WEDGE ? m.fz : 0]);
    }
    return o;
  };

  /** A guest's copy: take the host's record as it stands. */
  run.observe = function (w) {
    if (!w) return;
    run.rest = !!w.rf;
    run.stage = w.s; run.hazard = w.hz || 0; run.stirT = w.sr || 0; run.hold = w.hd || 0; run.waves = w.wv || 0;
    if (w.g && w.s === FSTAGE.FIGHT) {
      const g = run.g || (run.g = makeGuardian(1));
      g.x = w.g.x; g.z = w.g.z; g.faceX = w.g.fx; g.faceZ = w.g.fz; g.hp = w.g.h; g.maxHp = w.g.mh;
      g.phase = w.g.p; g.st = w.g.s; g.t = w.g.t; g.move = w.g.m; g.hurtT = w.g.u || 0; g.invincible = !!w.g.iv;
    } else if (run.stage !== FSTAGE.FIGHT) run.g = null;
    ctx.door(!run.gateOpen());
    run.marks = (w.mk || []).map((m) => ({ k: m[0], x: m[1], z: m[2], r: m[3], at: m[4], born: m[5], burning: m[0] !== FMARK.WEDGE ? m[6] : 0, fx: m[6], fz: m[7] }));
  };

  return run;
}
