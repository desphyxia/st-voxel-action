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
/** Cells either way along a line the crown test reads. */
const CROWN = 6;
/** Rounds of it: each can free a cell the last one read before cutting. */
const CROWN_ROUNDS = 3;
/** The least a crown's cut leaves between its surface and its bed. */
const MIN_DEPTH = 0.75;

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
  /* Caps over a margin wide enough to settle every cell the crown test below
     reads, and that test reaches CROWN cells past the window. */
  var R = SETTLE, P = CROWN * CROWN_ROUNDS, T = M + 2 * P, S = T + 2 * R, caps = new Array(S * S);
  for (i = 0; i < S; i++) for (j = 0; j < S; j++) {
    caps[i * S + j] = cap(-half + i - R - P + OX, -half + j - R - P + OZ);
  }
  /* Each water cell's settled level, over the window and its margin. */
  var lvl = new Array(T * T);
  for (i = 0; i < T; i++) for (j = 0; j < T; j++) {
    var own = caps[(i + R) * S + (j + R)];
    if (!own) { lvl[i * T + j] = null; continue; }
    var lim = own.lim;
    for (var a = -R; a <= R; a++) for (var b = -R; b <= R; b++) {
      var n = caps[(i + R + a) * S + (j + R + b)];
      if (!n || n.lim >= n.wl || Math.abs(n.wl - own.wl) >= STEP) continue;
      var up = n.lim + EASE * Math.max(Math.abs(a), Math.abs(b));
      if (up < lim) lim = up;
    }
    lvl[i * T + j] = Math.min(lim, own.wl);
  }
  /* ---- no crown across a river ----
     Settling pulls the water beside a low bank down and eases back up over a
     few metres, so a narrow river with low banks on both sides was held down
     at both edges and left standing in the middle: a strip up to a metre over
     the water either side of it, falls down both flanks, and a deck laid
     between the banks under water. Water that is higher than the water on
     both sides of it along a line has nowhere to stand, so along each axis a
     cell may stand no higher than the higher of the two lowest levels it
     reaches through water on either side. A river falling steadily along its
     course is untouched — one side is always higher — and only a hump is cut. */
  /* Cutting one cell can free the one beside it, which was read before the
     cut, so the test runs in rounds. Each reads CROWN cells further out than
     the last, which is what the margin is for: every window starts from the
     same levels over what it reads, and so reaches the same answer. */
  var settled = lvl;
  for (var round = 1; round <= CROWN_ROUNDS; round++) {
    var next = lvl.slice(), e = CROWN * round;
    for (i = e; i < T - e; i++) for (j = e; j < T - e; j++) {
      var v0 = lvl[i * T + j];
      if (v0 === null) continue;
      for (var ax = 0; ax < 2; ax++) {
        var di = ax ? 0 : 1, dj = ax ? 1 : 0, lo1 = Infinity, lo2 = Infinity, t, v;
        for (t = 1; t <= CROWN; t++) { v = lvl[(i + di * t) * T + j + dj * t]; if (v === null) break; if (v < lo1) lo1 = v; }
        for (t = 1; t <= CROWN; t++) { v = lvl[(i - di * t) * T + j - dj * t]; if (v === null) break; if (v < lo2) lo2 = v; }
        if (lo1 < Infinity && lo2 < Infinity && Math.max(lo1, lo2) < v0) v0 = Math.max(lo1, lo2);
      }
      next[i * T + j] = v0;
    }
    lvl = next;
  }
  var out = [];
  for (i = 0; i < M; i++) for (j = 0; j < M; j++) {
    var c0 = cells[i * M + j];
    if (!c0.water) continue;
    var lim2 = lvl[(i + P) * T + j + P];
    if (lim2 !== null && lim2 < c0.wl) out.push([c0, lim2, settled[(i + P) * T + j + P]]);
  }
  /* A bank that does not hold takes the bed down with the water, or the
     river would drain to a film. A crown only ever levels water with the
     water beside it, which already has a bed, so its own is carved no deeper
     than it takes to stay a river: cutting every crown's bed by its full
     depth took spore's unreachable ground from 1% to 3%. */  /* Applied after every cap is read, so no cell's answer depends on the order
     the window happened to walk them in. */
  for (d = 0; d < out.length; d++) {
    var cw = out[d][0], nl = out[d][1], held = out[d][2], depth = cw.wl - cw.H;
    cw.wl = nl;
    cw.H = Math.min(cw.H, Math.floor(held - depth + 1e-9), Math.floor(nl - Math.min(depth, MIN_DEPTH) + 1e-9));
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
          /* Joined neighbour to neighbour, as water is: a river easing down a
             quarter at a time is one pool, though its ends differ by more
             than a step. Measured against where the pool was entered, a hump
             of 8.25 / 8.0 / 7.75 split at 7.75 and never saw itself perched. */
          if (Math.abs(nl - pl) < STEP) {
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
  /* Everything a quad carries is given per corner: depth, foam and flow. A
     fall carries depth 0 at its lip and 1 at its base, so the shader knows how
     far the water has dropped, and foam 2 on all four corners. A surface quad
     carries foam as an amount from 0 to 1 — shore froth and the churn under a
     fall — and it is the same at a corner whichever quad asks, so the foam,
     like the level, runs across the surface without a seam. */
  function wquad(q,dep,foam,fl){
    for(var a=0;a<4;a++){ wv.push(q[a*3],q[a*3+1],q[a*3+2]);
      wd.push(dep[a]); wf.push(foam[a]); wfl.push(fl[a*2],fl[a*2+1]); }
    wi.push(wn,wn+2,wn+1, wn,wn+3,wn+2); wn+=4;
  }
  var WDIR=[[1,0],[-1,0],[0,1],[0,-1]];
  /* A fall's four corners are laid lip, lip, base, base. */
  var FALL_DEP=[0,0,1,1], FALL_FOAM=[2,2,2,2];
  /* How deep each column reads: its surface over the mean bed around it. And
     per column, the way it flows and whether a fall lands in it. */
  var DEP=new Float32Array(NX*NZ), FX=new Float32Array(NX*NZ), FZ=new Float32Array(NX*NZ), CH=new Uint8Array(NX*NZ);
  for(i=1;i<NX-1;i++)for(j=1;j<NZ-1;j++){
    k=i*NZ+j; if(!(FLG[k]&1)) continue;
    var bsum=0,bn=0;
    for(var bi2=-2;bi2<=2;bi2++)for(var bj2=-2;bj2<=2;bj2++){
      var kb=(i+bi2)*NZ+(j+bj2);
      if(kb<0||kb>=NX*NZ) continue;
      bsum+=Hs[kb]; bn++;
    }
    DEP[k]=clamp((WL[k]-bsum/bn)/1.6,0,1);
    var cf=cellAt(-half+i*V,-half+j*V); FX[k]=cf.fx; FZ[k]=cf.fz;
    for(var dq=0;dq<4;dq++){ var kq=(i+WDIR[dq][0])*NZ+(j+WDIR[dq][1]);
      if((FLG[kq]&1)&&WL[kq]-WL[k]>=STEP) CH[k]=1; }
  }
  /* One surface, not a tile per column. Each column used to be drawn flat at
     its own level, and a river whose level eases down a quarter-metre at a
     time (containWater) came out as a patchwork of tiles at different
     heights, each edge closed by a small face — the join showed at every
     column. Now a corner stands at the mean level of the water columns that
     meet there, so neighbouring quads share their corners and the surface is
     continuous: a slope, not a staircase.
     Only water of one pool is averaged: the levels at a corner are sorted and
     split wherever two differ by a fall (STEP) or more, and a quad takes the
     mean of the group its own level is in. The split depends on the corner,
     never on which quad asks, so both sides of a join agree — and a fall
     keeps its lip and its base, with a face between them. */
  var cv=[];
  /* A corner, as the pool `own` is in sees it: [level, depth, foam, fx, fz]. */
  function corner(ci,cj,own){
    cv.length=0;
    var dry=0;
    for(var a=ci-1;a<=ci;a++)for(var b=cj-1;b<=cj;b++){
      if(a<0||b<0||a>=NX||b>=NZ){ dry++; continue; }
      var kk=a*NZ+b; if(FLG[kk]&1) cv.push(kk); else dry++;
    }
    /* insertion sort by level */
    for(var p=1;p<cv.length;p++) for(var r=p;r>0&&WL[cv[r-1]]>WL[cv[r]];r--){ var t0=cv[r-1]; cv[r-1]=cv[r]; cv[r]=t0; }
    var at=0; while(at<cv.length&&Math.abs(WL[cv[at]]-own)>1e-9) at++;
    var lo=at, hi=at;
    while(lo>0&&WL[cv[lo]]-WL[cv[lo-1]]<STEP) lo--;
    while(hi+1<cv.length&&WL[cv[hi+1]]-WL[cv[hi]]<STEP) hi++;
    var sy=0,sd=0,sx=0,sz=0,ch=0,n=0;
    for(var g=lo;g<=hi;g++){ var kg=cv[g]; sy+=WL[kg]; sd+=DEP[kg]; sx+=FX[kg]; sz+=FZ[kg]; if(CH[kg]) ch=1; n++; }
    /* Froth where the water meets the bank, and churn where a fall lands. */
    var foam=Math.max(dry?0.55:0,ch);
    return [sy/n,sd/n,foam,sx/n,sz/n];
  }
  for(i=1;i<NX-1;i++)for(j=1;j<NZ-1;j++){
    k=i*NZ+j; if(!(FLG[k]&1)) continue;
    x=-half+i*V; z=-half+j*V; y=WL[k];
    var dd2, c00=corner(i,j,y), c10=corner(i+1,j,y), c11=corner(i+1,j+1,y), c01=corner(i,j+1,y);
    wquad([x,c00[0],z, x+V,c10[0],z, x+V,c11[0],z+V, x,c01[0],z+V],[c00[1],c10[1],c11[1],c01[1]],
          [c00[2],c10[2],c11[2],c01[2]],[c00[3],c00[4],c10[3],c10[4],c11[3],c11[4],c01[3],c01[4]]);
    /* A fall is water stepping down onto lower water by STEP or more. A step
       under that is part of the surface now — its two sides share corners —
       and needs no face. The face runs from this quad's edge corners down to
       the lower quad's, so both edges stay sealed. */
    for(dd2=0;dd2<4;dd2++){
      var di3=WDIR[dd2][0], dj3=WDIR[dd2][1], kn2=(i+di3)*NZ+(j+dj3);
      if(!(FLG[kn2]&1)) continue;
      var yl=WL[kn2];
      if(y-yl<STEP) continue;
      var e0, e1;
      if(di3===1){ e0=[i+1,j]; e1=[i+1,j+1]; } else if(di3===-1){ e0=[i,j]; e1=[i,j+1]; }
      else if(dj3===1){ e0=[i,j+1]; e1=[i+1,j+1]; } else { e0=[i,j]; e1=[i+1,j]; }
      var ex0=-half+e0[0]*V, ez0=-half+e0[1]*V, ex1=-half+e1[0]*V, ez1=-half+e1[1]*V;
      var u0=corner(e0[0],e0[1],y)[0], u1=corner(e1[0],e1[1],y)[0];
      var l0=corner(e0[0],e0[1],yl)[0], l1=corner(e1[0],e1[1],yl)[0];
      wquad([ex0,u0,ez0, ex1,u1,ez1, ex1,l1,ez1, ex0,l0,ez0],FALL_DEP,FALL_FOAM,[di3,dj3,di3,dj3,di3,dj3,di3,dj3]);
    }
  }
  w.water = { v: wv, i: wi, d: wd, f: wf, fl: wfl };
}
