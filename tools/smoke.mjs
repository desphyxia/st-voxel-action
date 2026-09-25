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
import { createServer } from 'node:http';
import { ROOT, preparePage, launch, GOLDEN_SEEDS, measureSeeds, measureWorld, CDN, THREE_LOCAL,
         someTileDone, generateSeeds, diffMeasure, mathProbe } from './lib/harness.mjs';
import { budgetSuite, viewSuite, combatSuite, enemySuite, gearSuite, regionSuite, networkSuite, meshSuite, animSuite, skySuite, navSuite,
         carveSuite, foliageSuite, trailSuite, chunkSuite, fieldSuite, streamSuite, seamSuite, propSuite, groundSuite, netSuite, soak, SOAK_TICKS } from './lib/playtest.mjs';
import { TARGETS, staleTargets } from './bundle-gen.mjs';
import { buildWorld } from '../src/gen/index.mjs';
import { chunkWorld } from '../src/gen/chunk.mjs';
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

/* ---------- NETWORK: regions agree with each other, issue #53 ----------
   REGION is two windows onto one region. This is neighbouring regions: a
   trail that crosses an edge crosses it at a port both sides derive alone. */
if (NODE_HALF) for (const r of networkSuite()) check(r.ok, `NETWORK: ${r.label}`, r.detail);

/* ---------- ANIM: poses read the simulation and never write it, issue #33 ---------- */
if (NODE_HALF) for (const r of animSuite()) check(r.ok, `ANIM: ${r.label}`, r.detail);

/* ---------- NAV: where a body of a given width can go, issues #15, #37, #6 ---------- */
if (NODE_HALF) for (const r of navSuite()) check(r.ok, `NAV: ${r.label}`, r.detail);

/* ---------- SKY: the hour and the weather are the seed's, issue #30 ---------- */
if (NODE_HALF) for (const r of skySuite()) check(r.ok, `SKY: ${r.label}`, r.detail);

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

/* ---------- GROUND: undulated, not noisy, and a trail flatter than it (#52) ---------- */
if (NODE_HALF) for (const r of groundSuite()) check(r.ok, `GROUND: ${r.label}`, r.detail);

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

/* ---------- WATER: held by its banks, and falls only onto water, issue #57 ----------
   Water stood above dry ground that did not hold it, and the renderer drew
   every such edge as a waterfall onto the grass — half or more of all falls on
   every seed. What is asserted is the cause, at the resolution it is drawn:
   no water column stands 0.4 m or more (the height at which a fall is drawn)
   above a dry column beside it. And, so the fix cannot have been to remove
   water, that real cascades — water stepping down onto lower water — are still
   produced somewhere across the six seeds. */
