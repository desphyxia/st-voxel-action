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

/**
 * The first tile only. The plate renders its six biome tiles one after another,
 * and under software rendering that is most of the smoke test's wall clock —
 * for a check whose whole claim is "the renderer still draws". The six seeds
 * are already compared voxel by voxel by PARITY and GOLDEN; drawing one of them
 * proves the renderer, and issue #25 asked for exactly this trade.
 */
export const someTileDone = () =>
  [...document.querySelectorAll('.wait')].some((w) => w.style.display === 'none');

/** Seeds the golden-master baseline is measured against. */
export const GOLDEN_SEEDS = [
  { nm: 'meadow', seed: 'ALDER-RUN', force: 0, size: 64, ox: 704, oz: 448 },
  { nm: 'mesa', seed: 'DRY-KETTLE', force: 1, size: 64, ox: 1408, oz: 896 },
  { nm: 'fen', seed: 'BLACKREED', force: 2, size: 64, ox: 2112, oz: 1280 },
  { nm: 'ash', seed: 'CINDERWAKE', force: 3, size: 64, ox: 2816, oz: 1728 },
  { nm: 'frost', seed: 'HOARFROST-9', force: 4, size: 64, ox: 3520, oz: 2176 },
  { nm: 'hero', seed: 'QUARTERSTONE', force: null, size: 64, ox: 0, oz: 0 },
];

/**
 * What one generated world contains. Self-contained on purpose: it is called
 * directly against src/gen in node, and serialized into the page to run
 * against the plate's bundled copy, and the two must agree exactly.
 *
 * `digest` hashes every array the generator emits — positions, colours,
 * materials, grass, water, reach, cells. The counts above it would miss a
 * change that swapped two voxels or shifted a colour; the digest would not.
 */
