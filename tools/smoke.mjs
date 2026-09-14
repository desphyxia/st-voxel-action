/**
 * Smoke test — the gate that keeps the build playable.
 *
 *   node tools/smoke.mjs                 # assert everything
 *   node tools/smoke.mjs --node          # only what needs no browser (~2 s)
 *   node tools/smoke.mjs --browser       # only what does
 *   node tools/smoke.mjs --quick         # everything but the render (pre-push hook)
 *   node tools/smoke.mjs --update        # re-record the golden baseline
 *
 * The --node / --browser split exists for CI, which runs them as two jobs. The
 * node half catches most real regressions and comes back in well under a
 * minute; the browser half has to boot Chromium and render in software, and no
 * amount of care makes that fast. A gate slow enough to be resented is a gate
 * that gets bypassed — see issue #25.
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
 *   5b. VIEW      camera-relative movement survives a 90 degree snap, the two
 *                 aiming models agree, and every action is bound and rebindable.
 *   6. PLAY       a character survives five simulated minutes on every seed
 *                 without falling through the world or ending up inside it.
 *   7. PARITY     the plate's worlds are identical to node's, digest included.
 *   8. GOLDEN     all six pinned seeds match tools/baseline.json exactly.
 *                 The generator is deterministic, so any drift is a real
 *                 change; --update re-records it deliberately.
 *   9. RENDER     the plate still draws, and the playable build boots, moves a
 *                 character under the camera it is given, and draws too.
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
import { ROOT, preparePage, launch, GOLDEN_SEEDS, measureSeeds, measureWorld,
         someTileDone, generateSeeds, diffMeasure, mathProbe } from './lib/harness.mjs';
import { budgetSuite, viewSuite, soak, SOAK_TICKS } from './lib/playtest.mjs';
import { TARGETS, staleTargets } from './bundle-gen.mjs';

const argv = process.argv.slice(2);
const UPDATE = argv.includes('--update');
const QUICK = argv.includes('--quick');
/* Which halves to run. Neither flag means both. */
const NODE_HALF = !argv.includes('--browser');
const BROWSER_HALF = !argv.includes('--node') && !UPDATE;
const OUT = join(ROOT, '.render');
const BASELINE = join(ROOT, 'tools/baseline.json');
const TARGET = join(ROOT, 'docs/concept/index.html');
const PLAY_TARGET = join(ROOT, 'docs/play/index.html');

const fails = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? ' ok ' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) fails.push(label);
};

/* ---------- SYNC + NODE: no browser needed ---------- */
const stale = staleTargets().map((s) => s.target.name);
check(stale.length === 0, `SYNC: ${TARGETS.length} pages carry the current src`,
      stale.length ? `${stale.join(', ')} — run: node tools/bundle-gen.mjs` : '');

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
if (NODE_HALF) for (const r of budgetSuite()) check(r.ok, `MOVE: ${r.label}`, r.detail);

/* ---------- VIEW: the camera and the input table ----------
   Both are pure functions of an angle and a lookup, which is the whole reason
   they live in src/sim rather than in the page: "up is still up after you
   rotate the view" and "a mouse point and a stick direction mean the same
   thing" are exactly the claims a screenshot cannot make. */
if (NODE_HALF) for (const r of viewSuite()) check(r.ok, `VIEW: ${r.label}`, r.detail);

