/**
 * Shared plumbing for the headless harness scripts.
 *
 * The plate (and later the game) loads three.js from cdnjs, which is blocked in
 * some sandboxes and unavailable offline. We rewrite that one tag in a temp copy
 * and point it at the local three.js instead.
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const CDN = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
export const THREE_LOCAL = join(ROOT, 'tools/node_modules/three/build/three.min.js');

/** Instrumentation hook: the generator is inside an IIFE, so we expose it. */
const INSTRUMENT_ANCHOR = '  /* ---------- scene assembly ---------- */';

export function chromiumPath() {
  const p = process.env.CHROMIUM_PATH
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  if (!existsSync(p)) {
    throw new Error(
      `Chromium not found at ${p}. Set CHROMIUM_PATH to a Chromium binary.`);
  }
  return p;
}

export function preparePage({ target, outDir, instrument = false, name = 'page.html' }) {
  let html = readFileSync(target, 'utf8');
  if (!html.includes(CDN)) {
    throw new Error(`three.js CDN tag not found in ${target} — did it change?`);
  }
  if (!existsSync(THREE_LOCAL)) {
    throw new Error('tools/node_modules/three missing — run `npm install` in tools/');
  }
  html = html.replace(CDN, `file://${THREE_LOCAL}`);
  if (instrument) {
    if (!html.includes(INSTRUMENT_ANCHOR)) {
      throw new Error('instrumentation anchor not found — the generator moved');
    }
    html = html.replace(INSTRUMENT_ANCHOR, '  window.__BW=buildWorld;\n' + INSTRUMENT_ANCHOR);
  }
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, name);
  writeFileSync(path, html);
  return path;
}

export function launch() {
  return chromium.launch({
    executablePath: chromiumPath(),
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
           '--no-sandbox', '--disable-dev-shm-usage'],
  });
}

/** The plate marks each biome tile done by hiding its "generating…" label. */
export const tilesDone = () =>
  [...document.querySelectorAll('.wait')].every((w) => w.style.display === 'none');

/** Seeds the golden-master baseline is measured against. */
export const GOLDEN_SEEDS = [
  { nm: 'meadow', seed: 'ALDER-RUN', force: 0, size: 32, ox: 700, oz: 430 },
  { nm: 'mesa', seed: 'DRY-KETTLE', force: 1, size: 32, ox: 1400, oz: 860 },
  { nm: 'fen', seed: 'BLACKREED', force: 2, size: 32, ox: 2100, oz: 1290 },
  { nm: 'ash', seed: 'CINDERWAKE', force: 3, size: 32, ox: 2800, oz: 1720 },
  { nm: 'frost', seed: 'HOARFROST-9', force: 4, size: 32, ox: 3500, oz: 2150 },
  { nm: 'hero', seed: 'QUARTERSTONE', force: null, size: 64, ox: 0, oz: 0 },
];

/** Runs in the page. Counts what the generator produced, without rendering it. */
export function measureSeeds(cfgs) {
  return cfgs.map((c) => {
    const d = window.__BW(c);
    let water = 0, trail = 0, unreach = 0;
    for (let i = 0; i < d.M * d.M; i++) {
      if (d.cells[i].water) water++;
      if (d.trail[i]) trail++;
    }
    for (let i = 0; i < d.unreach.length; i++) unreach += d.unreach[i];
    return {
      seed: c.nm,
      voxels: d.pos.length / 3,
      grass: d.grass.ph.length,
      waterCells: water,
      trailCells: trail,
      bridges: d.bridges.length,
      landmark: !!d.lmPos,
      overhang: !!d.ovhPos,
      unreachPct: +(100 * unreach / d.unreach.length).toFixed(1),
    };
  });
}
