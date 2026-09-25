/**
 * Water. Three passes that share one rule: water goes where the ground lets it.
 *
 *   fillWaterTable       hollows flood until they spill
 *   flowField            one downhill vector per cell, shared by water and foam
 *   buildWaterGeometry   the surface quads, shore foam and vertical falls
 *
 * The geometry is plain vertex, index and per-vertex attribute arrays — depth,
 * foam and flow — and no renderer object of any kind.
 */
import { V, DIRS4, clamp } from './constants.mjs';
import { hyp } from './exact.mjs';
import { groundCellAt } from './ground.mjs';

/* ---------- water is held by its banks (issue #57) ----------
   The field lays a river 0.75 m deep in a bed cut a metre into the ground, and
   a pond 1.25 m deep, so on level ground the surface sits a quarter-metre under
   the bank. Nothing kept it there. Erosion cuts banks back, a trail's cutting
   lowers them, and a river crossing a slope has its downhill bank below it —
   and wherever that happened the water stood above the dry ground beside it,
   held up by nothing, and the renderer drew the edge as a waterfall.

   So: a water cell's surface may be no higher than FREEBOARD under the lowest
   dry bank beside it, and its bed is carved by the same amount, so it keeps its
   depth rather than draining away. A lowered cell pulls the water around it
   down too, but on a slope: d cells away the surface may stand at most
   d * EASE above it. EASE is under the 0.4 m at which the renderer hangs a
   sheet, so the surface eases back up to its own level instead of stepping.
   A hard radius was tried first and made the problem it was fixing — every
   cell just outside it stood a full step above the one just inside, and
   meadow's falls between water cells went from 84 to 159. Only a cell that was
   actually held down does the pulling, and only water at its own level: an
   unbounded slope was tried second and pulled mesa's rivers down through
   every terrace, taking all 244 of its real cascades with them.

   Every input is read through groundCellAt and the field, never this window
   alone, so two windows onto the same bank decide it the same way. Runs after
   the region's grading and before the spans are cut, which is what lets a
   carved bed reach the spans with nothing else to update. */
const FREEBOARD = 0.25;
/** A change of level the renderer draws as a fall: water this far below its
    neighbour is a different pool, and a held-down cell never pulls it, so a
    river's natural cascade down a terrace survives. */
const STEP = 0.4;
/** Metres per cell a lowered surface climbs back towards its own level. */
const EASE = 0.25;
/** Cells a lowered surface reaches: enough for EASE to climb back 2 m. */
const SETTLE = 8;

export function containWater(w) {
  var M = w.M, cells = w.cells, half = w.half, OX = w.OX, OZ = w.OZ, G = w.G, i, j, d;
  /* Ground and water as this pass sees them, at any world coordinate. */
  function at(x, z) {
    var c = groundCellAt(w, x, z);
    if (c.water && c.wl === undefined) c = { H: c.H, water: true, magma: c.magma, wl: G.cell(x, z).wl };
    return c;
  }
  /* How high this cell's water may stand, or null if it is not water. */
  function cap(x, z) {
    var c = at(x, z);
    if (!c.water) return null;
    var lim = c.wl;
    for (var q = 0; q < 4; q++) {
      var n = at(x + DIRS4[q][0], z + DIRS4[q][1]);
      if (n.water || n.magma) continue;
      if (n.H - FREEBOARD < lim) lim = n.H - FREEBOARD;
    }
    return { wl: c.wl, lim: lim };
  }
  var R = SETTLE, S = M + 2 * R, caps = new Array(S * S);
  for (i = 0; i < S; i++) for (j = 0; j < S; j++) {
    caps[i * S + j] = cap(-half + i - R + OX, -half + j - R + OZ);
  }
  var out = [];
  for (i = 0; i < M; i++) for (j = 0; j < M; j++) {
    var c0 = cells[i * M + j];
    if (!c0.water) continue;
    var own = caps[(i + R) * S + (j + R)], lim = own.lim;
    for (var a = -R; a <= R; a++) for (var b = -R; b <= R; b++) {
      var n = caps[(i + R + a) * S + (j + R + b)];
      if (!n || n.lim >= n.wl || Math.abs(n.wl - own.wl) >= STEP) continue;
      var up = n.lim + EASE * Math.max(Math.abs(a), Math.abs(b));
      if (up < lim) lim = up;
    }
    if (lim < c0.wl) out.push([c0, lim]);
  }
  /* Applied after every cap is read, so no cell's answer depends on the order
     the window happened to walk them in. */
  for (d = 0; d < out.length; d++) {
    var cw = out[d][0], nl = out[d][1], depth = cw.wl - cw.H;
    cw.wl = nl;
    cw.H = Math.min(cw.H, Math.floor(nl - depth + 1e-9));
  }
  w.contained = out.length;
}

