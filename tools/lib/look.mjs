/**
 * A measurement of how the world looks — issue #29.
 *
 * Everything else in this project is asserted by counting: FNV digests over
 * every generator array, ten movement assertions, bit-identical netcode after
 * latency and loss, pixel counts for the swing arc and the sentry's telegraph.
 * The rendering surface had nothing. #12 rewrote how the entire world is drawn
 * and was landed on a human squinting at two screenshots, which is exactly the
 * situation CLAUDE.md already warns about from the other direction: bridges
 * stopped being generated and *the screenshots looked fine*.
 *
 * ## What this is not
 *
 * Not a screenshot diff. An exact pixel compare fails on every antialiasing
 * change, every driver, every machine, and a gate that cries wolf is a gate
 * that gets bypassed. The bar here is **would a person notice**, which means
 * tolerating a few percent and still catching a biome that stopped being drawn.
 *
 * ## The signature
 *
 * Four numbers-of-numbers, all computed in the page from the framebuffer so
 * that two million pixels never cross the bridge:
 *
 *   - **blocks** — the frame reduced to a 16 x 8 grid of mean RGB. This is the
 *     layout: where the canyon is, where the water is, which way the light
 *     falls. Robust to noise by construction, because each block averages
 *     thousands of pixels.
 *   - **hist** — a 4 x 4 x 4 RGB histogram in parts per thousand. This is the
 *     palette, independent of where anything is. A biome that stops being drawn
 *     moves it hard; a camera nudge barely moves it at all.
 *   - **edge** — mean absolute luminance gradient, x100. This is the *texture*:
 *     creases, contact shading, per-voxel dither. It is what separates the
 *     greedy mesh from the instanced boxes, and it is the one that would have
 *     caught #12's regression without anybody looking.
 *   - **ink** — the fraction of the frame that is not the clear colour, in
 *     parts per thousand. Bluntly: did anything draw at all.
 *
 * Read from the canvas, not from a page screenshot, so the HUD is not in it —
 * the HUD contains a frame counter, which would make every baseline stale on
 * the next run.
 *
 * ## Tolerances, and what they are and are not calibrated against
 *
 * `node tools/look.mjs --noise` renders every plate twice in one session and
 * reports what identical input differs by. **It is exactly zero, on all twelve
 * plates, in all four terms.** With the clock pinned and the camera parked, the
 * software renderer is bit-deterministic within a session.
 *
 * So the tolerances below are *not* a multiple of a measured floor, because the
 * measured floor is nothing. They are a judgement about a floor this sandbox
 * cannot see: a different driver, a different machine, hardware rather than
 * software rasterisation. Treat them as provisional until this has run
 * somewhere other than here, and read `--noise` on that machine before touching
 * them. What can be said is the other side of the gap — swapping the terrain
 * renderer back to instanced boxes moves *every* plate two to four times past
 * the bar, texture hardest at 13% to 36%. That is the change #12 made, and it
 * is the one this gate exists to have caught.
 */

/**
 * Where the camera stands for each plate. Two per seed, and two rather than one
 * because they fail differently: the wide shot frames most of the window and is
 * what notices a biome, a river or a landmark going missing, while the close one
 * is at the zoom the game is actually played at and is where a change in
 * shading or texture is legible at all. `turn` is in quarter-turns off the
 * default view, so the two do not share a silhouette.
 */
export const POSES = [
  { nm: 'wide', view: 20, x: 0, z: 0, turn: 0 },
  { nm: 'close', view: 10, x: 0, z: 0, turn: 1 },
];

/** Pinned clock. Any value does, as long as it never changes again. */
export const PLATE_T = 12.5;

/** The viewport every plate is rendered at. */
export const PLATE_W = 960, PLATE_H = 540;

/**
 * Reduce the canvas to a signature. Serialized into the page, so it may use
 * nothing from this module's scope — the same constraint measureWorld is
 * written under, and for the same reason.
 */
export function signature() {
  const c = document.querySelector('#cv');
  const g = c.getContext('webgl') || c.getContext('webgl2');
  const w = c.width, h = c.height;
  const px = new Uint8Array(w * h * 4);
  g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, px);

  const BX = 16, BY = 8;
  const sum = new Float64Array(BX * BY * 3), cnt = new Float64Array(BX * BY);
  const hist = new Float64Array(64);
  let ink = 0, edge = 0, edgeN = 0;
  const L = (i) => 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];

  for (let y = 0; y < h; y++) {
    const by = Math.min(BY - 1, (y * BY / h) | 0);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = px[i], gg = px[i + 1], b = px[i + 2];
      const bx = Math.min(BX - 1, (x * BX / w) | 0), k = by * BX + bx;
      sum[k * 3] += r; sum[k * 3 + 1] += gg; sum[k * 3 + 2] += b; cnt[k]++;
      hist[((r >> 6) << 4) | ((gg >> 6) << 2) | (b >> 6)]++;
      /* The clear colour is the sky. Anything else is world. */
      if (r + gg + b > 24) ink++;
    }
  }
  /* Gradient on a sparse lattice: every other pixel is plenty for a mean, and
     it keeps this under a second in a software renderer. */
  for (let y = 1; y < h - 1; y += 2) {
    for (let x = 1; x < w - 1; x += 2) {
      const i = (y * w + x) * 4;
      edge += Math.abs(L(i) - L(i + 4)) + Math.abs(L(i) - L(i + w * 4));
      edgeN++;
    }
  }

  const n = w * h;
  const blocks = [];
  for (let k = 0; k < BX * BY; k++) {
    const d = cnt[k] || 1;
    blocks.push(Math.round(sum[k * 3] / d), Math.round(sum[k * 3 + 1] / d), Math.round(sum[k * 3 + 2] / d));
  }
  return {
    blocks,
    hist: Array.from(hist, (v) => Math.round(1000 * v / n)),
    edge: Math.round(100 * edge / (2 * edgeN)),
    ink: Math.round(1000 * ink / n),
  };
}

