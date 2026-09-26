/**
 * The biome table. One row per biome: where it sits on the climate chart
 * (t = temperature, m = moisture), how its ground is shaped (base, hill,
 * canyon, col), and the palettes and vegetation kit it stamps with.
 *
 * The plate's document also reads nm, c, ds and mt — the same rows drive the
 * climate chart and the biome cards, so the table lives here and nowhere else.
 *
 * Each row also names the material its ground is made of, per layer. Palette
 * and material are deliberately separate: two biomes can both be grass and look
 * nothing alike, and the blend dithering that makes a transition read only works
 * on colour. See src/gen/materials.mjs.
 *
 * Palette slots name a group in src/gen/palette.mjs rather than holding colours
 * of their own (issue #28). A voxel records which entry it picked, not what
 * colour came out, so a biome restyles by editing that table and nothing has to
 * be regenerated. The DEBT note that used to sit here is discharged.
 */
import { MAT } from './materials.mjs';
import { PAL } from './palette.mjs';

/**
 * Four biomes and four scars — `docs/DECISIONS.md` §5, issue #3.
 *
 * The first CLIMATE_N rows are the natural biomes, anchored at a point on the
 * temperature and moisture chart. The rest are scars: the damage the three
 * weapons did, painted as an overlay field of their own (src/gen/field.mjs)
 * rather than placed on the chart. A scar has no t or m, and its rows leave
 * base and hill unset, because a scar cuts across the land rather than
 * replacing it — the ground keeps the shape the climate gave it, and what
 * the scar changes is what it is made of, what grows on it and what stands in
 * it. That is also why a cell's weights never go wholly to scars: the climate
 * underneath keeps a share, and you can see what the land used to be.
 *
 * Boreal Fen and Frostmoor are gone. Their ground became Sporeverge and
 * Rimewaste, which is what the decision says they overlapped with.
 */
