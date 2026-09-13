/**
 * Shared plumbing for the headless harness scripts.
 *
 * The plate (and later the game) loads three.js from cdnjs, which is blocked in
 * some sandboxes and unavailable offline. We rewrite that one tag in a temp copy
 * and point it at the local three.js instead.
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const CDN = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
export const THREE_LOCAL = join(ROOT, 'tools/node_modules/three/build/three.min.js');

/** Instrumentation hook: the generator is inside an IIFE, so we expose it. */
const INSTRUMENT_ANCHOR = '  /* ---------- scene assembly ---------- */';

/**
 * Find a Chromium to drive. Resolved rather than hardcoded, because two things
 * vary: the binary sits in chrome-linux64/ on current revisions and chrome-linux/
 * on older ones, and the installed revision often does not match the one
 * playwright-core expects (this sandbox ships 1194; playwright-core 1.63 wants
 * 1243). Guessing either got CI wrong once already.
 */
export function chromiumPath() {
  const tried = [];
  const pick = (p) => { if (!p) return null; tried.push(p); return existsSync(p) ? p : null; };

  // 1. Explicit override always wins.
  let found = pick(process.env.CHROMIUM_PATH);
  if (found) return found;

  // 2. Whatever playwright-core expects — correct whenever the versions agree.
  try { found = pick(chromium.executablePath()); if (found) return found; } catch { /* none installed */ }

  // 3. Any full Chromium in a browsers cache. Newest revision first.
  //    'chromium_headless_shell-*' is deliberately excluded: we render.
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, join(homedir(), '.cache/ms-playwright')]
    .filter(Boolean).filter(existsSync);
  const layouts = ['chrome-linux64/chrome', 'chrome-linux/chrome',
                   'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe'];
  for (const root of roots) {
    const builds = readdirSync(root)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => parseInt(b.slice(9), 10) - parseInt(a.slice(9), 10));
    for (const dir of builds) {
      for (const layout of layouts) {
        found = pick(join(root, dir, layout));
        if (found) return found;
      }
    }
  }
  throw new Error(
    `No Chromium found. Set CHROMIUM_PATH to a Chromium binary.\nTried:\n  ${tried.join('\n  ')}`);
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
