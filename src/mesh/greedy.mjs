/**
 * Greedy meshing with baked per-face ambient occlusion — issue #12.
 *
 * The instanced-box renderer draws six faces for every voxel it emits, whether
 * or not anything can see them: 817k to 1.04M faces for one 64 m window. The
 * volume those voxels describe exposes only 173k to 205k faces to open air, and
 * merging coplanar runs cuts that again. That is the whole argument, and it is
 * measured rather than assumed — tools/smoke.mjs asserts the ratio.
 *
 * Three things this does that the box renderer cannot:
 *
 *   - **It meshes the volume, not a shell.** buildVoxels emits a surface and a
 *     skirt down to the lowest neighbour, which is what a box renderer needs and
 *     is not a closed surface. The spans in cell.sp are the real solid volume —
 *     the same ones src/sim/collider.mjs builds from, so what you see and what
 *     you walk into come from one source.
 *   - **It drops sealed interiors.** Air that cannot be reached from outside the
 *     window is a cave, caves are decoration by decision, and meshing their
 *     walls is 1 to 6.5% of faces nobody will ever be inside to see.
 *   - **It bakes contact shading.** Per-face AO from neighbour occupancy is what
 *     gives a voxel world its creases, and it costs nothing at draw time.
 *
 * No DOM and no three.js, like everything else that has to be assertable in
 * node. Output is plain arrays.
 *
 * The look shifts, and the issue says so: a merged quad has one material where
 * six boxes each had their own dithered shade. That per-voxel noise is exactly
 * what prevents merging, so losing it is the price of the merge rather than an
 * accident. #28 is what makes the trade clean — colour now comes from the
 * material at draw time, so a quad carries an id and the renderer decides.
 */
import { V, CEIL, CHUNK, clamp } from '../gen/constants.mjs';
import { MAT } from '../gen/materials.mjs';
import { BIOMES, BIO, rouletteBiome } from '../gen/biomes.mjs';
import { PAL } from '../gen/palette.mjs';
import { PASS } from '../gen/rng.mjs';

/** Voxel levels in a full-height column. */
export const LEVELS = Math.round(CEIL / V);

/* The six face directions, as [axis, sign]. Order is part of the output, so
   changing it changes every mesh. */
const DIRS = [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]];

/**
 * Every 25 cm level the generated world has solid in this column, top-down
 * order not guaranteed. One definition, because the mesher's occupancy grid and
 * a carve have to agree on what is there before one of them removes it.
 */
export function forSolidY(w, gi, gj, fn) {
  if (gi < 0 || gj < 0 || gi >= w.NX || gj >= w.NZ) return;
  var half = w.half, M = w.M;
  var x = -half + gi * V + V / 2, z = -half + gj * V + V / 2;
  var ci = clamp(Math.round(x + half), 0, M - 1);
  var cj = clamp(Math.round(z + half), 0, M - 1);
  var sp = w.cells[ci * M + cj].sp;
  /* Every span but the last at its own height; the last one refined to the
     25 cm height field, exactly as the collider does it. */
  for (var q = 0; q < sp.length; q++) {
    var lo = sp[q][0];
    var hi = q === sp.length - 1 ? Math.min(w.Hs[gi * w.NZ + gj], CEIL) : sp[q][1];
    for (var y = Math.max(0, Math.floor(lo / V)); y < Math.min(LEVELS, Math.ceil(hi / V)); y++) fn(y);
  }
}

/**
 * Where one carved voxel lives in `w.edits`.
 *
 * The edit map is a plain Map hung on the world, keyed by voxel and valued by
 * the material that was there. It is deliberately the smallest thing that can
 * answer "is this voxel still here" — the mesher is the only system reading it
 * today. When collision, the wire and the save format need the same answer it
 * should move out of src/mesh and grow an authority; see the note in carve.mjs.
 */
export function editKey(w, gi, gj, y) { return (gi * w.NZ + gj) * LEVELS + y; }

/** Has this voxel been carved away? */
export function isCut(w, gi, gj, y) {
  return !!(w.edits && w.edits.has(editKey(w, gi, gj, y)));
}

/** Is this voxel solid right now — generated, and not since carved? */
export function solidVox(w, gi, gj, y) {
  if (y < 0 || y >= LEVELS || isCut(w, gi, gj, y)) return 0;
  var hit = 0;
  forSolidY(w, gi, gj, function (yy) { if (yy === y) hit = 1; });
  return hit;
}