/* ---------- a pool does not stand above all the water around it (#67) ----------
   The river's level is capped at a smooth profile now (riverBed in field.mjs),
   which takes it through pillars and hills instead of over them. What that
   leaves is water that is still the highest thing on its stretch — a canyon
   lip, an eroded bank — with falls pouring out of it on two or more sides and
   nothing flowing in. Water cannot do that, so such a pool drains to the
   highest of the levels it pours into, and its bed is cut to keep its depth.

   A pool is the water joined to a cell at its own level (within STEP). One
   that reaches further than PERCH_R from where it was asked about is not
   decided at all: the answer has to be the same from every window that can see
   the cell, and a flood that ran off the edge of what one of them reads would
   not be. Every level is read through the same lookup containWater uses, and
   nothing is written until every pool has been decided. Runs before
   containWater, which then caps whatever it leaves under its banks. */
const PERCH_R = 12;

export function drainPerched(w) {
  var M = w.M, cells = w.cells, half = w.half, OX = w.OX, OZ = w.OZ, G = w.G, i, j;
  function lvl(x, z) {
    var c = groundCellAt(w, x, z);
    if (!c.water) return null;
    return c.wl === undefined ? G.cell(x, z).wl : c.wl;
  }
  var decided = new Map(), out = [];
  for (i = 0; i < M; i++) for (j = 0; j < M; j++) {
    var c0 = cells[i * M + j];
    if (!c0.water || c0.pond) continue;
    var x0 = -half + i + OX, z0 = -half + j + OZ, k0 = x0 + ',' + z0;
    var hit = decided.get(k0);
    if (hit === undefined) {
      var wl0 = lvl(x0, z0), seen = new Set([k0]), q = [[x0, z0]], mem = [k0];
      var higher = false, dirs = 0, outWl = -Infinity, open = false;
      while (q.length && !open) {
        var p = q.pop(), pl = lvl(p[0], p[1]);
        for (var d = 0; d < 4; d++) {
          var nx = p[0] + DIRS4[d][0], nz = p[1] + DIRS4[d][1], nl = lvl(nx, nz);
          if (nl === null) continue;
          if (Math.abs(nl - wl0) < STEP) {
            var nk = nx + ',' + nz;
            if (seen.has(nk)) continue;
            if (Math.max(Math.abs(nx - x0), Math.abs(nz - z0)) > PERCH_R) { open = true; break; }
            seen.add(nk); mem.push(nk); q.push([nx, nz]);
          } else if (nl > pl) higher = true;
          else { dirs |= 1 << d; if (nl > outWl) outWl = nl; }
        }
      }
      var spill = (dirs & 1) + (dirs >> 1 & 1) + (dirs >> 2 & 1) + (dirs >> 3 & 1);
      hit = (!open && !higher && spill >= 2) ? outWl : null;
      for (var m = 0; m < mem.length; m++) decided.set(mem[m], hit);
    }
    if (hit !== null && hit < c0.wl) out.push([c0, hit]);
  }
  for (var o = 0; o < out.length; o++) {
    var cw = out[o][0], nl2 = out[o][1], depth = cw.wl - cw.H;
    cw.wl = nl2;
    cw.H = Math.min(cw.H, Math.floor(nl2 - depth + 1e-9));
  }
  w.drained = out.length;
}

export function fillWaterTable(w) {
  var M = w.M, cells = w.cells, i, j, d0;
  for(var it=0;it<4;it++){
    var changed=0;
    for(i=1;i<M-1;i++)for(j=1;j<M-1;j++){
      var cw2=cells[i*M+j]; if(cw2.water||cw2.magma) continue;
      var best=0,walls=0,spill=false,rim=Infinity;
      for(d0=0;d0<4;d0++){
        var cn2=cells[(i+DIRS4[d0][0])*M+(j+DIRS4[d0][1])];
        if(cn2.water){ if(cn2.wl>cw2.H+0.75&&cn2.wl>best) best=cn2.wl; }
        else {
          if(cn2.H>=cw2.H+1) walls++;
          else if(cn2.H<cw2.H) spill=true;
          if(!cn2.magma&&cn2.H<rim) rim=cn2.H;
        }
      }
      /* a hollow fills; a plain drains; and a hollow whose rim is lower than
         the water it would take in is not a hollow at that level (#57) */
      if(best>0&&walls>=2&&!spill&&rim>=best){
        cw2.water=true; cw2.pond=true; cw2.wl=best; cw2.sp=[[0,Math.max(cw2.H,1)]]; changed++;
      }
    }
    if(!changed) break;
  }
}

export function flowField(w) {
  var M = w.M, cells = w.cells, i, j;
  for(i=0;i<M;i++)for(j=0;j<M;j++){
    var cf=cells[i*M+j];
    var hl=cells[(i>0?i-1:i)*M+j], hr=cells[(i<M-1?i+1:i)*M+j],
        hb=cells[i*M+(j>0?j-1:j)], hf=cells[i*M+(j<M-1?j+1:j)];
    var gx=(cf.water?(hl.wl||hl.H)-(hr.wl||hr.H):hl.H-hr.H),
        gz=(cf.water?(hb.wl||hb.H)-(hf.wl||hf.H):hb.H-hf.H);
    var gl=hyp(gx,gz);
    if(gl<0.001){ cf.fx=0.7; cf.fz=0.7; } else { cf.fx=-gx/gl; cf.fz=-gz/gl; }
  }
}

