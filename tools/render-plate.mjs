/**
 * Headless render / verify harness for the concept plate.
 *
 * The plate loads three.js from cdnjs, which is blocked in some sandboxes and
 * unavailable offline. This script makes a temp copy of the plate pointing at a
 * local three.js instead, drives it in headless Chromium, and can either
 * screenshot it, export the biome plates, or instrument the generator.
 *
 *   node tools/render-plate.mjs --shots            # page screenshots
 *   node tools/render-plate.mjs --plates           # export the six biome PNGs
 *   node tools/render-plate.mjs --diag             # generator stats per seed
 *
 *   --out <dir>     where to write (default: ./.render)
 *   --width <px>    viewport width (default: 1280)
 *
 * Env:
 *   CHROMIUM_PATH   path to a Chromium binary. Defaults to the Playwright
 *                   browser bundled in Claude Code's remote sandbox; set it
 *                   explicitly anywhere else.
 *
 * Software rendering is slow: a full run takes minutes, not seconds.
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

const OUT = resolve(opt('out', join(ROOT, '.render')));
const WIDTH = parseInt(opt('width', '1280'), 10);
const CDN = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
const THREE_LOCAL = join(ROOT, 'tools/node_modules/three/build/three.min.js');
const EXEC = process.env.CHROMIUM_PATH
  || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/* The plate is one self-contained file; we rewrite two things in a temp copy. */
function preparePage({ instrument }) {
  let html = readFileSync(join(ROOT, 'docs/concept/index.html'), 'utf8');
  if (!html.includes(CDN)) throw new Error('three.js CDN tag not found — did the plate change?');
  html = html.replace(CDN, `file://${THREE_LOCAL}`);
  if (instrument) {
    const anchor = '  /* ---------- scene assembly ---------- */';
    if (!html.includes(anchor)) throw new Error('instrumentation anchor not found in the plate');
    html = html.replace(anchor, '  window.__BW=buildWorld;\n' + anchor);
  }
  mkdirSync(OUT, { recursive: true });
  const path = join(OUT, instrument ? 'diag.html' : 'test.html');
  writeFileSync(path, html);
  return path;
}

async function launch() {
  return chromium.launch({
    executablePath: EXEC,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
           '--no-sandbox', '--disable-dev-shm-usage'],
  });
}

/** The plate marks each biome tile done by hiding its "generating…" label. */
const tilesDone = () =>
  [...document.querySelectorAll('.wait')].every((w) => w.style.display === 'none');

async function shots() {
  const file = preparePage({ instrument: false });
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: WIDTH, height: 950 } });
  page.setDefaultTimeout(300000);
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`file://${file}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(tilesDone, null, { timeout: 300000 });
  await page.screenshot({ path: join(OUT, 'hero.png') });
  for (const [name, y] of [['tiles', 1150], ['world', 2200], ['traversability', 3000],
                           ['frames', 5600], ['matrix', 7000]]) {
    await page.evaluate((v) => window.scrollTo(0, v), y);
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(OUT, `${name}.png`) });
  }
  console.log(`wrote screenshots to ${OUT}`);
  console.log('page errors:', errs.join(' | ') || 'none');
  await browser.close();
}

async function plates() {
  const file = preparePage({ instrument: false });
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: WIDTH, height: 950 } });
  page.setDefaultTimeout(300000);
  await page.goto(`file://${file}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(tilesDone, null, { timeout: 300000 });
  const tiles = await page.evaluate(() => [...document.querySelectorAll('.tile')].map((t) => ({
    name: t.querySelector('.nm').textContent,
    data: t.querySelector('canvas').toDataURL('image/png'),
  })));
  const dir = join(OUT, 'plates');
  mkdirSync(dir, { recursive: true });
  tiles.forEach((t, i) => {
    const slug = t.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    writeFileSync(join(dir, `${String(i + 1).padStart(2, '0')}-${slug}.png`),
                  Buffer.from(t.data.split(',')[1], 'base64'));
  });
  console.log(`wrote ${tiles.length} plates to ${dir}`);
  await browser.close();
}

/**
 * Generator stats without rendering anything. This is the mode that catches
 * silent generation regressions — a feature that stops being produced looks
 * identical to one that was never there, until you count it.
 */
async function diag() {
  const file = preparePage({ instrument: true });
  const browser = await launch();
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`file://${file}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__BW, null, { timeout: 120000 });
  const rows = await page.evaluate(() => {
    const cfgs = [
      { nm: 'meadow', seed: 'ALDER-RUN', force: 0, size: 32, ox: 700, oz: 430 },
      { nm: 'mesa', seed: 'DRY-KETTLE', force: 1, size: 32, ox: 1400, oz: 860 },
      { nm: 'fen', seed: 'BLACKREED', force: 2, size: 32, ox: 2100, oz: 1290 },
      { nm: 'ash', seed: 'CINDERWAKE', force: 3, size: 32, ox: 2800, oz: 1720 },
      { nm: 'frost', seed: 'HOARFROST-9', force: 4, size: 32, ox: 3500, oz: 2150 },
      { nm: 'hero', seed: 'QUARTERSTONE', force: null, size: 64, ox: 0, oz: 0 },
    ];
    return cfgs.map((c) => {
      const d = window.__BW(c);
      let water = 0, trail = 0, unreach = 0;
      for (let i = 0; i < d.M * d.M; i++) { if (d.cells[i].water) water++; if (d.trail[i]) trail++; }
      for (let i = 0; i < d.unreach.length; i++) unreach += d.unreach[i];
      return {
        seed: c.nm,
        voxels: d.pos.length / 3,
        grass: d.grass.ph.length,
        waterCells: water,
        trailCells: trail,
        bridges: d.bridges.length,
        landmark: d.lmPos ? 'yes' : 'NONE',
        overhang: d.ovhPos ? 'yes' : 'NONE',
        unreachPct: +(100 * unreach / d.unreach.length).toFixed(1),
      };
    });
  });
  console.table(rows);
  console.log('page errors:', errs.join(' | ') || 'none');
  await browser.close();
}

const mode = flag('plates') ? plates : flag('diag') ? diag : shots;
mode().catch((e) => { console.error(e); process.exit(1); });
