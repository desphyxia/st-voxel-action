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
 *                 possible and this is what makes it loud. Carrying the code is
 *                 not the same as using it, so this also checks that every
 *                 grass attribute the generator emits reaches a shader on both
 *                 pages — the drift that hid a missing tint for six issues.
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
 *   5f. REGION    two windows onto the same ground agree about it — heights,
 *                 trail, sites, crossings, landmarks, and every voxel, prop and
 *                 blade of grass between them outside a measured 4 m skirt.
 *                 Routes are decided per 64 m region rather than per window
 *                 (#16) and every other draw is keyed on its place (#41),
 *                 which is what lets the generator be asked for more than one.
 *   5g. NET       a host and a guest agree exactly after latency and packet
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
import { budgetSuite, viewSuite, combatSuite, enemySuite, gearSuite, regionSuite, meshSuite,
         carveSuite, foliageSuite, trailSuite, chunkSuite, fieldSuite, streamSuite, seamSuite, propSuite, netSuite, soak, SOAK_TICKS } from './lib/playtest.mjs';
import { TARGETS, staleTargets } from './bundle-gen.mjs';
import { buildWorld } from '../src/gen/index.mjs';
import { PALETTE, PAL, palR } from '../src/gen/palette.mjs';
import { captureLook, compare, breaches, describe } from './lib/look.mjs';
import { audit, worldFields, EXEMPT, ONE_SIDED } from './lib/consume.mjs';

const argv = process.argv.slice(2);
const UPDATE = argv.includes('--update');
const QUICK = argv.includes('--quick');
/* Which halves to run. Neither flag means both. */
const NODE_HALF = !argv.includes('--browser');
const BROWSER_HALF = !argv.includes('--node') && !UPDATE;
const OUT = join(ROOT, '.render');
const BASELINE = join(ROOT, 'tools/baseline.json');
const LOOK_BASELINE = join(ROOT, 'tools/look-baseline.json');
/* How far a body may be inside a surface on the frame it lands, in metres. A
   fifth of a voxel: twice the deepest ever measured, and far too small to be a
   body stuck in a hill. */
const LAND_SLOP = 0.05;
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

/* Every grass attribute the generator emits has to reach a shader on *both*
   pages. This is the narrow, static version of issue #40: SYNC proves the pages
   carry the same src, and the golden digest proves the array is still produced,
   but neither notices a page that builds the array and then drops it on the
   floor. That is not hypothetical — it is exactly what happened to `ti`, which
   the plate has drawn since it was written and the playable build, written
   fresh in #21, never uploaded. Six issues passed and nothing said a word. */
{
  const want = [['ti', 'aTint'], ['dc', 'aDry'], ['c', 'aCol'], ['ph', 'aPhase']];
  const missing = [];
  for (const t of TARGETS) {
    const src = readFileSync(t.file, 'utf8');
    for (const [field, attr] of want) {
      if (!src.includes(`gd.${field}[`) || !src.includes(`'${attr}'`)) {
        missing.push(`${t.name}: grass.${field} -> ${attr}`);
      }
    }
  }
  check(missing.length === 0, 'SYNC: both pages draw with every grass attribute',
        missing.length ? missing.join('; ') : `${want.length} attributes on ${TARGETS.length} pages`);
}

/* Issue #28: the point of moving colour out of the per-voxel record is that a
   biome can be restyled without regenerating. That is a claim about the data,
   so it is checkable without a browser: edit the table, resolve the same voxels
   again, and the ground changes colour while the world does not move. */
{
  const w = buildWorld({ seed: 'ALDER-RUN', size: 64, force: 0, ox: 704, oz: 448 });
  const slot = PAL.MEADOW_SURF;
  const before = [], after = [];
  const grab = (out) => {
    for (let i = 0; i < w.pal.length && out.length < 3000; i++) {
      if (w.pal[i] >= slot.at && w.pal[i] < slot.at + slot.n) {
        out.push(palR(w.pal[i], w.shd[i]).toFixed(6));
      }
    }
  };
  grab(before);
  const keep = PALETTE[slot.at];
  PALETTE[slot.at] = 0x123456;                    /* a colour nothing else uses */
  grab(after);
  PALETTE[slot.at] = keep;
  const moved = before.filter((v, i) => v !== after[i]).length;

  check(before.length > 0 && moved > 0,
        'PALETTE: a biome restyles from the table, with nothing regenerated',
        `${moved} of ${before.length} meadow surface voxels changed colour`);
  /* And the record really is four arrays of one length, not three plus colour. */
  check(w.pal.length === w.pos.length / 3 && w.shd.length === w.pal.length
        && w.mat.length === w.pal.length && w.col === undefined,
        'PALETTE: a voxel is place, entry, shade and material — and no colour',
        `${w.pal.length} voxels, col ${w.col === undefined ? 'gone' : 'STILL THERE'}`);
}

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

/* ---------- REGION: two views of the same ground agree ----------
   Issue #16's bar, and the reason the generator can now be asked for more than
   one window. Nothing here needs a browser: it is two worlds and a comparison. */
if (NODE_HALF) for (const r of regionSuite()) check(r.ok, `REGION: ${r.label}`, r.detail);

/* ---------- MESH: the greedy mesher, issue #12 ---------- */
if (NODE_HALF) for (const r of meshSuite()) check(r.ok, `MESH: ${r.label}`, r.detail);

/* ---------- CARVE: the mesh follows an edit, issue #12 ---------- */
if (NODE_HALF) for (const r of carveSuite()) check(r.ok, `CARVE: ${r.label}`, r.detail);

/* ---------- FOLIAGE: a leaf is not a wall, issue #46 ---------- */
if (NODE_HALF) for (const r of foliageSuite()) check(r.ok, `FOLIAGE: ${r.label}`, r.detail);

/* ---------- CONSUME: is anything reading what the generator emits? (#40) ----------
   PARITY hashes what comes out of the generator, so an array produced
   perfectly and then dropped on the floor hashes the same as one that is
   drawn. This is the other half: every field the world hands out is read by a
   page or by src/sim, src/mesh or src/net — or is exempt on the record. */
if (NODE_HALF) {
  const seen = audit();
  const loose = seen.orphans.filter((f) => !EXEMPT[f]);
  check(loose.length === 0, 'CONSUME: everything the generator emits has a consumer',
        loose.length ? `nothing reads ${loose.join(', ')} — draw it, delete it, or exempt it in tools/lib/consume.mjs`
                     : `${worldFields().length} fields, ${Object.keys(EXEMPT).length} exempt `
                       + `(${Object.keys(EXEMPT).join(', ')})`);

  /* And the audit has to be able to find one, in both the ways it could fail.
     Two canaries, because the first one alone proves less than it looks like it
     does — a name present nowhere is reported as an orphan even by a matcher
     far too loose to be any use, which is exactly what happened when this was
     first written with one:

       qsFieldNothingReads  appears in no file at all. Catches an audit that has
                            stopped matching anything, so everything looks read.
       userData             appears everywhere, always as a property of some
                            object that is not a world. Catches an audit that
                            has stopped caring *whose* property it is — which is
                            the way this one would actually go wrong, and the
                            way the first canary cannot see. */
  const canary = audit(['qsFieldNothingReads', 'userData']);
  const blind = ['qsFieldNothingReads', 'userData'].filter((f) => !canary.orphans.includes(f));
  check(blind.length === 0, 'CONSUME: and the audit can tell when nothing reads a field',
        blind.length ? `${blind.join(' and ')} came back consumed — the audit matches too loosely`
                     : 'a field nobody reads is reported, and a field only other objects have is not');

  /* Drift between the pages, pinned rather than forbidden: they are legitimately
     different now, so what is asserted is that the difference has not changed
     without someone saying so. */
  const drifted = seen.oneSided.filter((f) => !ONE_SIDED.includes(f));
  const healed = ONE_SIDED.filter((f) => !seen.oneSided.includes(f));
  check(drifted.length === 0 && healed.length === 0,
        'CONSUME: and the two pages read the fields they are recorded as reading',
        drifted.length || healed.length
          ? `new: ${drifted.join(', ') || 'none'}; gone: ${healed.join(', ') || 'none'} `
            + '— update ONE_SIDED in tools/lib/consume.mjs if that is intended'
          : `${seen.oneSided.length} fields read by one page and not the other, as recorded`);
}

/* ---------- CHUNK: a chunk alone is the ground its neighbour sees, issue #13 ---------- */
if (NODE_HALF) for (const r of chunkSuite()) check(r.ok, `CHUNK: ${r.label}`, r.detail);

/* ---------- FIELD: loaded chunks answer as one world, issue #13 ---------- */
if (NODE_HALF) for (const r of fieldSuite()) check(r.ok, `FIELD: ${r.label}`, r.detail);

/* ---------- PROPS: only the faces that can be seen, issue #51 ---------- */
if (NODE_HALF) for (const r of propSuite()) check(r.ok, `PROPS: ${r.label}`, r.detail);

/* ---------- SEAM: a streamed world draws without a visible join, issue #13 ---------- */
if (NODE_HALF) for (const r of seamSuite()) check(r.ok, `SEAM: ${r.label}`, r.detail);

/* ---------- STREAM: which chunk to build next, and when, issue #13 ---------- */
if (NODE_HALF) for (const r of streamSuite()) check(r.ok, `STREAM: ${r.label}`, r.detail);

/* ---------- WALK: the routed trail fits a body, issue #45 ---------- */
if (NODE_HALF) for (const r of trailSuite()) check(r.ok, `WALK: ${r.label}`, r.detail);

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
  /* Two more wanderers over the same ground. One walk per seed was certifying
     a property it could not establish: varying the walk finds overlaps on 3 of
     36 runs that the single walk never meets. They are all shallow landing
     frames, so this costs a second and buys the coverage the claim needs. */
  for (const suffix of ['/b', '/c']) {
    const alt = soak(worlds[i], GOLDEN_SEEDS[i].nm + suffix);
    jumped += alt.jumps; vaulted += alt.vaults;
    s.insideGrounded += alt.insideGrounded;
    s.insideTicks += alt.insideTicks;
    if (alt.insideDepth > s.insideDepth) s.insideDepth = alt.insideDepth;
    if (!alt.survived) s.survived = false;
  }
  check(s.survived, `PLAY: ${s.seed} five minutes without falling through`,
        `${s.ticks}/${SOAK_TICKS} ticks x3 walks, ${s.dead || 'alive'}`);
  /* Falling through the world is the loud failure; ending up inside it is the
     quiet one, and a scripted climb that clips a ledge is how it gets in.

     **This used to demand zero overlap of any kind, and that was not the
     property it named.** Every embed ever observed — on this build and on the
     one before foliage went soft — is a body a few millimetres into the
     surface it is landing on, for one or two ticks, never while grounded.
     Deepest seen across 36 walks: 27.8 mm, a ninth of a voxel. Meanwhile the
     zero-overlap rule certified a property it could not establish, because it
     ran one walk per seed: the same six worlds embed on 3 of 36 walks when the
     walk is varied.

     So it asks the two things it actually meant. A body at rest inside the
     world is a bug at any depth; a landing frame is allowed a tolerance well
     under a voxel and well over what has ever been measured. */
  check(s.insideGrounded === 0, `PLAY: ${s.seed} never at rest inside the ground`,
        `${s.insideGrounded} grounded ticks embedded of ${s.insideTicks} overlapping`);
  check(s.insideDepth <= LAND_SLOP, `PLAY: ${s.seed} and never more than a landing's slop into it`,
        `deepest ${(s.insideDepth * 1000).toFixed(1)} mm, tolerance ${LAND_SLOP * 1000} mm`);
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
        /* The property that actually matters is not "there is water, so there
           must be a bridge" — a river you never have to cross needs nothing.
           It is that the route never asks you to swim: wherever a trail cell
           sits on water, there is a crossing. The old form passed vacuously on
           meadow, whose window happened to contain no water at all. */
        check(m.wetTrail === 0 || m.bridges > 0,
              `SANITY: ${m.seed} a trail over water has a crossing`,
              `${m.wetTrail} trail cells in water, ${m.bridges} crossings, `
              + `${m.waterCells} water cells in all`);
        /* Issue #43: the router spends an A* keeping the trail walkable, and
           props were stamped on top of it afterwards — a boulder could stand
           in the path. Foliage and a crossing deck are allowed; nothing else
           solid may be in the walkable band over a trail cell. */
        check(m.trailProps === 0, `TRAIL: ${m.seed} nothing stands in the routed trail`,
              m.trailProps ? `${m.trailProps} prop voxels in the walkable band` : 'clear');
        /* Issue #44: a river one cell wide stepping diagonally rasterised to
           cells meeting only at their corners — a dotted line of puddles that
           flow, foam, wading and the crossing logic all fail to see as a river.
           The gap between a 4-connected and an 8-connected count is the defect. */
        check(m.waterBodies === m.waterBodies8,
              `WATER: ${m.seed} every water body is properly joined`,
              `${m.waterBodies} bodies, ${m.waterBodies8} counting diagonals`);
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

      /* ---------- BUILD: it opens in the view ----------
         The page is a design document with a game in the middle of it, and the
         stage takes the viewport on load so the game is what you land in. This
         is the CSS fill and not native fullscreen, which cannot be entered
         without a user gesture — so what is asserted is that it filled, and
         that the way back out is reachable from inside it.

         Everything after this runs on the page as it was, so the fill is
         dropped here: the stage is fixed over the page furniture while it is
         up, and a covered button is not clickable. */
      const opened = await bp.evaluate(() => {
        const st = document.querySelector('#stage'), c = document.querySelector('#cv');
        const r = st.getBoundingClientRect(), vv = window.visualViewport;
        return { maxed: st.classList.contains('maxed'),
                 w: Math.round(r.width), h: Math.round(r.height),
                 top: Math.round(r.top), bottom: Math.round(r.bottom),
                 vw: Math.round(vv ? vv.width : window.innerWidth),
                 vh: Math.round(vv ? vv.height : window.innerHeight),
                 cw: c.width, ch: c.height,
                 exit: getComputedStyle(document.querySelector('#exitfs')).display };
      });
      check(opened.maxed && opened.top <= 1 && opened.bottom >= opened.vh - 1
            && opened.w >= opened.vw - 1 && opened.cw === opened.w && opened.ch === opened.h,
            'BUILD: opens filling the view, with the canvas following',
            `${opened.w}x${opened.h} over a ${opened.vw}x${opened.vh} viewport, canvas ${opened.cw}x${opened.ch}`);
      check(opened.exit !== 'none', 'BUILD: and the way back to the page is reachable from inside it',
            opened.exit !== 'none' ? 'exit control shown' : 'NO EXIT — the lattice is unreachable');
      await bp.click('#exitfs');
      /* Wait for the *drawing buffer* to settle, not just for the class to come
         off. Leaving the fill resizes on a later frame, and `vp` is what
         QS.project maps a world point through — running the next check against
         a stale one aims every pointer at the wrong place on screen, which is
         exactly how this first came back: nothing was struck and nothing died. */
      await bp.waitForFunction(() => {
        const st = document.querySelector('#stage'), c = document.querySelector('#cv');
        const r = st.getBoundingClientRect();
        return !st.classList.contains('maxed')
          && c.width === Math.max(1, r.width | 0) && c.height === Math.max(1, r.height | 0);
      }, null, { timeout: PATIENCE });

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
        /* Facing is set here, so nothing else may set it. A mouse that has been
           over the stage leaves an aim behind, and the swing follows the aim
           rather than the facing — which reads on screen as a perfectly good
           arc pointing somewhere else, and comes back as a post that was never
           struck. This check used to hold only because no earlier check had
           moved a pointer across the view. */
        P.input.clearPointer();
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
        /* Same reason as the swing check: this drives facing by hand every tick,
           and a pointer left over the view would out-vote it. */
        P.input.clearPointer();
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

      /* ---------- BUILD: the two terrain renderers (#12) ----------
         Both are in the page at once so the side-by-side the issue asks for is
         two shots of one camera rather than two runs that might differ. What
         the gate can hold is that the swap actually swaps, that props survive
         it — they stay instanced by decision, and hiding them with the terrain
         was the first bug the comparison caught — and that nothing errors. */
      const swap = await bp.evaluate(() => {
        const P = window.QSPLAY;
        const out = { boxes: P.boxCount, quads: P.meshQuads, started: P.mesh };
        P.setMesh(false); P.draw();
        out.offMesh = P.mesh;
        P.setMesh(true); P.draw();
        out.onMesh = P.mesh;
        return out;
      });
      check(swap.quads > 0 && swap.boxes * 6 / swap.quads > 5,
            'BUILD: the mesh draws a fraction of what the boxes do',
            `${swap.boxes * 6} box faces, ${swap.quads} quads `
            + `— ${(swap.boxes * 6 / swap.quads).toFixed(1)}x fewer`);
      check(swap.started === true && swap.offMesh === false && swap.onMesh === true,
            'BUILD: and the renderer swaps both ways, the mesh by default',
            `default ${swap.started ? 'mesh' : 'boxes'}, toggles to boxes and back`);
      check(bErrors.length === 0, 'BUILD: and neither renderer errors',
            bErrors.slice(0, 3).join(' | '));

      /* ---------- BUILD: grass the frustum is allowed to reject (#51) ----------
         The blades used to be one instanced cloud per window with culling
         switched off, and it had to be: an InstancedMesh's bounding sphere in
         three is its *blade's*, not its instances', so the whole cloud would
         have vanished the moment the one blade at the origin left the view.
         They are tiles now, each carrying a sphere measured from the blades
         actually in it, and the point of the change is that a tile the camera
         is not looking at stops being submitted.

         So the cull is measured by taking it away. Count what a frame submits,
         turn frustumCulled off on every tile, count again, and require the
         second number to be higher by a real share of the grass. A check that
         read only the first number would pass just as happily against the
         single un-culled cloud this replaced, which is the failure it exists
         to catch. */
      const gcull = await bp.evaluate(() => {
        const P = window.QSPLAY, tiles = [];
        P.scene.traverse((o) => { if (o.userData.kind === 'grass') tiles.push(o); });
        const scene = tiles.reduce((a, o) => a + o.count * (o.geometry.index.count / 3), 0);
        P.draw();
        const culled = P.draws.triangles;
        /* Does each tile's sphere actually hold its blades — base and tip, the
           tip taken at the tallest the shader can stretch one to? A sphere that
           does not is a tile culled while part of it is still on screen, which
           is a hole in the ground rather than a saving. */
        const m = new window.THREE.Matrix4();
        let blades = 0, outside = 0;
        for (const o of tiles) {
          const bs = o.geometry.boundingSphere;
          if (!bs || !o.frustumCulled) { outside += o.count; blades += o.count; continue; }
          const r2 = bs.radius * bs.radius;
          for (let i = 0; i < o.count; i++) {
            o.getMatrixAt(i, m); blades++;
            const e = m.elements, dx = e[12] - bs.center.x, dz = e[14] - bs.center.z;
            const dy = e[13] - bs.center.y, ty = e[13] + e[5] * 1.3 - bs.center.y;
            if (dx * dx + dy * dy + dz * dz > r2) outside++;
            else if (dx * dx + ty * ty + dz * dz > r2) outside++;
          }
        }
        for (const o of tiles) o.frustumCulled = false;
        P.draw();
        const all = P.draws.triangles;
        for (const o of tiles) o.frustumCulled = true;
        return { tiles: tiles.length, scene, culled, all, blades, outside };
      });
      check(gcull.tiles > 4 && gcull.blades > 0 && gcull.outside === 0,
            'BUILD: the grass is in tiles, each with bounds that hold its blades',
            `${gcull.tiles} tiles over ${gcull.blades.toLocaleString()} blades, `
            + `${gcull.outside} outside the sphere they are culled against`);
      check(gcull.all - gcull.culled > gcull.scene * 0.2,
            'BUILD: and a frame only pays for the tiles the camera holds',
            `${gcull.scene.toLocaleString()} grass triangles in the scene, `
            + `${(gcull.all - gcull.culled).toLocaleString()} of them never submitted `
            + `— ${(100 * (gcull.all - gcull.culled) / gcull.scene).toFixed(0)}%`);

      /* ---------- BUILD: the mesh follows an edit (#12) ----------
         The node half asserts that meshChunk answers differently once a voxel
         is gone. What only the page can answer is whether the *scene* followed:
         a chunk whose geometry was swapped for a new one, in a renderer that is
         holding a world it did not just build. Clearing the edits afterwards
         has to put the quad count back exactly, or something is remembering
         what it should have thrown away. */
      const bit = await bp.evaluate(() => {
        const P = window.QSPLAY, a = P.actor;
        const before = P.meshQuads;
        const r = P.carve(a.x, a.y - 0.2, a.z);
        P.draw();
        const after = P.meshQuads;
        const back = P.clearEdits();
        P.draw();
        return { before, after, back, cut: r.cut, chunks: r.chunks, held: r.held,
                 restored: P.meshQuads };
      });
      check(bit.cut > 0 && bit.chunks > 0 && bit.after !== bit.before,
            'BUILD: a carve takes ground away and the chunk is remeshed in place',
            `${bit.cut} voxels over ${bit.chunks} chunk(s), ${bit.before} quads -> ${bit.after}`);
      check(bit.back === bit.cut && bit.restored === bit.before,
            'BUILD: and putting it back leaves the mesh the generator made',
            `${bit.back} edits cleared, ${bit.restored} quads against ${bit.before}`);
      check(bErrors.length === 0, 'BUILD: and carving errors nothing',
            bErrors.slice(0, 3).join(' | '));

      /* ---------- BUILD: the view's own controls ----------
         The readout used to cover the top-left of the view and could not be
         put away; the zoom could not be reached at all without the keyboard.
         Both are driven here through the real buttons rather than through the
         functions behind them, because a control that exists and does not
         respond to a click is the failure worth catching. */
      /* Start from a blade at rest. The checks above leave a swing in flight and
         the sweep fades on the animation loop in wall-clock, not in ticks — so
         whether it is still visible here depends on how fast the machine is.
         It was on CI and not locally, and "pressing one does not also swing"
         read the leftover as the press's doing. */
      await bp.evaluate(() => {
        const a = window.QSPLAY.actor;
        if (a) { a.swing = null; a.dodge = null; }
      });
      await bp.waitForFunction(() => !window.QSPLAY.sweeping, null, { timeout: PATIENCE });

      const tools = await bp.evaluate(async () => {
        const P = window.QSPLAY, out = {};
        out.quietFirst = !P.sweeping;
        /* A real mouse press, because that is the one the stage acts on: its
           pointerdown handler presses Mouse0 for pointerType 'mouse' and takes
           the touch path otherwise. A synthetic event without a pointerType
           would sail past the guard this is here to hold. */
        const click = (id) => {
          const b = document.getElementById(id);
          b.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true, cancelable: true, composed: true,
            pointerType: 'mouse', button: 0, buttons: 1, isPrimary: true,
          }));
          b.click();
          return b;
        };
        const hud = document.getElementById('hud');
        const shown = () => getComputedStyle(hud).display !== 'none';
        out.hudAtBoot = shown();
        out.pressedAtBoot = document.getElementById('hudbtn').getAttribute('aria-pressed');
        click('hudbtn'); out.hudOn = shown(); out.readout = hud.textContent.length;
        click('hudbtn'); out.hudOff = shown();

        /* The toggle sits at the top of the view and is centred on it. */
        const sr = document.querySelector('#stage').getBoundingClientRect();
        const br = document.getElementById('hudbtn').getBoundingClientRect();
        out.offCentre = Math.abs((br.left + br.width / 2) - (sr.left + sr.width / 2));
        out.fromTop = br.top - sr.top;

        /* Zoom, and whether the frustum actually followed it. */
        const frustum = () => { P.draw(); return P.view; };
        out.view0 = frustum();
        click('zoomin'); out.viewIn = frustum();
        click('zoomout'); click('zoomout'); out.viewOut = frustum();
        /* Walk to the near end and check it stops rather than running past. */
        for (let i = 0; i < 12; i++) click('zoomin');
        out.viewMin = frustum();
        out.inDisabled = document.getElementById('zoomin').disabled;
        for (let i = 0; i < 20; i++) click('zoomout');
        out.viewMax = frustum();
        out.outDisabled = document.getElementById('zoomout').disabled;
        /* And that clicking a control did not also swing the blade. The swing
           starts on the next tick, not on the press, so the clock has to move
           before this means anything. */
        P.run(4); P.draw();
        out.swung = P.sweeping || QSPHASE();
        function QSPHASE() { const a = P.actor; return !!(a && a.swing); }
        return out;
      });
      check(tools.hudAtBoot === false && tools.pressedAtBoot === 'false'
            && tools.hudOn === true && tools.hudOff === false && tools.readout > 20,
            'BUILD: the readout is off until asked for, and the button asks',
            `boot ${tools.hudAtBoot ? 'shown' : 'hidden'}, on ${tools.hudOn}, off again ${tools.hudOff}, `
            + `${tools.readout} chars of readout`);
      check(tools.offCentre < 2 && tools.fromTop >= 0 && tools.fromTop < 24,
            'BUILD: and its button is at the top middle of the view',
            `${tools.offCentre.toFixed(1)} px off centre, ${tools.fromTop.toFixed(0)} px down`);
      check(tools.viewIn < tools.view0 && tools.viewOut > tools.viewIn,
            'BUILD: the zoom buttons move the camera in and out',
            `${tools.view0} m -> in ${tools.viewIn} -> out ${tools.viewOut}`);
      /* Both halves matter. The disabled state is what a player runs into; the
         finite-and-in-range test is what catches the zoom having walked off the
         end of its own table and handed the camera a NaN. */
      const zoomSane = [tools.viewMin, tools.viewMax].every((v) => Number.isFinite(v) && v >= 6 && v <= 40);
      check(tools.viewMin < tools.view0 && tools.inDisabled
            && tools.viewMax > tools.view0 && tools.outDisabled && zoomSane,
            'BUILD: and they stop at each end rather than running past it',
            `nearest ${tools.viewMin} m (in ${tools.inDisabled ? 'disabled' : 'still live'}), `
            + `furthest ${tools.viewMax} m (out ${tools.outDisabled ? 'disabled' : 'still live'})`);
      check(tools.quietFirst === true && tools.swung === false,
            'BUILD: and pressing one does not also swing',
            !tools.quietFirst ? 'the blade was already out before the presses — check is not isolated'
                              : (tools.swung ? 'the blade came out' : 'quiet, before and after'));

      /* ---------- BUILD: a new world, and the renderer, from the view ----------
         Both of these already existed on the page below the stage, which is no
         use once the stage is filling the window. The overlay twins are what
         this covers, and the thing worth asserting about a second control for
         one piece of state is that the two never disagree.

         The world is put back afterwards: the checks below this walk a measured
         distance from spawn, and a random world is a random place to start. */
      const world = await bp.evaluate(async () => {
        const P = window.QSPLAY, out = {};
        const press = (id) => {
          const b = document.getElementById(id);
          b.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true, cancelable: true, composed: true,
            pointerType: 'mouse', button: 0, buttons: 1, isPrimary: true,
          }));
          b.click();
          return b;
        };
        const box = document.getElementById('seedin');
        /* Voxel count, not spawn position, as the evidence that the terrain is
           genuinely different. Spawn looked like the obvious tell and is a bad
           one: two seeds can put you in the same place, and it only appeared to
           work here because earlier checks had walked the character away from
           it. The voxel count is a property of the world itself. */
        out.seed0 = P.seed; out.box0 = box.value; out.vox0 = P.boxCount;

        press('newworld');
        out.seed1 = P.seed; out.box1 = box.value; out.vox1 = P.boxCount;
        out.alive1 = !!P.actor && !!P.ready;
        press('newworld');
        out.seed2 = P.seed;

        /* One state, two buttons: the overlay twin and the one on the page. */
        const lbl = () => [document.getElementById('meshtog').textContent,
                           document.getElementById('meshbtn').textContent].join('/');
        out.meshAt0 = P.mesh; out.lblAt0 = lbl();
        press('meshtog'); out.meshAt1 = P.mesh; out.lblAt1 = lbl();
        press('meshtog'); out.meshAt2 = P.mesh; out.lblAt2 = lbl();

        box.value = 'QUARTERSTONE';
        press('regen');
        out.restored = P.seed;
        return out;
      });
      check(world.seed1 !== world.seed0 && world.seed2 !== world.seed1
            && world.box1 === world.seed1 && world.alive1 && world.vox1 !== world.vox0,
            'BUILD: New grows a different world and writes the seed down',
            `${world.seed0} -> ${world.seed1} -> ${world.seed2}, `
            + `seed box ${world.box1 === world.seed1 ? 'agrees' : 'DISAGREES'}, `
            + `${world.vox0} voxels -> ${world.vox1}`);
      check(world.meshAt1 !== world.meshAt0 && world.meshAt2 === world.meshAt0
            && world.lblAt0 === 'Boxes/Boxes' && world.lblAt1 === 'Mesh/Mesh'
            && world.lblAt2 === 'Boxes/Boxes',
            'BUILD: the renderer toggle in the view agrees with the one on the page',
            `${world.lblAt0} -> ${world.lblAt1} -> ${world.lblAt2}, `
            + `mesh ${world.meshAt0} -> ${world.meshAt1} -> ${world.meshAt2}`);
      check(world.restored === 'QUARTERSTONE', 'BUILD: and the world the rest of the gate needs is back',
            `seed ${world.restored}`);

      /* The toolbar spans the view so its middle button can be centred by the
         layout. That makes it a full-width strip across the top, and a strip
         that takes pointer events is a strip that eats clicks meant for the
         ground beneath it. Only the buttons may be solid. */
      const strip = await bp.evaluate(() => {
        const t = document.querySelector('#tools').getBoundingClientRect();
        const b = document.getElementById('hudbtn').getBoundingClientRect();
        /* A point inside the strip, level with the buttons, in the gap between
           the left group and the centre one. */
        const x = (b.left + t.left) / 2, y = b.top + b.height / 2;
        const hit = document.elementFromPoint(x, y);
        return { onStrip: x > t.left && x < b.left,
                 lands: hit ? (hit.id || hit.tagName.toLowerCase()) : 'nothing',
                 width: Math.round(t.width),
                 stageWidth: Math.round(document.querySelector('#stage').getBoundingClientRect().width) };
      });
      check(strip.onStrip && strip.lands !== 'tools',
            'BUILD: and the toolbar strip does not swallow clicks meant for the ground',
            `a press in the gap lands on <${strip.lands}>, strip ${strip.width} of ${strip.stageWidth} px wide`);

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
        const vv = window.visualViewport;
        return { w: Math.round(r.width), h: Math.round(r.height), cw: c.width, ch: c.height,
                 top: Math.round(r.top), bottom: Math.round(r.bottom),
                 vh: Math.round(vv ? vv.height : window.innerHeight),
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
      /* A canvas that matches the stage is not enough: a stage taller than what
         is actually on screen matches its canvas perfectly and still loses its
         bottom edge behind the fold. That is the shape of the bug this pins —
         the stage has to fit inside the visible viewport, not merely agree
         with itself. */
      check(fsOn.top >= -1 && fsOn.bottom <= fsOn.vh + 1,
            'BUILD: and all of it is on screen, not cut off at the bottom',
            `stage ${fsOn.top}..${fsOn.bottom} within a ${fsOn.vh} px viewport`
            + (fsOn.bottom > fsOn.vh + 1 ? ` — ${fsOn.bottom - fsOn.vh} px below the fold` : ''));
      check(fsOn.exit !== 'none', 'BUILD: and there is a way out from inside it',
            fsOn.exit !== 'none' ? 'exit control shown' : 'NO EXIT — the stage covers the button');
      check(!fsOff.filling && fsOff.h === fsBefore.h && fsOff.cw === fsOff.w,
            'BUILD: and leaving it puts the stage back',
            `${fsOff.w}x${fsOff.h}, canvas ${fsOff.cw}x${fsOff.ch}`);

      /* ---------- BUILD: a phone can move the character ----------
         There is no keyboard on a phone, so every verb needs somewhere to
         press. The controls feed the same input table a gamepad does, which is
         why none of this needed a change in src/sim — but "the same table" is
         a claim, and this is what holds it to it.

         Synthetic pointers with pointerType 'touch' go through the page's real
         handlers; nothing here is a shortcut past them. */
      const touch = await bp.evaluate(() => {
        const P = window.QSPLAY, QS = window.QS;
        P.setTouch(true); P.pause(true);
        const stage = document.querySelector('#stage');
        const r = stage.getBoundingClientRect();
        const ev = (el, type, x, y, id) => el.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, composed: true,
          pointerId: id, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y,
          buttons: type === 'pointerup' ? 0 : 1,
        }));
        const out = {};
        out.shown = getComputedStyle(document.querySelector('#pad')).display !== 'none';

        /* The stick lands where the thumb does, anywhere in the left of the view. */
        const ox = r.left + r.width * 0.2, oy = r.top + r.height * 0.6;
        ev(stage, 'pointerdown', ox, oy, 7);
        out.rest = P.input.axes().ix;
        ev(stage, 'pointermove', ox + 56, oy, 7);
        out.full = P.input.axes().ix;
        /* Past the edge of its travel it must still be a unit vector: the
           heading crosses the wire, and the host trusts what it is sent. */
        ev(stage, 'pointermove', ox + 400, oy, 7);
        const far = P.input.axes();
        out.clamped = Math.sqrt(far.ix * far.ix + far.iy * far.iy);

        /* From the spawn, not from wherever the checks above left the character.
           They walk it into a cache, through a machine's arc and around a post,
           and it can finish anywhere — against a wall, in water, on magma. This
           check is about whether analog magnitude survives the trip from thumb
           to actor, so it has to run somewhere there is room to walk. */
        P.respawn();
        const a = P.actor;
        a.dead = null; a.vx = 0; a.vz = 0;
        const x0 = a.x, z0 = a.z;
        P.run(60);
        out.walked = Math.sqrt((P.actor.x - x0) ** 2 + (P.actor.z - z0) ** 2);
        /* Reported on failure, because "0.00 m" alone does not say whether the
           character was blocked, drowned or killed on the way. */
        out.from = [Math.round(x0 * 100) / 100, Math.round(z0 * 100) / 100];
        out.ended = P.actor.dead || (P.actor.swimming ? 'swimming' : (P.actor.blocked ? 'blocked' : 'walking'));
        ev(stage, 'pointerup', ox + 400, oy, 7);
        out.released = P.input.axes().ix;

        /* The conflict this had to solve: Mouse0 is bound to attack, so before
           this every tap anywhere swung the sword. */
        const b = P.actor;
        b.swing = null; b.stamina = QS.STAMINA_MAX; b.staminaHold = 0; b.dead = null;
        ev(stage, 'pointerdown', r.left + r.width * 0.78, r.top + r.height * 0.45, 9);
        P.run(2);
        out.tapSwung = !!P.actor.swing;
        ev(stage, 'pointerup', r.left + r.width * 0.78, r.top + r.height * 0.45, 9);

        const atk = document.querySelector('#tAtk'), ar = atk.getBoundingClientRect();
        P.actor.swing = null; P.actor.stamina = QS.STAMINA_MAX; P.actor.staminaHold = 0;
        ev(atk, 'pointerdown', ar.left + ar.width / 2, ar.top + ar.height / 2, 11);
        P.run(2);
        out.buttonSwung = !!P.actor.swing;
        ev(atk, 'pointerup', ar.left + ar.width / 2, ar.top + ar.height / 2, 11);

        /* A finger is not a cursor: fed as one, facing would lock to the last tap. */
        out.cursorActive = P.input.cursor.active;
        out.run = QS.RUN;
        P.pause(false); P.setTouch(false);
        return out;
      });
      check(touch.shown && touch.rest === 0 && touch.full > 0.98
            && Math.abs(touch.clamped - 1) < 1e-6 && touch.released === 0,
            'BUILD: a thumb in the left of the view is a stick',
            `rest ${touch.rest}, full ${touch.full.toFixed(3)}, `
            + `clamped ${touch.clamped.toFixed(6)} past its travel, ${touch.released} on release`);
      check(touch.walked > 3.5 && touch.walked < 4.5,
            'BUILD: and it walks the character at the speed it asks for',
            `${touch.walked.toFixed(2)} m in 60 ticks, RUN is ${touch.run}`
            + `, from ${touch.from.join(',')}, ${touch.ended}`);
      check(touch.tapSwung === false && touch.buttonSwung === true && touch.cursorActive === false,
            'BUILD: a tap on open ground does not swing, the button does',
            `${touch.tapSwung ? 'TAP SWUNG' : 'tap quiet'}, `
            + `${touch.buttonSwung ? 'button swung' : 'BUTTON DEAD'}, `
            + `${touch.cursorActive ? 'CURSOR LATCHED' : 'facing follows travel'}`);

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

      /* ---------- STREAM: a world with no edge, issue #13 ----------
         The node half proves the chunks agree, that the field answers what one
         collider answers, that the scheduler stays ahead of a run, and that a
         seam is not drawn twice. None of it says the *page* is wired to any of
         it — the same gap BUILD exists to close for the controller.

         Its own page, because `?stream=1` is the flag a person would use and
         because a streamed world replaces the world: run on the page above, it
         would leave every check before it looking at something else.

         Driven through QSPLAY.run rather than wall clock, like everything else
         here. That is also why the page pumps the stream from its tick and not
         from its render loop: a gate that never draws a frame would otherwise
         walk straight into ground nobody had decided, and the wall would have
         read as the controller's fault. */
      /* ---------- STREAM: the control that turns it on, issue #13/#51 ----------
         `?stream=1` is not reachable in the published artifact — the page runs
         in an iframe whose own URL carries no query — so the button below the
         view is the only way a player gets to a world with no edge, and it is
         what has to be asserted. Off at boot, on when pressed, and the world
         it grows is a different one from the same seed. */
      const cp = await browser.newPage({ viewport: { width: 1100, height: 700 } });
      cp.setDefaultTimeout(PATIENCE);
      const cErrors = [];
      cp.on('pageerror', (e) => cErrors.push(e.message));
      await cp.goto(`file://${bfile}`, { waitUntil: 'domcontentloaded', timeout: PATIENCE });
      await cp.waitForFunction(() => !!(window.QSPLAY && window.QSPLAY.ready), null, { timeout: PATIENCE });
      /* The in-view button, first and on its own, because it is the only one
         reachable in the state the build opens in: the stage fills the
         viewport and the page furniture is behind it. A control that is only
         below the stage is not a control, which is how the first version of
         this shipped. */
      const inView = await cp.evaluate(async () => {
        const P = window.QSPLAY;
        const t = document.getElementById('streamtog');
        const st = document.querySelector('#stage');
        const covered = st.classList.contains('maxed') || document.fullscreenElement === st;
        const r = t.getBoundingClientRect();
        const onScreen = r.width > 0 && r.height > 0 && r.top >= 0
          && r.bottom <= (window.innerHeight || 1e9);
        t.click();
        await new Promise((x) => setTimeout(x, 50));
        const on = { streaming: P.streaming, pressed: t.getAttribute('aria-pressed'),
                     chunks: P.chunks, grounded: P.actor.grounded };
        t.click();
        await new Promise((x) => setTimeout(x, 50));
        return { covered, onScreen, on, off: { streaming: P.streaming,
                 pressed: t.getAttribute('aria-pressed') } };
      });
      check(inView.covered && inView.onScreen,
            'STREAM: the switch is reachable in the view the build opens in',
            inView.covered ? 'stage fills the viewport, and the Stream button is on screen inside it'
                           : 'stage was not filling the viewport, so this proved nothing');
      check(inView.on.streaming === true && inView.on.pressed === 'true'
            && inView.on.chunks && inView.on.chunks.loaded > 1 && inView.on.grounded
            && inView.off.streaming === false && inView.off.pressed === 'false',
            'STREAM: and pressing it there turns streaming on and off again',
            `${inView.on.chunks ? inView.on.chunks.loaded : 0} chunks loaded while on, `
            + 'standing, and back to one window after');

      const toggled = await cp.evaluate(async () => {
        const P = window.QSPLAY;
        const b = document.getElementById('streambtn');
        const before = { on: P.streaming, label: b.textContent, pressed: b.getAttribute('aria-pressed'),
                         boxes: P.boxCount, seed: P.seed };
        b.click();
        await new Promise((r) => setTimeout(r, 50));
        const after = { on: P.streaming, label: b.textContent, pressed: b.getAttribute('aria-pressed'),
                        chunks: P.chunks, grounded: P.actor.grounded, seed: P.seed };
        b.click();
        await new Promise((r) => setTimeout(r, 50));
        return { before, after, back: { on: P.streaming, label: b.textContent, seed: P.seed } };
      });
      check(toggled.before.on === false && /off/.test(toggled.before.label)
            && toggled.before.pressed === 'false',
            'STREAM: the build opens on one window, with streaming offered and off',
            `the page button reads "${toggled.before.label}"`);
      check(toggled.after.on === true && /on/.test(toggled.after.label)
            && toggled.after.pressed === 'true' && toggled.after.chunks
            && toggled.after.chunks.loaded > 1 && toggled.after.grounded,
            'STREAM: and pressing it grows a world with no edge, standing',
            `"${toggled.after.label}", ${toggled.after.chunks ? toggled.after.chunks.loaded : 0} chunks `
            + `loaded, same seed ${toggled.after.seed}`);
      check(toggled.back.on === false && /off/.test(toggled.back.label)
            && toggled.back.seed === toggled.before.seed,
            'STREAM: and pressing it again comes back to the one window it started in',
            `"${toggled.back.label}", seed ${toggled.back.seed}`);
      check(cErrors.length === 0, 'STREAM: and the swap errors nothing',
            cErrors.slice(0, 3).join(' | '));
      await cp.close();

      const sp = await browser.newPage({ viewport: { width: 900, height: 600 } });
      sp.setDefaultTimeout(PATIENCE);
      const sErrors = [];
      sp.on('pageerror', (e) => sErrors.push(e.message));
      sp.on('console', (m) => { if (m.type() === 'error' && !/ERR_/.test(m.text())) sErrors.push(m.text()); });
      await sp.goto(`file://${bfile}?stream=1`, { waitUntil: 'domcontentloaded', timeout: PATIENCE });
      await sp.waitForFunction(() => !!(window.QSPLAY && window.QSPLAY.ready), null, { timeout: PATIENCE });
      const streamed = await sp.evaluate(() => {
        const P = window.QSPLAY, QS = window.QS;
        const a0 = P.actor;
        const boot = { on: P.streaming, chunks: P.chunks, grounded: a0.grounded,
                       y: a0.y, quads: P.meshQuads };
        /* A body that picks its way, not one that holds a key.
 
           The first version held KeyD for 15 s, then KeyS. On the golden seed
           that walks into a lake and then into a machine: it ended `swimming`
           in 0.875 m of water at (27.9, -27.4) having covered 39 m, and the
           other leg ended `dead: struck`. Both read as streaming failing to
           keep up, and neither was — held the other way the same build walks
           78 m and crosses to chunk (-2, -2) without complaint.
 
           So this turns instead, the way the node soak's wanderer does and for
           the same reason: the question is whether the ground holds together
           across chunks, not whether a body walking blind into a lake drowns.
           Water and machines are the controller's business and are pinned
           elsewhere. */
        const KEYS = ['KeyW', 'KeyA', 'KeyD', 'KeyS'];
        const seen = new Set();
        let lowest = Infinity, inside = 0, peak = 0, deaths = 0, turns = 0;
        let k = 0, held = KEYS[0];
        P.input.press(held);
        let last = { x: P.actor.x, z: P.actor.z };
        for (let i = 0; i < 4800; i++) {
          P.run(1);
          const a = P.actor, c = QS.chunkAt(a.x, a.z);
          seen.add(c.cx + ',' + c.cz);
          if (a.y < lowest) lowest = a.y;
          if (QS.embedded(P.collider, a)) inside++;
          if (P.chunks.loaded > peak) peak = P.chunks.loaded;
          if (i % 120 === 119) {
            /* Turn when the way ahead stops being ground to walk on: too
               little progress, water, or having been killed. */
            const moved = Math.hypot(a.x - last.x, a.z - last.z);
            const wet = !!a.inWater || !!a.swimming;
            if (a.dead) { deaths++; P.respawn(); }
            if (moved < 3 || wet || a.dead) {
              P.input.release(held);
              k = (k + 1) % KEYS.length; held = KEYS[k]; turns++;
              P.input.press(held);
            }
            last = { x: P.actor.x, z: P.actor.z };
          }
        }
        P.input.release(held);
        for (let i = 0; i < 90; i++) P.run(1);
        const a1 = P.actor;
        return { boot, seen: seen.size, lowest, inside, peak, deaths, turns,
                 end: { x: a1.x, z: a1.z, y: a1.y, grounded: a1.grounded },
                 chunks: P.chunks, quads: P.meshQuads,
                 nodesMatch: P.chunks.nodes === P.chunks.loaded };
      });
      check(streamed.boot.on && streamed.boot.grounded && streamed.boot.quads > 0,
            'STREAM: the build opens on a world with no edge',
            `${streamed.boot.chunks.loaded} chunks loaded, ${streamed.boot.quads} quads, `
            + `character standing at y ${streamed.boot.y.toFixed(2)}`);
      check(streamed.seen >= 4 && streamed.inside === 0 && streamed.lowest > -2,
            'STREAM: and walking across chunk after chunk neither falls through nor sticks',
            `${streamed.seen} chunks walked in 80 s over ${streamed.turns} turns, `
            + `${streamed.inside} ticks inside the ground, lowest y `
            + `${streamed.lowest.toFixed(2)}, ended at `
            + `(${streamed.end.x.toFixed(0)}, ${streamed.end.z.toFixed(0)}) `
            + `${streamed.end.grounded ? 'standing' : 'in the air'}`);
      check(streamed.chunks.dropped > 0 && streamed.chunks.built > streamed.chunks.loaded
            && streamed.nodesMatch,
            'STREAM: and the world behind is let go rather than kept',
            `${streamed.chunks.built} built, ${streamed.chunks.dropped} let go, `
            + `${streamed.chunks.loaded} held (peak ${streamed.peak}), and the scene holds `
            + `${streamed.chunks.nodes} of them`);
      check(sErrors.length === 0, 'STREAM: and no errors while it streams',
            sErrors.slice(0, 3).join(' | '));

      /* ---------- WORKER: generation off the main thread, issue #13 ----------
         The hitch #13 asks to be rid of is a 86-290 ms freeze every time a
         chunk arrives, so the only thing worth asserting is *what the main
         thread still pays* once a worker is generating. Reported either way,
         because a page's CSP may refuse a blob: worker and a refusal does not
         arrive as an exception — the build falls back and keeps playing, and
         the gate should say which of the two it measured rather than fail on
         an environment question. */
      const worker = streamed.chunks;
      if (worker.workers > 0 && worker.offThread > 0) {
        check(worker.gen > worker.deliver + worker.take,
              'WORKER: generating a chunk costs the main thread less than doing it',
              `${worker.offThread} windows off this thread: ${worker.gen.toFixed(0)} ms to `
              + `generate, ${worker.deliver.toFixed(0)} ms to deliver and `
              + `${worker.take.toFixed(0)} ms to adopt — ${(worker.deliver + worker.take).toFixed(0)} ms `
              + `on this thread against ${worker.gen.toFixed(0)} doing it here`);
      } else {
        check(true, 'WORKER: no worker here, and the build streams without one',
              worker.poolFailed ? 'the pool was refused or never answered — main-thread fallback'
                                : 'no worker started; the stream ran on the main thread');
      }
      await sp.screenshot({ path: join(OUT, 'play-streamed.png') });
      await sp.close();
    }

    /* ---------- LOOK: does the world still look like itself? (#29) ----------
       Twelve plates, six seeds at two poses, each reduced to a signature that
       answers four questions a person would ask: is it laid out the same, is it
       the same palette, does it have the same texture, and did anything draw.

       This is the check that #12 should have had to pass. It is deliberately
       not a pixel compare — the bar is "would a person notice", so it tolerates
       a few percent and still catches a biome that stopped being drawn.
       tools/look.mjs is the same measurement with per-plate output and the
       --noise mode that says what the floor is. */
    if (!QUICK) {
      if (!existsSync(LOOK_BASELINE)) {
        check(false, 'LOOK: baseline exists', 'run node tools/look.mjs --update to record');
      } else {
        const lookBase = JSON.parse(readFileSync(LOOK_BASELINE, 'utf8'));
        const look = await captureLook(browser, preparePage({ target: PLAY_TARGET, outDir: OUT, name: 'look.html' }),
                                      { seeds: GOLDEN_SEEDS });
        const moved = [];
        for (const k of Object.keys(look.plates)) {
          if (!lookBase.plates[k]) { moved.push(`${k} is not in the baseline`); continue; }
          const b = breaches(compare(lookBase.plates[k], look.plates[k]));
          if (b.length) moved.push(`${k}: ${b.join('; ')}`);
        }
        check(moved.length === 0, 'LOOK: the world looks the way the baseline says it does',
              moved.length ? moved.slice(0, 3).join(' | ')
                             + (moved.length > 3 ? ` (+${moved.length - 3} more)` : '')
                             + ' — node tools/look.mjs to see all of it'
                           : `${Object.keys(look.plates).length} plates unchanged: `
                             + describe(compare(lookBase.plates['hero/wide'], look.plates['hero/wide']))
                             + ' on hero/wide');
        check(look.errs.length === 0, 'LOOK: and nothing errored drawing them',
              look.errs.slice(0, 3).join(' | '));
      }
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