const t1 = Date.now();
let jumped = 0, vaulted = 0;
for (let i = 0; NODE_HALF && i < worlds.length; i++) {
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
if (NODE_HALF) {
  check(jumped > 0 && vaulted > 0, 'PLAY: jumps and vaults happen on real terrain',
        `${jumped} jumps, ${vaulted} vaults across ${worlds.length} seeds`);
}
const playMs = Date.now() - t1;

/* ---------- GOLDEN: node work, so it runs without a browser ---------- */
if (NODE_HALF) {
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

}

/* The plate generates its hero world synchronously on load, so even
   DOMContentLoaded can take minutes under software rendering on a slow runner.
   Playwright's 30 s default is nowhere near enough — this failed in CI once. */
const PATIENCE = 600000;

if (BROWSER_HALF) {
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

    /* ---------- RENDER ---------- */
    if (!QUICK && !UPDATE) {
      const rp = await browser.newPage({ viewport: { width: 1100, height: 800 } });
      rp.setDefaultTimeout(PATIENCE);
      rp.setDefaultNavigationTimeout(PATIENCE);
      const rErrors = [];
      rp.on('pageerror', (e) => rErrors.push(e.message));
      const rfile = preparePage({ target: TARGET, outDir: OUT, name: 'smoke-render.html' });
      await rp.goto(`file://${rfile}`, { waitUntil: 'domcontentloaded', timeout: PATIENCE });
      await rp.waitForFunction(someTileDone, null, { timeout: PATIENCE });
      await rp.screenshot({ path: join(OUT, 'smoke.png') });
      check(rErrors.length === 0, 'RENDER: draws without errors', rErrors.slice(0, 2).join(' | '));
      const painted = await rp.evaluate(() => {
        const c = document.querySelector('.tile canvas');
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4000) if (d[i] > 0) n++;
        return n;
      });
      check(painted > 50, 'RENDER: a biome plate has pixels', `${painted} sampled`);
      await rp.close();

      /* ---------- BUILD: the thing you can actually play ----------
         The VIEW checks above prove the camera maths; this proves the page is
         wired to it. Held key in, character moves up the screen — at every one of
         the four view steps, which is the bar in issue #21. Deterministic because
         QSPLAY.run steps the same fixed tick the loop does, so none of it waits on
         a software renderer's frame rate. */
      const bp = await browser.newPage({ viewport: { width: 1100, height: 700 } });
      bp.setDefaultTimeout(PATIENCE);
      bp.setDefaultNavigationTimeout(PATIENCE);
      const bErrors = [];
      bp.on('pageerror', (e) => bErrors.push(e.message));
      bp.on('console', (m) => { if (m.type() === 'error' && !/ERR_/.test(m.text())) bErrors.push(m.text()); });
      const bfile = preparePage({ target: PLAY_TARGET, outDir: OUT, name: 'play.html' });
      await bp.goto(`file://${bfile}`, { waitUntil: 'domcontentloaded', timeout: PATIENCE });
      await bp.waitForFunction(() => !!(window.QSPLAY && window.QSPLAY.ready), null, { timeout: PATIENCE });
      check(bErrors.length === 0, 'BUILD: boots with no page errors', bErrors.slice(0, 3).join(' | '));

      const spawned = await bp.evaluate(() => {
        const a = window.QSPLAY.actor;
        return { y: a.y, grounded: a.grounded, embedded: window.QSPLAY.actor.dead };
      });
      check(spawned.grounded && !spawned.embedded, 'BUILD: the character spawns standing on the world',
            `y ${spawned.y.toFixed(2)}, ${spawned.grounded ? 'grounded' : 'in the air'}`);

      const walked = await bp.evaluate(() => {
        const P = window.QSPLAY, out = [];
        for (let q = 0; q < 4; q++) {
          P.respawn();
          const a0 = P.screen();
          P.input.press('KeyW');
          P.run(45);
          P.input.release('KeyW');
          const a1 = P.screen();
          out.push({ step: q, dx: a1.x - a0.x, dy: a1.y - a0.y });
          /* Snap the view a quarter and settle the easing before the next pass. */
          P.input.press('KeyE'); P.run(1); P.input.release('KeyE'); P.run(90);
        }
        return out;
      });
      /* The follow camera keeps the character near the middle, so the screen
         displacement is small — what matters is that it is upward and that no
         view step sends it sideways or down. */
      const offAxis = walked.filter((w) => !(w.dy < -0.5 && Math.abs(w.dx) < Math.abs(w.dy)));
      check(offAxis.length === 0, 'BUILD: holding up walks up the screen at every view step',
            offAxis.length ? offAxis.map((w) => `step ${w.step} (${w.dx.toFixed(1)}, ${w.dy.toFixed(1)})`).join(', ')
                           : walked.map((w) => w.dy.toFixed(1)).join(' / '));

      await bp.screenshot({ path: join(OUT, 'play.png') });
      const bPainted = await bp.evaluate(() => {
        /* Draw and read in one task: WebGL clears the drawing buffer as soon as
           the browser gets a turn, so a read after an animation frame sees black. */
        window.QSPLAY.draw();
        const c = document.querySelector('#cv');
        const g = document.createElement('canvas');
        g.width = c.width; g.height = c.height;
        const x = g.getContext('2d');
        x.drawImage(c, 0, 0);
        const d = x.getImageData(0, 0, g.width, g.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4000) if (d[i] + d[i + 1] + d[i + 2] > 60) n++;
        return n;
      });
      check(bPainted > 50, 'BUILD: draws', `${bPainted} sampled`);
      check(bErrors.length === 0, 'BUILD: no errors while playing', bErrors.slice(0, 3).join(' | '));
      await bp.close();
    }

  } finally {
    await browser.close();
  }
}

console.log(`\ngeneration: ${genMs} ms for ${measured.length} seeds`);
if (NODE_HALF) console.log(`simulation: ${playMs} ms for ${measured.length} x five minutes`);

if (fails.length) {
  console.error(`\n${fails.length} check(s) failed:\n  ${fails.join('\n  ')}`);
  console.error('\nIf the change was intentional: node tools/smoke.mjs --update');
  process.exit(1);
}
console.log('\nall checks passed');
