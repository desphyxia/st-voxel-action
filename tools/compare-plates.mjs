#!/usr/bin/env node
/**
 * The two terrain renderers, composed into something a human can judge —
 * issue #12, and the input #29 will want.
 *
 *   node tools/compare-renderers.mjs      # first: the two shots and the numbers
 *   node tools/compare-plates.mjs         # then: the plates built from them
 *
 * tools/compare-renderers.mjs answers "how different is this" in two numbers
 * and leaves two PNGs behind. Neither number can say *which* renderer is
 * better, because that question is about where the difference falls: a mean
 * luma diff spread evenly over open ground and a mean luma diff concentrated
 * on every pillar base are the same number and not the same picture.
 *
 * So this crops the same four places out of both shots and puts them side by
 * side at 3x, which is the magnification at which a 25 cm voxel is a block
 * rather than a pixel. The four are chosen to separate what the mesh gains
 * from what it loses:
 *
 *   - the trail fork      a large flat surface, and an edge against grass
 *   - the ruin            vertical structure, contact shadows, rubble
 *   - the wall            worked stone, where per-voxel dither sold a material
 *   - open meadow         ground and nothing else, as a control
 *
 * It is a composition step and nothing more: no world is generated and no
 * frame is rendered here. Re-run compare-renderers.mjs first if the build has
 * moved, or these plates are of a build that no longer exists.
 */
import { launch, ROOT } from './lib/harness.mjs';
import { join } from 'node:path';
import { writeFileSync, existsSync } from 'node:fs';

const OUT = join(ROOT, '.render');
const SHOTS = { boxes: join(OUT, 'compare-boxes.png'), mesh: join(OUT, 'compare-mesh.png') };

for (const [k, f] of Object.entries(SHOTS)) {
  if (!existsSync(f)) {
    console.error('missing ' + k + ' shot: ' + f + '\n  run: node tools/compare-renderers.mjs');
    process.exit(1);
  }
}
const B = 'file://' + SHOTS.boxes, M = 'file://' + SHOTS.mesh;

/* Windows into the 1052x504 stage, in its own pixels. Tied to the build's
   default camera and spawn, so they move if either does — check the full
   plate before quoting the detail one. */
const REGIONS = [
  { nm: 'the trail forking, and the character on it', x: 400, y: 215, w: 260, h: 130 },
  { nm: 'the ruin: pillars, rubble and a cut bank', x: 660, y: 330, w: 260, h: 130 },
  { nm: 'the wall and the bank behind it', x: 60, y: 215, w: 260, h: 130 },
  { nm: 'open meadow — nothing but ground', x: 150, y: 330, w: 260, h: 130 },
];
const ZOOM = 3;

const CSS = `
 body{margin:0;background:#14161a;font:13px/1.4 ui-monospace,Menlo,Consolas,monospace;color:#c9d1d9}
 h2{font:600 15px/1 ui-monospace,monospace;color:#e6edf3;margin:0 0 8px}
 .lab{color:#8b949e;margin:0 0 6px;letter-spacing:.04em;text-transform:uppercase;font-size:11px}
 .pair{display:grid;grid-template-columns:1fr 1fr;gap:14px}
 .cell{background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:10px}
 .win{overflow:hidden;position:relative;border-radius:3px}
 .win img{position:absolute;image-rendering:pixelated;transform-origin:0 0}
 .full img{position:static;width:100%;display:block}
 .note{color:#7d8590;margin:10px 2px 26px;max-width:1180px}
`;

const crop = (src, r) =>
  `<div class="win" style="width:${r.w * ZOOM}px;height:${r.h * ZOOM}px">`
  + `<img src="${src}" style="transform:scale(${ZOOM}) translate(${-r.x}px,${-r.y}px)"></div>`;

const full = `<!doctype html><meta charset="utf-8"><style>${CSS}</style>
<div style="padding:18px;width:1220px">
  <h2>One camera, one frame, two terrain renderers</h2>
  <p class="note">Props, grass and water are identical in both — only the terrain swaps.
     The numbers are tools/compare-renderers.mjs&rsquo;.</p>
  <p class="lab">Instanced boxes</p>
  <div class="cell full"><img src="${B}"></div>
  <p class="lab" style="margin-top:18px">Greedy mesh with baked per-face occlusion</p>
  <div class="cell full"><img src="${M}"></div>
</div>`;

const detail = `<!doctype html><meta charset="utf-8"><style>${CSS}</style>
<div style="padding:18px;width:1220px">
  <h2>The same ${REGIONS.length} places, magnified ${ZOOM}&times;</h2>
  <p class="note">Left is boxes, right is the mesh. What to look for: per-voxel colour dither
     (boxes have it in the data, the mesh approximates it in the shader), and contact shading
     in the creases (the mesh bakes it, the boxes never had it).</p>
  ${REGIONS.map((r) => `
   <p class="lab">${r.nm}</p>
   <div class="pair"><div class="cell">${crop(B, r)}</div><div class="cell">${crop(M, r)}</div></div>
   <div style="height:20px"></div>`).join('')}
</div>`;

const browser = await launch();
for (const [html, name] of [[full, 'plate-full'], [detail, 'plate-detail']]) {
  const f = join(OUT, name + '.html');
  writeFileSync(f, html);
  const page = await browser.newPage({ viewport: { width: 1260, height: 900 } });
  await page.goto('file://' + f, { waitUntil: 'networkidle' });
  await page.screenshot({ path: join(OUT, name + '.png'), fullPage: true });
  await page.close();
  console.log('  .render/' + name + '.png');
}
await browser.close();
