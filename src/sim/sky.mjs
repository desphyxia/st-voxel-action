/**
 * The sky: time of day and weather — issue #30.
 *
 * `docs/DECISIONS.md` §5 commits to "full day/night and weather; rain wets
 * materials, snow accumulates, fog for distance". This is the half of it that
 * is not three.js: given a time and a seed, where the sun is, what colour the
 * light and the sky are, how cloudy it is, whether it is raining or snowing,
 * and how wet the ground has got. The renderer draws from it; nothing here
 * knows a renderer exists.
 *
 * Pure, and on purpose. The clock is simulation seconds, not the wall clock, so
 * two players whose simulations agree see the same hour; and the weather is a
 * hash of the seed and the hour, not a random draw, so it is the same on both
 * machines without a byte crossing the wire (§8: "a seed and two characters").
 * `wetness` is what material conduction will read when something does — today
 * nothing in src/sim reads it, so the weather cannot yet change how the game
 * plays, only how it looks.
 *
 * Trigonometry is src/gen/exact.mjs's, like everything in src/.
 */
import { sin, cos, TAU } from '../gen/exact.mjs';

/** Seconds of simulation time in one full day. */
export const DAY_SECONDS = 1200;
/** Where a world's clock starts, as a fraction of a day: mid-morning, so the
    first thing anyone sees is low, warm light with long shadows. */
export const DAWN_START = 0.34;
/** Seconds one weather spell lasts before the next is rolled. */
export const SPELL_SECONDS = 150;

/* The sun's path. Noon puts it where the build's fixed sun always stood,
   (-16, 26, 12) normalised, so a noon frame reads like every frame before. */
const NOON_AZ = 2.4865;            /* atan2(12, -16) */
const MAX_EL = 0.9144;             /* asin(26 / |(-16, 26, 12)|) */