export function measureWorld(d, name) {
  const buf = new DataView(new ArrayBuffer(8));
  const SEED = 2166136261 >>> 0;
  let h = SEED;   /* over everything */
  let s = SEED;   /* over the section being hashed right now */
  const num = (v) => {
    buf.setFloat64(0, +v);
    for (let b = 0; b < 8; b++) {
      const c = buf.getUint8(b);
      h ^= c; h = Math.imul(h, 16777619) >>> 0;
      s ^= c; s = Math.imul(s, 16777619) >>> 0;
    }
  };
  const arr = (a) => { if (!a) { num(-1); return; } num(a.length); for (let i = 0; i < a.length; i++) num(a[i]); };
  const hex = (v) => ('00000000' + (v >>> 0).toString(16)).slice(-8);

  /* Each section is hashed into its own bucket as well as into the total, so
     a digest-only mismatch names the array that moved instead of only saying
     that one did. Working that out the hard way cost a CI round trip. */
  const parts = {};
  const part = (nm, fn) => { s = SEED; fn(); parts[nm] = hex(s); };

  part('vox', () => { arr(d.pos); arr(d.pal); arr(d.shd); arr(d.mat); });
  part('magma', () => { arr(d.mpos); arr(d.mpal); arr(d.mshd); arr(d.mmat); });
  part('grass', () => {
    arr(d.grass.p); arr(d.grass.ph); arr(d.grass.ti);
    arr(d.grass.sc); arr(d.grass.yw); arr(d.grass.c); arr(d.grass.dc);
  });
  part('water', () => {
    arr(d.water.v); arr(d.water.i); arr(d.water.d); arr(d.water.f); arr(d.water.fl);
  });
  part('maps', () => {
    arr(d.trail); arr(d.topi); arr(d.unreach); arr(d.reach); arr(d.Hs); arr(d.FLG);
  });
  part('sites', () => {
    arr(d.spawn); arr(d.lmPos); arr(d.ovhPos);
    num(d.lamps.length); for (let q = 0; q < d.lamps.length; q++) arr(d.lamps[q]);
    num(d.bridges.length); for (let q = 0; q < d.bridges.length; q++) arr(d.bridges[q]);
  });
  part('cells', () => {
    num(d.NX); num(d.NZ); num(d.half); num(d.M); num(d.size);
    for (let q = 0; q < d.cells.length; q++) {
      const c = d.cells[q];
      num(c.H); num(c.water ? 1 : 0); num(c.pond ? 1 : 0); num(c.wl); num(c.magma ? 1 : 0);
      num(c.dom); num(c.cw); num(c.fx); num(c.fz); arr(c.w);
      num(c.sp ? c.sp.length : -1);
      for (let t = 0; c.sp && t < c.sp.length; t++) { num(c.sp[t][0]); num(c.sp[t][1]); }
      num(c.canyon ? c.canyon.d : -1);
    }
  });

  /* Props standing in the routed trail (issue #43).
     Terrain and props sit on interleaved lattices — buildVoxels emits column
     centres at -half + i*V + V/2, addVox rounds to multiples of V — so a voxel
     on the whole-V grid is a stamp and one on the half-offset is terrain. The
     collider already relies on that offset; here it is what tells the two
     apart without threading a marker through every array.

     Foliage is exempt: a tree beside a road has branches over the road, and
     whether those branches should *collide* is a separate question. That means
     MAT.SNOW as well as MAT.LEAF — a frost conifer's canopy is snow-capped per
     voxel, so half of it is filed under snow. Ground accumulation is also snow
     but lands on the terrain lattice, so it never reaches this test.

     A crossing is exempt because a deck belongs on the trail — that is what it
     is for. */
  let trailProps = 0;
  {
    /* Inlined rather than imported: this function is stringified into the page
       (measureWorld.toString()), where a module import is not in scope. */
    const VV = 0.25;
    const half = d.half, M = d.M, NZ = d.NZ;
    const ci = (v) => Math.min(M - 1, Math.max(0, Math.round(v + half)));
    const onDeck = (x, z) => {
      for (let q = 0; q < d.bridges.length; q++) {
        const b = d.bridges[q];
        const along = (x - b[0]) * b[2] + (z - b[1]) * b[3];
        const across = (x - b[0]) * b[3] - (z - b[1]) * b[2];
        if (Math.abs(along) <= b[4] / 2 + 1 && Math.abs(across) <= 1.25) return true;
      }
      return false;
    };
    for (let q = 0; q < d.pos.length; q += 3) {
      const x = d.pos[q], y = d.pos[q + 1], z = d.pos[q + 2];
      /* half-offset means terrain, so only whole-V positions are stamps */
      if (Math.abs(x / VV - Math.round(x / VV)) > 0.25) continue;
      if (Math.abs(z / VV - Math.round(z / VV)) > 0.25) continue;
      if (!d.trail[ci(x) * M + ci(z)]) continue;
      const mt = d.mat[q / 3];
      if (mt === 10 || mt === 5) continue;                     /* LEAF, SNOW — canopy */
      const k = Math.min(NZ - 1, Math.max(0, Math.round((x + half) / VV - 0.5))) * NZ
              + Math.min(NZ - 1, Math.max(0, Math.round((z + half) / VV - 0.5)));
      const surf = d.Hs[k];
      if (y < surf - 0.3 || y > surf + 1.8) continue;          /* the walkable band */
      if (onDeck(x, z)) continue;
      trailProps++;
    }
  }

  /* Issue #47: a lamp stands beside the route it lights. It used to exist or
     not by the trail's local shape, and ash had none. Counted here with how
     many have a trail cell within 3 m of the post; the trail check above
     already says none of them stands on it. */
  let lamps = d.lamps.length, lampsByTrail = 0;
  for (let q = 0; q < d.lamps.length; q++) {
    const px = d.lamps[q][0] - 0.5, pz = d.lamps[q][2], M = d.M, half = d.half;
    let near = false;
    for (let di = -3; di <= 3 && !near; di++) for (let dj = -3; dj <= 3 && !near; dj++) {
      const i = Math.round(px + half) + di, j = Math.round(pz + half) + dj;
      if (i < 0 || j < 0 || i >= M || j >= M) continue;
      if (d.trail[i * M + j] && Math.sqrt((i - half - px) ** 2 + (j - half - pz) ** 2) <= 3) near = true;
    }
    if (near) lampsByTrail++;
  }

  /* Water bodies counted two ways. A river narrow enough to be one cell wide,
     stepping diagonally, joins only at its corners: 4-connected sees a string
     of puddles where 8-connected sees one river, and the gap between the two
     counts is exactly the defect (issue #44). */
  let waterBodies = 0, waterBodies8 = 0;
  {
    const M = d.M;
    const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const N8 = N4.concat([[1, 1], [1, -1], [-1, 1], [-1, -1]]);
    const count = (nbr) => {
      const seen = new Uint8Array(M * M);
      let n = 0;
      for (let st = 0; st < M * M; st++) {
        if (!d.cells[st].water || seen[st]) continue;
        n++;
        const q = [st]; seen[st] = 1;
        while (q.length) {
          const c = q.pop(), cx = (c / M) | 0, cz = c % M;
          for (let e = 0; e < nbr.length; e++) {
            const a2 = cx + nbr[e][0], b2 = cz + nbr[e][1];
            if (a2 < 0 || b2 < 0 || a2 >= M || b2 >= M) continue;
            const k2 = a2 * M + b2;
            if (d.cells[k2].water && !seen[k2]) { seen[k2] = 1; q.push(k2); }
          }
        }
      }
      return n;
    };
    waterBodies = count(N4); waterBodies8 = count(N8);
  }

  let water = 0, trail = 0, unreach = 0, wetTrail = 0;
  for (let i = 0; i < d.M * d.M; i++) {
    if (d.cells[i].water) water++;
    if (d.trail[i]) trail++;
    /* A trail cell standing in water is the route asking you to swim. It is
       what a crossing is for, and the only honest trigger for requiring one. */
    if (d.trail[i] && d.cells[i].water) wetTrail++;
  }
  for (let i = 0; i < d.unreach.length; i++) unreach += d.unreach[i];
  return {
    seed: name,
    trailProps, waterBodies, waterBodies8, lamps, lampsByTrail,
    voxels: d.pos.length / 3,
    /* mats must equal voxels: pos, col and mat are one record split three ways,
       and a stamp that forgets its material shows up here as a mismatch. */
    mats: d.mat ? d.mat.length : -1,
    matKinds: d.mat ? new Set(d.mat).size : -1,
    grass: d.grass.ph.length,
    waterCells: water,
    trailCells: trail,
    wetTrail,
    bridges: d.bridges.length,
    landmark: !!d.lmPos,
    overhang: !!d.ovhPos,
    unreachPct: +(100 * unreach / d.unreach.length).toFixed(1),
    digest: hex(h),
    parts,
  };
}

