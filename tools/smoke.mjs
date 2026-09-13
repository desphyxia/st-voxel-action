/**
 * Smoke test — the gate that keeps the build playable.
 *
 *   node tools/smoke.mjs                 # assert
 *   node tools/smoke.mjs --update        # re-record the golden baseline
 *   node tools/smoke.mjs --quick         # skip the render pass (pre-push hook)
 *
 * Two things are asserted today, because today there is no game yet:
 *
 *   1. BOOT      the target loads and runs with zero page errors, and the
 *                generator produces a scene.
 *   2. GOLDEN    the generator's output for six pinned seeds matches
 *                tools/baseline.json exactly. Deterministic seeds mean any
 *                drift is a real change; --update re-records it deliberately.
 *
 * As the prototype gains verbs, each one adds an assertion here — that is the
 * ratchet. See docs/PROTOTYPE.md. When src/ exists, point TARGET at the game
 * and keep the plate assertions as a separate job.
 *
 * No frame-rate assertions: CI renders in software, so timings there are
 * meaningless. Proxy metrics (voxel counts, generation time) are asserted
 * instead, and real performance is checked by hand on a GPU.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, preparePage, launch, tilesDone, GOLDEN_SEEDS, measureSeeds }
  from './lib/harness.mjs';

const argv = process.argv.slice(2);
const UPDATE = argv.includes('--update');
const QUICK = argv.includes('--quick');
const OUT = join(ROOT, '.render');
const BASELINE = join(ROOT, 'tools/baseline.json');
const TARGET = join(ROOT, 'docs/concept/index.html');

const fails = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? ' ok ' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) fails.push(label);
};

/* The plate generates its hero world synchronously on load, so even
   DOMContentLoaded can take minutes under software rendering on a slow runner.
   Playwright's 30 s default is nowhere near enough — this failed in CI once. */
const PATIENCE = 600000;

const browser = await launch();
try {
  /* ---------- BOOT + GOLDEN ---------- */
  const page = await browser.newPage();
  page.setDefaultTimeout(PATIENCE);
  page.setDefaultNavigationTimeout(PATIENCE);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/ERR_/.test(m.text())) errors.push(m.text()); });

  const file = preparePage({ target: TARGET, outDir: OUT, instrument: true, name: 'smoke.html' });
  await page.goto(`file://${file}`, { waitUntil: 'domcontentloaded', timeout: PATIENCE });
  await page.waitForFunction(() => !!window.__BW, null, { timeout: PATIENCE });

  const t0 = Date.now();
  const measured = await page.evaluate(
    ([cfgs, fnSrc]) => new Function(`return (${fnSrc})`)()(cfgs),
    [GOLDEN_SEEDS, measureSeeds.toString()]);
  const genMs = Date.now() - t0;

  check(errors.length === 0, 'BOOT: no page errors', errors.slice(0, 3).join(' | '));
  check(measured.length === GOLDEN_SEEDS.length, 'BOOT: every seed generated');

  if (UPDATE) {
    writeFileSync(BASELINE, JSON.stringify(measured, null, 1) + '\n');
    console.log(`\nbaseline re-recorded (${measured.length} seeds, ${genMs} ms)`);
  } else {
    check(existsSync(BASELINE), 'GOLDEN: baseline exists', 'run --update to record');
    if (existsSync(BASELINE)) {
      const base = JSON.parse(readFileSync(BASELINE, 'utf8'));
      for (const want of base) {
        const got = measured.find((m) => m.seed === want.seed);
        if (!got) { check(false, `GOLDEN: ${want.seed} generated`); continue; }
        const diffs = Object.keys(want)
          .filter((k) => k !== 'seed' && want[k] !== got[k])
          .map((k) => `${k} ${want[k]} → ${got[k]}`);
        check(diffs.length === 0, `GOLDEN: ${want.seed}`, diffs.join(', '));
      }
      /* Invariants that must hold for any seed, baseline or not. */
      for (const m of measured) {
        check(m.voxels > 1000, `SANITY: ${m.seed} produced terrain`, `${m.voxels} voxels`);
        check(m.landmark, `SANITY: ${m.seed} has a landmark`);
        check(m.waterCells === 0 || m.bridges > 0,
              `SANITY: ${m.seed} water implies a crossing`,
              `${m.waterCells} water cells, ${m.bridges} bridges`);
      }
    }
  }

  /* ---------- RENDER ---------- */
  if (!QUICK && !UPDATE) {
    const rp = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    rp.setDefaultTimeout(PATIENCE);
    rp.setDefaultNavigationTimeout(PATIENCE);
    const rErrors = [];
    rp.on('pageerror', (e) => rErrors.push(e.message));
    const rfile = preparePage({ target: TARGET, outDir: OUT, name: 'smoke-render.html' });
    await rp.goto(`file://${rfile}`, { waitUntil: 'domcontentloaded', timeout: PATIENCE });
    await rp.waitForFunction(tilesDone, null, { timeout: PATIENCE });
    await rp.screenshot({ path: join(OUT, 'smoke.png') });
    check(rErrors.length === 0, 'RENDER: draws without errors', rErrors.slice(0, 2).join(' | '));
    const painted = await rp.evaluate(() => {
      const c = document.querySelector('.tile canvas');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4000) if (d[i] > 0) n++;
      return n;
    });
    check(painted > 50, 'RENDER: biome plates have pixels', `${painted} sampled`);
  }

  console.log(`\ngeneration: ${genMs} ms for ${measured.length} seeds`);
} finally {
  await browser.close();
}

if (fails.length) {
  console.error(`\n${fails.length} check(s) failed:\n  ${fails.join('\n  ')}`);
  console.error('\nIf the change was intentional: node tools/smoke.mjs --update');
  process.exit(1);
}
console.log('\nall checks passed');
