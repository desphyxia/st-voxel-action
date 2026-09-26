/**
 * What a voxel is made of, as opposed to what colour it happens to be.
 *
 * Until now a voxel carried only a colour, and three fusions in the gear design
 * were fiction because nothing could answer the questions they ask: chain-frost
 * conducts through wet ground and standing water, emberweft spreads to dry
 * grass, and the lodestone flail's damage depends on whether it tore basalt or
 * sand out of the ground (docs/DECISIONS.md §5).
 *
 * Every field here exists because some system needs it. Nothing is speculative:
 *
 *   hard   carve resistance. A bite that cannot pay it leaves the voxel alone.
 *   dens   mass. What the lodestone flail throws, and how hard it lands.
 *   burn   flammability. Emberweft spreads across anything above zero.
 *   cond   conductivity. Chain-frost and shock travel through it.
 *   grip   footing. Ice is the reason this is not a constant.
 *   step   footstep and impact sound key — audio is material-driven by decision.
 *   emit   emissive. Drawn by the renderer as its own lit pass.
 *   harm   damage per second on contact. Magma is the only one today.
 *
 * Ids are stored per voxel as a byte and are part of the save format: append
 * new materials at the end, never renumber.
 */

export const MAT = {
  AIR: 0, SOIL: 1, GRASS: 2, ROCK: 3, SAND: 4, SNOW: 5, ICE: 6, BASALT: 7,
  ASH: 8, WOOD: 9, LEAF: 10, PEAT: 11, PATH: 12, MAGMA: 13, METAL: 14, LIGHT: 15, GLASS: 16, FUNGUS: 17, CLOTH: 18, FLESH: 19,
};

/** Indexed by MAT. Order is the wire format — append only. */
export const MATERIALS = [
  { id: 0,  k: 'air',    nm: 'Air',      hard: 0,   dens: 0,   burn: 0,   cond: 0,   grip: 1,    step: 'none',   emit: 0, harm: 0 },
  { id: 1,  k: 'soil',   nm: 'Soil',     hard: 0.5, dens: 0.6, burn: 0,   cond: 0.2, grip: 1,    step: 'soft',   emit: 0, harm: 0 },
  { id: 2,  k: 'grass',  nm: 'Grass',    hard: 0.45,dens: 0.5, burn: 0.8, cond: 0.2, grip: 1,    step: 'soft',   emit: 0, harm: 0 },
  { id: 3,  k: 'rock',   nm: 'Rock',     hard: 0.8, dens: 1,   burn: 0,   cond: 0.1, grip: 1,    step: 'hard',   emit: 0, harm: 0 },
  { id: 4,  k: 'sand',   nm: 'Sand',     hard: 0.3, dens: 0.5, burn: 0,   cond: 0.1, grip: 0.85, step: 'grain',  emit: 0, harm: 0 },
  { id: 5,  k: 'snow',   nm: 'Snow',     hard: 0.15,dens: 0.3, burn: 0,   cond: 0.3, grip: 0.8,  step: 'crunch', emit: 0, harm: 0 },
  { id: 6,  k: 'ice',    nm: 'Ice',      hard: 0.6, dens: 0.9, burn: 0,   cond: 0.7, grip: 0.35, step: 'hard',   emit: 0, harm: 0 },
  { id: 7,  k: 'basalt', nm: 'Basalt',   hard: 1.2, dens: 1.4, burn: 0,   cond: 0.1, grip: 1,    step: 'hard',   emit: 0, harm: 0 },
  { id: 8,  k: 'ash',    nm: 'Ash',      hard: 0.2, dens: 0.3, burn: 0,   cond: 0.1, grip: 0.9,  step: 'grain',  emit: 0, harm: 0 },
  { id: 9,  k: 'wood',   nm: 'Wood',     hard: 0.4, dens: 0.6, burn: 1,   cond: 0.1, grip: 1,    step: 'wood',   emit: 0, harm: 0 },
  { id: 10, k: 'leaf',   nm: 'Foliage',  hard: 0.1, dens: 0.1, burn: 1,   cond: 0.1, grip: 1,    step: 'brush',  emit: 0, harm: 0 },
  { id: 11, k: 'peat',   nm: 'Peat',     hard: 0.35,dens: 0.5, burn: 0.6, cond: 0.5, grip: 0.9,  step: 'soft',   emit: 0, harm: 0 },
  { id: 12, k: 'path',   nm: 'Trodden',  hard: 0.5, dens: 0.7, burn: 0,   cond: 0.2, grip: 1.05, step: 'soft',   emit: 0, harm: 0 },
  { id: 13, k: 'magma',  nm: 'Magma',    hard: 99,  dens: 1.2, burn: 1,   cond: 0.9, grip: 0.5,  step: 'none',   emit: 1, harm: 40 },
  { id: 14, k: 'metal',  nm: 'Metal',    hard: 1.5, dens: 1.6, burn: 0,   cond: 1,   grip: 1,    step: 'metal',  emit: 0, harm: 0 },
  { id: 15, k: 'light',  nm: 'Lit core', hard: 1.5, dens: 0.8, burn: 0,   cond: 1,   grip: 1,    step: 'metal',  emit: 1, harm: 0 },
  { id: 16, k: 'glass',  nm: 'Glass',    hard: 1.0, dens: 1.2, burn: 0,   cond: 0.3, grip: 0.6,  step: 'glass',  emit: 0, harm: 0 },
  { id: 17, k: 'fungus', nm: 'Fungus',   hard: 0.2, dens: 0.3, burn: 0.4, cond: 0.4, grip: 0.9,  step: 'soft',   emit: 0, harm: 0 },
  /* What authored characters are made of (#34). Not terrain: nothing is
     generated from them, but a hit on one is a hit on cloth or on flesh. */
  { id: 18, k: 'cloth',  nm: 'Cloth',    hard: 0.1, dens: 0.3, burn: 0.9, cond: 0.1, grip: 1,    step: 'soft',   emit: 0, harm: 0 },
  { id: 19, k: 'flesh',  nm: 'Flesh',    hard: 0.1, dens: 1.0, burn: 0.3, cond: 0.6, grip: 1,    step: 'soft',   emit: 0, harm: 0 },
];

/** Wet ground conducts: what chain-frost needs, and why water level matters. */
export function conductivity(matId, wet) {
  var c = MATERIALS[matId].cond;
  return wet ? Math.min(1, c + 0.6) : c;
}

/** True when one bite of the given strength can break this material at all. */
export function carvable(matId, bite) { return MATERIALS[matId].hard <= bite; }
