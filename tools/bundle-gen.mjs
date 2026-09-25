/**
 * Bundles src/gen into the concept plate.
 *
 *   node tools/bundle-gen.mjs           # rewrite docs/concept/index.html
 *   node tools/bundle-gen.mjs --check   # fail if the plate is out of date
 *
 * The plate has to stay a single self-contained file: it is opened from disk,
 * and published as an artifact whose CSP admits no module graph. So the
 * generator is inlined into it between markers rather than imported at runtime.
 * src/gen is the source; the block in the plate is output, and the smoke test
 * fails if the two have drifted.
 *
 * The transform is deliberately dumb — strip `import`, strip `export`,
 * concatenate in dependency order, close over it all and publish one global.
 * Keep src/gen to plain static imports and it stays true.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PLATE = join(ROOT, 'docs/concept/index.html');
export const PLAY = join(ROOT, 'docs/play/index.html');
export const BEGIN = '/* QS-BUNDLE-BEGIN — generated from src/gen by tools/bundle-gen.mjs */';
export const END = '/* QS-BUNDLE-END */';

/** Dependency order, per directory. A module may only use names above it. */
const MODULES = {
  'src/gen': ['constants', 'exact', 'materials', 'palette', 'rng', 'biomes', 'field', 'erosion', 'region', 'ground', 'routes',
              'spans', 'water', 'surface', 'props', 'grass', 'reach', 'index', 'chunk'],
  'src/mesh': ['greedy', 'carve', 'propmesh'],
  'src/sim': ['collider', 'chunks', 'stream', 'combat', 'lattice', 'loot', 'actor', 'enemy', 'anim', 'camera', 'input'],
  'src/net': ['transport', 'session'],
};

/** The generator's public surface: what the concept plate draws with. */
const GEN_API = ['V', 'CEIL', 'CHUNK', 'MOVE', 'clamp', 'BIOMES', 'MAT', 'MATERIALS',
                 'carvable', 'makeGen', 'buildWorld',
                 /* the colour table, so a renderer can resolve a voxel's palette
                    index and restyle without regenerating — issue #28 */
                 'PALETTE', 'PAL', 'palR', 'palG', 'palB', 'shadeValue',
                 /* the pinned math, so the smoke test can compare it across engines */
                 'sin', 'cos', 'exp', 'hyp',
                 /* the chunked world, for the build's streamed renderer — issue #13 */
                 'chunkWorld', 'chunkCentre', 'SKIRT', 'WINDOW'];

/** The greedy mesher, behind the build's renderer flag — issue #12. */
const MESH_API = ['meshChunk', 'chunkOccupancy', 'innerChunk', 'openAir', 'surfaceAt', 'LEVELS',
  'isCut', 'solidVox', 'carve', 'clearEdits', 'chunkGrid', 'BITE', 'BITE_R',
  /* props without the faces nobody can see — issue #51 */
  'meshProps', 'solidKeys'];

