#!/usr/bin/env node
/**
 * Writes assets/vox/hero.vox — the first authored model (#34).
 *
 *   node tools/author-hero.mjs          # rewrite the file
 *   node tools/author-hero.mjs --check  # fail if the file is not what this writes
 *
 * The model is authored here, part by part, as code a person can read and
 * change, and written as a MagicaVoxel file a person can open and keep
 * editing by hand. Once someone does, this script is retired and the file is
 * the source: the page never runs it, it only reads the .vox.
 *
 * One model per part of the hero rig (src/sim/anim.mjs), named for the part it
 * dresses and sized to it at VOX_SCALE, so the bones and poses the boxes had
 * are the ones the model has. Colour indices mean roles — see HERO_VOX_ROLES
 * in src/mesh/vox.mjs — and the palette written here is only what MagicaVoxel
 * shows while editing; the page never draws with it.
 *
 * Grids are laid out in the page's frame: x across, y up, z forward (the way
 * the character faces), and converted to the file's z-up axes on the way out.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeVox } from '../src/mesh/vox.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const HERO_VOX = join(ROOT, 'assets/vox/hero.vox');

/* Colour index -> what MagicaVoxel shows for it. */
const SHOW = {
  1: 0x2f6f7a, 2: 0x234f57, 3: 0xc99a6e, 4: 0xa87c55, 5: 0x3a2a1e, 6: 0x5a3f2a, 7: 0x2e2622,
  8: 0x3b3834, 9: 0x6b604c, 10: 0x16181c, 11: 0x6b6660, 12: 0xa9b0b6, 13: 0xd9a25e,
};
const CLOTH = 1, CLOTH_D = 2, SKIN = 3, SKIN_D = 4, HAIR = 5, LEATHER = 6, BOOT = 7,
  TROUSER = 8, CANVAS = 9, EYE = 10, IRON = 11, STEEL = 12, MARK = 13;

/** [name, [w, h, d], (x, y, z) -> colour or 0] */
const PARTS = [
  ['legL', [3, 9, 4], leg], ['legR', [3, 9, 4], leg],
  ['torso', [8, 10, 6], (x, y, z) => {
    if (y === 9 && (x === 0 || x === 7)) return 0;             /* round the shoulders */
    if (y === 2) return (z === 5 && (x === 3 || x === 4)) ? IRON : LEATHER;   /* belt, buckle */
    if (z === 5 && (x === 3 || x === 4) && y >= 8) return y === 9 ? SKIN : CLOTH_D;  /* the neck of the tunic */
    if (y === 0 || x === 0 || x === 7) return CLOTH_D;          /* hem and sides */
    if (z === 0 && (x === 2 || x === 5) && y > 2) return LEATHER;   /* pack straps over the back */
    return CLOTH;
  }],
  ['pack', [5, 5, 3], (x, y, z) => {
    if (y === 4) return LEATHER;                                /* the flap */
    if (z === 0 && x === 2 && y === 2) return IRON;             /* buckle */
    if (z === 0 && (x === 1 || x === 3)) return LEATHER;        /* straps */
    return CANVAS;
  }],
  ['head', [5, 5, 5], (x, y, z) => {
    if (y === 0 && (x === 0 || x === 4) && (z === 0 || z === 4)) return 0;   /* the jaw's corners */
    if (y === 4 && (x === 0 || x === 4) && (z === 0 || z === 4)) return 0;   /* the crown's */
    if (y === 4) return HAIR;
    if (y >= 2 && z <= 1) return HAIR;                          /* the back */
    if (y >= 3 && (x === 0 || x === 4) && z <= 2) return HAIR;  /* over the ears */
    if (z === 4 && y === 2 && (x === 1 || x === 3)) return EYE;
    if (z === 4 && y === 1 && x === 2) return SKIN_D;           /* mouth */
    if (z === 4 && y === 3) return HAIR;                        /* fringe */
    return SKIN;
  }],
  /* The nose stays, as it did on the boxes: facing has to read at forty
     pixels tall, and this is the one warm mark on the front of the head. */
  ['nose', [2, 2, 3], () => MARK],
  ['armL', [2, 7, 2], (x, y) => (y < 2 ? SKIN : (y === 2 ? CLOTH_D : CLOTH))],
  ['hand', [2, 2, 3], (x, y, z) => (z === 2 ? SKIN : LEATHER)],
  ['guard', [5, 1, 2], (x) => (x === 2 ? MARK : IRON)],
  ['blade', [1, 1, 18], () => STEEL],
];
function leg(x, y, z) {
  if (y < 2) return BOOT;
  if (y === 2) return (z === 3 || z === 0) ? BOOT : LEATHER;    /* boot tops, a strap */
  return TROUSER;
}

export function authorHero() {
  const models = PARTS.map(([name, [w, h, d], fill]) => {
    const xyzi = [];
    for (let z = 0; z < d; z++) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const c = fill(x, y, z);
      /* page (x, y up, z forward) -> file (x, y back, z up) */
      if (c) xyzi.push(x, d - 1 - z, y, c);
    }
    return { name, size: [w, d, h], xyzi: new Uint8Array(xyzi) };
  });
  const palette = new Uint32Array(256);
  for (let i = 1; i < 256; i++) palette[i] = SHOW[i] !== undefined ? SHOW[i] : 0x808080;
  return writeVox({ version: 150, models, palette });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const bytes = authorHero();
  if (process.argv.includes('--check')) {
    let now = null;
    try { now = readFileSync(HERO_VOX); } catch (e) { /* missing */ }
    if (!now || Buffer.compare(Buffer.from(bytes), now) !== 0) {
      console.error('assets/vox/hero.vox is not what tools/author-hero.mjs writes');
      process.exit(1);
    }
    console.log('assets/vox/hero.vox is current');
  } else {
    mkdirSync(dirname(HERO_VOX), { recursive: true });
    writeFileSync(HERO_VOX, bytes);
    console.log(`wrote assets/vox/hero.vox, ${bytes.length} bytes, ${PARTS.length} models`);
  }
}
