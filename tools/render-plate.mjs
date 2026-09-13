/**
 * Headless render harness for the concept plate.
 *
 *   node tools/render-plate.mjs --shots     # page screenshots
 *   node tools/render-plate.mjs --plates    # export the six biome PNGs
 *   node tools/render-plate.mjs --diag      # generator stats per seed (no rendering)
 *
 *   --out <dir>     where to write (default: ./.render)
 *   --width <px>    viewport width (default: 1280)
 *
 * Env: CHROMIUM_PATH — path to a Chromium binary. Defaults to the Playwright
 * build bundled in Claude Code's remote sandbox; set it explicitly elsewhere.
 *
 * Software rendering is slow: a full run takes minutes. --diag skips rendering.
 * For the assertion gate rather than a look, use tools/smoke.mjs.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, preparePage, launch, tilesDone, GOLDEN_SEEDS, measureSeeds, measureWorld }
  from './lib/harness.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

const OUT = join(ROOT, opt('out', '.render'));
const WIDTH = parseInt(opt('width', '1280'), 10);
const TARGET = join(ROOT, 'docs/concept/index.html');

const browser = await launch();
try {
  if (flag('diag')) {
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    const file = preparePage({ target: TARGET, outDir: OUT, name: 'diag.html' });
    await page.goto(`file://${file}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window.QS && window.QS.buildWorld), null, { timeout: 120000 });
    const rows = await page.evaluate(
      ([cfgs, fnSrc, measureSrc]) => new Function(`return (${fnSrc})`)()(cfgs, measureSrc),
      [GOLDEN_SEEDS, measureSeeds.toString(), measureWorld.toString()]);
    console.table(rows);
    console.log('page errors:', errs.join(' | ') || 'none');
  } else {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: 950 } });
    page.setDefaultTimeout(600000);
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    const file = preparePage({ target: TARGET, outDir: OUT, name: 'test.html' });
    await page.goto(`file://${file}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(tilesDone, null, { timeout: 600000 });

    if (flag('plates')) {
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
    } else {
      await page.screenshot({ path: join(OUT, 'hero.png') });
      for (const [name, y] of [['tiles', 1150], ['world', 2200], ['traversability', 3000],
                               ['frames', 5600], ['matrix', 7000]]) {
        await page.evaluate((v) => window.scrollTo(0, v), y);
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(OUT, `${name}.png`) });
      }
      console.log(`wrote screenshots to ${OUT}`);
    }
    console.log('page errors:', errs.join(' | ') || 'none');
  }
} finally {
  await browser.close();
}