/**
 * How far apart two signatures are, in the four terms that mean something.
 * Every one is a "would a person notice" quantity, not a pixel count.
 */
export function compare(a, b) {
  let blockMax = 0, blockSum = 0;
  for (let i = 0; i < a.blocks.length; i++) {
    const d = Math.abs(a.blocks[i] - b.blocks[i]);
    if (d > blockMax) blockMax = d;
    blockSum += d;
  }
  let histL1 = 0;
  for (let i = 0; i < a.hist.length; i++) histL1 += Math.abs(a.hist[i] - b.hist[i]);
  return {
    blockMax,
    blockMean: blockSum / a.blocks.length,
    histL1,
    edge: Math.abs(a.edge - b.edge),
    edgePct: a.edge ? 100 * Math.abs(a.edge - b.edge) / a.edge : 0,
    ink: Math.abs(a.ink - b.ink),
  };
}

/**
 * The bar. Each of these is comfortably above the measured run-to-run noise
 * floor and comfortably below the smallest change a person would call a
 * different-looking world — the gap between those two is what makes this
 * possible at all, and if it ever closes the answer is a better signature,
 * not a looser tolerance.
 */
export const TOL = {
  blockMax: 28,     /* one block of the 128 shifting by a ninth of full range */
  blockMean: 7,     /* or the whole frame drifting slightly */
  histL1: 90,       /* 9% of the frame changing which colour bin it is in */
  edgePct: 12,      /* texture gaining or losing an eighth of itself */
  ink: 12,          /* 1.2% of the frame appearing or disappearing */
};

/** Which terms are out of bounds, as a list of readable strings. */
export function breaches(d, tol) {
  tol = tol || TOL;
  const out = [];
  if (d.blockMax > tol.blockMax) out.push(`layout ${d.blockMax} > ${tol.blockMax}`);
  if (d.blockMean > tol.blockMean) out.push(`overall ${d.blockMean.toFixed(1)} > ${tol.blockMean}`);
  if (d.histL1 > tol.histL1) out.push(`palette ${d.histL1} > ${tol.histL1}`);
  if (d.edgePct > tol.edgePct) out.push(`texture ${d.edgePct.toFixed(1)}% > ${tol.edgePct}%`);
  if (d.ink > tol.ink) out.push(`coverage ${d.ink} > ${tol.ink}`);
  return out;
}

/** One line summarising a comparison, breached or not. */
export function describe(d) {
  return `layout ${d.blockMax}/${d.blockMean.toFixed(1)}, palette ${d.histL1}, `
    + `texture ${d.edgePct.toFixed(1)}%, coverage ${d.ink}`;
}

/**
 * Boot the build once and capture every plate from it.
 *
 * One page for all twelve: a boot costs more than a world does, and rebuilding
 * the world per seed through the same code path the game uses is also the
 * stronger test — a leak between worlds shows up here rather than being hidden
 * by a fresh page each time.
 */
export async function captureLook(browser, file, opts) {
  opts = opts || {};
  const seeds = opts.seeds;
  const page = await browser.newPage({ viewport: { width: PLATE_W, height: PLATE_H } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message)));
  await page.goto('file://' + file, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => !!(window.QSPLAY && window.QSPLAY.ready), null, { timeout: 120000 });

  const out = {};
  for (const s of seeds) {
    for (const p of POSES) {
      const key = s.nm + '/' + p.nm;
      const sig = await page.evaluate(([cfg, pose, t, sigSrc]) => {
        const posed = window.QSPLAY.plate({
          cfg,
          t,
          x: pose.x, z: pose.z, view: pose.view,
          yaw: window.QS.START_YAW + pose.turn * window.QS.QUARTER,
        });
        if (!posed) return null;
        /* Drawn and read in one task: WebGL clears its buffer on yield. */
        // eslint-disable-next-line no-new-func
        const f = new Function('return (' + sigSrc + ')')();
        const v = f();
        v.posed = posed;
        return v;
      }, [{ seed: s.seed, size: s.size, force: s.force, ox: s.ox, oz: s.oz },
          p, PLATE_T, signature.toString()]);
      if (!sig) throw new Error('plate refused for ' + key);
      out[key] = sig;
    }
  }
  await page.close();
  return { plates: out, errs };
}
