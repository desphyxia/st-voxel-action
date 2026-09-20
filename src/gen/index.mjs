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
 * it left on the world object. It is no longer also the order a random stream
 * is consumed in — as of issue #41 every draw is positional, keyed on the
 * place it belongs to, so a pass can be reordered without rewriting every
 * world and two windows onto the same ground agree voxel for voxel.
 * tools/smoke.mjs pins six seeds against tools/baseline.json to keep that
 * honest, and compares overlapping windows to keep the agreement honest.
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
  var w = { cfg: cfg, size: S, G: G, half: half, OX: OX, OZ: OZ, M: M, cells: cells };
  w.cellAt = function (mx2, mz2) {
    var a = clamp(Math.round(mx2 + half), 0, M - 1), b = clamp(Math.round(mz2 + half), 0, M - 1);
    return cells[a * M + b];
  };
  return w;
}

export function buildWorld(cfg) {
  var w = seedCells(cfg);
  /* Visual only, and only grass reads it. Kept on the world rather than passed
     down, because buildGrass is the one pass that wants it and threading an
     argument through nine that do not would be worse. */
  w.gdens = cfg.gdens === undefined ? 1 : cfg.gdens;
  erode(w);                    /* talus at the cliff feet, banks cut back */
  layRoutes(w);                /* sites, A* routes, grading, crossings */
  cutSpans(w);                 /* caves cut, then rims undercut over them */
  fillWaterTable(w);           /* hollows flood until they spill */
  flowField(w);                /* one downhill vector per cell */
  sampleGrid(w);               /* 1 m cells resampled onto the voxel grid */
  buildVoxels(w);              /* the terrain voxels themselves */
  /* Where the terrain ends and the stamps begin. The greedy mesher (#12)
     replaces the terrain and leaves props instanced — a felled tree must not
     remesh a chunk — so the renderer needs to know which voxels are which.
     Taken here rather than inferred from the lattice, because a heuristic that
     is usually right is the kind of thing that breaks quietly. */
  w.propStart = w.pos.length / 3;
  var kit = makeStamps(w);
  scatterProps(w, kit);        /* trees, boulders, canyon arcs */
  placeClutter(w, kit);        /* scree, clutter, the sites, lamps, bridges */
  placeLandmark(w, kit);       /* one landmark, visible three chunks away */
  buildGrass(w);
  buildWaterGeometry(w);
  floodReach(w);               /* what the movement budget can actually reach */
  chooseSpawn(w);
  return {
    /* One voxel is pos + pal + shd + mat. Colour is resolved at draw time
       against src/gen/palette.mjs, so a biome restyles without regenerating
       (issue #28). Same four for the emissive pass. */
    pos: w.pos, pal: w.pal, shd: w.shd, mat: w.mat, propStart: w.propStart,
    mpos: w.mpos, mpal: w.mpal, mshd: w.mshd, mmat: w.mmat,
    grass: w.grass, water: w.water, lamps: w.lamps,
    ovhPos: w.ovhPos, lmPos: w.lmPos, trail: w.TRAIL, topi: w.TOPI,
    unreach: w.UNREACH, reach: w.REACH, bridges: w.bridges,
    /* The two places the trails were routed to, as cell indices. A ruin and a
       holding stand on them (props.mjs), which makes them the places worth
       putting something in — see src/sim/loot.mjs. */
    sites: w.sites,
    Hs: w.Hs, FLG: w.FLG, NX: w.NX, NZ: w.NZ, half: w.half,
    cells: w.cells, M: w.M, spawn: w.spawn, size: w.size,
    /* Where this window sits and what grew it. The mesher (src/mesh) needs both
       to rebuild a column's own positional stream — which is only reproducible
       at all because of issue #41 — and chunk streaming will want them too. */
    G: w.G, OX: w.OX, OZ: w.OZ,
  };
}
