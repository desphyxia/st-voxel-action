/**
 * From cells to voxels. sampleGrid resamples the 1 m cell grid onto the 25 cm
 * voxel grid — top height, span bottom, water level, flags. buildVoxels then
 * walks each column down from its surface and emits the boxes.
 *
 * Output is flat arrays: pos (x,y,z per voxel), then pal and shd — a palette
 * index and a shade byte — and mat, one material id each. Every push into pos
 * is matched by exactly one into each of the others; the four arrays are one
 * record split four ways and the smoke test checks their lengths agree.
 *
 * Colour used to be three floats here, collapsed at generation time. Issue #28
 * moved the multiply to draw time so a biome can be restyled without
 * regenerating: see src/gen/palette.mjs.
 */
import { V, CEIL, clamp } from './constants.mjs';
import { MAT } from './materials.mjs';
import { BIOMES, BIO, rouletteBiome } from './biomes.mjs';
import { PAL, pickPal, shadeByte } from './palette.mjs';
import { PASS } from './rng.mjs';

/* How much of the sub-metre relief a graded trail keeps. Zero is a crisply
   constructed path and risks a one-voxel lip along its edge; see issue #52. */
export const TRAIL_DETAIL = 0;

export function sampleGrid(w) {
  var S = w.size, M = w.M, half = w.half, cells = w.cells, cellAt = w.cellAt,
      G = w.G, OX = w.OX, OZ = w.OZ, TRAIL = w.TRAIL, i, j;
  var NX=Math.round(S/V), NZ=NX;
  var Hs=new Float32Array(NX*NZ), BOT=new Float32Array(NX*NZ), WL=new Float32Array(NX*NZ),
      DOM=new Uint8Array(NX*NZ), FLG=new Uint8Array(NX*NZ);
  var x,z,k,c;
  function ci(px){return clamp(Math.round(px+half),0,M-1);}
  /* The cell height field read between the lattice points. Cell `a` sits at
     world -half + a, so px + half is a continuous cell coordinate and the four
     cells around it are the corners to interpolate between.

     This reads `cells`, which carries the region's grading (layRoutes applies
     it before this pass), so it is the *graded* route being sampled and not the
     ground the route was cut into. It stays the same from any window because
     the cells do: it needs one metre of neighbourhood and a streamed chunk
     throws away four. */
  function cellH(a,b){
    /* The column's *ground* top, which is what sampleGrid draws — not the
       cell's H. The two differ wherever the generator floors a column at one
       voxel of ground: a cell at H=0 still has a span of [0,1], and reading H
       there put a metre-high ledge in the middle of a level route. */
    return Math.max(cells[clamp(a,0,M-1)*M+clamp(b,0,M-1)].H,1);
  }
  /* A trail ramps towards the ground beside it, never into water. A water
     cell's H is its *bed*, and a trail along a shore used to blend its edge
     down towards the riverbed: fen's lakeside trail tilted into the lake, and
     the edge voxels dropped below the water they bordered, which the water
     pass then drew as a fall onto dry ground — every one of the fourteen left
     once the banks held (#57). Beside water, the trail reads its own height. */
  function rampH(a,b,own){
    var c=cells[clamp(a,0,M-1)*M+clamp(b,0,M-1)];
    return (c.water||c.magma)?own:cellH(a,b);
  }
  function trailRamp(px,pz){
    var fx=px+half, fz=pz+half;
    var a=Math.floor(fx), b=Math.floor(fz), tx=fx-a, tz=fz-b;
    var own=cellH(ci(px),ci(pz));
    var h0=rampH(a,b,own)*(1-tx)+rampH(a+1,b,own)*tx;
    var h1=rampH(a,b+1,own)*(1-tx)+rampH(a+1,b+1,own)*tx;
    return h0*(1-tz)+h1*tz;
  }
  for(i=0;i<NX;i++){ x=-half+i*V+V/2;
    for(j=0;j<NZ;j++){ z=-half+j*V+V/2; k=i*NZ+j;
      c=cellAt(x,z);
      var topsp=c.sp[c.sp.length-1];
      /* Sub-metre relief, attenuated where the ground is not ordinary ground.
         Water already got half of it. A trail gets less again, and for the same
         reason the grading pass exists at all: region.mjs levels a route on the
         1 m cell grid so it can be walked, and then this resample used to put
         the chatter straight back on top of it — measured, a trail came out no
         flatter than the ground it crossed, and on canyon ground 26% rougher
         (issue #52). */
      var tr=TRAIL[ci(x)*M+ci(z)];
      var d=G.detail(x+OX,z+OZ);
      if(tr) d*=TRAIL_DETAIL; else if(c.water) d*=0.5;
      /* A trail rides the cell field *sampled continuously* rather than the one
         cell it stands on. Everywhere else the whole-metre lattice is the
         point — the world is authored in metres and the terraces are the look —
         but a route is a built surface, and taking the nearest cell's integer
         height made it climb in whole-metre jumps: measured, every step along a
         trail was 0, 4, 8 or 12 voxels and never 1, 2 or 3.

         Reading the same field between the cells turns a 1 m cell step into a
         ramp four voxel columns long, which is 1 voxel per column — the tightest
         a 25 cm grid can express. It is written as an offset from this cell's
         own height so that a column whose top span was cut by a cave keeps its
         span and gains only the ramp. */
      /* Rounded to the voxel grid, because everything downstream of here — the
         mesher, the collider, buildVoxels — is built out of 25 cm boxes. A
         difference of at most one voxel survives that rounding: rounding is
         monotone, so two values within V of each other land within V. */
      var top=tr?Math.round(trailRamp(x,z)/V)*V:topsp[1];
      Hs[k]=clamp(top+d,0,CEIL); BOT[k]=topsp[0]; WL[k]=c.wl; DOM[k]=c.dom;
      FLG[k]=(c.water?1:0)|(c.magma?2:0)|(tr?4:0)|(tr===2?8:0);
    } }
  w.NX = NX; w.NZ = NZ; w.Hs = Hs; w.BOT = BOT; w.WL = WL; w.DOM = DOM; w.FLG = FLG; w.ci = ci;
}