/**
 * Where the chunk a streamed window owns begins, in window cells.
 *
 * A window generated for one chunk is `CHUNK` plus a skirt on every side, and
 * only the middle `CHUNK` is that chunk's to draw — the skirt is the
 * neighbour's ground, generated so this window's edge effects and its AO ring
 * fall outside what it keeps. Drawing the whole window would put every seam's
 * geometry in twice, and leaning on the window's own chunk grid would draw a
 * 32 m square starting at the window's corner: the chunk, shifted by a skirt.
 */
export function innerChunk(w) {
  var k = Math.round((w.NX - CHUNK / V) / 2);
  return { i: k, j: k };
}

/**
 * The solid volume of one chunk at 25 cm, from the spans — not from the voxels
 * the generator emitted. `pad` of 1 gives the AO and the face test a ring of
 * neighbours to read, so a chunk's edge is shaded by the chunk beside it.
 *
 * Carved voxels are subtracted afterwards rather than tested per cell: edits
 * are sparse by nature, so walking the map costs what has been carved instead
 * of what has not.
 *
 * `org` overrides where the chunk starts, in **window cells**. Chunks are
 * normally laid on the window's own grid from cell 0, which is right for a
 * world that is a whole number of chunks across. A streamed window is not: it
 * is a chunk plus a skirt on every side, so the chunk it owns begins
 * `SKIRT / V` cells in, nowhere near a multiple of `CHUNK / V`.
 * `innerChunk(w)` is that origin.
 */
export function chunkOccupancy(w, cx, cz, pad, org) {
  pad = pad === undefined ? 1 : pad;
  var side = Math.round(CHUNK / V);
  var nx = side + pad * 2, nz = side + pad * 2, ny = LEVELS;
  var i0 = (org ? org.i : cx * side) - pad, j0 = (org ? org.j : cz * side) - pad;
  var occ = new Uint8Array(nx * nz * ny);
  var NZ = w.NZ, NX = w.NX;
  var a, b, base = 0;
  function mark(y) { occ[base + y] = 1; }
  for (a = 0; a < nx; a++) {
    for (b = 0; b < nz; b++) {
      var gi = i0 + a, gj = j0 + b;
      if (gi < 0 || gj < 0 || gi >= NX || gj >= NZ) continue;
      base = (a * nz + b) * ny;
      forSolidY(w, gi, gj, mark);
    }
  }
  if (w.edits && w.edits.size) {
    w.edits.forEach(function (_m, k) {
      var y = k % ny, cell = (k - y) / ny, gj = cell % NZ, gi = (cell - gj) / NZ;
      var a2 = gi - i0, b2 = gj - j0;
      if (a2 < 0 || b2 < 0 || a2 >= nx || b2 >= nz) return;
      occ[(a2 * nz + b2) * ny + y] = 0;
    });
  }
  return { occ: occ, nx: nx, nz: nz, ny: ny, i0: i0, j0: j0, pad: pad };
}

/** One past the highest solid level anywhere in an occupancy grid; 0 if empty. */
export function topOf(g) {
  if (g.top !== undefined) return g.top;
  var occ = g.occ, ny = g.ny, n = occ.length, top = 0, y;
  for (var k = 0; k < n; k += ny) {
    for (y = ny - 1; y >= top; y--) if (occ[k + y]) { top = y + 1; break; }
  }
  g.top = top;
  return top;
}

/**
 * Air reachable from outside the chunk box. Anything else is a sealed cave, and
 * its walls are not meshed — see the note at the top.
 */
