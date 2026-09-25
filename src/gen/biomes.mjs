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

export const BIOMES = [
 {k:'meadow',nm:'Meadowlands',t:0.58,m:0.66,c:'#6b9a45',ds:'Broadleaf stands, meandering rivers, boulder fields. The tutorial biome and the one the palette is calibrated against.',mt:'base 3 m · hills 1–3 m · rivers common',
  surf:PAL.MEADOW_SURF,soil:PAL.MEADOW_SOIL,rock:PAL.MEADOW_ROCK,bed:PAL.MEADOW_BED,
  mat:{surf:MAT.GRASS,soil:MAT.SOIL,rock:MAT.ROCK,bed:MAT.SAND},
  gr:{d:7.8,c:0x86ab4f,dry:0xb6a35a,h:[0.35,0.30]},tree:{t:'broad',d:0.9},base:3,hill:3,canyon:0.1,col:0.05},
 {k:'mesa',nm:'Redrock Mesa',t:0.82,m:0.20,c:'#c08a52',ds:'Stacked sandstone, dry washes, hoodoos. Canyons and arcs are generated here more than anywhere else.',mt:'base 6 m · hills 1–2 m · canyons 3–5 m',
  surf:PAL.MESA_SURF,soil:PAL.MESA_SOIL,rock:PAL.MESA_ROCK,bed:PAL.MESA_BED,
  mat:{surf:MAT.SAND,soil:MAT.SOIL,rock:MAT.ROCK,bed:MAT.SAND},
  gr:{d:3.0,c:0xc0a760,dry:0xd8c07a,h:[0.30,0.25]},tree:{t:'scrub',d:0.25},base:6,hill:2,canyon:0.85,col:0.5},
 {k:'fen',nm:'Boreal Fen',t:0.40,m:0.90,c:'#4a7a4e',ds:'Peat shelves, standing water, black conifers and reed beds. Wide slow water, poor footing.',mt:'base 2 m · hills 1 m · water 4–8 m wide',
  surf:PAL.FEN_SURF,soil:PAL.FEN_SOIL,rock:PAL.FEN_ROCK,bed:PAL.FEN_BED,
  mat:{surf:MAT.GRASS,soil:MAT.PEAT,rock:MAT.ROCK,bed:MAT.PEAT},
  gr:{d:8.7,c:0x5f8a48,dry:0x7d8a3e,h:[0.40,0.28]},tree:{t:'conifer',d:0.8},base:2,hill:1,canyon:0,col:0},
 {k:'ash',nm:'Ashfall Barrens',t:0.90,m:0.48,c:'#5a504a',ds:'Basalt columns, fissures and magma seams under a grey crust. Vertical cover everywhere, nothing to eat.',mt:'base 4 m · columns 2–4 m · magma seams',
  surf:PAL.ASH_SURF,soil:PAL.ASH_SOIL,rock:PAL.ASH_ROCK,bed:PAL.ASH_BED,
  mat:{surf:MAT.ASH,soil:MAT.ASH,rock:MAT.BASALT,bed:MAT.BASALT},
  gr:{d:2.5,c:0x6b5a50,dry:0xd2642a,h:[0.26,0.22]},tree:{t:'snag',d:0.3},base:4,hill:2,canyon:0.3,col:0.9},
 {k:'frost',nm:'Frostmoor',t:0.12,m:0.44,c:'#cfd9e2',ds:'Snow over hard rock, frozen shelves, wind-stripped ridges. Tracks show, and so do you.',mt:'base 5 m · hills 2–3 m · ice shelves',
  surf:PAL.FROST_SURF,soil:PAL.FROST_SOIL,rock:PAL.FROST_ROCK,bed:PAL.FROST_BED,
  mat:{surf:MAT.SNOW,soil:MAT.SOIL,rock:MAT.ROCK,bed:MAT.ICE},
  gr:{d:3.9,c:0xc8d6de,dry:0x9fb4bf,h:[0.28,0.23]},tree:{t:'conifer',d:0.45},base:5,hill:3,canyon:0.15,col:0.2}
];

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
