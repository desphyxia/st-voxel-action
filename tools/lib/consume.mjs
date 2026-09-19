/**
 * Does anything read what the generator emits? — issue #40.
 *
 * Two checks in the gate look like they cover this and do not. **SYNC** proves
 * both pages carry the `src/` that is on disk, which is a question about
 * source. **PARITY** proves the plate's worlds are identical to node's via the
 * FNV digest, which is a question about what is *emitted* — an array produced
 * correctly and then dropped on the floor hashes exactly the same as one that
 * is drawn.
 *
 * So the digest catches a feature that stops being produced, and nothing
 * catches one that stops being consumed. That is the bridges lesson with the
 * arrow reversed: there a feature silently stopped being generated and the
 * screenshots looked fine; here features are generated forever and reach
 * nobody. `grass.ti` was uploaded by the plate and dropped by the build for six
 * issues before an audit found it.
 *
 * ## Two things the issue predates
 *
 * It says a field should be "referenced by the renderer surface of both pages",
 * and neither half of that is right any more.
 *
 * **Consumers are no longer only the pages.** The build bundles `src/mesh`,
 * `src/sim` and `src/net` as well, and `Hs`, `FLG`, `cells` and `M` are read by
 * the collider and the mesher rather than by any page. A field consumed there
 * is consumed.
 *
 * **The two pages are no longer symmetric.** The plate is documentation of the
 * generator and draws the reach overlay from `topi` and `unreach`; the build is
 * the game and splits terrain from props with `propStart`. Requiring them to
 * read the same fields would manufacture drift rather than find it. So the
 * asymmetry is *pinned* instead: the list of fields only one page reads is
 * written down, and changing it is a visible act in a diff.
 *
 * ## What this cannot tell you
 *
 * It is a **source-text** check. It answers "is anything referencing this
 * field", not "is it drawn, and drawn correctly" — that is #29. A field read
 * into a variable that is then unused would pass. Saying otherwise would be the
 * exact failure this session kept finding, so it is said here instead.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, PLATE, PLAY, BEGIN, END } from '../bundle-gen.mjs';

/**
 * Fields the generator hands out, read off `src/gen/index.mjs` rather than
 * listed here. A list would be a thing to forget to update, and forgetting is
 * the failure mode this exists to catch.
 */
export function worldFields() {
  const src = readFileSync(join(ROOT, 'src/gen/index.mjs'), 'utf8');
  const at = src.lastIndexOf('\n  return {');
  if (at < 0) throw new Error('src/gen/index.mjs: no world literal found');
  const body = src.slice(at, src.indexOf('\n  };', at)).replace(/\/\*[\s\S]*?\*\//g, '');
  return [...body.matchAll(/(\w+)\s*:/g)].map((m) => m[1]);
}

/** A page with the inlined `src/` cut out, leaving only what the page itself is. */
function pageOwn(file) {
  const html = readFileSync(file, 'utf8');
  const a = html.indexOf(BEGIN), b = html.indexOf(END);
  if (a < 0 || b < 0) throw new Error(`bundle markers not found in ${file}`);
  return html.slice(0, a) + html.slice(b + END.length);
}

/**
 * The names a world is held under. Narrow on purpose: a bare `.field` would
 * match any object's property of that name and report a field as consumed when
 * nothing reads it, and a check that passes wrongly is worse than one that
 * complains wrongly.
 */
const HOLDER = '(?:data|world|built\\.data|d|w|wd)';
const reads = (txt, k) => new RegExp(HOLDER + '\\.' + k + '\\b').test(txt);

/**
 * Fields with no consumer, and why that is allowed. Every entry is a decision
 * someone made on purpose; the point of the list is that adding to it shows up
 * in a diff.
 */
export const EXEMPT = {
  bridges: 'read by the gate, not by a renderer: the SANITY check counts them '
    + 'per seed, which is how making them route-driven was caught removing them '
    + 'from every world.',
  mmat: 'the emissive record kept parallel to the solid one — pos/pal/shd/mat '
    + 'against mpos/mpal/mshd/mmat (#28). Only the golden digest reads it. It is '
    + 'the one field of the record that has not yet earned its place, and the '
    + 'honest options are a consumer or a deletion, not a third year of drift.',
};

/** Who reads each field: the two pages by name, and the directories under src/. */
export function audit(extra) {
  const fields = worldFields().concat(extra || []);
  const plate = pageOwn(PLATE), play = pageOwn(PLAY);
  const dirs = {};
  for (const d of ['src/sim', 'src/mesh', 'src/net']) {
    dirs[d] = readdirSync(join(ROOT, d)).filter((f) => f.endsWith('.mjs'))
      .map((f) => readFileSync(join(ROOT, d, f), 'utf8'));
  }
  const rows = fields.map((k) => {
    const where = [];
    if (reads(plate, k)) where.push('plate');
    if (reads(play, k)) where.push('play');
    for (const d of Object.keys(dirs)) if (dirs[d].some((t) => reads(t, k))) where.push(d);
    return { field: k, where, inPlate: where.includes('plate'), inPlay: where.includes('play') };
  });
  return {
    rows,
    orphans: rows.filter((r) => r.where.length === 0).map((r) => r.field),
    oneSided: rows.filter((r) => r.inPlate !== r.inPlay)
      .map((r) => r.field + '->' + (r.inPlate ? 'plate' : 'play')).sort(),
  };
}

/**
 * The asymmetry as it stands. Not a rule about what ought to be shared — a
 * record of what is, so that a field quietly appearing on one page and not the
 * other has to be acknowledged. `grass.ti` was exactly this and went unnoticed
 * for six issues.
 */
export const ONE_SIDED = [
  'G->play',          /* the generator itself. A worker cannot send one — nine
                         closures, and structuredClone refuses the whole world
                         over them — so the build makes its own with makeGen and
                         puts it back on each streamed chunk, because the mesher
                         reads G.pstream to shade a voxel (#13). The plate
                         generates in place and never needs to reattach one. */
  'Hs->plate',        /* the plate shades from the height field; the build's collider owns it */
  'M->plate',
  'NX->plate',
  'cells->plate',
  'lmPos->plate',
  'mat->plate',
  'ovhPos->plate',
  'propStart->play',  /* where terrain ends and props begin — the mesher's split (#12) */
  'topi->plate',      /* the reach overlay recolours by top-voxel index */
  'trail->plate',
  'unreach->plate',
];