function skyClamp(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
function skyMix(a, b, k) { return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]; }
function skySmooth(e0, e1, x) { const t = skyClamp((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); }

/* An integer hash, for the weather: a spell is decided by the seed word and
   which spell it is, and nothing else. */
function skyHash(seed, n, salt) {
  let h = Math.imul((seed | 0) ^ Math.imul(n + 0x9e37 | 0, 0x85ebca6b), 0xc2b2ae35) ^ salt;
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/**
 * A seed as the 32-bit word the weather hashes. Worlds are seeded with
 * strings ('QUARTERSTONE'), and a number is taken as it is.
 */
export function skyWord(seed) {
  if (typeof seed === 'number') return seed | 0;
  let h = 0x811c9dc5;
  const t = String(seed == null ? '' : seed);
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h | 0;
}

/**
 * One weather spell: how clouded it is, and whether it rains. A third of
 * spells are clear, a third broken cloud, and a third overcast, of which half
 * rain. `cold` (0..1, from the ground under the camera) turns rain into snow.
 */
export function spellAt(seed, n) {
  const r = skyHash(seed, n, 0x51);
  if (r < 0.34) return { cloud: 0.1 * skyHash(seed, n, 0x52), rain: 0 };
  if (r < 0.67) return { cloud: 0.35 + 0.25 * skyHash(seed, n, 0x53), rain: 0 };
  const wet = skyHash(seed, n, 0x54) < 0.5;
  return { cloud: 0.75 + 0.2 * skyHash(seed, n, 0x55), rain: wet ? 0.6 + 0.4 * skyHash(seed, n, 0x56) : 0 };
}

/**
 * The weather at `seconds`, blended across the edge of a spell so it never
 * changes in a frame. `wetness` builds while it rains and dries after, taken
 * over the last few spells — so it is a pure function of the time too, not a
 * running total anything has to remember.
 */
export function weatherAt(seed, seconds) {
  seed = skyWord(seed);
  const s = seconds / SPELL_SECONDS, n = Math.floor(s), f = s - n;
  const a = spellAt(seed, n), b = spellAt(seed, n + 1);
  const k = skySmooth(0.8, 1.0, f);
  const cloud = a.cloud + (b.cloud - a.cloud) * k, rain = a.rain + (b.rain - a.rain) * k;
  /* Wet: each of the last four spells' rain, fading with how long ago it
     stopped. Rain that is falling now counts in full. */
  let wet = 0;
  for (let q = 0; q < 4; q++) {
    const sp = spellAt(seed, n - q);
    if (!sp.rain) continue;
    const since = q === 0 ? 0 : (s - (n - q + 1));        /* spells since it ended */
    wet = Math.max(wet, sp.rain * skyClamp(1 - since / 2.5));
  }
  return { cloud, rain, wetness: skyClamp(wet) };
}

/**
 * Where the sun is and what the light is at `seconds` after the world began.
 * Everything a renderer needs to draw the sky, and nothing it would compute
 * itself: directions are unit vectors toward the light, colours are linear
 * 0..1 triples, intensities are what three's lights take.
 *
 * `wx`, if given, is the weather to use instead of the seed's — {cloud, rain,
 * wetness} — which is how a look baseline gets a clear noon on any seed.
 */
export function skyAt(seconds, seed, wx) {
  const phase = ((DAWN_START + seconds / DAY_SECONDS) % 1 + 1) % 1;   /* 0 midnight, .5 noon */
  const ang = (phase - 0.25) * TAU;                                    /* 0 at sunrise */
  const up = sin(ang);                                                 /* -1 midnight .. 1 noon */
  const el = MAX_EL * up;
  const az = NOON_AZ + (phase - 0.5) * 2.2;                            /* east to west through the day */
  const ce = cos(el);
  const sunDir = [cos(az) * ce, sin(el), sin(az) * ce];
  const moonDir = [-sunDir[0] * 0.6, 0.75, -sunDir[2] * 0.6];

  const day = skySmooth(-0.08, 0.22, up);          /* 0 night .. 1 day */
  const low = 1 - skySmooth(0.12, 0.5, up);        /* how golden: 1 near the horizon */
  const w = wx || weatherAt(seed, seconds);
  const dim = 1 - 0.45 * w.cloud;               /* cloud takes the edge off the sun */

  const sunCol = skyMix([1.0, 0.94, 0.82], [1.0, 0.62, 0.34], low * day);
  const sunI = 1.12 * day * dim * (1 - 0.15 * low);
  const moonI = 0.22 * (1 - day);
  const skyTop = skyMix(skyMix([0.03, 0.05, 0.11], [0.29, 0.52, 0.80], day), [0.46, 0.49, 0.54], w.cloud * 0.8);
  const horizon = skyMix(skyMix([0.07, 0.09, 0.16], [0.72, 0.82, 0.90], day), [1.0, 0.64, 0.42], low * day * 0.8);
  const skyHorizon = skyMix(horizon, [0.62, 0.64, 0.67], w.cloud * 0.7);
  /* The golden hour is the sky's colour as much as the sun's: the fill warms
     with it, or a low sun only reads as a dimmer one. */
  const hemiSky = skyMix(skyMix([0.18, 0.24, 0.38], [0.62, 0.76, 0.91], day), [0.86, 0.66, 0.52], low * day * 0.55);
  const hemiGround = skyMix([0.08, 0.07, 0.09], [0.29, 0.23, 0.17], day);
  const hemiI = 0.34 + 0.34 * day;
  return {
    phase, day, low, up, sunDir, moonDir, sunCol, sunI, moonI,
    moonCol: [0.55, 0.66, 0.95],
    skyTop, skyHorizon, fogCol: skyHorizon,
    hemiSky, hemiGround, hemiI,
    /* Lamps come on before the sun is down and go off after it is up. */
    lamps: 1 - skySmooth(0.02, 0.2, up),
    cloud: w.cloud, rain: w.rain, wetness: w.wetness,
  };
}