/** Everything the playable build needs on top of it: the simulation and the wire. */
const SIM_API = ['LIQUID', 'EPS', 'makeCollider', 'colliderForWorld', 'softProp',
                 'chunkAt', 'makeChunkField', 'makeStream', 'STREAM',
                 'ACTOR', 'TICK', 'RUN', 'GRAVITY', 'JUMP_V', 'JUMP_APEX',
                 'makeActor', 'placeOnGround', 'embedded', 'step', 'display', 'applyDisplay',
                 'PHASE', 'phase', 'swingProgress', 'dodging', 'invulnerable',
                 'STAMINA_MAX', 'SWING_COST', 'DODGE_COST', 'SWING_TIME', 'WINDUP', 'ACTIVE',
                 'REACH', 'ARC', 'DODGE_TIME', 'DODGE_DIST', 'practicePosts',
                 'PLAYER_HP', 'SWING_DAMAGE', 'HURT_TIME', 'hurt', 'heal', 'applyHits',
                 'baseStats', 'statsOf', 'swingTime', 'dodgeSpeed',
                 'TRAD', 'TRADITIONS', 'MOD', 'MODULES', 'FUS', 'FUSIONS',
                 'FRAME', 'FRAMES', 'CARRY', 'makeGear', 'recomputeGear',
                 'latentFusions', 'knows', 'recipeFor', 'hexXY', 'hexAdjacent',
                 'takeModule', 'learnFusion', 'socketModule', 'unsocketModule',
                 'gearWire', 'applyGearWire', 'refitGear', 'seatOn', 'pullFrom',
                 'PICKUP_R', 'CACHES', 'makeLootField', 'cacheSites', 'spoilModule',
                 'SENTRY', 'EST', 'makeSentry', 'stepSentry', 'makeEncounter',
                 'WAKE_TIME', 'TELEGRAPH_TIME', 'STRIKE_TIME', 'RECOVER_TIME',
                 'HERO_RIG', 'SENTRY_RIG', 'poseHero', 'poseSentry', 'blendPose', 'swingYaw',
                 'restPositions', 'STRIDE', 'SENTRY_STRIDE',
                 'makeCamera', 'snap', 'warpTo', 'follow', 'eye', 'basis', 'moveFrom',
                 'project', 'groundAt', 'heading', 'aimFromPointer', 'aimFromStick',
                 'setView', 'VIEW', 'QUARTER', 'START_YAW',
                 'ACTIONS', 'DEFAULT_BINDINGS', 'defaultBindings', 'makeInput', 'stickFromDrag',
                 'snapshot', 'restore', 'makeLoopback', 'makeHost', 'makeGuest', 'spawnNear', 'ACT'];

/**
 * The two pages that carry a bundle. The plate is a design document and gets
 * the generator only; the playable build gets the simulation as well.
 */
export const TARGETS = [
  { file: PLATE, name: 'docs/concept/index.html', dirs: ['src/gen'], api: GEN_API },
  { file: PLAY, name: 'docs/play/index.html', dirs: ['src/gen', 'src/mesh', 'src/sim', 'src/net'],
    api: GEN_API.concat(MESH_API).concat(SIM_API) },
];

/**
 * The transform below is a flat concatenation into one scope, so an import that
 * renames anything is a lie: `import { advance as advanceCombat }` bundles to a
 * scope that only ever defined `advance`, and the page throws a ReferenceError
 * on the first tick. A namespace import has the same problem.
 *
 * This is the same class of trap as a module missing from MODULES, and it cost
 * the same kind of afternoon. Fail here, where the message can say what to do.
 */
function assertPlainImports(dir, name, src) {
  const bad = [];
  const lines = src.split('\n');
  for (const line of lines) {
    if (!/^\s*(import|export)\b/.test(line) || !/from\s*'/.test(line)) continue;
    if (/\bimport\s*\*\s*as\b/.test(line)) bad.push(line.trim());
    else if (/\{[^}]*\bas\b[^}]*\}/.test(line)) bad.push(line.trim());
  }
  if (bad.length) {
    throw new Error(
      `${dir}/${name}.mjs renames an import, which the bundle cannot carry.\n` +
      bad.map((b) => `  ${b}`).join('\n') +
      '\n  Everything is concatenated into one scope — rename the export instead.');
  }
}

function strip(src) {
  return src
    .replace(/^export\s*\{[\s\S]*?\}\s*from\s*'[^']*';[ \t]*$/gm, '')
    .replace(/^import[\s\S]*?from\s*'[^']*';[ \t]*$/gm, '')
    .replace(/^export\s+/gm, '');
}

/**
 * A module added to src/gen but not to MODULES used to bundle silently: the
 * plate would throw a ReferenceError on load, never define window.QS, and the
 * smoke test would sit there until its timeout. Fail here instead, where the
 * message can say what is wrong.
 */
