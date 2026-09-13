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

export function preparePage({ target, outDir, name = 'page.html' }) {
  let html = readFileSync(target, 'utf8');
  if (!html.includes(CDN)) {
    throw new Error(`three.js CDN tag not found in ${target} — did it change?`);
  }
  if (!existsSync(THREE_LOCAL)) {
    throw new Error('tools/node_modules/three missing — run `npm install` in tools/');
  }
  html = html.replace(CDN, `file://${THREE_LOCAL}`);
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

/**
 * What one generated world contains. Self-contained on purpose: it is called
 * directly against src/gen in node, and serialized into the page to run
 * against the plate's bundled copy, and the two must agree exactly.
 *
 * `digest` hashes every array the generator emits — positions, colours, grass,
 * water, reach, cells. The counts above it would miss a change that swapped
 * two voxels or shifted a colour; the digest would not.
 */
export function measureWorld(d, name) {
  const buf = new DataView(new ArrayBuffer(8));
  let h = 2166136261 >>> 0;
  const num = (v) => {
    buf.setFloat64(0, +v);
    for (let b = 0; b < 8; b++) { h ^= buf.getUint8(b); h = Math.imul(h, 16777619) >>> 0; }
  };
  const arr = (a) => { if (!a) { num(-1); return; } num(a.length); for (let i = 0; i < a.length; i++) num(a[i]); };
  arr(d.pos); arr(d.col); arr(d.mpos); arr(d.mcol);
  arr(d.grass.p); arr(d.grass.ph); arr(d.grass.ti); arr(d.grass.sc); arr(d.grass.yw); arr(d.grass.c);
  arr(d.water.v); arr(d.water.i); arr(d.water.d); arr(d.water.f); arr(d.water.fl);
  arr(d.trail); arr(d.topi); arr(d.unreach); arr(d.reach); arr(d.Hs); arr(d.FLG);
  arr(d.spawn); arr(d.lmPos); arr(d.ovhPos);
  num(d.lamps.length); for (let q = 0; q < d.lamps.length; q++) arr(d.lamps[q]);
  num(d.bridges.length); for (let q = 0; q < d.bridges.length; q++) arr(d.bridges[q]);
  num(d.NX); num(d.NZ); num(d.half); num(d.M); num(d.size);
  for (let q = 0; q < d.cells.length; q++) {
    const c = d.cells[q];
    num(c.H); num(c.water ? 1 : 0); num(c.pond ? 1 : 0); num(c.wl); num(c.magma ? 1 : 0);
    num(c.dom); num(c.cw); num(c.fx); num(c.fz); arr(c.w);
    num(c.sp ? c.sp.length : -1);
    for (let s = 0; c.sp && s < c.sp.length; s++) { num(c.sp[s][0]); num(c.sp[s][1]); }
    num(c.canyon ? c.canyon.d : -1);
  }
  let water = 0, trail = 0, unreach = 0;
  for (let i = 0; i < d.M * d.M; i++) {
    if (d.cells[i].water) water++;
    if (d.trail[i]) trail++;
  }
  for (let i = 0; i < d.unreach.length; i++) unreach += d.unreach[i];
  return {
    seed: name,
    voxels: d.pos.length / 3,
    grass: d.grass.ph.length,
    waterCells: water,
    trailCells: trail,
    bridges: d.bridges.length,
    landmark: !!d.lmPos,
    overhang: !!d.ovhPos,
    unreachPct: +(100 * unreach / d.unreach.length).toFixed(1),
    digest: ('00000000' + (h >>> 0).toString(16)).slice(-8),
  };
}

/** Runs in the page, against the generator the plate has bundled. */
export function measureSeeds(cfgs, measureSrc) {
  const measure = new Function(`return (${measureSrc})`)();
  return cfgs.map((c) => measure(window.QS.buildWorld(c), c.nm));
}

/** Same six seeds, generated in node straight off src/gen. */
export async function measureSeedsInNode(cfgs) {
  const { buildWorld } = await import('../../src/gen/index.mjs');
  return cfgs.map((c) => measureWorld(buildWorld(c), c.nm));
}
