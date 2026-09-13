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

/** What a player can cross, in metres. */
export const MOVE = { step: 1, vault: 2, jump: 2.5, wade: 0.75, fall: 6 };

/** Four-neighbourhood, in cell space. Order matters: it is part of the seed. */
export const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
