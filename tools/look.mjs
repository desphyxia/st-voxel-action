#!/usr/bin/env node
/**
 * The look gate — issue #29.
 *
 *   node tools/look.mjs              # compare every plate against the baseline
 *   node tools/look.mjs --update     # re-record it, deliberately
 *   node tools/look.mjs --noise      # measure the run-to-run floor and stop
 *
 * Twelve plates: six golden seeds at two camera poses each, rendered through
 * the real build with its clock pinned and everything that is not the world
 * hidden. Each is reduced to a signature (see lib/look.mjs) and compared
 * against tools/look-baseline.json.
 *
 * `--noise` is the honest half of this. A tolerance guessed from taste is a
 * tolerance that either misses regressions or fires on nothing; this renders
 * every plate twice in one session and reports what identical input differs
 * by, which is the floor the tolerances in lib/look.mjs have to clear.
 */
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { ROOT, preparePage, launch, GOLDEN_SEEDS } from './lib/harness.mjs';
import { captureLook, compare, breaches, describe, TOL, POSES } from './lib/look.mjs';

const argv = process.argv.slice(2);
const UPDATE = argv.includes('--update');
const NOISE = argv.includes('--noise');
export const LOOK_BASELINE = join(ROOT, 'tools/look-baseline.json');

const OUT = join(ROOT, '.render');
const file = preparePage({ target: join(ROOT, 'docs/play/index.html'), outDir: OUT, name: 'look.html' });

const browser = await launch();
const t0 = Date.now();
const first = await captureLook(browser, file, { seeds: GOLDEN_SEEDS });
let bad = 0;

if (NOISE) {
  const second = await captureLook(browser, file, { seeds: GOLDEN_SEEDS });
  const worst = { blockMax: 0, blockMean: 0, histL1: 0, edgePct: 0, ink: 0 };
  for (const k of Object.keys(first.plates)) {
    const d = compare(first.plates[k], second.plates[k]);
    for (const t of Object.keys(worst)) if (d[t] > worst[t]) worst[t] = d[t];
    console.log('  ' + k.padEnd(14) + describe(d));
  }
  console.log('\n  worst over ' + Object.keys(first.plates).length + ' plates:');
  for (const t of Object.keys(worst)) {
    const v = typeof worst[t] === 'number' ? worst[t].toFixed(2) : worst[t];
    console.log('    ' + t.padEnd(10) + String(v).padStart(8) + '   tolerance ' + TOL[t]);
  }
  console.log('\n  A tolerance is only meaningful if it is well above these.');
} else if (UPDATE) {
  const rec = { recorded: new Date().toISOString().slice(0, 10), poses: POSES, plates: {} };
  for (const [k, v] of Object.entries(first.plates)) {
    rec.plates[k] = { blocks: v.blocks, hist: v.hist, edge: v.edge, ink: v.ink, posed: v.posed };
  }
  writeFileSync(LOOK_BASELINE, JSON.stringify(rec, null, 1) + '\n');
  console.log('  recorded ' + Object.keys(rec.plates).length + ' plates to tools/look-baseline.json');
} else if (!existsSync(LOOK_BASELINE)) {
  console.error('  no baseline: run node tools/look.mjs --update');
  bad = 1;
} else {
  const base = JSON.parse(readFileSync(LOOK_BASELINE, 'utf8'));
  for (const k of Object.keys(first.plates)) {
    if (!base.plates[k]) { console.log('  ' + k.padEnd(14) + 'NEW — not in the baseline'); bad++; continue; }
    const d = compare(base.plates[k], first.plates[k]);
    const b = breaches(d);
    console.log('  ' + (b.length ? 'CHANGED  ' : 'ok       ') + k.padEnd(14) + describe(d)
                + (b.length ? '   <- ' + b.join('; ') : ''));
    if (b.length) bad++;
  }
}

if (first.errs.length) { console.log('\n  page errors: ' + first.errs.slice(0, 3).join(' | ')); bad++; }
console.log('\n  ' + ((Date.now() - t0) / 1000).toFixed(0) + 's');
if (bad && !UPDATE && !NOISE) console.log('  If the change was intended: node tools/look.mjs --update');
await browser.close();
process.exit(bad && !UPDATE && !NOISE ? 1 : 0);