export function openAir(g) {
  var nx = g.nx, nz = g.nz, ny = g.ny, occ = g.occ;
  var open = new Uint8Array(nx * nz * ny), q = [], head = 0;
  function push(a, b, y) {
    if (a < 0 || b < 0 || y < 0 || a >= nx || b >= nz || y >= ny) return;
    var k = (a * nz + b) * ny + y;
    if (occ[k] || open[k]) return;
    open[k] = 1; q.push(k);
  }
  var a, b, y, top = topOf(g);
  /* Issue #59. Above the highest solid level every cell is air that reaches
     the top, so it is open without being flooded to — that was more than half
     the volume, and all of the flood's cost up there. The flood starts from
     the first open layer instead, which is the same set of cells it reached. */
  if (top < ny) {
    for (a = 0; a < nx; a++) for (b = 0; b < nz; b++) {
      var base = (a * nz + b) * ny;
      for (y = top; y < ny; y++) open[base + y] = 1;
      q.push(base + top);
    }
  } else {
    for (a = 0; a < nx; a++) for (b = 0; b < nz; b++) push(a, b, ny - 1);
  }
  for (y = 0; y < Math.min(top, ny); y++) {
    for (a = 0; a < nx; a++) { push(a, 0, y); push(a, nz - 1, y); }
    for (b = 0; b < nz; b++) { push(0, b, y); push(nx - 1, b, y); }
  }
  while (head < q.length) {
    var k = q[head++], yy = k % ny, bb = ((k - yy) / ny) % nz, aa = ((k - yy) / ny - bb) / nz;
    push(aa + 1, bb, yy); push(aa - 1, bb, yy);
    push(aa, bb + 1, yy); push(aa, bb - 1, yy);
    push(aa, bb, yy + 1); push(aa, bb, yy - 1);
  }
  return open;
}

/**
 * What a solid cell is made of, and which palette group it wears.
 *
 * Both, because they are different questions: MAT.ROCK is what you carve and
 * what your boots sound like, and it is meadow rock or mesa rock depending on
 * where you are standing. Merging on the palette group is therefore finer than
 * merging on the material, and it is the one that decides what you see.
 *
 * The rules are buildVoxels', reproduced against the same inputs rather than
 * guessed: the biome is drawn from the column's own positional stream, so the
 * first value out of PASS.VOX at this column is the same roulette the generator
 * rolled. That only works because issue #41 made the stream answer for a place
 * — before it, a mesher could not have reproduced this at all.
 */
export function surfaceAt(w, gi, gj, y) {
  var NZ = w.NZ, NX = w.NX, half = w.half, M = w.M;
  if (gi < 0 || gj < 0 || gi >= NX || gj >= NZ) return { mat: MAT.ROCK, pal: PAL.MEADOW_ROCK.at };
  var k = gi * NZ + gj, hh = w.Hs[k], flg = w.FLG[k];
  var x = -half + gi * V + V / 2, z = -half + gj * V + V / 2;
  var c = w.cells[clamp(Math.round(x + half), 0, M - 1) * M + clamp(Math.round(z + half), 0, M - 1)];
  var R = w.G.pstream(PASS.VOX, gi + Math.round(w.OX / V), gj + Math.round(w.OZ / V));
  var b = BIOMES[rouletteBiome(c.w, R, 3)];  /* as surface.mjs: #55 item 9 */
  var top = Math.floor((hh - 0.001) / V);
  if (y >= top) {
    if (flg & 2) return { mat: MAT.ASH, pal: PAL.MAGMA_CRUST.at };
    if (flg & 1) return { mat: b.mat.bed, pal: b.bed.at };
    if (flg & 4) {
      /* As surface.mjs (#55 item 12), draw for draw: the path's dither is the
         next draw after the roulette on the same stream. */
      if (!(flg & 8) && R() < 0.35) return { mat: b.mat.surf, pal: b.surf.at };
      if ((flg & 8) && (b === BIOMES[BIO.MESA] || b === BIOMES[BIO.RIME])) return { mat: MAT.PATH, pal: b.soil.at };
      return { mat: MAT.PATH, pal: PAL.TRODDEN.at };
    }
    var n0 = gi > 0 ? w.Hs[k - NZ] : hh - 2, n1 = gi < NX - 1 ? w.Hs[k + NZ] : hh - 2;
    var n2 = gj > 0 ? w.Hs[k - 1] : hh - 2, n3 = gj < NZ - 1 ? w.Hs[k + 1] : hh - 2;
    return (hh - Math.min(n0, n1, n2, n3)) > 0.9
      ? { mat: b.mat.rock, pal: b.rock.at } : { mat: b.mat.surf, pal: b.surf.at };
  }
  return (y * V < hh - 1.25)
    ? { mat: b.mat.rock, pal: b.rock.at } : { mat: b.mat.soil, pal: b.soil.at };
}

/** Vertex AO from the three cells around a corner: the classic 0..3 ramp. */
function cornerAO(s1, s2, cor) { return (s1 && s2) ? 0 : 3 - (s1 + s2 + cor); }

