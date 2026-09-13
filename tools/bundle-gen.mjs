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
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PLATE = join(ROOT, 'docs/concept/index.html');
export const BEGIN = '/* QS-BUNDLE-BEGIN — generated from src/gen by tools/bundle-gen.mjs */';
export const END = '/* QS-BUNDLE-END */';

/** Dependency order. A module may only use names defined above it. */
const MODULES = ['constants', 'rng', 'biomes', 'field', 'erosion', 'routes', 'spans',
                 'water', 'surface', 'props', 'grass', 'reach', 'index'];

/** What the plate reads off the global. Everything else stays private. */
const EXPOSED = ['V', 'CEIL', 'CHUNK', 'MOVE', 'clamp', 'BIOMES', 'makeGen', 'buildWorld'];

function strip(src) {
  return src
    .replace(/^export\s*\{[\s\S]*?\}\s*from\s*'[^']*';[ \t]*$/gm, '')
    .replace(/^import[\s\S]*?from\s*'[^']*';[ \t]*$/gm, '')
    .replace(/^export\s+/gm, '');
}

export function renderBundle() {
  const parts = MODULES.map((m) => {
    const src = strip(readFileSync(join(ROOT, `src/gen/${m}.mjs`), 'utf8')).trim();
    return `/* ---------- src/gen/${m}.mjs ---------- */\n${src}`;
  });
  return [
    BEGIN,
    '(function(){',
    '"use strict";',
    ...parts,
    `globalThis.QS={${EXPOSED.map((n) => `${n}:${n}`).join(',')}};`,
    '})();',
    END,
  ].join('\n');
}

/** Swap the generated block in an HTML string for a freshly rendered one. */
export function withBundle(html) {
  const a = html.indexOf(BEGIN), b = html.indexOf(END);
  if (a < 0 || b < 0) throw new Error(`bundle markers not found in ${PLATE}`);
  return html.slice(0, a) + renderBundle() + html.slice(b + END.length);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const html = readFileSync(PLATE, 'utf8');
  const next = withBundle(html);
  if (process.argv.includes('--check')) {
    if (next !== html) {
      console.error('docs/concept/index.html is out of date — run: node tools/bundle-gen.mjs');
      process.exit(1);
    }
    console.log('plate is in sync with src/gen');
  } else {
    writeFileSync(PLATE, next);
    console.log(`bundled ${MODULES.length} modules into docs/concept/index.html`);
  }
}
