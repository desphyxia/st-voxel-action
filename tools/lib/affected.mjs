/**
 * Which browser checks a change can reach.
 *
 * The browser half of the smoke test takes ~17 minutes on CI and 25–30 here,
 * in software rendering, and most changes can only break part of it. Its
 * checks are split into groups; this maps changed paths onto them, so a
 * contributor can run the part that matters before pushing and leave the whole
 * of it to CI, which still runs everything.
 *
 * Conservative by construction: a path no rule names reaches every group.
 * Skipping a group here is a bet that CI will not disagree, and a wrong bet
 * costs a red build, so the rules only ever narrow where the reason is plain.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Every group, in the order the smoke test runs them. */
export const GROUPS = {
  boot: 'the plate loads, MATH agrees across engines, PARITY with src/gen',
  render: 'the plate draws a biome',
  build: 'the playable build: move, view, swing, enemy, loot, net, HUD, fullscreen',
  stream: 'the streaming control and a streamed world, from disk',
  worker: 'the worker pool over HTTP, and a streamed host with a guest',
  magma: 'the magma sheet, on the ash seed',
  look: 'the look gate: plates against tools/look-baseline.json',
};
const ALL = Object.keys(GROUPS);
const PLAY = ['build', 'stream', 'worker', 'magma', 'look'];
const SIM = ['build', 'stream', 'worker'];

/* First match wins. A path none of these name reaches everything. */
const RULES = [
  [/\.md$/, []],
  [/^src\/gen\//, ALL],
  [/^src\/mesh\//, PLAY],
  [/^src\/(sim|net)\//, SIM],
  [/^assets\//, ['build', 'look']],
  [/^tools\/author-hero\.mjs$/, ['build', 'look']],
  [/^tools\/(look\.mjs|look-baseline\.json|lib\/look\.mjs)$/, ['look']],
  /* Read only by the node half. */
  [/^tools\/(baseline\.json|render-plate\.mjs|hooks\/|lib\/(playtest|consume|affected)\.mjs)/, []],
  [/^docs\/concept\//, ['boot', 'render']],
  [/^docs\/play\//, PLAY],
  [/^docs\//, []],
];

const BUNDLE = /\/\* QS-BUNDLE-BEGIN[\s\S]*?\/\* QS-BUNDLE-END \*\//;

let ROOT_DIR = process.cwd();
function git(args) {
  return execFileSync('git', args, { cwd: ROOT_DIR, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * A page whose only change is its generated bundle is explained by the src/
 * paths that moved it, and those have rules of their own — otherwise every
 * change under src/sim would reach the magma and look checks through the page
 * it is bundled into.
 */
function bundleOnly(path, base) {
  let was;
  try { was = git(['show', `${base}:${path}`]); } catch (e) { return false; }
  const now = existsSync(join(ROOT_DIR, path)) ? readFileSync(join(ROOT_DIR, path), 'utf8') : '';
  return was.replace(BUNDLE, '') === now.replace(BUNDLE, '');
}

/**
 * Paths changed since `base` — committed, staged, unstaged and untracked —
 * and the groups they reach. Returns { base, groups: [...], why: [[path, [...]]] }.
 */
export function affected(root, base = 'origin/main') {
  ROOT_DIR = root;
  const fork = git(['merge-base', base, 'HEAD']).trim();
  const paths = new Set([
    ...git(['diff', '--name-only', fork]).split('\n'),
    ...git(['ls-files', '--others', '--exclude-standard']).split('\n'),
  ].filter(Boolean));
  const hit = new Set(), why = [];
  for (const p of [...paths].sort()) {
    let g = ALL;
    if (/^docs\/(play|concept)\/index\.html$/.test(p) && bundleOnly(p, fork)) g = [];
    else for (const [re, gs] of RULES) if (re.test(p)) { g = gs; break; }
    why.push([p, g]);
    for (const x of g) hit.add(x);
  }
  return { base: `${base} (${fork.slice(0, 7)})`, groups: ALL.filter((g) => hit.has(g)), why };
}
