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
 *   5c. COMBAT    a committed swing: three windows, a stamina cost, an arc that
 *                 is an arc, and a dodge that cancels recovery and nothing else.
 *   5d. ENEMY     one machine that closes, telegraphs, swings, staggers and
 *                 dies — and a dodge through its strike that costs nothing.
 *   5e. GEAR      a hex lattice: a module does nothing until it is socketed,
 *                 a fusion needs a shared edge *and* a recipe found in the
 *                 world, and what is on the ground is derived on both machines
 *                 rather than sent — one integer of it crosses.
 *   5f. NET       a host and a guest agree exactly after latency and packet
 *                 loss, the host is authoritative, and no terrain crosses.
 *   6. PLAY       a character survives five simulated minutes on every seed
 *                 without falling through the world or ending up inside it.
 *   7. PARITY     the plate's worlds are identical to node's, digest included.
 *   8. GOLDEN     all six pinned seeds match tools/baseline.json exactly.
 *                 The generator is deterministic, so any drift is a real
 *                 change; --update re-records it deliberately.
 *   9. RENDER     the plate still draws, and the playable build boots, moves a
 *                 character under the camera it is given, and draws too.
 *  10. NET (page) two windows, postMessage between them, and a key pressed in
 *                 one moving a character in the other.
 *  11. BUILD      a swing winds up, draws an arc you can actually count pixels
 *                 of, and strikes what is in front of it once; a machine
 *                 notices, closes, telegraphs visibly, and can be killed; and
 *                 there is loot in the world to walk to, which seats in the
 *                 lattice and widens the arc the player is reading; and the
 *                 stage can fill the screen with the canvas following it, by
 *                 either of the two routes a page in an iframe may get.
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
import { budgetSuite, viewSuite, combatSuite, enemySuite, gearSuite, netSuite,
         soak, SOAK_TICKS } from './lib/playtest.mjs';
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
for (const dir of ['src/gen', 'src/sim', 'src/net']) {
  for (const f of readdirSync(join(ROOT, dir)).filter((n) => n.endsWith('.mjs'))) {
    if (f === 'exact.mjs') continue;                     /* where they are allowed to appear */
    const src = readFileSync(join(ROOT, dir, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const m of src.match(UNPINNED) || []) strays.push(`${dir}/${f}: ${m}`);
  }
}
check(strays.length === 0, 'MATH: src/ uses only pinned arithmetic',
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

/* ---------- COMBAT: the first verb that is not movement ----------
   None of these numbers are balance — #9 decides that. What is pinned here is
   the shape: that a swing is committed rather than merely slow, that it costs
   something, and that the arc is an arc. */
if (NODE_HALF) for (const r of combatSuite()) check(r.ok, `COMBAT: ${r.label}`, r.detail);

/* ---------- ENEMY: something that fights back ----------
   The telegraph is what these are really about. From 45 degrees you see the top
   of things, and a wind-up you cannot read is a fight you cannot learn — so the
   assertions are about windows and openings, not about damage. */
if (NODE_HALF) for (const r of enemySuite()) check(r.ok, `ENEMY: ${r.label}`, r.detail);

/* ---------- GEAR: modules, sockets, fusion and what is on the ground ----------
   The spine of progression (§4), and the first reason this world has anywhere
   worth going. Same terms as COMBAT: none of these numbers are balance. What is
   pinned is the shape — that a lattice is adjacency rather than a list, that a
   fusion needs both a shared edge and a recipe you went and found, and that
   what is lying on the ground is derived on both machines rather than sent. */
if (NODE_HALF) for (const r of gearSuite()) check(r.ok, `GEAR: ${r.label}`, r.detail);

/* ---------- NET: two players, one world, one authority ----------
   A host and a guest over a loopback wire with latency and loss dialled in. The
   claim these are really testing is the controller's determinism: replaying the
   same inputs from the same state has to reproduce the host exactly, or a guest
   can only ever be approximately where it thinks it is. */
if (NODE_HALF) for (const r of netSuite()) check(r.ok, `NET: ${r.label}`, r.detail);

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

      /* ---------- BUILD: does a swing read? ----------
         The literal question in issue #23. Everything else about the swing is
         asserted in node, where it is maths; whether you can *see* it is only
         answerable by counting lit pixels where the arc should be, against the
         same frame with no swing in it. */
      const reads = await bp.evaluate(() => {
        const P = window.QSPLAY, QS = window.QS;
        const pale = () => {
          P.draw();
          const c = document.querySelector('#cv');
          const g = document.createElement('canvas');
          g.width = c.width; g.height = c.height;
          const x = g.getContext('2d');
          x.drawImage(c, 0, 0);
          const s = P.screen(), R = 90;
          const d = x.getImageData(Math.max(0, (s.x - R) | 0), Math.max(0, (s.y - R) | 0),
                                   R * 2, R * 2).data;
          let n = 0;
          for (let i = 0; i < d.length; i += 4) {
            if (d[i] > 210 && d[i + 1] > 195 && d[i + 2] > 150) n++;
          }
          return n;
        };
        /* Stand next to a practice post, facing it, with the clock stopped. */
        P.pause(true);
        const t = P.targets[0], a = P.actor;
        a.x = t.x - 1.15; a.z = t.z - 0.25; a.y = t.y;
        a.faceX = 1; a.faceZ = 0; a.vx = 0; a.vz = 0;
        a.stamina = QS.STAMINA_MAX; a.staminaHold = 0; a.swing = null; a.dodge = null;
        QS.warpTo(P.cam, a.x, a.y, a.z);
        const before = pale(), struckBefore = P.struck;
        P.input.press('KeyF'); P.run(1); P.input.release('KeyF');
        const windup = QS.phase(a) === QS.PHASE.WINDUP;
        while (QS.phase(a) !== QS.PHASE.ACTIVE) P.run(1);
        P.run(2);
        const during = pale(), sweeping = P.sweeping;
        while (a.swing) P.run(1);
        P.pause(false);
        return { before, during, sweeping, windup, struck: P.struck - struckBefore };
      });
      check(reads.windup && reads.sweeping, 'BUILD: a swing has a wind-up and shows its arc',
            `${reads.windup ? 'wound up' : 'no wind-up'}, ${reads.sweeping ? 'arc drawn' : 'ARC MISSING'}`);
      check(reads.during > reads.before + 40, 'BUILD: and the arc is visible on screen',
            `${reads.before} lit pixels idle, ${reads.during} mid-swing`);
      check(reads.struck === 1, 'BUILD: a post in the arc is struck, once',
            `${reads.struck} hits`);

      /* ---------- BUILD: is there anything to find, and does it change the
           thing you are looking at? ----------
         The node half proves the lattice arithmetic. What it cannot prove is
         that the world has any of it lying in it, or that seating a module
         changes what is drawn rather than only what is computed — a sigil that
         widened the hitbox and left the arc alone would be a lie on the floor,
         and it is the arc the player is reading. So: walk onto a cache, then
         count the same pale pixels the swing check counts, bare and seated. */
      const found = await bp.evaluate(() => {
        const P = window.QSPLAY, QS = window.QS;
        P.pause(true);
        const a = P.actor;
        a.hp = QS.PLAYER_HP; a.dead = null;
        const loose = P.loose;
        const caches = loose.filter((o) => o.kind === 'cache');
        if (!caches.length) { P.pause(false); return { caches: 0 }; }
        const it = caches[0].item;
        const before = { carried: P.gear.carried.length, known: P.gear.known, loose: loose.length };
        a.x = it.x; a.y = it.y; a.z = it.z; a.vx = 0; a.vz = 0; a.vy = 0;
        QS.warpTo(P.cam, a.x, a.y, a.z);
        P.run(4);
        const after = { carried: P.gear.carried.length, known: P.gear.known,
                        loose: P.loose.length };
        P.pause(false);
        return { caches: caches.length, before, after,
                 seated: P.gear.slots.filter((v) => v >= 0).length };
      });
      check(found.caches > 0, 'BUILD: the world has caches in it to walk to',
            `${found.caches} still unopened`);
      check(!!found.after && found.after.carried === found.before.carried + 1
              && found.after.known !== found.before.known
              && found.after.loose === found.before.loose - 1,
            'BUILD: and walking onto one hands over a module and a recipe',
            found.after ? `carried ${found.before.carried} → ${found.after.carried}, `
                          + `recipes ${found.before.known} → ${found.after.known}, `
                          + `${found.before.loose} → ${found.after.loose} left on the ground`
                        : 'nothing to find');

      const widened = await bp.evaluate(() => {
        const P = window.QSPLAY, QS = window.QS;
        const lit = () => {
          P.draw();
          const c = document.querySelector('#cv');
          const g = document.createElement('canvas');
          g.width = c.width; g.height = c.height;
          const x = g.getContext('2d');
          x.drawImage(c, 0, 0);
          const s = P.screen(), R = 110;
          const d = x.getImageData(Math.max(0, (s.x - R) | 0), Math.max(0, (s.y - R) | 0),
                                   R * 2, R * 2).data;
          let n = 0;
          for (let i = 0; i < d.length; i += 4) {
            if (d[i] > 210 && d[i + 1] > 195 && d[i + 2] > 150) n++;
          }
          return n;
        };
        /* One swing, held at its widest, with the clock stopped.
           The press is retried rather than assumed: `step` reads the attack
           before it recomputes whether the actor is standing in water, so the
           first tick after a teleport can refuse the swing on the *previous*
           position's state — and a single consumed press with a `while` after
           it is an infinite loop, not a failed check. Every loop is bounded for
           the same reason. */
        const swingAndCount = () => {
          const a = P.actor;
          let guard = 0;
          while (!a.swing && guard++ < 240) {
            a.stamina = a.st.maxStamina; a.staminaHold = 0;
            a.dodge = null; a.vault = null; a.dead = null;
            P.input.press('KeyF'); P.run(1); P.input.release('KeyF');
          }
          if (!a.swing) return -1;
          while (QS.phase(a) !== QS.PHASE.ACTIVE && guard++ < 480) P.run(1);
          P.run(1);
          const n = lit();
          while (a.swing && guard++ < 720) P.run(1);
          return n;
        };
        P.pause(true);
        const t = P.targets[0], a = P.actor;
        a.x = t.x - 1.15; a.z = t.z - 0.25; a.y = t.y;
        a.faceX = 1; a.faceZ = 0; a.vx = 0; a.vz = 0;
        a.hp = QS.PLAYER_HP; a.dead = null; a.swing = null; a.dodge = null; a.vault = null;
        QS.warpTo(P.cam, a.x, a.y, a.z);
        /* Whatever in this patch of world is already pale. Subtracted from
           both counts, so what is compared is arc against arc. One settling
           tick first, so the actor's idea of where it is standing has caught
           up with where it was just put. */
        P.run(2);
        const idle = lit();
        const bare = swingAndCount();
        const bareReach = a.st.reach;
        /* Empty the lattice first: the cache above may already have filled it. */
        for (let q = 0; q < P.gear.slots.length; q++) P.unsocket(q);
        while (P.gear.carried.length) P.gear.carried.pop();
        P.give(QS.MOD.SIGIL);
        const seated = P.socket(0, 0);
        const kit = swingAndCount();
        P.pause(false);
        return { idle, bare: bare - idle, kit: kit - idle,
                 bareReach, kitReach: a.st.reach, seated };
      });
      check(widened.seated && widened.kitReach > widened.bareReach,
            'BUILD: a module seated in the lattice changes what the blade covers',
            `${widened.bareReach.toFixed(2)} m bare, ${widened.kitReach.toFixed(2)} m seated`);
      check(widened.bare > 0 && widened.kit > widened.bare * 1.2,
            'BUILD: and the arc on screen is the one it actually cuts with',
            `${widened.bare} lit pixels bare, ${widened.kit} with the sigil, `
            + `over ${widened.idle} already pale`);

      /* ---------- BUILD: does the telegraph read? ----------
         The question issue #24 turns on. Counting a colour band the way the
         swing check does is the wrong instrument here: the wedge is a
         translucent overlay, so what lands on screen is the terrain's colour
         mixed with the tell's, and no fixed band both catches that mix and
         excludes dry grass. So hold the machine still and toggle only the
         tell: two frames of the same world, one winding up and one not, and
         count the pixels that go orange between them. Nothing else moves, so
         every pixel counted is the telegraph. */
      const tells = await bp.evaluate(() => {
        const P = window.QSPLAY, QS = window.QS;
        const grab = () => {
          P.draw();
          const c = document.querySelector('#cv');
          const g = document.createElement('canvas');
          g.width = c.width; g.height = c.height;
          const x = g.getContext('2d');
          x.drawImage(c, 0, 0);
          return { d: x.getImageData(0, 0, g.width, g.height).data, w: g.width };
        };
        P.pause(true);
        const foes = P.foes;
        if (!foes || !foes.length) return { foes: 0 };
        const m = foes[0], a = P.actor;
        /* Put the machine back the way it was found: the checks above walked
           the character around, and one of these may already have noticed. */
        const live = P.machines[0];
        live.ai.state = QS.EST.DORMANT; live.ai.t = 0; live.ai.sideT = 0;
        live.hp = QS.SENTRY.hp; live.dead = null;
        /* Just outside its reach, facing it. */
        a.x = m.x - 3.0; a.z = m.z; a.y = m.y; a.faceX = 1; a.faceZ = 0;
        a.vx = 0; a.vz = 0; a.hp = QS.PLAYER_HP; a.dead = null;
        QS.warpTo(P.cam, a.x, a.y, a.z);
        P.run(1);
        let n = 0, tele = 0, sawWake = false, sawClose = false;
        while (n < 1200) {
          P.run(1); n++;
          a.hp = QS.PLAYER_HP;                   /* this is a rendering test */
          const s = P.foes[0].s;
          if (s === QS.EST.WAKE) sawWake = true;
          if (s === QS.EST.CLOSE) sawClose = true;
          if (s === QS.EST.TELEGRAPH) { tele++; if (tele >= 36) break; }
        }
        /* Late in the wind-up, where the tell is at its most emphatic. */
        const lit = grab();
        const held = live.ai.t;
        live.ai.state = QS.EST.CLOSE; live.ai.t = 0;
        const dark = grab();                     /* same frame, no tell */
        live.ai.state = QS.EST.TELEGRAPH; live.ai.t = held;
        let orange = 0, cx = 0, cy = 0;
        for (let i = 0; i < lit.d.length; i += 4) {
          const dr = lit.d[i] - dark.d[i], db = lit.d[i + 2] - dark.d[i + 2];
          if (dr > 20 && dr - db > 30) {
            orange++;
            const q = i / 4; cx += q % lit.w; cy += (q / lit.w) | 0;
          }
        }
        const s = P.screen();
        const off = orange ? Math.hypot(cx / orange - s.x, cy / orange - s.y) : Infinity;
        /* Then kill it, to prove the loop closes. */
        let guard = 0;
        while (!P.foes[0] || (P.foes[0].s !== QS.EST.DEAD && guard < 4000)) {
          guard++;
          const f = P.foes[0], dx = f.x - a.x, dz = f.z - a.z;
          const l = Math.hypot(dx, dz) || 1;
          a.hp = QS.PLAYER_HP;
          a.stamina = QS.STAMINA_MAX; a.staminaHold = 0;
          if (l > 1.3) { a.x += (dx / l) * 0.04; a.z += (dz / l) * 0.04; }
          else if (!a.swing) { P.input.press('KeyF'); P.run(1); P.input.release('KeyF'); continue; }
          a.faceX = dx / l; a.faceZ = dz / l;
          P.run(1);
        }
        P.pause(false);
        return { foes: foes.length, orange, off, tele, sawWake, sawClose,
                 dead: P.foes[0] && P.foes[0].s === QS.EST.DEAD, hp: P.foes[0] && P.foes[0].h };
      });
      check(tells.foes > 0 && tells.sawWake && tells.sawClose,
            'BUILD: a machine notices and closes',
            `${tells.foes} machines, ${tells.sawWake ? 'woke' : 'NEVER WOKE'}, `
            + `${tells.sawClose ? 'closed' : 'NEVER CLOSED'}`);
      /* Big enough to see, and near enough to the character to be seen while
         you are looking at the fight rather than hunting for it. */
      check(tells.orange > 300 && tells.off < 160,
            'BUILD: and its telegraph is visible on screen',
            `${tells.orange} px turn orange, ${Number.isFinite(tells.off) ? tells.off.toFixed(0) : '-'} px from the character`);
      check(tells.dead && tells.hp === 0, 'BUILD: and it can be killed',
            tells.dead ? 'down' : `still up on ${tells.hp} hp`);

      /* ---------- BUILD: fullscreen ----------
         Two paths, because a published artifact runs in an iframe and only gets
         native fullscreen if the host granted allow="fullscreen". Both have to
         end with the drawing buffer matching the box it is drawn into — a stage
         that grew while the canvas did not is a stretched, wrongly-framed game.

         `settled` polls rather than sleeps: fullscreenchange fires before the
         new box is laid out, and under software rendering a frame is most of a
         second, so any fixed wait here measures the renderer instead. */
      const stageFits = () => bp.waitForFunction(() => {
        const st = document.querySelector('#stage'), c = document.querySelector('#cv');
        const r = st.getBoundingClientRect();
        return c.width === Math.max(1, r.width | 0) && c.height === Math.max(1, r.height | 0);
      }, null, { timeout: PATIENCE });
      const stageState = () => bp.evaluate(() => {
        const st = document.querySelector('#stage'), c = document.querySelector('#cv');
        const r = st.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), cw: c.width, ch: c.height,
                 filling: document.fullscreenElement === st || st.classList.contains('maxed'),
                 exit: getComputedStyle(document.querySelector('#exitfs')).display };
      });
      await stageFits();
      const fsBefore = await stageState();
      await bp.click('#fullbtn');
      await stageFits();
      const fsOn = await stageState();
      await bp.click('#exitfs');
      await stageFits();
      const fsOff = await stageState();
      check(fsOn.filling && fsOn.h > fsBefore.h && fsOn.cw === fsOn.w && fsOn.ch === fsOn.h,
            'BUILD: fullscreen fills the screen and the canvas follows',
            `${fsBefore.w}x${fsBefore.h} to ${fsOn.w}x${fsOn.h}, canvas ${fsOn.cw}x${fsOn.ch}`);
      check(fsOn.exit !== 'none', 'BUILD: and there is a way out from inside it',
            fsOn.exit !== 'none' ? 'exit control shown' : 'NO EXIT — the stage covers the button');
      check(!fsOff.filling && fsOff.h === fsBefore.h && fsOff.cw === fsOff.w,
            'BUILD: and leaving it puts the stage back',
            `${fsOff.w}x${fsOff.h}, canvas ${fsOff.cw}x${fsOff.ch}`);

      /* ---------- NET in a browser ----------
         The loopback suite proves the protocol; this proves the page is wired
         to a real one. Two windows, postMessage between them, and the guest's
         key ending up in the host's copy of the guest.

         Driven through QSPLAY.run rather than wall clock: two software-rendered
         scenes on a runner manage a frame or two a second, and a test that waits
         for them measures the renderer, not the netcode. */
      const [peerPage] = await Promise.all([
        bp.waitForEvent('popup', { timeout: PATIENCE }),
        bp.evaluate(() => window.QSPLAY.host()),
      ]);
      peerPage.setDefaultTimeout(PATIENCE);
      peerPage.on('pageerror', (e) => bErrors.push(`peer: ${e.message}`));
      peerPage.on('console', (m) => {
        if (m.type() === 'error' && !/ERR_/.test(m.text())) bErrors.push(`peer: ${m.text()}`);
      });
      await peerPage.waitForFunction(() => !!(window.QSPLAY && window.QSPLAY.ready), null,
                                     { timeout: PATIENCE });
      await bp.waitForFunction(() => window.QSPLAY.connected, null, { timeout: PATIENCE });
      await peerPage.waitForFunction(() => window.QSPLAY.connected, null, { timeout: PATIENCE });
      const roles = [await bp.evaluate(() => window.QSPLAY.role),
                     await peerPage.evaluate(() => window.QSPLAY.role)];
      check(roles[0] === 'host' && roles[1] === 'guest', 'NET: two windows, one host',
            roles.join(' / '));

      /* The guest never received any terrain — only a seed — so if it is
         standing on the same ground as the host, it grew it. */
      const sameWorld = await peerPage.evaluate(() => window.QSPLAY.actor.y);
      check(Number.isFinite(sameWorld) && sameWorld > 0,
            'NET: the guest grew the world from the seed it was sent',
            `standing at y ${sameWorld.toFixed(2)}`);

      const before = await bp.evaluate(() => ({ x: window.QSPLAY.peer.x, z: window.QSPLAY.peer.z }));
      await peerPage.evaluate(() => window.QSPLAY.input.press('KeyW'));
      /* Alternating evaluates, because each one yields to the event loop and
         that is what lets postMessage actually deliver between the two. */
      for (let q = 0; q < 20; q++) {
        await peerPage.evaluate(() => window.QSPLAY.run(4));
        await bp.evaluate(() => window.QSPLAY.run(4));
      }
      await peerPage.evaluate(() => window.QSPLAY.input.release('KeyW'));
      for (let q = 0; q < 12; q++) {
        await peerPage.evaluate(() => window.QSPLAY.run(4));
        await bp.evaluate(() => window.QSPLAY.run(4));
      }
      const after = await bp.evaluate(() => ({ x: window.QSPLAY.peer.x, z: window.QSPLAY.peer.z }));
      const guestSays = await peerPage.evaluate(() => ({
        x: window.QSPLAY.actor.x, z: window.QSPLAY.actor.z, stats: window.QSPLAY.stats }));
      const moved = Math.hypot(after.x - before.x, after.z - before.z);
      const gap = Math.hypot(after.x - guestSays.x, after.z - guestSays.z);
      check(moved > 1, 'NET: a key in one window moves a character in the other',
            `${moved.toFixed(2)} m`);
      check(gap < 0.6, 'NET: and both windows agree where it ended up',
            `${gap.toFixed(3)} m apart, ${guestSays.stats.corrections} corrections, ` +
            `${guestSays.stats.replayed} inputs replayed`);

      await bp.screenshot({ path: join(OUT, 'play.png') });
      await peerPage.screenshot({ path: join(OUT, 'play-guest.png') });
      check(bErrors.length === 0, 'NET: no errors in either window', bErrors.slice(0, 3).join(' | '));
      await peerPage.close();
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