function assertComplete(dir) {
  const listed = MODULES[dir];
  const onDisk = readdirSync(join(ROOT, dir))
    .filter((f) => f.endsWith('.mjs')).map((f) => f.slice(0, -4)).sort();
  const missing = onDisk.filter((m) => !listed.includes(m));
  const extra = listed.filter((m) => !onDisk.includes(m));
  if (missing.length || extra.length) {
    throw new Error(
      `MODULES['${dir}'] in tools/bundle-gen.mjs is out of step with ${dir}.\n` +
      (missing.length ? `  not bundled: ${missing.join(', ')} — add them in dependency order\n` : '') +
      (extra.length ? `  listed but absent: ${extra.join(', ')}\n` : ''));
  }
}

/**
 * Two modules declaring the same top-level name.
 *
 * The bundle is a flat concatenation into one scope, so two `function foo`s do
 * not shadow — the later one simply wins, everywhere, including inside the
 * earlier module's own code. That is silent, and it is not theoretical: a
 * `groundAt` added to src/gen/ground.mjs collided with the one src/sim/camera.mjs
 * has always exported, and every call in the generator started asking the camera
 * where a screen pixel lands. The plate was fine (it bundles src/gen alone) and
 * the playable build hung on boot, which cost a CI round trip to find.
 *
 * Same class as a module missing from MODULES and an import that renames: the
 * flat scope makes it possible, so the bundler is where it has to be caught.
 */
function assertNoCollisions(target, seen, dir, m, src) {
  const names = [];
  const re = /^(?:export\s+)?(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var|class)\s+([A-Za-z_$][\w$]*))/gm;
  let hit;
  while ((hit = re.exec(src))) names.push(hit[1] || hit[2]);
  for (const n of names) {
    const where = `${dir}/${m}.mjs`;
    if (seen.has(n) && seen.get(n) !== where) {
      throw new Error(
        `${target.name}: '${n}' is declared in both ${seen.get(n)} and ${where}.\n` +
        '  The bundle is one flat scope, so the later declaration wins everywhere\n' +
        '  and the earlier module silently calls the wrong function. Rename one.');
    }
    seen.set(n, where);
  }
}

export function renderBundle(target) {
  const parts = [], seen = new Map();
  for (const dir of target.dirs) {
    assertComplete(dir);
    for (const m of MODULES[dir]) {
      const raw = readFileSync(join(ROOT, `${dir}/${m}.mjs`), 'utf8');
      assertPlainImports(dir, m, raw);
      const body = strip(raw).trim();
      assertNoCollisions(target, seen, dir, m, body);
      parts.push(`/* ---------- ${dir}/${m}.mjs ---------- */\n${body}`);
    }
  }
  return [
    BEGIN,
    '(function(){',
    '"use strict";',
    ...parts,
    `globalThis.QS={${target.api.map((n) => `${n}:${n}`).join(',')}};`,
    '})();',
    END,
  ].join('\n');
}

/** Swap the generated block in an HTML string for a freshly rendered one. */
export function withBundle(html, target) {
  const t = target || TARGETS[0];
  const a = html.indexOf(BEGIN), b = html.indexOf(END);
  if (a < 0 || b < 0) throw new Error(`bundle markers not found in ${t.name}`);
  return html.slice(0, a) + renderBundle(t) + html.slice(b + END.length);
}

/** Every target that is out of date, as { name, next } — empty when in sync. */
export function staleTargets() {
  const out = [];
  for (const t of TARGETS) {
    const html = readFileSync(t.file, 'utf8');
    const next = withBundle(html, t);
    if (next !== html) out.push({ target: t, next });
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const stale = staleTargets();
  if (process.argv.includes('--check')) {
    if (stale.length) {
      console.error(`out of date — run: node tools/bundle-gen.mjs\n  ${stale.map((s) => s.target.name).join('\n  ')}`);
      process.exit(1);
    }
    console.log(`in sync with src: ${TARGETS.map((t) => t.name).join(', ')}`);
  } else {
    for (const s of stale) writeFileSync(s.target.file, s.next);
    const n = TARGETS.reduce((k, t) => k + t.dirs.reduce((j, d) => j + MODULES[d].length, 0), 0);
    console.log(stale.length
      ? `bundled into ${stale.map((s) => s.target.name).join(', ')}`
      : `already in sync (${n} module slots across ${TARGETS.length} pages)`);
  }
}