export const BIOMES = [
 {k:'meadow',nm:'Meadowlands',t:0.58,m:0.66,c:'#6b9a45',ds:'Broadleaf stands, meandering rivers, boulder fields. The tutorial biome and the one the palette is calibrated against.',mt:'base 3 m · hills 1–3 m · rivers common',
  surf:PAL.MEADOW_SURF,soil:PAL.MEADOW_SOIL,rock:PAL.MEADOW_ROCK,bed:PAL.MEADOW_BED,
  mat:{surf:MAT.GRASS,soil:MAT.SOIL,rock:MAT.ROCK,bed:MAT.SAND},
  gr:{d:7.8,c:0x86ab4f,dry:0xb6a35a,h:[0.35,0.30]},tree:{t:'broad',d:0.9},base:3,hill:3,canyon:0.1,col:0.05},
 {k:'mesa',nm:'Redrock Mesa',t:0.82,m:0.20,c:'#c08a52',ds:'Stacked sandstone, dry washes, hoodoos. Canyons and arcs are generated here more than anywhere else.',mt:'base 6 m · hills 1–2 m · canyons 3–5 m',
  surf:PAL.MESA_SURF,soil:PAL.MESA_SOIL,rock:PAL.MESA_ROCK,bed:PAL.MESA_BED,
  mat:{surf:MAT.SAND,soil:MAT.SOIL,rock:MAT.ROCK,bed:MAT.SAND},
  gr:{d:3.0,c:0xc0a760,dry:0xd8c07a,h:[0.30,0.25]},tree:{t:'scrub',d:0.25},base:6,hill:2,canyon:0.85,col:0.5},
 {k:'pine',nm:'Cloudpine Highlands',t:0.20,m:0.62,c:'#4f7466',ds:'High granite shoulders under dark conifer stands, cold streams and blue-green turf. The tallest ground there is.',mt:'base 7 m · hills 2–4 m · tarns',
  surf:PAL.PINE_SURF,soil:PAL.PINE_SOIL,rock:PAL.PINE_ROCK,bed:PAL.PINE_BED,
  mat:{surf:MAT.GRASS,soil:MAT.SOIL,rock:MAT.ROCK,bed:MAT.SAND},
  gr:{d:6.4,c:0x6f9a78,dry:0x9aa67a,h:[0.30,0.24]},tree:{t:'conifer',d:0.95},base:7,hill:4,canyon:0.2,col:0.15},
 {k:'thorn',nm:'Thornwood',t:0.44,m:0.30,c:'#6b6a3a',ds:'Crooked hardwood in tangles, thorn thickets and dry brown turf. Close sightlines and no straight way through.',mt:'base 3 m · hills 1–2 m · thickets',
  surf:PAL.THORN_SURF,soil:PAL.THORN_SOIL,rock:PAL.THORN_ROCK,bed:PAL.THORN_BED,
  mat:{surf:MAT.GRASS,soil:MAT.SOIL,rock:MAT.ROCK,bed:MAT.SAND},
  gr:{d:5.6,c:0x8a8a48,dry:0xa6904e,h:[0.34,0.26]},tree:{t:'thorn',d:1.1},base:3,hill:2,canyon:0.05,col:0.1},
 {k:'ash',nm:'Ashfall Barrens',scar:true,c:'#5a504a',ds:'The tech weapon\'s burn: basalt columns, fissures and magma seams under a grey crust. Vertical cover everywhere, nothing to eat.',mt:'scar · columns 2–4 m · magma seams',
  surf:PAL.ASH_SURF,soil:PAL.ASH_SOIL,rock:PAL.ASH_ROCK,bed:PAL.ASH_BED,
  mat:{surf:MAT.ASH,soil:MAT.ASH,rock:MAT.BASALT,bed:MAT.BASALT},
  gr:{d:2.5,c:0x6b5a50,dry:0xd2642a,h:[0.26,0.22]},tree:{t:'snag',d:0.3},canyon:0.3,col:0.9},
 {k:'rime',nm:'Rimewaste',scar:true,c:'#cfd9e2',ds:'A magical winter that never lifted: snow over black ice, frozen shelves, trees caught mid-motion. Tracks show, and so do you.',mt:'scar · snow cover · black ice',
  surf:PAL.RIME_SURF,soil:PAL.RIME_SOIL,rock:PAL.RIME_ROCK,bed:PAL.RIME_BED,
  mat:{surf:MAT.SNOW,soil:MAT.SOIL,rock:MAT.ROCK,bed:MAT.ICE},
  gr:{d:3.9,c:0xc8d6de,dry:0x9fb4bf,h:[0.28,0.23]},tree:{t:'conifer',d:0.45},canyon:0.15,col:0.2},
 {k:'spore',nm:'Sporeverge',scar:true,c:'#7a5f86',ds:'A biological bloom that got out: mycelium mats over peat, standing water, fungal towers with lit gills.',mt:'scar · fungal towers 3–7 m · wide slow water',
  surf:PAL.SPORE_SURF,soil:PAL.SPORE_SOIL,rock:PAL.SPORE_ROCK,bed:PAL.SPORE_BED,
  mat:{surf:MAT.FUNGUS,soil:MAT.PEAT,rock:MAT.ROCK,bed:MAT.PEAT},
  gr:{d:4.2,c:0x8a7494,dry:0x9a8a5a,h:[0.30,0.26]},tree:{t:'fungus',d:0.7},hill:1,canyon:0,col:0},
 {k:'glass',nm:'Glasslands',scar:true,c:'#5f8f88',ds:'Where two weapons met: ground fused to dark glass, shard fields, almost nothing growing.',mt:'scar · vitrified crust · shards 1–4 m',
  surf:PAL.GLASS_SURF,soil:PAL.GLASS_SOIL,rock:PAL.GLASS_ROCK,bed:PAL.GLASS_BED,
  mat:{surf:MAT.GLASS,soil:MAT.SOIL,rock:MAT.GLASS,bed:MAT.GLASS},
  gr:{d:0.25,c:0x6f8f86,dry:0x8fa8a0,h:[0.22,0.18]},tree:{t:'shard',d:0.55},hill:1,canyon:0,col:0}
];

/** How many rows lead the table as climate anchors; the rest are scars. */
export const CLIMATE_N = 4;
/** Row indices by name, so nothing downstream counts positions. */
export const BIO = { MEADOW: 0, MESA: 1, PINE: 2, THORN: 3, ASH: 4, RIME: 5, SPORE: 6, GLASS: 7 };

/** Picks one biome out of a blend, sharpened so blends still read as somewhere. */
export function rouletteBiome(w, r, pow) {
  var p = [], t = 0, i, k = pow === undefined ? 5 : pow;
  for (i = 0; i < w.length; i++) { var e = 1; for (var q = 0; q < k; q++) e *= w[i]; p.push(e); t += e; }
  var v = r() * t, s = 0;
  for (i = 0; i < w.length; i++) { s += p[i]; if (v <= s) return i; }
  return w.length - 1;
}

/* ---------- colour ----------
   Voxels no longer come through here — they record a palette index and a shade
   byte (src/gen/palette.mjs). What is left is grass, whose colour is *blended*
   across every biome present in a cell rather than picked from one, so it has
   no single entry to point at and stays a float triple. Tracked in #39. */

/** The three components of a scaled hex colour, for the blended ones. */
export function shadeR(hex, k) { return ((hex >> 16 & 255) / 255) * k; }
export function shadeG(hex, k) { return ((hex >> 8 & 255) / 255) * k; }
export function shadeB(hex, k) { return ((hex & 255) / 255) * k; }
