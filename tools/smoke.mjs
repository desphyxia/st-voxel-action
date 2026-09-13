/**
 * Smoke test — the gate that keeps the build playable.
 *
 *   node tools/smoke.mjs                 # assert
 *   node tools/smoke.mjs --update        # re-record the golden baseline
 *   node tools/smoke.mjs --quick         # skip the render pass (pre-push hook)
 *
 * What is asserted today, because today there is no game yet:
 *
 *   1. SYNC       docs/concept/index.html carries the generator that is in
 *                 src/gen right now. The plate inlines it rather than importing
 *                 it (it has to stay one self-contained file), so drift is
 *                 possible and this is what makes it loud.
 *   2. NODE       src/gen generates every seed with no browser and no DOM.
 *   3. BOOT       the plate loads and runs with zero page errors.
 *   4. PARITY     the plate's worlds are identical to node's, digest included.
 *   5. GOLDEN     all six pinned seeds match tools/baseline.json exactly.
 *                 The generator is deterministic, so any drift is a real
 *                 change; --update re-records it deliberately.
 *   6. RENDER     the plate still draws.
 *
 * As the prototype gains verbs, each one adds an assertion here — that is the
 * ratchet. See docs/PROTOTYPE.md.
 *
 * No frame-rate assertions: CI renders in software, so timings there are
 * meaningless. Proxy metrics (voxel counts, generation time) are asserted
 * instead, and real performance is checked by hand on a GPU.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, preparePage, launch, tilesDone, GOLDEN_SEEDS, measureSeeds, measureWorld,
         measureSeedsInNode } from './lib/harness.mjs';
import { PLATE, withBundle } from './bundle-gen.mjs';

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

/* ---------- SYNC + NODE: no browser needed ---------- */
const plateHtml = readFileSync(PLATE, 'utf8');
const inSync = withBundle(plateHtml) === plateHtml;
check(inSync, 'SYNC: plate carries the current src/gen',
      inSync ? '' : 'run: node tools/bundle-gen.mjs');

const t0 = Date.now();
const measured = await measureSeedsInNode(GOLDEN_SEEDS);
const genMs = Date.now() - t0;
check(measured.length === GOLDEN_SEEDS.length, 'NODE: src/gen generates every seed, no browser');

/* The plate generates its hero world synchronously on load, so even
   DOMContentLoaded can take minutes under software rendering on a slow runner.
   Playwright's 30 s default is nowhere near enough — this failed in CI once. */
const PATIENCE = 600000;

const browser = await launch();
try {
  /* ---------- BOOT + PARITY ---------- */
  const page = await browser.newPage();
  page.setDefaultTimeout(PATIENCE);
  page.setDefaultNavigationTimeout(PATIENCE);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/ERR_/.test(m.text())) errors.push(m.text()); });

  const file = preparePage({ target: TARGET, outDir: OUT, name: 'smoke.html' });
  await page.goto(`file://${file}`, { waitUntil: 'domcontentloaded', timeout: PATIENCE });
  await page.waitForFunction(() => !!(window.QS && window.QS.buildWorld), null, { timeout: PATIENCE });

  const inPage = await page.evaluate(
    ([cfgs, fnSrc, measureSrc]) => new Function(`return (${fnSrc})`)()(cfgs, measureSrc),
    [GOLDEN_SEEDS, measureSeeds.toString(), measureWorld.toString()]);

  check(errors.length === 0, 'BOOT: no page errors', errors.slice(0, 3).join(' | '));
  check(inPage.length === GOLDEN_SEEDS.length, 'BOOT: every seed generated in the plate');

  for (const want of measured) {
    const got = inPage.find((m) => m.seed === want.seed);
    const diffs = !got ? ['missing']
      : Object.keys(want).filter((k) => want[k] !== got[k]).map((k) => `${k} ${want[k]} → ${got[k]}`);
    check(diffs.length === 0, `PARITY: ${want.seed} plate matches src/gen`, diffs.join(', '));
  }

  /* The plate renders its hero continuously from requestAnimationFrame. Leave
     this page open and it competes with the render pass below for the whole
     run — on a 4-core box in software that is the difference between 90 s and
     a timeout. It has done its job; close it. */
  await page.close();

  /* ---------- GOLDEN ---------- */
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