export function buildVoxels(w) {
  var NX = w.NX, NZ = w.NZ, Hs = w.Hs, BOT = w.BOT, FLG = w.FLG, half = w.half,
      cellAt = w.cellAt, G = w.G, i, j, k, x, z, c;
  /* The window's origin in voxels. A column's world voxel index is i + vx0,
     which is what two windows onto the same ground agree on — see issue #41. */
  var vx0 = Math.round(w.OX / V), vz0 = Math.round(w.OZ / V);
  /* voxels */
  var pos=[],pal=[],shd=[],mat=[],mpos=[],mpal=[],mshd=[],mmat=[],y,hh,mn,slope;
  /* One push into each, always together — the four arrays are one record. */
  function emit(px,py,pz,idx,k,m){ pos.push(px,py,pz); pal.push(idx); shd.push(shadeByte(k)); mat.push(m); }
  function emitEm(px,py,pz,idx,k,m){ mpos.push(px,py,pz); mpal.push(idx); mshd.push(shadeByte(k)); mmat.push(m); }
  var TOPI=new Int32Array(NX*NZ);
  for(i=0;i<NX;i++){ x=-half+i*V+V/2;
    for(j=0;j<NZ;j++){ z=-half+j*V+V/2; k=i*NZ+j; hh=Hs[k];
      var n0=i>0?Hs[k-NZ]:hh-2, n1=i<NX-1?Hs[k+NZ]:hh-2,
          n2=j>0?Hs[k-1]:hh-2, n3=j<NZ-1?Hs[k+1]:hh-2;
      mn=Math.min(n0,n1,n2,n3); slope=hh-mn;
      c=cellAt(x,z);
      /* Every shade this column wears comes out of one stream, seeded from the
         column and from nothing the pass did before it got here. */
      var R=G.pstream(PASS.VOX,i+vx0,j+vz0);
      /* The cube, not the fifth power, for the ground itself (#55 item 9):
         two biomes met on a line one metre wide — frost against meadow read
         as a hard straight white edge. A gentler weighting widens the band in
         which a column may take either biome's surface, so a border is a few
         metres of dither rather than a seam. Props and grass keep their own. */
      var b=BIOMES[rouletteBiome(c.w,R,3)], topc, topm;
      if(FLG[k]&2){ emitEm(x,hh-V/2,z,PAL.EM_MAGMA.at+(R()<0.5?0:1),1,MAT.MAGMA);
                    topc=PAL.MAGMA_CRUST.at; topm=MAT.ASH; }
      else if(FLG[k]&1){ topc=pickPal(b.bed,R); topm=b.mat.bed; }
      else if(FLG[k]&4){
        /* Roads and paths (#55 item 12). A road — region to region — is worn
           earth, or gravel on the mesa and packed snow in the rime. A path —
           hub to site, or over a ford — lets a third of its columns show the
           ground it crosses, so it reads as fainter than the road it leaves. */
        if(!(FLG[k]&8)&&R()<0.35){ topc=pickPal(b.surf,R); topm=b.mat.surf; }
        else if((FLG[k]&8)&&(b===BIOMES[BIO.MESA]||b===BIOMES[BIO.RIME])){ topc=pickPal(b.soil,R); topm=MAT.PATH; }
        else { topc=pickPal(PAL.TRODDEN,R); topm=MAT.PATH; }
      }
      else if(slope>0.9){ topc=pickPal(b.rock,R); topm=b.mat.rock; }
      else { topc=pickPal(b.surf,R); topm=b.mat.surf; }
      var topk=0.9+R()*0.2;
      TOPI[k]=pos.length/3;
      emit(x,hh-V/2,z,topc,topk,topm);
      /* accumulation: snow and ash settle on whatever faces up */
      if(!(FLG[k]&1)&&!(FLG[k]&4)){
        var acc=(c.w[BIO.RIME]*0.95+c.w[BIO.ASH]*0.5)*(1-clamp(slope/1.1,0,1));
        if(acc>0.40){
          var snowy=c.w[BIO.RIME]>=c.w[BIO.ASH];
          var ac=snowy?pickPal(PAL.SNOWFALL,R):pickPal(PAL.ASHFALL,R), ak=0.9+R()*0.2;
          emit(x,hh+V/2,z,ac,ak,snowy?MAT.SNOW:MAT.ASH);
        }
      }
      var bottom=Math.max(BOT[k],mn);
      for(y=hh-1.5*V;y>bottom-0.001;y-=V){
        var deep=(y<hh-1.25);
        var sc=deep?pickPal(b.rock,R):pickPal(b.soil,R);
        var band=Math.floor(y/0.75)%2;
        var sk=(band?0.94:1.06)*(0.88+R()*0.2);
        emit(x,y,z,sc,sk,deep?b.mat.rock:b.mat.soil);
      }
      /* the underside of an undercut rim, and the floor under it */
      if(BOT[k]>0.01){
        var uc=pickPal(b.rock,R), uk=0.72+R()*0.15;
        emit(x,BOT[k]+V/2,z,uc,uk,b.mat.rock);
        for(var sq=c.sp.length-2;sq>=0;sq--){
          var lt=c.sp[sq][1];
          var lc=pickPal(b.rock,R), lk=0.80+R()*0.18;
          /* The floor under a rim and the course below it: the same entry, the
             lower one a tenth darker. That used to be three floats multiplied
             by 0.9; it is the shade that carries it now. */
          emit(x,lt-V/2,z,lc,lk,b.mat.rock);
          emit(x,lt-1.5*V,z,lc,lk*0.9,b.mat.rock);
        }
      }
    } }
  w.pos = pos; w.pal = pal; w.shd = shd; w.mat = mat;
  w.mpos = mpos; w.mpal = mpal; w.mshd = mshd; w.mmat = mmat; w.TOPI = TOPI;
}