if (NODE_HALF) {
  const D4W = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const standing = (w, Hs) => {
    const { NX, NZ, FLG, WL } = w, where = [];
    let falls = 0;
    for (let i = 1; i < NX - 1; i++) for (let j = 1; j < NZ - 1; j++) {
      const k = i * NZ + j;
      if (!(FLG[k] & 1)) continue;
      for (const [di, dj] of D4W) {
        const kn = (i + di) * NZ + (j + dj);
        if (FLG[kn] & 1) { if (WL[kn] <= WL[k] - 0.4) falls++; }
        else if (Hs[kn] <= WL[k] - 0.4) where.push(`${i},${j}`);
      }
    }
    return { where, falls };
  };
  let cascades = 0;
  for (let q = 0; q < worlds.length; q++) {
    const r = standing(worlds[q], worlds[q].Hs);
    cascades += r.falls;
    check(r.where.length === 0, `WATER: ${GOLDEN_SEEDS[q].nm} no water stands above the bank beside it`,
          r.where.length ? `${r.where.length} edges, first at voxel ${r.where[0]}` : `${r.falls} falls, every one onto water`);
  }
  check(cascades > 0, 'WATER: and water still falls where the terrain steps it down',
        `${cascades} cascades across ${worlds.length} seeds`);

  /* Every step down from water to lower water is closed by a face. Only falls
     of 0.4 m and more used to be: a river descends a voxel at a time, and each
     25 cm step was an open slit onto the bed, a dark crack across the surface
     at 45° — 5,609 of them over 27 streamed chunks. Counted from the emitted
     geometry, against the steps in the level field it was built from. */
  let steps = 0, faces = 0, riffles = 0;
  for (const w of worlds) {
    const { NX, NZ, FLG, WL } = w, v = w.water.v;
    for (let i = 1; i < NX - 1; i++) for (let j = 1; j < NZ - 1; j++) {
      const k = i * NZ + j;
      if (!(FLG[k] & 1)) continue;
      for (const [di, dj] of D4W) {
        const kn = (i + di) * NZ + (j + dj);
        if ((FLG[kn] & 1) && WL[kn] < WL[k] - 0.001) steps++;
      }
    }
    for (let q = 0; q < v.length / 12; q++) {
      const y0 = v[q * 12 + 1], y2 = v[q * 12 + 7];
      if (y0 !== y2) { faces++; if (y0 - y2 < 0.4) riffles++; }
    }
  }
  /* #67: no pool stands above all the water around it. A river used to ride
     up every pillar, hill and canyon lip its noise band crossed, so pools sat
     perched on rock with falls pouring out on two or more sides and nothing
     flowing in. Counted over the golden seeds and a 3x3 block of streamed
     chunks; a pool with one outlet and no inlet is a spring-fed pool and is
     allowed. The self-test lifts one cell a metre above its neighbours and
     requires the count to find it. */
  const perched = (w) => {
    const { M, cells } = w, seen = new Uint8Array(M * M), found = [];
    for (let i = 1; i < M - 1; i++) for (let j = 1; j < M - 1; j++) {
      const k0 = i * M + j; if (!cells[k0].water || seen[k0]) continue;
      const q = [k0]; seen[k0] = 1; let higher = false, edge = false, dirs = 0, n = 0;
      while (q.length) {
        const a = q.pop(), ai = (a / M) | 0, aj = a % M, ca = cells[a]; n++;
        for (let d = 0; d < 4; d++) {
          const bi = ai + D4W[d][0], bj = aj + D4W[d][1];
          if (bi < 1 || bj < 1 || bi >= M - 1 || bj >= M - 1) { edge = true; continue; }
          const b = bi * M + bj, cb = cells[b]; if (!cb.water) continue;
          const dy = cb.wl - ca.wl;
          if (Math.abs(dy) < 0.4) { if (!seen[b]) { seen[b] = 1; q.push(b); } }
          else if (dy < 0) dirs |= 1 << d; else higher = true;
        }
      }
      const spill = (dirs & 1) + (dirs >> 1 & 1) + (dirs >> 2 & 1) + (dirs >> 3 & 1);
      if (!edge && !higher && spill >= 2) found.push(`${n} cells at ${i},${j}`);
    }
    return found;
  };
  const perchedAt = [];
  worlds.forEach((w, q) => perched(w).forEach((p) => perchedAt.push(`${GOLDEN_SEEDS[q].nm} ${p}`)));
  for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) {
    perched(chunkWorld('QUARTERSTONE', cx, cz, null, 1)).forEach((p) => perchedAt.push(`chunk ${cx},${cz} ${p}`));
  }
  const wp = worlds.find((w) => w.cells.some((c, k) => c.water)), probe = { ...wp, cells: wp.cells.map((c) => ({ ...c })) };
  let lifted = false;
  for (let k = 0; k < probe.cells.length && !lifted; k++) {
    const i = (k / probe.M) | 0, j = k % probe.M;
    if (i < 2 || j < 2 || i > probe.M - 3 || j > probe.M - 3 || !probe.cells[k].water) continue;
    if (D4W.every(([di, dj]) => probe.cells[(i + di) * probe.M + j + dj].water)) { probe.cells[k].wl += 1; lifted = true; }
  }
  check(perchedAt.length === 0 && lifted && perched(probe).length === 1,
        'WATER: and no pool stands above all the water around it (#67)',
        perchedAt.length ? `${perchedAt.length} perched: ${perchedAt.slice(0, 3).join('; ')}`
          : `none over ${worlds.length} seeds and 9 streamed chunks; a cell lifted a metre is found`);

  check(steps > 0 && faces === steps,
        'WATER: and every step down to lower water is closed, however small',
        `${steps} steps across ${worlds.length} seeds, ${faces} faces (${riffles} riffles under 0.4 m)`);
  /* The self-test: cut one bank voxel beside water down to the bed and require
     the check to find it. */
  const w0 = worlds.find((w) => w.FLG.some((f) => f & 1)), Hs2 = Float32Array.from(w0.Hs);
  let planted = null;
  for (let i = 1; i < w0.NX - 1 && !planted; i++) for (let j = 1; j < w0.NZ - 1 && !planted; j++) {
    const k = i * w0.NZ + j, kn = (i + 1) * w0.NZ + j;
    if ((w0.FLG[k] & 1) && !(w0.FLG[kn] & 1)) { Hs2[kn] = w0.WL[k] - 1; planted = `${i},${j}`; }
  }
  const caught = planted && standing(w0, Hs2).where.includes(planted);
  check(!!caught, 'WATER: and the check sees a bank that does not hold',
        caught ? `bank beside ${planted} cut down, found` : `CUT BANK AT ${planted} NOT SEEN — the check is blind`);
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
      /* `?stream=0`: the BUILD checks are about the one-window world, and the
         build now streams by default wherever a worker answers — which, from
         disk, headless Chromium's blob: workers do. The default is WORKER's to
         check, on a page served the way a person would get it. */
      await bp.goto(`file://${bfile}?stream=0`, { waitUntil: 'domcontentloaded', timeout: PATIENCE });
      await bp.waitForFunction(() => !!(window.QSPLAY && window.QSPLAY.ready), null, { timeout: PATIENCE });
      check(bErrors.length === 0, 'BUILD: boots with no page errors', bErrors.slice(0, 3).join(' | '));

      /* The sky turns with the simulation (#30), and everything below that
         counts pixels would be counting a different hour and different weather
         depending on how long the checks before it ran. Noon and clear, until
         the SKY checks let it go. */
      await bp.evaluate(() => window.QSPLAY.setSky('noon', 0, true));
      /* And `?stream=0` is obeyed without asking anything of a worker. */
      const booted = await bp.evaluate(() => ({ s: window.QSPLAY.streaming, b: window.QSPLAY.boot }));
      check(!booted.s && booted.b === null,
            'BUILD: asked for one window, it opens on one window',
            `streaming ${booted.s ? 'ON' : 'off'}; boot ${booted.b ? 'PROBED workers' : 'did not probe'}`);

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
        /* Issue #33: the rig late in the wind-up, and again as it cuts. */
        while (a.swing && a.swing.t < 0.2) P.run(1);
        P.draw(); const wound = P.rigs.hero;
        while (QS.phase(a) !== QS.PHASE.ACTIVE) P.run(1);
        P.run(2);
        const during = pale(), sweeping = P.sweeping;
        P.run(4); P.draw(); const cut = P.rigs.hero;
        while (a.swing) P.run(1);
        P.pause(false);
        return { before, during, sweeping, windup, struck: P.struck - struckBefore, wound, cut };
      });
      /* Issue #33: the swing is a pose, not an arm group on one axis. Late in
         the wind-up the body has turned back with the blade; as it cuts, both
         have driven through past the facing. */
      check(!!reads.wound && reads.wound.armR.ry < -0.9 && reads.wound.torso.ry < -0.25
            && reads.cut.armR.ry > 0.5 && reads.cut.torso.ry > 0.2,
            'BUILD: the swing is animated: the body winds back with the blade and drives through',
            reads.wound ? `wound up: blade ${reads.wound.armR.ry.toFixed(2)}, body ${reads.wound.torso.ry.toFixed(2)}; `
                          + `cutting: blade ${reads.cut.armR.ry.toFixed(2)}, body ${reads.cut.torso.ry.toFixed(2)}` : 'no rig');
      /* Issue #62: characters, machines, posts and loot were 57 meshes, each its
         own draw call. */
      const ad = await bp.evaluate(() => window.QSPLAY.actorDraws);
      const tally = {}; for (const k of ad.list) tally[k] = (tally[k] || 0) + 1;
      check(ad.n <= 16, 'BUILD: characters, machines, posts and loot cost a handful of draw calls',
            `${ad.n} draws: ${Object.entries(tally).map(([k, n]) => k + ' ' + n).join(', ')} (were 57 meshes)`);
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
        /* No machine in the frame. After #53 a graded trail runs from the
           nearest sentry's post to the practice posts, and a sentry woken by
           the walking checks above comes down it and stands 1.7 m from this
           post, rising and lighting its top plate — pale, and moving, so the
           idle frame and the swing frame each counted a different amount of
           it. Parked out of the world for the measurement and put back after,
           so the checks that want them find them where they were. */
        const parked = (P.machines || []).map((e) => [e, e.x, e.y, e.z]);
        for (const [e] of parked) { e.x += 1000; e.z += 1000; }
        P.run(2);
        /* And nothing still lit from the check before. The swing trail and a
           post's hit flash fade on the wall clock, not on ticks, so what was
           left of them here depended on how fast the renderer was. */
        P.settle();
        const idle = lit();
        const bare = swingAndCount();
        const bareReach = a.st.reach;
        /* Empty the lattice first: the cache above may already have filled it. */
        for (let q = 0; q < P.gear.slots.length; q++) P.unsocket(q);
        while (P.gear.carried.length) P.gear.carried.pop();
        P.give(QS.MOD.SIGIL);
        const seated = P.socket(0, 0);
        const kit = swingAndCount();
        for (const [e, x, y, z] of parked) { e.x = x; e.y = y; e.z = z; }
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
        const rigLit = P.rigs.foes[0];
        const held = live.ai.t;
        live.ai.state = QS.EST.CLOSE; live.ai.t = 0;
        const dark = grab();                     /* same frame, no tell */
        const rigDark = P.rigs.foes[0];
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
        return { foes: foes.length, orange, off, tele, sawWake, sawClose, rigLit, rigDark,
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
      /* Issue #33: the telegraph is a pose now, not a box changing height. Late
         in the wind-up the machine has risen, leans away and has drawn both
         arms behind it; the same frame without the tell has done none of it. */
      const rl = tells.rigLit, rd = tells.rigDark;
      check(!!rl && rl.body.sy > 1.05 && rl.body.rx < -0.15 && rl.armL.ry > 0.4 && rl.armR.ry < -0.4
            && Math.abs(rd.body.rx) < 0.1 && Math.abs(rd.armL.ry) < 0.1,
            'BUILD: and the telegraph is animated: it rises, leans back and draws its arms',
            rl ? `wound up: rise ${rl.body.sy.toFixed(2)}, lean ${rl.body.rx.toFixed(2)}, arms ${rl.armL.ry.toFixed(2)} / ${rl.armR.ry.toFixed(2)}; `
                 + `without the tell: lean ${rd.body.rx.toFixed(2)}, arms ${rd.armL.ry.toFixed(2)}` : 'no rig');
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
        const hm = P.grassLength / 0.50;
        let blades = 0, outside = 0;
        for (const o of tiles) {
          const bs = o.geometry.boundingSphere;
          if (!bs || !o.frustumCulled) { outside += o.count; blades += o.count; continue; }
          const r2 = bs.radius * bs.radius;
          for (let i = 0; i < o.count; i++) {
            o.getMatrixAt(i, m); blades++;
            const e = m.elements, dx = e[12] - bs.center.x, dz = e[14] - bs.center.z;
            const dy = e[13] - bs.center.y, ty = e[13] + e[5] * 1.3 * hm - bs.center.y;
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

      /* ---------- BUILD: the two grass controls under the view ----------
         They are the page's only tuning knobs, and they work by different
         means on purpose: length is a uniform the shader multiplies the
         generator's blade height by, density is how many blades the generator
         makes at all. So the gate holds the difference rather than just that
         each one moved something — length must change what is drawn *without*
         changing how many blades exist, and density must change the count.

         The tiles' bounding spheres are the trap here. One fitted at 50 cm
         does not hold a blade at 110, and the tile would be culled with part
         of it still on screen, so the length check re-walks every blade
         against the refitted spheres at the new length. */
      const gtune = await bp.evaluate(async () => {
        const P = window.QSPLAY;
        const count = () => { let n = 0; P.scene.traverse((o) => {
          if (o.userData.kind === 'grass') n += o.count; }); return n; };
        const loose = () => { const m = new window.THREE.Matrix4(); let out = 0;
          const hm = P.grassLength / 0.50;
          P.scene.traverse((o) => { if (o.userData.kind !== 'grass') return;
            const bs = o.geometry.boundingSphere;
            if (!bs) { out += o.count; return; }
            const r2 = bs.radius * bs.radius;
            for (let i = 0; i < o.count; i++) { o.getMatrixAt(i, m); const e = m.elements;
              const dx = e[12] - bs.center.x, dz = e[14] - bs.center.z;
              const ty = e[13] + e[5] * 1.3 * hm - bs.center.y;
              if (dx * dx + ty * ty + dz * dz > r2) out++; } });
          return out; };
        const len0 = P.grassLength, den0 = P.grassDensity;
        const blades0 = count();
        const el = document.getElementById('glen');
        el.value = '110'; el.dispatchEvent(new Event('input', { bubbles: true }));
        const out = { len0, den0, blades0, lenNow: P.grassLength,
                      bladesAfterLen: count(), looseAtLong: loose(),
                      readout: document.getElementById('glenv').textContent };
        P.setGrassLength(len0);
        /* Density regrows the world, so it is driven through the API and put
           back afterwards; the slider's own listener is the same call. */
        P.setGrassDensity(den0 * 2);
        await new Promise((r) => setTimeout(r, 200));
        out.denNow = P.grassDensity; out.bladesAfterDen = count();
        P.setGrassDensity(den0);
        await new Promise((r) => setTimeout(r, 200));
        out.bladesBack = count();
        return out;
      });
      check(gtune.lenNow > 1.0 && gtune.bladesAfterLen === gtune.blades0
            && gtune.looseAtLong === 0,
            'BUILD: the length control redraws the grass without regrowing it',
            `${(gtune.len0 * 100).toFixed(0)} cm -> ${gtune.readout}, `
            + `${gtune.blades0.toLocaleString()} blades either way, `
            + `${gtune.looseAtLong} of them outside a refitted sphere`);
      check(gtune.bladesAfterDen > gtune.blades0 * 1.6
            && Math.abs(gtune.bladesBack - gtune.blades0) < gtune.blades0 * 0.01,
            'BUILD: and the density control grows more of them, and fewer again',
            `${gtune.den0} /m2 is ${gtune.blades0.toLocaleString()} blades, `
            + `${gtune.denNow} /m2 is ${gtune.bladesAfterDen.toLocaleString()}, `
            + `back to ${gtune.bladesBack.toLocaleString()}`);

      /* ---------- BUILD: grass thins as the view widens, issue #61 ----------
         Grass was two thirds of a frame's triangles at every zoom, and at the
         widest a blade is under a pixel. What is asserted: the default view
         draws every blade, the widest draws a quarter to a third of them, the
         blades it keeps still cover the ground rather than a strip of it, and
         coming back draws every blade again. */
      const zg = await bp.evaluate(() => {
        const P = window.QSPLAY, cam = P.cam, v0 = cam.view;
        const tiles = () => { const t = []; P.scene.traverse((o) => { if (o.userData.kind === 'grass') t.push(o); }); return t; };
        const sum = (f) => tiles().reduce((n, o) => n + f(o), 0);
        P.frameOnce();
        const full = sum((o) => o.userData.full), atDefault = sum((o) => o.count);
        cam.view = 40; P.frameOnce();
        const wide = sum((o) => o.count);
        /* Coverage: the metre cells of the fullest tile that still hold a blade. */
        const big = tiles().sort((p, q) => q.userData.full - p.userData.full)[0], m = new window.THREE.Matrix4(), v = new window.THREE.Vector3();
        const cells = (n) => { const c = new Set(); for (let i = 0; i < n; i++) { big.getMatrixAt(i, m); v.setFromMatrixPosition(m); c.add(Math.floor(v.x) + ',' + Math.floor(v.z)); } return c.size; };
        const covFull = cells(big.userData.full), covWide = cells(big.count);
        cam.view = v0; P.frameOnce();
        const back = sum((o) => o.count);
        return { v0, full, atDefault, wide, back, covFull, covWide };
      });
      check(zg.atDefault === zg.full && zg.back === zg.full
            && zg.wide <= zg.full * 0.35 && zg.wide >= zg.full * 0.2 && zg.covWide >= zg.covFull * 0.9,
            'BUILD: grass thins as the view widens, and covers the ground when it does',
            `${zg.full.toLocaleString()} blades at view ${zg.v0}, ${zg.wide.toLocaleString()} at view 40 `
            + `(${(100 * zg.wide / zg.full).toFixed(0)}%), ${zg.back.toLocaleString()} back at ${zg.v0}; `
            + `the fullest tile keeps a blade in ${zg.covWide} of its ${zg.covFull} metre cells`);

      /* ---------- BUILD: the shadow map is drawn when the world changes, issue #60 ----------
         It was drawn every frame, which drew every terrain and prop triangle
         twice. Asserted by counting the times it is actually drawn: none while
         the world stands still and the character moves, one for a carve. And
         nothing that moves casts into it — the character sits on a blob. */
      const sh = await bp.evaluate(() => {
        const P = window.QSPLAY, a = P.actor;
        P.pause(true); P.frameOnce(); P.frameOnce();
        const s0 = P.shadowRenders;
        P.input.press('KeyW');
        for (let i = 0; i < 6; i++) { P.run(8); P.frameOnce(); }
        P.input.release('KeyW');
        const idle = P.shadowRenders - s0;
        P.carve(a.x + 2.5, a.y - 0.3, a.z, { radius: 0.6, bite: 99 });
        P.frameOnce(); P.frameOnce();
        const carved = P.shadowRenders - s0 - idle;
        P.clearEdits(); P.frameOnce();
        const kinds = {}; for (const k of P.casters) kinds[k] = (kinds[k] || 0) + 1;
        const b = P.blob, out = { idle, carved, kinds, blob: b, ay: P.actor.y, grounded: P.actor.grounded };
        P.pause(false);
        return out;
      });
      check(sh.idle === 0 && sh.carved === 1,
            'BUILD: the shadow map is drawn when the world changes, not every frame',
            `${sh.idle} redraws over six frames of walking, ${sh.carved} for one carve`);
      check(!sh.kinds.actor && sh.blob.visible && (!sh.grounded || Math.abs(sh.blob.y - sh.ay) < 0.1),
            'BUILD: and what moves sits on a blob rather than casting into it',
            `casting: ${Object.entries(sh.kinds).map(([k, n]) => k + ' ' + n).join(', ')}; `
            + `blob ${sh.blob.visible ? 'shown' : 'HIDDEN'} at y ${sh.blob.y.toFixed(2)} under a character at ${sh.ay.toFixed(2)}`);

      /* ---------- SKY: the day turns, and the build draws it — #30, #31, #55 ----------
         The hour and the weather are src/sim/sky.mjs's and asserted in node;
         what is asserted here is that the page draws them. A night that is
         darker than noon but still has a picture in it. A sun that moves in
         steps, so the shadow map (#60) is redrawn a handful of times a minute
         and not every frame. Rain that wets the ground and fills the air. Fog
         on the hand-written shaders, which three does not give them. */
      const sky = await bp.evaluate(() => {
        const P = window.QSPLAY, QS = window.QS;
        P.pause(true);
        const c = document.querySelector('#cv'), gl = c.getContext('webgl') || c.getContext('webgl2');
        const w = c.width, h = c.height;
        const lum = () => {
          P.frameOnce(); P.draw();
          const px = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
          let s = 0, n = 0;
          for (let i = 0; i < px.length; i += 28) { s += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]; n++; }
          return s / n;
        };
        P.setSky('noon', 0, true); const noon = lum(), atNoon = P.sky;
        P.setSky('dusk', 0, true); const dusk = lum();
        P.setSky('night', 0, true); const night = lum(), atNight = P.sky;
        P.setSky('auto', 0);
        const per = Math.round(1 / QS.TICK), s0 = P.shadowRenders;
        for (let i = 0; i < 60; i++) { P.run(per); P.frameOnce(); }
        const redraws = P.shadowRenders - s0, after = P.sky;
        const S = QS.SPELL_SECONDS; let t = -1;
        for (let k = 0; k < 400 && t < 0; k++) if (QS.weatherAt(P.seed, (k + 0.5) * S).rain > 0.5) t = (k + 0.5) * S;
        P.setSky('auto', t); P.frameOnce(); const wet = P.sky;
        const fog = [];
        P.scene.traverse((o) => { const k = o.userData.kind;
          if ((k === 'grass' || k === 'water') && o.material) fog.push(o.material.fog === true && 'fogNear' in o.material.uniforms); });
        P.setSky('noon', 0, true); P.frameOnce();
        P.pause(false);
        return { noon, dusk, night, atNoon, atNight, redraws, after, wet, t,
                 fogged: fog.filter(Boolean).length, fogMats: fog.length };
      });
      check(sky.atNoon.tone && sky.night < sky.noon * 0.55 && sky.night > 12 && sky.dusk < sky.noon && sky.dusk > sky.night,
            'SKY: noon, dusk and night are three different lights, and night still has a picture in it',
            `mean luma ${sky.noon.toFixed(1)} at noon, ${sky.dusk.toFixed(1)} at dusk, ${sky.night.toFixed(1)} at night; `
            + `lamps ${sky.atNoon.lamps} / ${sky.atNight.lamps}; filmic tone mapping ${sky.atNoon.tone ? 'on' : 'OFF'}`);
      check(sky.after.sec >= 59 && sky.redraws >= 4 && sky.redraws <= 9,
            'SKY: the sun moves, in steps, and the shadow map follows it a few times a minute',
            `${sky.redraws} shadow redraws over ${sky.after.sec.toFixed(0)} s of simulated time `
            + `(sun now ${sky.after.sun.map((v) => v.toFixed(2)).join(',')})`);
      check(sky.t > 0 && (sky.wet.mode === 'rain' || sky.wet.mode === 'snow') && sky.wet.parts > 0 && sky.wet.wet > 0.5 && sky.wet.fogFar > sky.wet.fogNear,
            'SKY: rain falls, the ground darkens with it, and the fog comes in',
            `at ${sky.t} s: ${sky.wet.mode} with ${sky.wet.parts} drops, wetness ${sky.wet.wet.toFixed(2)}, `
            + `fog ${sky.wet.fogNear.toFixed(0)}–${sky.wet.fogFar.toFixed(0)}`);
      check(sky.fogMats > 0 && sky.fogged === sky.fogMats,
            'SKY: and the hand-written grass and water shaders are fogged like everything else',
            `${sky.fogged} of ${sky.fogMats} grass and water meshes take the scene's fog`);

      /* ---------- BUILD: a chunk the camera cannot see is not drawn ----------
         Grass was the only thing in a world node that was frustum-culled;
         terrain, props, water and the emissive record were all pinned visible
         with frustumCulled=false. That is why a streamed world submitted six
         times the terrain and props of a windowed one for the same view — the
         field holds 25 chunks of ground and every one of them was sent.

         Measured the way the grass cull is, by taking it away: count what a
         frame submits, turn the test off on everything in the scene, count
         again, and require the second number to be materially higher. A check
         that read only the first number would pass against the old build. The
         bounds themselves are checked too — every mesh that claims to be
         culled must carry a finite sphere, because three leaves a NaN centre
         on an empty buffer and a NaN is culled for the wrong reason. */
      const ccull = await bp.evaluate(() => {
        const P = window.QSPLAY, all = [];
        P.scene.traverse((o) => { if (o.isMesh || o.isInstancedMesh) all.push(o); });
        /* Only what a world node builds. The characters, the practice posts
           and the loot are three's own defaults with a sphere it computes the
           first time it needs one, and asserting against a null there would be
           checking three rather than this build. */
        const OURS = ['terrain', 'props', 'boxes', 'emissive', 'water', 'grass'];
        const kinds = {}, bad = [];
        for (const o of all) {
          const k = o.userData.kind || 'other';
          if (!kinds[k]) kinds[k] = { culled: 0, pinned: 0 };
          kinds[k][o.frustumCulled ? 'culled' : 'pinned']++;
          if (!o.frustumCulled || OURS.indexOf(k) < 0) continue;
          const bs = o.geometry.boundingSphere;
          if (!bs || !isFinite(bs.radius) || !isFinite(bs.center.x)
              || !isFinite(bs.center.y) || !isFinite(bs.center.z)) bad.push(k);
        }
        P.draw();
        const culled = P.draws.triangles;
        const was = all.map((o) => o.frustumCulled);
        for (const o of all) o.frustumCulled = false;
        P.draw();
        const open = P.draws.triangles;
        all.forEach((o, i) => { o.frustumCulled = was[i]; });
        return { kinds, bad, culled, open, meshes: all.length };
      });
      check(ccull.bad.length === 0 && (ccull.kinds.terrain || {}).pinned === 0
            && (ccull.kinds.props || {}).pinned === 0
            && (ccull.kinds.water || {}).pinned === 0,
            'BUILD: terrain, props and water are culled against real bounds',
            Object.entries(ccull.kinds).map(([k, v]) =>
              `${k} ${v.culled}/${v.culled + v.pinned}`).join(', ')
            + (ccull.bad.length ? ` — BAD BOUNDS on ${[...new Set(ccull.bad)].join(', ')}` : ''));
      /* Not asserted here that the cull *saves* anything: one 64 m window is
         roughly what the camera holds at the default zoom, and measured, it
         rejects no terrain at all. The saving is a streamed world's, and so is
         the risk, so both are asserted over there. */
      check(ccull.open >= ccull.culled,
            'BUILD: and turning the test off cannot draw less',
            `${ccull.culled.toLocaleString()} triangles with the test on, `
            + `${ccull.open.toLocaleString()} with it off across ${ccull.meshes} meshes`);

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

        /* One state, two buttons: the overlay twin and the one on the page.
           Both name the renderer and light up when it is on, rather than being
           labelled with what they switch *to* — which had the build opening on
           the mesh with a button reading "Boxes". */
        const lit = () => [document.getElementById('meshtog').getAttribute('aria-pressed'),
                           document.getElementById('meshbtn').getAttribute('aria-pressed')].join('/');
        out.meshAt0 = P.mesh; out.lblAt0 = lit();
        out.pageText0 = document.getElementById('meshbtn').textContent;
        out.viewText = document.getElementById('meshtog').textContent;
        press('meshtog'); out.meshAt1 = P.mesh; out.lblAt1 = lit();
        out.pageText1 = document.getElementById('meshbtn').textContent;
        press('meshtog'); out.meshAt2 = P.mesh; out.lblAt2 = lit();

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
      check(world.meshAt0 === true && world.meshAt1 === false && world.meshAt2 === true
            && world.lblAt0 === 'true/true' && world.lblAt1 === 'false/false'
            && world.lblAt2 === 'true/true'
            && world.viewText === 'Mesh' && world.pageText0 === 'Mesh: on'
            && world.pageText1 === 'Mesh: off',
            'BUILD: the build opens on the mesh, and both buttons say so and light up',
            `"${world.viewText}" and "${world.pageText0}" -> "${world.pageText1}", `
            + `lit ${world.lblAt0} -> ${world.lblAt1} -> ${world.lblAt2}, `
            + `mesh ${world.meshAt0} -> ${world.meshAt1} -> ${world.meshAt2}`);
      check(world.restored === 'QUARTERSTONE', 'BUILD: and the world the rest of the gate needs is back',
            `seed ${world.restored}`);

      /* ---------- BUILD: the frame rate, on screen without the readout ----------
         The number is worth seeing while playing rather than while debugging,
         so it is up whenever the full readout is shut and stands down when it
         opens, because that already carries it.

         Beside it is what a frame costs this thread in milliseconds — every
         one of them, the ticks and the stream pump inside them included, not
         just the draw. It is labelled "ms cpu" because the number is smaller
         than 1000/fps and should be: the gap is the GPU, which WebGL hands work
         to and returns from long before it is done. That is the honest form of
         a question an "uncapped" switch briefly tried and
         failed to answer here. That switch drove the loop off vsync from a
         MessageChannel: it raised the count of frames *submitted*, presented
         nothing extra, and starved touch and compositing. On an iPhone it read
         200 fps while the world ran in slow motion — once the GPU queue backs
         up a frame takes hundreds of milliseconds, the fixed-step guard below
         can only run eight ticks of it, and in-world time falls behind the
         wall clock. There is no swapInterval(0) on the web. Timing the frame
         answers "is there headroom" without breaking the game to ask. */
      const pace = await bp.evaluate(async () => {
        const P = window.QSPLAY;
        const press = (id) => document.getElementById(id).click();
        const out = { el: !!document.getElementById('fpsr') };
        out.shownClosed = P.fpsShown; out.textClosed = P.fpsText;
        press('hudbtn');  out.shownOpen = P.fpsShown;
        press('hudbtn');  out.shownAgain = P.fpsShown;
        /* Frames driven by hand, because the loop does not run here:
           requestAnimationFrame does not fire in a page this harness never puts
           on screen. Paused first, so these cost a draw and a readout and do
           not walk the character somewhere the later checks did not put it. */
        P.pause(true);
        for (let i = 0; i < 5; i++) P.frameOnce();
        P.pause(false);
        out.cost = P.frameCost;
        out.noUncap = !document.getElementById('fpstog') && P.uncapped === undefined;
        return out;
      });
      check(pace.el && pace.shownClosed && !pace.shownOpen && pace.shownAgain
            && /\d+\s*fps/.test(pace.textClosed)
            && /\d+(\.\d+)?\s*ms cpu/.test(pace.textClosed),
            'BUILD: the frame rate and what a frame costs are on screen without the readout',
            `"${pace.textClosed.trim()}" with the readout shut, `
            + `${pace.shownOpen ? 'STILL SHOWN' : 'hidden'} with it open, back when it closes`);
      check(pace.noUncap && Number.isFinite(pace.cost) && pace.cost > 0,
            'BUILD: and nothing offers to outrun the display',
            'no Uncap button and no uncapped state; frame cost reads '
            + (Number.isFinite(pace.cost) ? pace.cost.toFixed(2) + ' ms' : 'NOT A NUMBER'));

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
        /* And from open ground, not the spawn itself. The spawn is the first
           walkable cell of trail, and a trail is a cutting: after #53 the one
           on hero put a 1.6 m bank 1.7 m along the stick's heading, and the
           character vaulted it and came up 0.7 m short. The start is found
           with the page's own actor and collider walking a scratch actor at
           full deflection, before the thumb is involved at all, so the check
           still measures the thumb and not the search. */
        const head = QS.moveFrom(P.cam, far.ix, far.iy);
        let start = null;
        for (let ring = 0; ring <= 12 && !start; ring++) {
          for (let k = 0; k < Math.max(1, ring * 8) && !start; k++) {
            const t = (k / Math.max(1, ring * 8)) * Math.PI * 2;
            const probe = QS.placeOnGround(P.collider, P.actor.x + ring * Math.cos(t), P.actor.z + ring * Math.sin(t));
            if (!probe) continue;
            const px = probe.x, pz = probe.z;
            let vaulted = false;
            for (let q = 0; q < 60; q++) {
              QS.step(P.collider, probe, { mx: head.mx, mz: head.mz }, []);
              if (probe.vault || probe.swimming || probe.dead) vaulted = true;
            }
            if (!vaulted && Math.sqrt((probe.x - px) ** 2 + (probe.z - pz) ** 2) > 3.9) start = [px, pz];
          }
        }
        out.start = start;
        const a = P.actor;
        if (start) {
          const s0 = QS.placeOnGround(P.collider, start[0], start[1]);
          a.x = s0.x; a.y = s0.y; a.z = s0.z; a.grounded = s0.grounded; a.apex = s0.apex;
        }
        a.dead = null; a.vx = 0; a.vz = 0; a.vy = 0; a.vault = null;
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
            + `, from ${touch.from.join(',')}${touch.start ? '' : ' (no open ground found near the spawn)'}, ${touch.ended}`);
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
      await peerPage.evaluate(() => window.QSPLAY.setSky('noon', 0, true));
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
      await cp.goto(`file://${bfile}?stream=0`, { waitUntil: 'domcontentloaded', timeout: PATIENCE });
      await cp.waitForFunction(() => !!(window.QSPLAY && window.QSPLAY.ready), null, { timeout: PATIENCE });
      await cp.evaluate(() => window.QSPLAY.setSky('noon', 0, true));
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
      await sp.evaluate(() => window.QSPLAY.setSky('noon', 0, true));
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

      /* ---------- STREAM: the chunks the camera cannot see are not drawn ----------
         A field of 25 chunks is 25,600 m2 of ground and the camera holds about
         one 64 m window of it, so a streamed frame should cost about what a
         windowed one does. It did not: everything in a world node except the
         grass carried frustumCulled=false, so all six times the terrain and
         props went to the GPU every frame.

         Two things have to hold, and the second is the one that matters.

         The cull has to *save* something — otherwise the bounds are wrong in
         the loose direction and this is all cost and no benefit.

         And it has to be **lossless**, which is checked exactly rather than
         argued: draw one frame with the test on and read the framebuffer, draw
         the same frame with it off and read again, and require the two to be
         the same pixels. One page, one camera, one pose, nothing between the
         reads. A chunk rejected while any part of it was on screen changes
         pixels, and so does a shadow that stopped being cast — three tests
         frustumCulled again in the shadow pass, against the light's frustum
         rather than the camera's, and this is what holds it to that.

         How hard does it bite? Measured, by shrinking every sphere fitBounds
         computes and seeing where the pixels move: x0.6 is still lossless,
         x0.4 loses 9,342 pixels, x0.25 loses 57,499, x0.1 loses 315,832. So it
         catches a sphere under about 40% of the right size and not a mildly
         tight one — the spheres carry roughly that much slack, because a
         sphere around a square chunk is a diagonal wider than the chunk and
         three has no box test for frustumCulled. That slack is also what the
         saving is losing: at x0.6 the same frame submits 738k against 897k. */
      const scull = await sp.evaluate(() => {
        const P = window.QSPLAY;
        P.pause(true);
        const c = document.querySelector('#cv');
        const gl = c.getContext('webgl') || c.getContext('webgl2');
        const w = c.width, h = c.height;
        const snap = () => { P.draw(); const px = new Uint8Array(w * h * 4);
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
        const meshes = []; P.scene.traverse((o) => {
          if (o.isMesh || o.isInstancedMesh) meshes.push(o); });
        const on = snap(), tOn = P.draws.triangles, cOn = P.draws.calls;
        const was = meshes.map((o) => o.frustumCulled);
        for (const o of meshes) o.frustumCulled = false;
        const off = snap(), tOff = P.draws.triangles, cOff = P.draws.calls;
        meshes.forEach((o, i) => { o.frustumCulled = was[i]; });
        let diff = 0;
        for (let i = 0; i < on.length; i += 4) {
          if (on[i] !== off[i] || on[i + 1] !== off[i + 1] || on[i + 2] !== off[i + 2]) diff++;
        }
        P.pause(false);
        return { px: w * h, diff, tOn, tOff, cOn, cOff, meshes: meshes.length,
                 pinned: was.filter((v) => !v).length };
      });
      check(scull.pinned === 0 && scull.tOff > scull.tOn * 2,
            'STREAM: and a frame is charged for the chunks the camera holds, not the field',
            `${scull.tOn.toLocaleString()} triangles of ${scull.tOff.toLocaleString()} `
            + `in ${scull.meshes} meshes, ${scull.cOn} draw calls of ${scull.cOff} `
            + `— ${(100 * (scull.tOff - scull.tOn) / scull.tOff).toFixed(0)}% never submitted`);
      check(scull.diff === 0,
            'STREAM: and rejecting them changes not one pixel',
            scull.diff === 0 ? `identical over ${scull.px.toLocaleString()} pixels`
                             : `${scull.diff} pixels differ — the cull is dropping something visible`);

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
        /* Adoption alone: `deliver` is a round trip less the worker's time,
           and mostly a reply queued behind a software-rendered frame — not
           this thread's work (#64). */
        check(worker.gen > worker.take,
              'WORKER: generating a chunk costs the main thread less than doing it',
              `${worker.offThread} windows off this thread: ${worker.gen.toFixed(0)} ms to `
              + `generate there, ${worker.take.toFixed(0)} ms to adopt here `
              + `(${worker.deliver.toFixed(0)} ms in transit)`);
      } else {
        check(true, 'WORKER: no worker here, and the build streams without one',
              worker.poolFailed ? 'the pool was refused or never answered — main-thread fallback'
                                : 'no worker started; the stream ran on the main thread');
      }
      await sp.screenshot({ path: join(OUT, 'play-streamed.png') });
      await sp.close();

      /* ---------- WORKER: the off-thread path, over HTTP (#64) ----------
         Everything above opens the page from disk, where a blob: worker is
         refused — so the path streaming actually takes in a browser, the one
         whose cost decides whether it can be the default, had no check at all.
         Here the page is served, the pool starts, and what the worker hands
         back is checked against what this thread would have built: the
         collider it packed answers every probe the same, and the grass tiles
         it composed hold the same blades. Timing is recorded, not asserted
         tightly — the runner is software-rendered and shared — but a return
         to the old 200 ms of main-thread work would still trip it. */
      const html = readFileSync(PLAY_TARGET, 'utf8').replace(CDN, 'three.js');
      const three = readFileSync(THREE_LOCAL);
      const srv = createServer((req, res) => {
        if (req.url.startsWith('/three.js')) { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(three); }
        else { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); }
      });
      await new Promise((r) => srv.listen(0, '127.0.0.1', r));
      const wp = await browser.newPage({ viewport: { width: 320, height: 200 } });
      wp.setDefaultTimeout(PATIENCE);
      const wErrors = [];
      wp.on('pageerror', (e) => wErrors.push(e.message));
      wp.on('console', (m) => { if (m.type() === 'error' && !/ERR_/.test(m.text())) wErrors.push(m.text()); });
      /* No flag: served, the build is meant to stream by default. */
      await wp.goto(`http://127.0.0.1:${srv.address().port}/`, { waitUntil: 'domcontentloaded', timeout: PATIENCE });
      await wp.waitForFunction(() => !!(window.QSPLAY && window.QSPLAY.ready), null, { timeout: PATIENCE });
      const wboot = await wp.evaluate(() => ({ s: window.QSPLAY.streaming, b: window.QSPLAY.boot }));
      check(wboot.s && wboot.b && wboot.b.workers,
            'WORKER: and where a worker answers, the build streams by default',
            `streaming ${wboot.s ? 'on' : 'OFF'}; a worker answered boot in ${wboot.b ? wboot.b.ms.toFixed(0) : '?'} ms`);
      await wp.evaluate(() => { const P = window.QSPLAY; P.setSky('noon', 0, true); P.pause(true); P.input.press('KeyW'); });
      const takes = [];
      let wc = null, lastDone = 0;
      for (let i = 0; i < 400 && lastDone < 12; i++) {
        /* A few ticks, then back to the event loop so a worker's reply can be
           delivered — a caller that never yields never receives one. */
        wc = await wp.evaluate(() => { window.QSPLAY.run(6); return window.QSPLAY.chunks; });
        if (wc.offThread > lastDone) { lastDone = wc.offThread; takes.push(wc.take); }
        await new Promise((r) => setTimeout(r, 120));
      }
      const same = await wp.evaluate(() => {
        const P = window.QSPLAY, QS = window.QS, f = P.field, out = { chunks: 0, probes: 0, diff: 0, blades: 0, bladesHere: 0 };
        for (const e of f.live()) {
          if (!e.col || !e.w) continue;
          const here = QS.colliderForChunk(e.w, e.cx, e.cz);
          out.chunks++;
          for (let a = -15.5; a < 16; a += 1.3) for (let b = -15.5; b < 16; b += 1.7) {
            const x = e.cx * QS.CHUNK + a, z = e.cz * QS.CHUNK + b; out.probes++;
            if (here.supportUnder(x, z, 0.3, Infinity) !== e.col.supportUnder(x, z, 0.3, Infinity)) out.diff++;
          }
          const nd = P.node(e.cx, e.cz);
          if (nd) {
            let n = 0; nd.g.traverse((o) => { if (o.userData.kind === 'grass') n += o.userData.full; });
            out.blades += n;
            out.bladesHere += P.grassTiles(e.w.grass, QS.CHUNK / 2).reduce((s, t) => s + t.n, 0);
          }
        }
        return out;
      });
      await wp.evaluate(() => { window.QSPLAY.input.release('KeyW'); });

      /* ---------- STREAM: the zoom stops before the loaded ground does (#31) ----------
         A streamed world's only edge is the ring of chunks around the players,
         and the widest zoom used to show it — sky in a near corner of the
         screen, where no fog reaches. Asked for 40, the view has to settle
         where every screen corner still lands on loaded ground, and come back
         to what the player asked for when they zoom in again. */
      const zoom = await wp.evaluate(() => {
        const P = window.QSPLAY, QS = window.QS, c = P.cam, cv = document.querySelector('#cv');
        QS.setView(c, 40); P.frameOnce(); P.frameOnce();
        const capped = c.view, f = P.field, h = QS.CHUNK / 2;
        let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
        for (const e of f.live()) { x0 = Math.min(x0, e.cx * QS.CHUNK - h); x1 = Math.max(x1, e.cx * QS.CHUNK + h);
                                    z0 = Math.min(z0, e.cz * QS.CHUNK - h); z1 = Math.max(z1, e.cz * QS.CHUNK + h); }
        /* Every corner of the screen, followed down onto the target's height. */
        const cam3 = P.camera, V3 = window.THREE.Vector3, out = [];
        for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          const p = new V3(sx, sy, -1).unproject(cam3), d = new V3(0, 0, -1).transformDirection(cam3.matrixWorld);
          const t = (c.ty - p.y) / d.y; out.push([p.x + t * d.x, p.z + t * d.z]);
        }
        const inside = out.every(([x, z]) => x > x0 && x < x1 && z > z0 && z < z1);
        QS.setView(c, 10); P.frameOnce();
        return { capped, inside, back: c.view, w: cv.width };
      });
      check(zoom.capped < 40 && zoom.capped >= 6 && zoom.inside && zoom.back === 10,
            'STREAM: zoomed all the way out, the screen stays on loaded ground',
            `asked for 40, held at ${zoom.capped.toFixed(1)} with every corner inside the loaded chunks; `
            + `back to ${zoom.back} when asked`);

      /* ---------- NET, streamed: a guest grows the kind of world its host has ----------
         The host's cfg did not say whether it streamed, so a streamed host and
         its guest stood in two different worlds from one seed. */
      const [wpeer] = await Promise.all([
        wp.waitForEvent('popup', { timeout: PATIENCE }),
        wp.evaluate(() => window.QSPLAY.host()),
      ]);
      wpeer.setDefaultTimeout(PATIENCE);
      wpeer.on('pageerror', (e) => wErrors.push(`peer: ${e.message}`));
      /* The host is paused from the walk above, and a paused host never ticks —
         so it never announces itself, and the guest waits for ever. Both are
         driven by hand until they have met, the same way the walk is. */
      await wpeer.waitForFunction(() => !!window.QSPLAY, null, { timeout: PATIENCE });
      let met = false;
      for (let q = 0; q < 300 && !met; q++) {
        await wp.evaluate(() => window.QSPLAY.run(4));
        met = await wpeer.evaluate(() => { const P = window.QSPLAY; if (P.role === 'guest') P.run(1);
                                           return !!(P.ready && P.connected); })
              && await wp.evaluate(() => window.QSPLAY.connected);
        if (!met) await new Promise((r) => setTimeout(r, 100));
      }
      check(met, 'NET: a streamed host and its guest find each other', met ? 'joined' : 'never joined');
      if (met) {
      await wpeer.evaluate(() => { const P = window.QSPLAY; P.setSky('noon', 0, true); P.pause(true); P.input.press('KeyD'); });
      for (let q = 0; q < 20; q++) {
        await wpeer.evaluate(() => window.QSPLAY.run(4));
        await wp.evaluate(() => window.QSPLAY.run(4));
      }
      await wpeer.evaluate(() => window.QSPLAY.input.release('KeyD'));
      for (let q = 0; q < 12; q++) {
        await wpeer.evaluate(() => window.QSPLAY.run(4));
        await wp.evaluate(() => window.QSPLAY.run(4));
      }
      const hostSees = await wp.evaluate(() => ({ x: window.QSPLAY.peer.x, z: window.QSPLAY.peer.z }));
      const guestIs = await wpeer.evaluate(() => ({ s: window.QSPLAY.streaming, x: window.QSPLAY.actor.x,
                                                     z: window.QSPLAY.actor.z, y: window.QSPLAY.actor.y }));
      const sgap = Math.hypot(hostSees.x - guestIs.x, hostSees.z - guestIs.z);
      check(guestIs.s && Number.isFinite(guestIs.y) && sgap < 0.6,
            'NET: a streamed host\'s guest streams too, and both agree where it stands',
            `guest streaming ${guestIs.s ? 'on' : 'OFF'}, ${sgap.toFixed(3)} m apart`);
      }
      await wpeer.close();
      await wp.evaluate(() => window.QSPLAY.pause(false));
      await wp.close();
      srv.close();
      takes.sort((a, b) => a - b);
      const med = takes.length ? takes[takes.length >> 1] : NaN;
      check(wErrors.length === 0 && wc && wc.workers > 0 && !wc.poolFailed && lastDone >= 6,
            'WORKER: served over HTTP, the pool starts and chunks arrive from it',
            `${wc ? wc.workers : 0} workers, ${lastDone} chunks adopted off this thread`
            + `${wc && wc.err ? `; error: ${wc.err}` : ''}${wErrors.length ? `; ${wErrors.slice(0, 2).join(' | ')}` : ''}`);
      check(same.chunks >= 9 && same.probes > 0 && same.diff === 0 && same.blades > 0 && same.blades === same.bladesHere,
            'WORKER: and what it builds is what this thread would have — the collider and the grass',
            `${same.chunks} chunks, ${same.probes} collider probes, ${same.diff} different; `
            + `${same.blades.toLocaleString()} blades drawn against ${same.bladesHere.toLocaleString()} rebuilt here`);
      check(takes.length > 0 && med < 60,
            'WORKER: and a chunk costs this thread a fraction of what it did',
            `median ${med.toFixed(1)} ms to adopt a chunk on this thread over ${takes.length} chunks `
            + `(was ~220 ms in this sandbox before #64; the frame is 16.7 ms), collider ${wc.col.toFixed(1)} ms, `
            + `scene ${wc.node.toFixed(1)} ms of the last`);
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
