/**
 * The approach (#7, docs/DECISIONS.md §6): the road up to the furnace as three
 * escalating beats with a breather after each, and a rest stone at the foot.
 *
 * Only *where* is decided here, as a pure function of the site's descriptor:
 * pads along the road where a group stands. Which machines they are and how
 * they are brought in and put away is the encounter's (enemy.mjs), through the
 * same machinery that holds a streamed world's groups, so a group cleared on
 * the road stays cleared for the session.
 *
 * The road runs from the gate (t = 0) out to its foot (t = PATH_LEN), and a
 * player comes the other way. In the order they are met:
 *
 *   foot   the rest stone, then
 *   beat 1 a few small groups of one kind, then a breather,
 *   beat 2 more of them, mixing archetypes, then a breather,
 *   beat 3 the most and the heaviest, and the gate.
 *
 * The scar's harder terrain in the second beat is not here: it is the
 * generator's (a later slice). No randomness: the seed picks the jitter, the
 * side of the road and the order of the packs, as a hash of the site's place.
 */
import { PATH_LEN } from '../gen/site.mjs';

/** Where each beat lies along the road, in metres from the gate, and how many
    groups it holds at the least (the seed adds one to the later beats). The
    breathers are the gaps between them. */
export const BEATS = [
  { lo: 236, hi: 290, n: 3, packs: ['SM.S', 'HH.H'] },
  { lo: 132, hi: 204, n: 4, packs: ['SMH.H', 'SHH.M', 'MSH.S'] },
  { lo: 14, hi: 104, n: 5, packs: ['SMH.M', 'MHH.S', 'SSM.H', 'SMH.H'] },
];

/** How far from the foot the rest stone stands, how near to it a player has
    to come for it to count as walked up to, and how far a pad stands to one
    side of the road. */
export const REST_R = 6;
export const PAD_SIDE = 5;
/** Group ids start above every id a chunk's post can make (encounter's `groupId`). */
export const PAD_GID = 1048576;

/** A pack's recipe as `{ members, reserve }` of kind letters: S sentry, M mortar, H hound. */
export function packOf(code) {
  const [m, r] = code.split('.');
  return { members: m.split(''), reserve: r };
}

function seedUnit(S, n) {
  let h = (Math.imul(S.cx | 0, 73856093) ^ Math.imul(S.cz | 0, 19349663) ^ Math.imul(n, 83492791)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * The pads for a site, in the order they are met from the foot: `{ gid, beat,
 * t, h, offs, pack }`, where `offs` is the places to try, the seed's side of
 * the road first and the road's own middle last.
 */
export function approachPads(S) {
  const pads = [];
  if (!S || !S.path) return pads;
  const vx = -S.uz, vz = S.ux;
  for (let b = BEATS.length - 1; b >= 0; b--) {
    const B = BEATS[b];
    const n = B.n + (b > 0 && seedUnit(S, 100 + b) < 0.5 ? 1 : 0);
    const first = (seedUnit(S, 200 + b) * B.packs.length) | 0;
    for (let i = 0; i < n; i++) {
      /* From the far end in, each at the middle of its share of the beat. */
      let t = B.hi - (B.hi - B.lo) * (i + 0.5) / n + (seedUnit(S, b * 16 + i) - 0.5) * 5;
      t = Math.max(B.lo, Math.min(B.hi, Math.round(t)));
      const p = S.path[Math.min(PATH_LEN, t)];
      const side = ((i + (seedUnit(S, 300 + b) < 0.5 ? 1 : 0)) % 2 ? 1 : -1) * PAD_SIDE;
      pads.push({
        gid: PAD_GID + b * 8 + i, beat: b, t, h: p[2],
        offs: [side, -side, 0].map((o) => ({ x: p[0] + vx * o, z: p[1] + vz * o })),
        pack: packOf(B.packs[(first + i) % B.packs.length]),
      });
    }
  }
  return pads;
}
