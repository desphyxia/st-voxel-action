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
 *   4. MATH       src/gen reaches for no arithmetic the spec leaves to the
 *                 implementation, and the replacements in src/gen/exact.mjs
 *                 return the same bits in node's V8 as in the browser's. The
 *                 engines disagree on Math.sin and Math.cos; that is why that
 *                 module exists.
 *   5. MOVE       every clause of the movement budget, against a micro-world
 *                 built to pin it: step, vault, jump, fall, wade, swim, magma.
 *   6. PLAY       a character survives five simulated minutes on every seed
 *                 without falling through the world or ending up inside it.
 *   7. PARITY     the plate's worlds are identical to node's, digest included.
 *   8. GOLDEN     all six pinned seeds match tools/baseline.json exactly.
 *                 The generator is deterministic, so any drift is a real
 *                 change; --update re-records it deliberately.
 *   9. RENDER     the plate still draws.
 *
 * As the prototype gains verbs, each one adds an assertion here — that is the
 * ratchet. See docs/PROTOTYPE.md.
 *
 * No frame-rate assertions: CI renders in software, so timings there are
 * meaningless. Proxy metrics (voxel counts, generation time) are asserted
 * instead, and real performance is checked by hand on a GPU.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, preparePage, launch, tilesDone, GOLDEN_SEEDS, measureSeeds, measureWorld,
         generateSeeds, diffMeasure, mathProbe } from './lib/harness.mjs';
import { budgetSuite, soak, SOAK_TICKS } from './lib/playtest.mjs';
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

/* The static half of the MATH check. The dynamic half, below, proves the
   replacements in src/gen/exact.mjs agree across engines; this one proves
   nothing walked around them. Both are needed: a single stray Math.sin is
   enough to give two players different worlds from the same seed. */
const UNPINNED = /Math\.(sin|cos|tan|asin|acos|atan|atan2|exp|expm1|log|log2|log10|log1p|pow|hypot|cbrt|sinh|cosh|tanh|fround)\b|\*\*/g;
const strays = [];
for (const dir of ['src/gen', 'src/sim']) {
  for (const f of readdirSync(join(ROOT, dir)).filter((n) => n.endsWith('.mjs'))) {
    if (f === 'exact.mjs') continue;                     /* where they are allowed to appear */
    const src = readFileSync(join(ROOT, dir, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const m of src.match(UNPINNED) || []) strays.push(`${dir}/${f}: ${m}`);
  }
}
check(strays.length === 0, 'MATH: src/gen and src/sim use only pinned arithmetic',
      strays.length ? `${strays.join(', ')} — use src/gen/exact.mjs` : '');

const t0 = Date.now();
const worlds = await generateSeeds(GOLDEN_SEEDS);
const measured = worlds.map((w, i) => measureWorld(w, GOLDEN_SEEDS[i].nm));
const genMs = Date.now() - t0;
check(measured.length === GOLDEN_SEEDS.length, 'NODE: src/gen generates every seed, no browser');

/* ---------- MOVE + PLAY: the movement budget, with no browser either ----------
   The controller is deliberately renderer-free, so the verbs can be asserted
   here rather than inferred from a screenshot. MOVE pins each clause of the
   budget against a micro-world built for it; PLAY turns a wanderer loose on
   each generated seed for five simulated minutes, which is the bar in
   docs/PROTOTYPE.md. */
for (const r of budgetSuite()) check(r.ok, `MOVE: ${r.label}`, r.detail);

const t1 = Date.now();
let jumped = 0, vaulted = 0;
for (let i = 0; i < worlds.length; i++) {
  const s = soak(worlds[i], GOLDEN_SEEDS[i].nm);
  jumped += s.jumps; vaulted += s.vaults;
  check(s.survived, `PLAY: ${s.seed} five minutes without falling through`,
        `${s.ticks}/${SOAK_TICKS} ticks, ${s.dead || 'alive'}`);
  /* Falling through the world is the loud failure; ending up inside it is the
     quiet one, and a scripted climb that clips a ledge is how it gets in. */
  check(s.insideTicks === 0, `PLAY: ${s.seed} never inside the ground`,
        `${s.insideTicks} ticks embedded`);
  /* A capsule wedged in a corner survives five minutes perfectly well. */
  check(s.travelled > 300, `PLAY: ${s.seed} covers ground`,
        `${s.travelled} m walked, ${s.displaced} m from spawn`);
}
check(jumped > 0 && vaulted > 0, 'PLAY: jumps and vaults happen on real terrain',
      `${jumped} jumps, ${vaulted} vaults across ${worlds.length} seeds`);
const playMs = Date.now() - t1;

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

  /* ---------- MATH ----------
     Two engines, one sample. If this fails, something in src/gen/exact.mjs has
     picked up an operation the spec only approximates and every PARITY check
     below is about to fail for that reason and no other. */
  const exact = await import('../src/gen/exact.mjs');
  const pageMath = await page.evaluate(
    (src) => new Function(`return (${src})`)()(window.QS), mathProbe.toString());
  const nodeMath = mathProbe(exact);
  check(pageMath === nodeMath, 'MATH: pinned math agrees across engines',
        pageMath === nodeMath ? '' : `node ${nodeMath} → plate ${pageMath}`);

  for (const want of measured) {
    const diffs = diffMeasure(want, inPage.find((m) => m.seed === want.seed));
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
        const diffs = diffMeasure(want, got, ['seed']);
        check(diffs.length === 0, `GOLDEN: ${want.seed}`, diffs.join(', '));
      }
      /* Invariants that must hold for any seed, baseline or not. */
      for (const m of measured) {
        check(m.voxels > 1000, `SANITY: ${m.seed} produced terrain`, `${m.voxels} voxels`);
        /* Every voxel carries a material, and a world uses more than one.
           A stamp that forgets its material breaks the first; a biome table
           that collapsed to a single id breaks the second. */
        check(m.mats === m.voxels, `MATERIAL: ${m.seed} one per voxel`,
              `${m.mats} materials, ${m.voxels} voxels`);
        check(m.matKinds >= 4, `MATERIAL: ${m.seed} uses a range`,
              `${m.matKinds} distinct`);
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
  console.log(`simulation: ${playMs} ms for ${measured.length} x five minutes`);
} finally {
  await browser.close();
}

if (fails.length) {
  console.error(`\n${fails.length} check(s) failed:\n  ${fails.join('\n  ')}`);
  console.error('\nIf the change was intentional: node tools/smoke.mjs --update');
  process.exit(1);
}
console.log('\nall checks passed');
