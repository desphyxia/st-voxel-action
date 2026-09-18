/**
 * From cells to voxels. sampleGrid resamples the 1 m cell grid onto the 25 cm
 * voxel grid — top height, span bottom, water level, flags. buildVoxels then
 * walks each column down from its surface and emits the boxes.
 *
 * Output is flat arrays: pos (x,y,z per voxel), col (r,g,b per voxel) and mat
 * (one material id per voxel), plus the same three for the emissive ones. Every
 * push into pos is matched by exactly one push into col and one into mat — the
 * three arrays are one record split three ways, and the smoke test checks their
 * lengths agree.
 */
import { V, CEIL, clamp } from './constants.mjs';
import { MAT } from './materials.mjs';
import { BIOMES, SNOW, ASHFALL, PATH, pickFrom, rouletteBiome, pushShade, shadeR, shadeG, shadeB }
  from './biomes.mjs';
import { PASS } from './rng.mjs';

export function sampleGrid(w) {
  var S = w.size, M = w.M, half = w.half, cells = w.cells, cellAt = w.cellAt,
      G = w.G, OX = w.OX, OZ = w.OZ, TRAIL = w.TRAIL, i, j;
  var NX=Math.round(S/V), NZ=NX;
  var Hs=new Float32Array(NX*NZ), BOT=new Float32Array(NX*NZ), WL=new Float32Array(NX*NZ),
      DOM=new Uint8Array(NX*NZ), FLG=new Uint8Array(NX*NZ);
  var x,z,k,c;
  function ci(px){return clamp(Math.round(px+half),0,M-1);}
  for(i=0;i<NX;i++){ x=-half+i*V+V/2;
    for(j=0;j<NZ;j++){ z=-half+j*V+V/2; k=i*NZ+j;
      c=cellAt(x,z);
      var topsp=c.sp[c.sp.length-1];
      var d=c.water?G.detail(x+OX,z+OZ)*0.5:G.detail(x+OX,z+OZ);
      Hs[k]=clamp(topsp[1]+d,0,CEIL); BOT[k]=topsp[0]; WL[k]=c.wl; DOM[k]=c.dom;
      FLG[k]=(c.water?1:0)|(c.magma?2:0)|(TRAIL[ci(x)*M+ci(z)]?4:0);
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
  var pos=[],col=[],mat=[],mpos=[],mcol=[],mmat=[],y,hh,mn,slope;
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
      var b=BIOMES[rouletteBiome(c.w,R)], topc, topm;
      if(FLG[k]&2){ mpos.push(x,hh-V/2,z); pushShade(mcol,R()<0.5?0xff6a1e:0xffa23c,1); mmat.push(MAT.MAGMA);
                    topc=0x2b2422; topm=MAT.ASH; }
      else if(FLG[k]&1){ topc=pickFrom(b.bed,R); topm=b.mat.bed; }
      else if(FLG[k]&4){ topc=pickFrom(PATH,R); topm=MAT.PATH; }
      else if(slope>0.9){ topc=pickFrom(b.rock,R); topm=b.mat.rock; }
      else { topc=pickFrom(b.surf,R); topm=b.mat.surf; }
      var topk=0.9+R()*0.2;
      TOPI[k]=pos.length/3;
      pos.push(x,hh-V/2,z); pushShade(col,topc,topk); mat.push(topm);
      /* accumulation: snow and ash settle on whatever faces up */
      if(!(FLG[k]&1)&&!(FLG[k]&4)){
        var acc=(c.w[4]*0.95+c.w[3]*0.5)*(1-clamp(slope/1.1,0,1));
        if(acc>0.40){
          var snowy=c.w[4]>=c.w[3];
          var ac=snowy?pickFrom(SNOW,R):pickFrom(ASHFALL,R), ak=0.9+R()*0.2;
          pos.push(x,hh+V/2,z); pushShade(col,ac,ak); mat.push(snowy?MAT.SNOW:MAT.ASH);
        }
      }
      var bottom=Math.max(BOT[k],mn);
      for(y=hh-1.5*V;y>bottom-0.001;y-=V){
        var deep=(y<hh-1.25);
        var sc=deep?pickFrom(b.rock,R):pickFrom(b.soil,R);
        var band=Math.floor(y/0.75)%2;
        var sk=(band?0.94:1.06)*(0.88+R()*0.2);
        pos.push(x,y,z); pushShade(col,sc,sk); mat.push(deep?b.mat.rock:b.mat.soil);
      }
      /* the underside of an undercut rim, and the floor under it */
      if(BOT[k]>0.01){
        var uc=pickFrom(b.rock,R), uk=0.72+R()*0.15;
        pos.push(x,BOT[k]+V/2,z); pushShade(col,uc,uk); mat.push(b.mat.rock);
        for(var sq=c.sp.length-2;sq>=0;sq--){
          var lt=c.sp[sq][1];
          var lc=pickFrom(b.rock,R), lk=0.80+R()*0.18;
          var lr=shadeR(lc,lk), lg=shadeG(lc,lk), lb=shadeB(lc,lk);
          pos.push(x,lt-V/2,z); col.push(lr,lg,lb); mat.push(b.mat.rock);
          pos.push(x,lt-1.5*V,z); col.push(lr*0.9,lg*0.9,lb*0.9); mat.push(b.mat.rock);
        }
      }
    } }
  w.pos = pos; w.col = col; w.mat = mat;
  w.mpos = mpos; w.mcol = mcol; w.mmat = mmat; w.TOPI = TOPI;
}
