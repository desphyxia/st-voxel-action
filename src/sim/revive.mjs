/**
 * Staying alive together (#114, docs/DECISIONS.md §3, "Combat numbers").
 *
 * Three rules, all of them the host's. None runs on a guest: a guest takes its
 * health and its downed state from the snapshot, the way it takes a machine's.
 *
 *   regen     Health comes back slowly once nothing has hunted you for
 *             `REGEN_DELAY` seconds. A machine that has noticed you keeps you
 *             hunted; a blow resets it. Spoils do not heal.
 *   downed    A machine's blow that would kill a player puts them down instead
 *             — if a partner is still standing. Alone, it kills, as it did.
 *             Magma, a fall and the void are not a blow and still kill.
 *   revive    A partner within `REVIVE_RANGE` for `REVIVE_TIME` stands you up
 *             on `REVIVE_HP` of your health. Left alone for `DOWN_TIME` you are
 *             gone. When nobody is standing, everyone downed is gone at once.
 *
 * A downed player is not a target and cannot act (`step` reads `a.down`), and
 * the lattice's own regrowth does not reach them (`heal`).
 */
import { hyp } from '../gen/exact.mjs';
import { REGEN_DELAY, REGEN_RATE, heal } from './combat.mjs';

/** Seconds a player lies there before they are lost. */
export const DOWN_TIME = 25;
/** How close a partner must be, and for how long, to stand you up. */
export const REVIVE_RANGE = 1.8;
export const REVIVE_TIME = 1.5;
/** The share of your health you get up with. */
export const REVIVE_HP = 0.4;
/** How far above or below a partner may be and still reach you. */
const REVIVE_SPAN = 1.5;

/** On their feet: not dead, and not down. */
export function onFeet(p) { return !!p && !p.dead && !p.down; }

/** Put a player down: stopped, nothing in the air, and a clock running. */
function lieDown(p) {
  p.dead = null; p.hp = 0; p.down = DOWN_TIME; p.reviveT = 0;
  p.swing = null; p.dodge = null; p.aim = null; p.tether = null; p.haul = null;
  p.vx = 0; p.vz = 0;
}

/** One tick of all three rules over the players the host is simulating. */
export function upkeep(players, dt) {
  let up = 0;
  for (const p of players) if (onFeet(p)) up++;

  for (const p of players) {
    if (!p) continue;
    /* A blow killed them. Somebody left on their feet makes it a fall. */
    if (p.dead === 'struck' && !p.down) {
      let other = false;
      for (const q of players) if (q && q !== p && onFeet(q)) other = true;
      if (other) { lieDown(p); }
    }
  }

  up = 0;
  for (const p of players) if (onFeet(p)) up++;

  for (const p of players) {
    if (!p || !p.down) continue;
    if (up === 0) { p.down = 0; p.dead = 'struck'; p.reviveT = 0; continue; }
    let near = false;
    for (const q of players) {
      if (q && q !== p && onFeet(q) && hyp(q.x - p.x, q.z - p.z) <= REVIVE_RANGE
          && Math.abs(q.y - p.y) <= REVIVE_SPAN) near = true;
    }
    p.reviveT = near ? p.reviveT + dt : Math.max(0, p.reviveT - dt);
    p.down -= dt;
    if (p.reviveT >= REVIVE_TIME) {
      p.down = 0; p.reviveT = 0; p.hp = Math.max(1, p.maxHp * REVIVE_HP);
      p.hunted = REGEN_DELAY; p.hurtT = 0;
    } else if (p.down <= 0) { p.down = 0; p.dead = 'struck'; p.reviveT = 0; }
  }

  for (const p of players) {
    if (!onFeet(p) || p.hp === undefined) continue;
    if (p.hunted > 0) p.hunted = Math.max(0, p.hunted - dt);
    else if (p.hp < p.maxHp) heal(p, REGEN_RATE * dt);
  }
}
