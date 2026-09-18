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
import { BIOMES, rouletteBiome } from '../gen/biomes.mjs';
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
 * The solid volume of one chunk at 25 cm, from the spans — not from the voxels
 * the generator emitted. `pad` of 1 gives the AO and the face test a ring of
 * neighbours to read, so a chunk's edge is shaded by the chunk beside it.
 *
 * Carved voxels are subtracted afterwards rather than tested per cell: edits
 * are sparse by nature, so walking the map costs what has been carved instead
 * of what has not.
 */
export function chunkOccupancy(w, cx, cz, pad) {
  pad = pad === undefined ? 1 : pad;
  var side = Math.round(CHUNK / V);
  var nx = side + pad * 2, nz = side + pad * 2, ny = LEVELS;
  var i0 = cx * side - pad, j0 = cz * side - pad;
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
  var a, b, y;
  for (a = 0; a < nx; a++) for (b = 0; b < nz; b++) push(a, b, ny - 1);
  for (y = 0; y < ny; y++) {
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
  var b = BIOMES[rouletteBiome(c.w, R)];
  var top = Math.floor((hh - 0.001) / V);
  if (y >= top) {
    if (flg & 2) return { mat: MAT.ASH, pal: PAL.MAGMA_CRUST.at };
    if (flg & 1) return { mat: b.mat.bed, pal: b.bed.at };
    if (flg & 4) return { mat: MAT.PATH, pal: PAL.TRODDEN.at };
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
export function meshChunk(w, cx, cz) {
  var g = chunkOccupancy(w, cx, cz), open = openAir(g);
  var nx = g.nx, nz = g.nz, ny = g.ny, occ = g.occ, pad = g.pad;
  var pos = [], nor = [], ao = [], mat = [], pal = [], idx = [];
  var quads = 0, faces = 0, vbase = 0;

  function solid(a, b, y) {
    if (a < 0 || b < 0 || y < 0 || a >= nx || b >= nz || y >= ny) return 0;
    return occ[(a * nz + b) * ny + y];
  }
  function seen(a, b, y) {
    if (a < 0 || b < 0 || y < 0 || a >= nx || b >= nz || y >= ny) return 1;
    return open[(a * nz + b) * ny + y];
  }

  var side = Math.round(CHUNK / V);
  for (var d = 0; d < DIRS.length; d++) {
    var axis = DIRS[d][0], sign = DIRS[d][1];
    /* u and v are the two axes of the slice; n is the one being swept. */
    var uA = (axis + 1) % 3, vA = (axis + 2) % 3;
    var dim = [nx, ny, nz];                       /* index order is (a, y, b) */
    var lim = [side, ny, side];
    var off = [pad, 0, pad];
    var key = new Int32Array(lim[uA] * lim[vA]);
    var aoq = new Int32Array(lim[uA] * lim[vA]);

    for (var s = 0; s < lim[axis]; s++) {
      var i, j, p = [0, 0, 0];
      /* ---- build the mask ---- */
      for (i = 0; i < lim[uA]; i++) {
        for (j = 0; j < lim[vA]; j++) {
          p[axis] = s + off[axis]; p[uA] = i + off[uA]; p[vA] = j + off[vA];
          var a = p[0], y = p[1], b = p[2];
          var m = 0, pg = 0, packed = 0;
          if (solid(a, b, y)) {
            var q = [0, 0, 0]; q[axis] = sign;
            var na = a + q[0], nyy = y + q[1], nb = b + q[2];
            if (!solid(na, nb, nyy) && seen(na, nb, nyy)) {
              var sf = surfaceAt(w, g.i0 + a, g.j0 + b, y);
              m = sf.mat; pg = sf.pal;
              /* the four corners of the face, in the slice's own axes */
              var e1 = [0, 0, 0], e2 = [0, 0, 0];
              e1[uA] = 1; e2[vA] = 1;
              var c0 = cornerAO(solid(na - e1[0], nb - e1[2], nyy - e1[1]),
                                solid(na - e2[0], nb - e2[2], nyy - e2[1]),
                                solid(na - e1[0] - e2[0], nb - e1[2] - e2[2], nyy - e1[1] - e2[1]));
              var c1 = cornerAO(solid(na + e1[0], nb + e1[2], nyy + e1[1]),
                                solid(na - e2[0], nb - e2[2], nyy - e2[1]),
                                solid(na + e1[0] - e2[0], nb + e1[2] - e2[2], nyy + e1[1] - e2[1]));
              var c2 = cornerAO(solid(na + e1[0], nb + e1[2], nyy + e1[1]),
                                solid(na + e2[0], nb + e2[2], nyy + e2[1]),
                                solid(na + e1[0] + e2[0], nb + e1[2] + e2[2], nyy + e1[1] + e2[1]));
              var c3 = cornerAO(solid(na - e1[0], nb - e1[2], nyy - e1[1]),
                                solid(na + e2[0], nb + e2[2], nyy + e2[1]),
                                solid(na - e1[0] + e2[0], nb - e1[2] + e2[2], nyy - e1[1] + e2[1]));
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
      for (i = 0; i < lim[uA]; i++) {
        for (j = 0; j < lim[vA];) {
          var kk = key[i * lim[vA] + j];
          if (!kk) { j++; continue; }
          var aa2 = aoq[i * lim[vA] + j], wRun = 1;
          while (j + wRun < lim[vA] && key[i * lim[vA] + j + wRun] === kk
                 && aoq[i * lim[vA] + j + wRun] === aa2) wRun++;
          var hRun = 1, ok = true;
          while (i + hRun < lim[uA] && ok) {
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
    if (a0 + a2 > a1 + a3) idx.push(vbase, vbase + 1, vbase + 2, vbase, vbase + 2, vbase + 3);
    else idx.push(vbase + 1, vbase + 2, vbase + 3, vbase + 1, vbase + 3, vbase);
    vbase += 4; quads++;
  }

  return { pos: pos, nor: nor, ao: ao, mat: mat, pal: pal, idx: idx, quads: quads, faces: faces };
}
