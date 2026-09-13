/**
 * From cells to voxels. sampleGrid resamples the 1 m cell grid onto the 25 cm
 * voxel grid — top height, span bottom, water level, flags. buildVoxels then
 * walks each column down from its surface and emits the boxes.
 *
 * Output is flat arrays: pos (x,y,z per voxel) and col (r,g,b per voxel), plus
 * the same pair for the emissive ones. DEBT: col is still a colour, chosen
 * here. Issue #14 replaces it with a material id and moves the choice of how a
 * material looks to the renderer.
 */
import { V, CEIL, clamp } from './constants.mjs';
import { BIOMES, SNOW, ASHFALL, PATH, pickFrom, rouletteBiome, pushShade, shadeR, shadeG, shadeB }
  from './biomes.mjs';

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
      cellAt = w.cellAt, R = w.R, i, j, k, x, z, c;
  /* voxels */
  var pos=[],col=[],mpos=[],mcol=[],y,hh,mn,slope;
  var TOPI=new Int32Array(NX*NZ);
  for(i=0;i<NX;i++){ x=-half+i*V+V/2;
    for(j=0;j<NZ;j++){ z=-half+j*V+V/2; k=i*NZ+j; hh=Hs[k];
      var n0=i>0?Hs[k-NZ]:hh-2, n1=i<NX-1?Hs[k+NZ]:hh-2,
          n2=j>0?Hs[k-1]:hh-2, n3=j<NZ-1?Hs[k+1]:hh-2;
      mn=Math.min(n0,n1,n2,n3); slope=hh-mn;
      c=cellAt(x,z);
      var b=BIOMES[rouletteBiome(c.w,R)], topc;
      if(FLG[k]&2){ mpos.push(x,hh-V/2,z); pushShade(mcol,R()<0.5?0xff6a1e:0xffa23c,1); topc=0x2b2422; }
      else if(FLG[k]&1) topc=pickFrom(b.bed,R);
      else if(FLG[k]&4) topc=pickFrom(PATH,R);
      else if(slope>0.9) topc=pickFrom(b.rock,R);
      else topc=pickFrom(b.surf,R);
      var topk=0.9+R()*0.2;
      TOPI[k]=pos.length/3;
      pos.push(x,hh-V/2,z); pushShade(col,topc,topk);
      /* accumulation: snow and ash settle on whatever faces up */
      if(!(FLG[k]&1)&&!(FLG[k]&4)){
        var acc=(c.w[4]*0.95+c.w[3]*0.5)*(1-clamp(slope/1.1,0,1));
        if(acc>0.40){
          var ac=c.w[4]>=c.w[3]?pickFrom(SNOW,R):pickFrom(ASHFALL,R), ak=0.9+R()*0.2;
          pos.push(x,hh+V/2,z); pushShade(col,ac,ak);
        }
      }
      var bottom=Math.max(BOT[k],mn);
      for(y=hh-1.5*V;y>bottom-0.001;y-=V){
        var sc=(y<hh-1.25)?pickFrom(b.rock,R):pickFrom(b.soil,R);
        var band=Math.floor(y/0.75)%2;
        var sk=(band?0.94:1.06)*(0.88+R()*0.2);
        pos.push(x,y,z); pushShade(col,sc,sk);
      }
      /* the underside of an undercut rim, and the floor under it */
      if(BOT[k]>0.01){
        var uc=pickFrom(b.rock,R), uk=0.72+R()*0.15;
        pos.push(x,BOT[k]+V/2,z); pushShade(col,uc,uk);
        for(var sq=c.sp.length-2;sq>=0;sq--){
          var lt=c.sp[sq][1];
          var lc=pickFrom(b.rock,R), lk=0.80+R()*0.18;
          var lr=shadeR(lc,lk), lg=shadeG(lc,lk), lb=shadeB(lc,lk);
          pos.push(x,lt-V/2,z); col.push(lr,lg,lb);
          pos.push(x,lt-1.5*V,z); col.push(lr*0.9,lg*0.9,lb*0.9);
        }
      }
    } }
  w.pos = pos; w.col = col; w.mpos = mpos; w.mcol = mcol; w.TOPI = TOPI;
}
