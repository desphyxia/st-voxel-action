/**
 * Quarterstone's terrain generator.
 *
 *   import { buildWorld } from './src/gen/index.mjs';
 *   const world = buildWorld({ seed: 'QUARTERSTONE', size: 64, force: null, ox: 0, oz: 0 });
 *
 * No DOM, no three.js, no renderer of any kind: this runs the same in Node, in
 * a worker and in the browser, and returns plain arrays and typed arrays. The
 * concept plate (docs/concept/index.html) draws what comes out of here; it is
 * one consumer, not the owner.
 *
 * The pass order below is the generator: each pass reads what the ones before
 * it left on the world object, and the random stream is consumed in exactly
 * this order — which is why a seed reproduces a world, and why reordering a
 * pass is a change to every world, not a refactor. tools/smoke.mjs pins six
 * seeds against tools/baseline.json to keep that honest.
 */
import { clamp } from './constants.mjs';
import { makeGen } from './field.mjs';
import { erode } from './erosion.mjs';
import { layRoutes } from './routes.mjs';
import { cutSpans } from './spans.mjs';
import { fillWaterTable, flowField, buildWaterGeometry } from './water.mjs';
import { sampleGrid, buildVoxels } from './surface.mjs';
import { makeStamps, scatterProps, placeClutter, placeLandmark } from './props.mjs';
import { buildGrass } from './grass.mjs';
import { floodReach, chooseSpawn } from './reach.mjs';

export { V, CEIL, CHUNK, MOVE, clamp } from './constants.mjs';
export { BIOMES } from './biomes.mjs';
export { makeGen } from './field.mjs';

/** The cell grid: one 1 m cell per lattice point, sampled from the fields. */
function seedCells(cfg) {
  var S = cfg.size, force = (cfg.force === undefined ? null : cfg.force);
  var G = makeGen(cfg.seed, force), half = S / 2;
  var OX = cfg.ox || 0, OZ = cfg.oz || 0;
  var M = S + 1, cells = new Array(M * M), i, j, mx, mz;
  for (i = 0; i < M; i++) {
    mx = -half + i;
    for (j = 0; j < M; j++) { mz = -half + j; cells[i * M + j] = G.cell(mx + OX, mz + OZ); }
  }
  var w = { cfg: cfg, size: S, G: G, R: G.rnd, half: half, OX: OX, OZ: OZ, M: M, cells: cells };
  w.cellAt = function (mx2, mz2) {
    var a = clamp(Math.round(mx2 + half), 0, M - 1), b = clamp(Math.round(mz2 + half), 0, M - 1);
    return cells[a * M + b];
  };
  return w;
}

export function buildWorld(cfg) {
  var w = seedCells(cfg);
  erode(w);                    /* talus at the cliff feet, banks cut back */
  layRoutes(w);                /* sites, A* routes, grading, crossings */
  cutSpans(w);                 /* caves cut, then rims undercut over them */
  fillWaterTable(w);           /* hollows flood until they spill */
  flowField(w);                /* one downhill vector per cell */
  sampleGrid(w);               /* 1 m cells resampled onto the voxel grid */
  buildVoxels(w);              /* the terrain voxels themselves */
  var kit = makeStamps(w);
  scatterProps(w, kit);        /* trees, boulders, canyon arcs */
  placeClutter(w, kit);        /* scree, clutter, the sites, lamps, bridges */
  placeLandmark(w, kit);       /* one landmark, visible three chunks away */
  buildGrass(w);
  buildWaterGeometry(w);
  floodReach(w);               /* what the movement budget can actually reach */
  chooseSpawn(w);
  return {
    pos: w.pos, col: w.col, mpos: w.mpos, mcol: w.mcol,
    grass: w.grass, water: w.water, lamps: w.lamps,
    ovhPos: w.ovhPos, lmPos: w.lmPos, trail: w.TRAIL, topi: w.TOPI,
    unreach: w.UNREACH, reach: w.REACH, bridges: w.bridges,
    Hs: w.Hs, FLG: w.FLG, NX: w.NX, NZ: w.NZ, half: w.half,
    cells: w.cells, M: w.M, spawn: w.spawn, size: w.size,
  };
}