/**
 * Mesh one chunk. Returns flat arrays and the counts the gate asserts on.
 *
 * Greedy in the usual two passes: build a mask of exposed faces for each slice,
 * then pull the largest rectangle of equal key out of it until it is empty. The
 * key is material and the four AO corners packed together — faces only merge
 * when they would draw identically, which is what keeps the creases.
 */
export function meshChunk(w, cx, cz, org) {
  var g = chunkOccupancy(w, cx, cz, undefined, org), open = openAir(g);
  var nx = g.nx, nz = g.nz, ny = g.ny, occ = g.occ, pad = g.pad;
  var pos = [], nor = [], ao = [], mat = [], pal = [], idx = [];
  var quads = 0, faces = 0, vbase = 0;

  var side = Math.round(CHUNK / V);
  /* Issue #59: the same sweep, the same order and the same output, with three
     costs taken out of it. Nothing at or above `top` is solid, so nothing
     there can have a face, and every loop that runs up the column stops at it —
     the mask entries above are never written and stay zero, so the rectangle
     pass stops exactly where it always did. Cells are addressed by flat index
     and stride rather than coordinate arrays built per cell. And only the
     vertical can step outside the grid: the pad ring keeps every horizontal
     neighbour of a chunk cell in range, so only y is bounds-checked. */
  var top = topOf(g);
  var STR = [nz * ny, 1, ny];                     /* strides, index order (a, y, b) */
  function occY(k, y) { return (y < 0 || y >= ny) ? 0 : occ[k]; }
  for (var d = 0; d < DIRS.length; d++) {
    var axis = DIRS[d][0], sign = DIRS[d][1];
    /* u and v are the two axes of the slice; n is the one being swept. */
    var uA = (axis + 1) % 3, vA = (axis + 2) % 3;
    var lim = [side, ny, side];
    var off = [pad, 0, pad];
    var key = new Int32Array(lim[uA] * lim[vA]);
    var aoq = new Int32Array(lim[uA] * lim[vA]);
    var sLim = axis === 1 ? Math.min(top, ny) : lim[axis];
    var iLim = uA === 1 ? Math.min(top, ny) : lim[uA];
    var jLim = vA === 1 ? Math.min(top, ny) : lim[vA];
    var su = STR[uA], sv = STR[vA], sn = STR[axis], nOff = sign * sn;
    /* How y moves with each step, for the one axis that can leave the grid. */
    var yN = axis === 1 ? sign : 0, yU = uA === 1 ? 1 : 0, yV = vA === 1 ? 1 : 0;

    for (var s = 0; s < sLim; s++) {
      var i, j;
      /* ---- build the mask ---- */
      for (i = 0; i < iLim; i++) {
        var rowK = (s + off[axis]) * sn + (i + off[uA]) * su + off[vA] * sv;
        var rowY = (axis === 1 ? s : 0) + (uA === 1 ? i : 0);
        for (j = 0; j < jLim; j++) {
          var k = rowK + j * sv, y = rowY + (vA === 1 ? j : 0);
          var m = 0, pg = 0, packed = 0;
          if (occ[k]) {
            var nk = k + nOff, nyy = y + yN;
            var nSolid = occY(nk, nyy);
            var nSeen = (nyy < 0 || nyy >= ny) ? 1 : open[nk];
            if (!nSolid && nSeen) {
              var a = (k / STR[0]) | 0, b = ((k - a * STR[0]) / ny) | 0;
              var sf = surfaceAt(w, g.i0 + a, g.j0 + b, y);
              m = sf.mat; pg = sf.pal;
              /* the four corners of the face, in the slice's own axes */
              var uMk = nk - su, uPk = nk + su, vMk = nk - sv, vPk = nk + sv;
              var uMy = nyy - yU, uPy = nyy + yU, vMy = nyy - yV, vPy = nyy + yV;
              var c0 = cornerAO(occY(uMk, uMy), occY(vMk, vMy), occY(uMk - sv, uMy - yV));
              var c1 = cornerAO(occY(uPk, uPy), occY(vMk, vMy), occY(uPk - sv, uPy - yV));
              var c2 = cornerAO(occY(uPk, uPy), occY(vPk, vPy), occY(uPk + sv, uPy + yV));
              var c3 = cornerAO(occY(uMk, uMy), occY(vPk, vPy), occY(uMk + sv, uMy + yV));
              packed = c0 | (c1 << 2) | (c2 << 4) | (c3 << 6);
              faces++;
            } else m = 0;
          }
          /* Keyed on the palette group, not the material: two biomes can both
             be MAT.ROCK and must not merge into one grey face. */
          key[i * lim[vA] + j] = m ? (pg + 1) : 0;
          aoq[i * lim[vA] + j] = (packed << 8) | m;
        }
      }
      /* ---- pull rectangles out of it ---- */
      for (i = 0; i < iLim; i++) {
        for (j = 0; j < jLim;) {
          var kk = key[i * lim[vA] + j];
          if (!kk) { j++; continue; }
          var aa2 = aoq[i * lim[vA] + j], wRun = 1;
          while (j + wRun < jLim && key[i * lim[vA] + j + wRun] === kk
                 && aoq[i * lim[vA] + j + wRun] === aa2) wRun++;
          var hRun = 1, ok = true;
          while (i + hRun < iLim && ok) {
            for (var t = 0; t < wRun; t++) {
              if (key[(i + hRun) * lim[vA] + j + t] !== kk || aoq[(i + hRun) * lim[vA] + j + t] !== aa2) { ok = false; break; }
            }
            if (ok) hRun++;
          }
          emit(axis, sign, s, i, j, hRun, wRun, kk - 1, aa2 >> 8, aa2 & 255, uA, vA, off);
          for (var di2 = 0; di2 < hRun; di2++)
            for (var dj2 = 0; dj2 < wRun; dj2++) key[(i + di2) * lim[vA] + j + dj2] = 0;
          j += wRun;
        }
      }
    }
  }

  function emit(axis, sign, s, i, j, hRun, wRun, pg, packed, m, uA, vA, off) {
    /* world-space corner of the quad, in metres */
    var o = [0, 0, 0];
    o[axis] = (s + off[axis] + (sign > 0 ? 1 : 0));
    o[uA] = i + off[uA]; o[vA] = j + off[vA];
    var du = [0, 0, 0], dv = [0, 0, 0];
    du[uA] = hRun; dv[vA] = wRun;
    var half = w.half;
    /* index order inside this function is (a, y, b) -> world (x, y, z) */
    function pt(a, y, b) {
      pos.push(-half + (g.i0 + a) * V, y * V, -half + (g.j0 + b) * V);
      nor.push(axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0);
      mat.push(m); pal.push(pg);
    }
    pt(o[0], o[1], o[2]);
    pt(o[0] + du[0], o[1] + du[1], o[2] + du[2]);
    pt(o[0] + du[0] + dv[0], o[1] + du[1] + dv[1], o[2] + du[2] + dv[2]);
    pt(o[0] + dv[0], o[1] + dv[1], o[2] + dv[2]);
    ao.push(packed & 3, (packed >> 2) & 3, (packed >> 4) & 3, (packed >> 6) & 3);
    /* Split the quad along the darker diagonal, or the crease bends the wrong
       way and a corner lights up where it should be in shadow. */
    var a0 = packed & 3, a2 = (packed >> 4) & 3, a1 = (packed >> 2) & 3, a3 = (packed >> 6) & 3;
    /* The corners run o, o+du, o+du+dv, o+dv whichever way the face points,
       so that order is counter-clockwise seen from +axis and clockwise seen
       from -axis. A negative face therefore takes the same two triangles the
       other way round. It used not to, and the material is single-sided: every
       -X, -Y and -Z face was culled, and three of the four view steps lost
       their walls (#56). */
    if (a0 + a2 > a1 + a3) {
      if (sign > 0) idx.push(vbase, vbase + 1, vbase + 2, vbase, vbase + 2, vbase + 3);
      else idx.push(vbase, vbase + 2, vbase + 1, vbase, vbase + 3, vbase + 2);
    } else {
      if (sign > 0) idx.push(vbase + 1, vbase + 2, vbase + 3, vbase + 1, vbase + 3, vbase);
      else idx.push(vbase + 1, vbase + 3, vbase + 2, vbase + 1, vbase, vbase + 3);
    }
    vbase += 4; quads++;
  }

  return { pos: pos, nor: nor, ao: ao, mat: mat, pal: pal, idx: idx, quads: quads, faces: faces };
}
