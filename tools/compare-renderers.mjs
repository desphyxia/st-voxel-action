#!/usr/bin/env node
/**
 * The two terrain renderers, from one camera and one frame — issue #12.
 *
 *   node tools/compare-renderers.mjs
 *
 * #12's bar is "parity or better with the plate's look, confirmed side by
 * side", and that is not something one renderer in a page can answer. The build
 * carries both behind a flag, so this drives the flag, reads the framebuffer
 * twice, and reports two numbers plus a screenshot each.
 *
 * **Both numbers are proxies, and the limits are worth knowing before quoting
 * them.** Mean luma difference answers "is this the same picture"; it goes *up*
 * when grain is added, because noise makes pixels disagree even as the look
 * converges. Local 3x3 variance answers "does it have the same texture", but at
 * this zoom a 25 cm voxel is a few pixels across, so it counts geometric edges
 * and baked occlusion alongside surface dither and cannot separate them.
 *
 * So this narrows what a human has to judge; it does not replace the judging.
 * A real perceptual comparison is #29, and this is the shape of its input.
 */
import { preparePage, ROOT, launch } from './lib/harness.mjs';
import { join } from 'node:path';

const OUT = join(ROOT, '.render');
const SETTLE = 12000;          /* software rendering: a frame is not free */

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error' && !/ERR_/.test(m.text())) errs.push(m.text()); });

const file = preparePage({ target: join(ROOT, 'docs/play/index.html'), outDir: OUT, name: 'compare.html' });
await page.goto('file://' + file, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => !!(window.QSPLAY && window.QSPLAY.ready), null, { timeout: 120000 });
await page.evaluate(() => window.QSPLAY.pause(true));

const counts = await page.evaluate(() => ({ boxes: window.QSPLAY.boxCount, quads: window.QSPLAY.meshQuads }));
const clip = await page.evaluate(() => {
  const r = document.querySelector('#stage').getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
});

async function shot(useMesh, name) {
  await page.evaluate((v) => window.QSPLAY.setMesh(v), useMesh);
  await new Promise((r) => setTimeout(r, SETTLE));
  await page.screenshot({ path: join(OUT, 'compare-' + name + '.png'), clip });
  /* Read the framebuffer in the same task that draws it: WebGL clears on yield. */
  return page.evaluate(() => {
    window.QSPLAY.draw();
    const c = document.querySelector('#cv');
    const g = c.getContext('webgl') || c.getContext('webgl2');
    const px = new Uint8Array(c.width * c.height * 4);
    g.readPixels(0, 0, c.width, c.height, g.RGBA, g.UNSIGNED_BYTE, px);
    return { w: c.width, h: c.height, px: Array.from(px) };
  });
}

const boxes = await shot(false, 'boxes');
const mesh = await shot(true, 'mesh');

const L = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
function meanDiff(a, b) {
  let s = 0;
  for (let i = 0; i < a.px.length; i += 4) s += Math.abs(L(a.px, i) - L(b.px, i));
  return s / (a.px.length / 4);
}
function grain(d) {
  let tot = 0, n = 0;
  for (let y = 1; y < d.h - 1; y += 2) {
    for (let x = 1; x < d.w - 1; x += 2) {
      let s = 0, s2 = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const v = L(d.px, ((y + dy) * d.w + (x + dx)) * 4); s += v; s2 += v * v;
      }
      tot += Math.sqrt(Math.max(0, s2 / 9 - (s / 9) * (s / 9))); n++;
    }
  }
  return tot / n;
}

const gb = grain(boxes), gm = grain(mesh);
console.log('');
console.log('  geometry   ' + counts.boxes + ' boxes (' + counts.boxes * 6 + ' faces)  vs  '
            + counts.quads + ' quads   ' + (counts.boxes * 6 / counts.quads).toFixed(1) + 'x fewer');
console.log('  same picture?   mean |luma| difference  ' + meanDiff(boxes, mesh).toFixed(2) + ' of 255');
console.log('  same texture?   local 3x3 sigma          boxes ' + gb.toFixed(2)
            + '   mesh ' + gm.toFixed(2) + '   (' + (100 * gm / gb).toFixed(0) + '%)');
console.log('  shots           .render/compare-boxes.png, .render/compare-mesh.png');
console.log('  ' + (errs.length ? 'ERRORS: ' + errs.slice(0, 3).join(' | ') : 'no page errors'));
console.log('');
await browser.close();
