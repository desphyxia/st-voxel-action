/**
 * World constants and the movement budget every generated feature is sized
 * against. See docs/DECISIONS.md §3 — a terrain feature exists to be crossed,
 * and these numbers say what "crossable" means.
 */

/** Voxel edge, metres. Terrain is authored in whole metres; this is the grain. */
export const V = 0.25;
/** Ceiling, metres. Nothing is generated above it. */
export const CEIL = 16;
/** Chunk edge, metres. */
export const CHUNK = 32;

/**
 * What a player can cross, in metres (DECISIONS §3, revised 2026-09-27, #73).
 *
 * - `step`   walked up without a jump: two voxels, so the 0.25 m stairs that
 *            ordinary ground climbs in are walked and a placed face is not.
 * - `slope`  the cell-level difference that is ground rather than a face: a
 *            1 m rise between cells is drawn as a ramp of 0.25 m steps
 *            (src/gen/surface.mjs), so the generator's metre-grid rules still
 *            treat it as walkable.
 * - `climb`  the tallest face one jump lands on; `climb2` with the double jump.
 *            Anything taller is a wall.
 * - `jump`   the gap one jump clears; `jump2` with the double jump.
 * - `jumpH`  how high the jump rises: `climb` plus room to arrive over the lip.
 *            With `jump` it fixes gravity — see src/sim/actor.mjs.
 * - `fall`   the tallest drop survived.
 */
export const MOVE = { step: 0.5, slope: 1, climb: 1, climb2: 2, jump: 3, jump2: 4.4, jumpH: 1.4,
                      wade: 0.75, fall: 6 };

/** Four-neighbourhood, in cell space. Order matters: it is part of the seed. */
export const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