/** Every difference between two measurements, `parts` flattened into it. */
export function diffMeasure(want, got, skip = []) {
  if (!got) return ['missing'];
  const out = Object.keys(want)
    .filter((k) => k !== 'parts' && !skip.includes(k) && want[k] !== got[k])
    .map((k) => `${k} ${want[k]} → ${got[k]}`);
  const wp = want.parts || {}, gp = got.parts || {};
  for (const k of Object.keys(wp)) if (wp[k] !== gp[k]) out.push(`${k}[] ${wp[k]} → ${gp[k]}`);
  return out;
}

/**
 * The generator's math, hashed over a fixed sample. src/gen/exact.mjs exists
 * because Math.sin, Math.cos, Math.exp and Math.hypot are only
 * implementation-approximated and drift between engine versions; this is what
 * asserts the replacements really are pinned, in the one place where two
 * different engines run the same code.
 */
export function mathProbe(E) {
  let a = 20260913 | 0;
  const rnd = () => {
    a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  const buf = new DataView(new ArrayBuffer(8));
  let h = 2166136261 >>> 0;
  const num = (v) => {
    buf.setFloat64(0, +v);
    for (let b = 0; b < 8; b++) { h ^= buf.getUint8(b); h = Math.imul(h, 16777619) >>> 0; }
  };
  for (let i = 0; i < 20000; i++) {
    const x = (rnd() - 0.5) * 40, y = (rnd() - 0.5) * 40;
    num(E.sin(x)); num(E.cos(y)); num(E.hyp(x, y)); num(E.exp(-Math.abs(x)));
  }
  return ('00000000' + (h >>> 0).toString(16)).slice(-8);
}

/** Runs in the page, against the generator the plate has bundled. */
export function measureSeeds(cfgs, measureSrc) {
  const measure = new Function(`return (${measureSrc})`)();
  return cfgs.map((c) => measure(window.QS.buildWorld(c), c.nm));
}

/** The worlds themselves, generated in node straight off src/gen. */
export async function generateSeeds(cfgs) {
  const { buildWorld } = await import('../../src/gen/index.mjs');
  return cfgs.map((c) => buildWorld(c));
}

/** Same six seeds, measured. */
export async function measureSeedsInNode(cfgs) {
  return (await generateSeeds(cfgs)).map((w, i) => measureWorld(w, cfgs[i].nm));
}
