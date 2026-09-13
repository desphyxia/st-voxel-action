/**
 * The Math functions the generator is allowed to use, rebuilt so that every
 * engine returns the same bits.
 *
 * ECMAScript pins +, -, *, / and Math.sqrt to IEEE 754 and leaves sin, cos,
 * exp, pow and hypot "implementation-approximated": two conforming engines may
 * differ in the last bit, and V8 has changed all of them between versions.
 * Measured, not assumed — over a 100k sample of the arguments this generator
 * actually produces:
 *
 *   node 22 (V8 12.4) vs Chromium 141 (V8 14.1):  sin and cos already differ.
 *   node 22 vs the CI runner's Chromium 153:      enough of them differ to
 *                                                 move voxels off the grid.
 *
 * That is what made tools/smoke.mjs's PARITY check fail on the runner while
 * passing on this machine: identical counts everywhere, different digest. A
 * one-bit difference usually vanishes when a position is rounded onto the
 * 25 cm grid, and occasionally lands on the rounding boundary and does not.
 *
 * It matters beyond the gate. A seed has to grow the same world on both
 * players' machines, in the tooling that measures it, and in whatever
 * generates it at runtime — so the generator uses only operations the spec
 * pins exactly: + - * /, Math.sqrt, abs, floor, round, min, max, imul, and
 * these.
 *
 * They are less accurate than the engine's — about 1e-12 relative against its
 * 1 ulp. That is the trade on purpose: for terrain sized in whole metres and
 * rounded onto a 25 cm grid, being identical everywhere is worth more than the
 * twelfth decimal.
 */

export const TAU = 6.283185307179586;
const HALF_PI = 1.5707963267948966;
const INV_TAU = 0.15915494309189535;

/**
 * sin(x). Argument reduced to [-pi/2, pi/2], then an odd Taylor series to
 * x^17 — every step a pinned IEEE operation.
 */
export function sin(x) {
  var q = x * INV_TAU;
  q = q - Math.floor(q + 0.5);                  /* [-0.5, 0.5) */
  var r = q * TAU;                              /* [-pi, pi)   */
  if (r > HALF_PI) r = Math.PI - r;
  else if (r < -HALF_PI) r = -Math.PI - r;      /* [-pi/2, pi/2] */
  var z = r * r;
  return r * (1 + z * (-1.6666666666666666e-1 + z * (8.333333333333333e-3 +
    z * (-1.984126984126984e-4 + z * (2.7557319223985893e-6 +
    z * (-2.505210838544172e-8 + z * (1.6059043836821613e-10 +
    z * (-7.647163731819816e-13 + z * 2.8114572543455206e-15))))))));
}

/** cos(x), as sin one quarter turn along. */
export function cos(x) { return sin(x + HALF_PI); }

/** 2^k for an integer k, by exact doublings. Math.pow is not pinned either. */
function pow2(k) {
  if (k >= 1024) return Infinity;
  if (k <= -1075) return 0;
  var r = 1, m = k < 0 ? 0.5 : 2, n = k < 0 ? -k : k;
  while (n) { if (n & 1) r *= m; m *= m; n >>= 1; }
  return r;
}

/* ln2 split so that k * LN2HI is exact for any integer k in range: the classic
   Cody-Waite reduction, which is what keeps the series argument small. */
const LOG2E = 1.4426950408889634;
const LN2HI = 6.93147180369123816490e-1;
const LN2LO = 1.90821492927058770002e-10;

/** exp(x). Reduced to exp(r) * 2^k with |r| <= ln2/2, then Taylor to r^10. */
export function exp(x) {
  if (!(x > -745.2)) return x !== x ? x : 0;    /* NaN through, underflow to 0 */
  if (x > 709.78) return Infinity;
  var k = Math.round(x * LOG2E);
  var r = (x - k * LN2HI) - k * LN2LO;
  var p = 1 + r * (1 + r * (0.5 + r * (1.6666666666666666e-1 +
    r * (4.1666666666666664e-2 + r * (8.333333333333333e-3 +
    r * (1.3888888888888889e-3 + r * (1.984126984126984e-4 +
    r * (2.48015873015873e-5 + r * (2.7557319223985893e-6 +
    r * 2.755731922398589e-7)))))))));
  return p * pow2(k);
}

/**
 * hypot for two finite arguments. Math.hypot guards against overflow and
 * underflow, which costs it a different last bit — and which last bit depends
 * on the engine. Nothing here is further from the origin than a few hundred
 * metres, so the plain form is both safe and pinned.
 */
export function hyp(a, b) { return Math.sqrt(a * a + b * b); }