export function buildWaterGeometry(w) {
  var NX = w.NX, NZ = w.NZ, Hs = w.Hs, WL = w.WL, FLG = w.FLG, half = w.half,
      cellAt = w.cellAt, i, j, k, x, z, y;
  var wv=[],wi=[],wd=[],wf=[],wfl=[],wn=0;
  /* `dep` is one depth for the whole quad, or four — one per corner. A fall
     carries 0 at its lip and 1 at its base, so the shader knows how far the
     water has dropped at every point of the sheet. */
  function wquad(q,dep,foam,fx,fz){
    for(var a=0;a<4;a++){ wv.push(q[a*3],q[a*3+1],q[a*3+2]);
      wd.push(typeof dep==='number'?dep:dep[a]); wf.push(foam); wfl.push(fx,fz); }
    wi.push(wn,wn+2,wn+1, wn,wn+3,wn+2); wn+=4;
  }
  var WDIR=[[1,0],[-1,0],[0,1],[0,-1]];
  /* A fall's four corners are laid lip, lip, base, base. */
  var FALL_DEP=[0,0,1,1];
  for(i=1;i<NX-1;i++)for(j=1;j<NZ-1;j++){
    k=i*NZ+j; if(!(FLG[k]&1)) continue;
    x=-half+i*V; z=-half+j*V; y=WL[k];
    var bsum=0,bn=0;
    for(var bi2=-2;bi2<=2;bi2++)for(var bj2=-2;bj2<=2;bj2++){
      var kb=(i+bi2)*NZ+(j+bj2);
      if(kb<0||kb>=NX*NZ) continue;
      bsum+=Hs[kb]; bn++;
    }
    var dep=clamp((y-bsum/bn)/1.6,0,1), foam=0, fx=0, fz=0, dd2;
    for(dd2=0;dd2<4;dd2++){
      var kn=(i+WDIR[dd2][0])*NZ+(j+WDIR[dd2][1]);
      if(FLG[kn]&1){
        var dy=WL[kn]-y;
        if(dy<-0.35){ fx+=WDIR[dd2][0]*-dy; fz+=WDIR[dd2][1]*-dy; foam=Math.max(foam,1); }
        else if(dy>0.35) foam=Math.max(foam,1);
        else { fx+=WDIR[dd2][0]*0.04; fz+=WDIR[dd2][1]*0.04; }
      } else {
        if(Hs[kn]>y-0.1) foam=Math.max(foam,1);
        else { fx+=WDIR[dd2][0]*0.5; fz+=WDIR[dd2][1]*0.5; foam=Math.max(foam,1); }
      }
    }
    var cfw=cellAt(x,z); fx=cfw.fx; fz=cfw.fz;
    wquad([x,y,z, x+V,y,z, x+V,y,z+V, x,y,z+V],dep,foam,fx,fz);
    /* A fall is water stepping down onto lower water. It used to be any step
       at all, dry ground included, so water standing above a bank that did not
       hold it was drawn as a waterfall onto the grass (#57). containWater now
       keeps a surface under its banks, and a fall is only ever drawn where the
       terrain put one pool below another. */
    for(dd2=0;dd2<4;dd2++){
      var di3=WDIR[dd2][0], dj3=WDIR[dd2][1], kn2=(i+di3)*NZ+(j+dj3);
      if(!(FLG[kn2]&1)) continue;
      var yl=WL[kn2];
      if(yl>y-0.001) continue;
      var q2;
      if(di3===1) q2=[x+V,y,z, x+V,y,z+V, x+V,yl,z+V, x+V,yl,z];
      else if(di3===-1) q2=[x,y,z, x,y,z+V, x,yl,z+V, x,yl,z];
      else if(dj3===1) q2=[x,y,z+V, x+V,y,z+V, x+V,yl,z+V, x,yl,z+V];
      else q2=[x,y,z, x+V,y,z, x+V,yl,z, x,yl,z];
      /* Every step down to lower water is closed, not only the ones tall
         enough to be a fall. A river descends a voxel at a time, and a 25 cm
         step with no face was an open slit onto the bed under it — at 45° a
         dark crack across the surface, 5,609 of them over 27 streamed chunks.
         Under 0.4 m it is a riffle: shaded as surface foam (1), which the
         shader ripples exactly as it ripples the quads either side, so both
         edges stay sealed. From 0.4 m it is a fall (2), as it always was. */
      wquad(q2,y-yl<0.4?dep:FALL_DEP,y-yl<0.4?1:2,di3,dj3);
    }
  }
  w.water = { v: wv, i: wi, d: wd, f: wf, fl: wfl };
}
