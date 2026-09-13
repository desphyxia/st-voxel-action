/**
 * Grass. One blade cloud per world: position, phase, tint, scale and yaw, all
 * plain arrays for the renderer to instance however it likes. Density, height
 * and colour are blended across the biomes present in the cell, not picked
 * from the dominant one, so a border reads as a gradient.
 */
import { V } from './constants.mjs';
import { BIOMES, shadeR, shadeG, shadeB } from './biomes.mjs';

export function buildGrass(w) {
  var NX = w.NX, NZ = w.NZ, Hs = w.Hs, FLG = w.FLG, half = w.half,
      cellAt = w.cellAt, R = w.R, i, j, k, x, z;
  var gpos=[],gph=[],gtint=[],gsc=[],gyaw=[],gcol=[];
  for(i=0;i<NX;i+=2)for(j=0;j<NZ;j+=2){
    k=i*NZ+j; if(FLG[k]) continue;
    x=-half+i*V+V/2; z=-half+j*V+V/2;
    var n0b=i>0?Hs[k-NZ]:Hs[k], n1b=j>0?Hs[k-1]:Hs[k];
    if(Hs[k]-Math.min(n0b,n1b)>0.6) continue;
    var cq=cellAt(x,z), dsum=0,hbase=0,hvar=0,cr=0,cg=0,cb=0,dry=0;
    for(var q2=0;q2<cq.w.length;q2++){var B2=BIOMES[q2],w2b=cq.w[q2];
      dsum+=w2b*B2.gr.d; hbase+=w2b*B2.gr.h[0]; hvar+=w2b*B2.gr.h[1];
      cr+=w2b*shadeR(B2.gr.c,1); cg+=w2b*shadeG(B2.gr.c,1); cb+=w2b*shadeB(B2.gr.c,1);
    }
    var nb=Math.floor(dsum*3.2); if(R()<dsum*3.2-nb) nb++;
    for(var g2=0;g2<nb;g2++){
      gpos.push(x+(R()-0.5)*0.5,Hs[k],z+(R()-0.5)*0.5);
      gph.push(R()*6.28); gtint.push(R()<0.15?1:0);
      gsc.push(hbase+R()*hvar); gyaw.push(R()*3.14);
      gcol.push(cr,cg,cb);
    }
  }
  w.grass = { p: gpos, ph: gph, ti: gtint, sc: gsc, yw: gyaw, c: gcol };
}
