#!/usr/bin/env node
/**
 * Which commit a `dev` build label came from.
 *
 *   node tools/which-build.mjs 3fa91c0
 *
 * The playable build's location bar shows `build <sha>` when it was published
 * as the artifact, and `dev <hash>` when it is a copy that was not stamped —
 * GitHub Pages, or a page opened from disk. This walks the history of
 * docs/play/index.html and prints the commits whose page hashes to <hash>.
 */
import { execFileSync } from 'node:child_process';
import { srcHash } from './lib/buildid.mjs';
import { ROOT } from './lib/harness.mjs';

const want = (process.argv[2] || '').toLowerCase().replace(/^dev[\s-]*/, '');
if (!/^[0-9a-f]{4,8}$/.test(want)) {
  console.error('usage: node tools/which-build.mjs <hash shown after "dev">');
  process.exit(2);
}
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
const shas = git(['log', '--format=%H %cs %s', '-300', '--', 'docs/play/index.html']).trim().split('\n');
const hits = [];
for (const line of shas) {
  const sha = line.slice(0, 40);
  if (srcHash(git(['show', `${sha}:docs/play/index.html`])).startsWith(want)) hits.push(line);
}
if (!hits.length) { console.log(`no commit in the last ${shas.length} changes to docs/play/index.html hashes to ${want}`); process.exit(1); }
for (const h of hits) console.log(h.slice(0, 7) + h.slice(40));
