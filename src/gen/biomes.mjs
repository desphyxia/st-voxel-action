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
 * DEBT: palettes are still hex colours chosen per voxel by the generator, which
 * means the renderer cannot restyle a material without regenerating the world.
 * Moving colour choice behind the material is tracked separately from #14.
 */
import { MAT } from './materials.mjs';

export const BIOMES = [
 {k:'meadow',nm:'Meadowlands',t:0.58,m:0.66,c:'#6b9a45',ds:'Broadleaf stands, meandering rivers, boulder fields. The tutorial biome and the one the palette is calibrated against.',mt:'base 3 m · hills 1–3 m · rivers common',
  surf:[0x5f8f3e,0x6b9a45,0x557f36,0x74a24e],soil:[0x6b4f33,0x5a4229,0x7a5a3c],rock:[0x7d7a72,0x8b877e,0x6d6a63],bed:[0xcbb187,0xd6bd94],
  mat:{surf:MAT.GRASS,soil:MAT.SOIL,rock:MAT.ROCK,bed:MAT.SAND},
  gr:{d:0.9,c:0x86ab4f,dry:0xb6a35a,h:[0.30,0.28]},tree:{t:'broad',d:0.9},base:3,hill:3,canyon:0.1,col:0.05},
 {k:'mesa',nm:'Redrock Mesa',t:0.82,m:0.20,c:'#c08a52',ds:'Stacked sandstone, dry washes, hoodoos. Canyons and arcs are generated here more than anywhere else.',mt:'base 6 m · hills 1–2 m · canyons 3–5 m',
  surf:[0xc98f55,0xd6a066,0xb97f49,0xc08a52],soil:[0xa9723f,0x8f5f34],rock:[0xb07a45,0xc08a52,0x9a6a3f,0xd1a06a],bed:[0xd8c08c,0xc9ad7a],
  mat:{surf:MAT.SAND,soil:MAT.SOIL,rock:MAT.ROCK,bed:MAT.SAND},
  gr:{d:0.35,c:0xc0a760,dry:0xd8c07a,h:[0.26,0.22]},tree:{t:'scrub',d:0.25},base:6,hill:2,canyon:0.85,col:0.5},
 {k:'fen',nm:'Boreal Fen',t:0.40,m:0.90,c:'#4a7a4e',ds:'Peat shelves, standing water, black conifers and reed beds. Wide slow water, poor footing.',mt:'base 2 m · hills 1 m · water 4–8 m wide',
  surf:[0x3f6b46,0x4a7a4e,0x35603f,0x577f4a],soil:[0x3a2f24,0x2e251c],rock:[0x5b6058,0x4c5149],bed:[0x4a4432,0x3c3a2a],
  mat:{surf:MAT.GRASS,soil:MAT.PEAT,rock:MAT.ROCK,bed:MAT.PEAT},
  gr:{d:1.0,c:0x5f8a48,dry:0x7d8a3e,h:[0.55,0.35]},tree:{t:'conifer',d:0.8},base:2,hill:1,canyon:0,col:0},
 {k:'ash',nm:'Ashfall Barrens',t:0.90,m:0.48,c:'#5a504a',ds:'Basalt columns, fissures and magma seams under a grey crust. Vertical cover everywhere, nothing to eat.',mt:'base 4 m · columns 2–4 m · magma seams',
  surf:[0x3a3532,0x46403c,0x2f2a28,0x4d4642],soil:[0x2b2726,0x241f1e],rock:[0x33302f,0x3f3a38,0x282524],bed:[0x1e1a19,0x272322],
  mat:{surf:MAT.ASH,soil:MAT.ASH,rock:MAT.BASALT,bed:MAT.BASALT},
  gr:{d:0.3,c:0x6b5a50,dry:0xd2642a,h:[0.24,0.2]},tree:{t:'snag',d:0.3},base:4,hill:2,canyon:0.3,col:0.9},
 {k:'frost',nm:'Frostmoor',t:0.12,m:0.44,c:'#cfd9e2',ds:'Snow over hard rock, frozen shelves, wind-stripped ridges. Tracks show, and so do you.',mt:'base 5 m · hills 2–3 m · ice shelves',
  surf:[0xdfe7ee,0xe9eef4,0xcfd9e2,0xd7e0e8],soil:[0x8b95a0,0x79838e],rock:[0x6b7480,0x7c8590,0x5d6670],bed:[0x9fc9d8,0xb7dbe6],
  mat:{surf:MAT.SNOW,soil:MAT.SOIL,rock:MAT.ROCK,bed:MAT.ICE},
  gr:{d:0.45,c:0xc8d6de,dry:0x9fb4bf,h:[0.26,0.22]},tree:{t:'conifer',d:0.45},base:5,hill:3,canyon:0.15,col:0.2}
];

/** Accumulation palettes: what settles on top of whatever faces up. */
export const SNOW = [0xe7eef4, 0xdae3ec, 0xf1f6fa];
export const ASHFALL = [0x6b635c, 0x746c64, 0x5c554f];
/** Trodden ground, wherever a route runs. */
export const PATH = [0x9a7c54, 0x8d7049, 0xa68960, 0x7f6641];

export function pickFrom(arr, r) { return arr[(r() * arr.length) | 0]; }

/** Picks one biome out of a blend, sharpened so blends still read as somewhere. */
export function rouletteBiome(w, r) {
  var p = [], t = 0, i;
  for (i = 0; i < w.length; i++) { var e = w[i] * w[i] * w[i] * w[i] * w[i]; p.push(e); t += e; }
  var v = r() * t, s = 0;
  for (i = 0; i < w.length; i++) { s += p[i]; if (v <= s) return i; }
  return w.length - 1;
}

/* ---------- colour ----------
   The generator emits plain float triples in 0..1, not renderer objects: the
   arithmetic below is exactly what THREE.Color.setHex().multiplyScalar() did
   when this code lived in the plate, so the plate still renders identically. */

/** Push one hex colour, scaled, onto a flat r,g,b array. */
export function pushShade(out, hex, k) {
  out.push(((hex >> 16 & 255) / 255) * k, ((hex >> 8 & 255) / 255) * k, ((hex & 255) / 255) * k);
}
/** The three components of a scaled hex colour, when the caller needs them twice. */
export function shadeR(hex, k) { return ((hex >> 16 & 255) / 255) * k; }
export function shadeG(hex, k) { return ((hex >> 8 & 255) / 255) * k; }
export function shadeB(hex, k) { return ((hex & 255) / 255) * k; }
