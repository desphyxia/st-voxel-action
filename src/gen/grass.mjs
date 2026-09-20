/**
 * Grass. One blade cloud per world: position, phase, tint, scale, yaw and two
 * colours, all plain arrays for the renderer to instance however it likes.
 * Density, height and both colours are blended across the biomes present in
 * the cell, not picked from the dominant one, so a border reads as a gradient.
 *
 * The dry colour is the second of those two (issue #39). Every biome row has
 * carried a `gr.dry` since the rows were written and nothing had ever read it:
 * the plate mixed towards one hardcoded uniform — the meadow value — and the
 * playable build did not draw dry blades at all. `dc` is that column, blended
 * exactly the way `c` is, so a dry blade on the mesa is mesa-coloured.
 *
 * Draws are positional (issue #41): a blade cloud belongs to the patch of
 * ground under it, not to the point in the pass where the walk reached it.
 *
 * `cfg.gdens` scales every biome's density at once, so a page can offer the
 * knob without editing the table. It is a *generator* input rather than a
 * rendering one, because how many blades exist is decided here — the renderer
 * can only choose how tall to draw the ones it is given, which is why the two
 * controls in the build behave differently: length is live, density rebuilds.
 * It does not travel on the wire; two players can disagree about how thick
 * their grass is, the way they can disagree about a shadow setting.
 */
import { V } from './constants.mjs';
import { BIOMES, shadeR, shadeG, shadeB } from './biomes.mjs';
import { PASS } from './rng.mjs';

export function buildGrass(w) {
  var NX = w.NX, NZ = w.NZ, Hs = w.Hs, FLG = w.FLG, half = w.half,
      cellAt = w.cellAt, G = w.G, i, j, k, x, z;
  var vx0 = Math.round(w.OX / V), vz0 = Math.round(w.OZ / V);
  var dmul = w.gdens === undefined ? 1 : w.gdens;
  var gpos=[],gph=[],gtint=[],gsc=[],gyaw=[],gcol=[],gdry=[];
  for(i=0;i<NX;i+=2)for(j=0;j<NZ;j+=2){
    k=i*NZ+j; if(FLG[k]) continue;
    x=-half+i*V+V/2; z=-half+j*V+V/2;
    var n0b=i>0?Hs[k-NZ]:Hs[k], n1b=j>0?Hs[k-1]:Hs[k];
    if(Hs[k]-Math.min(n0b,n1b)>0.6) continue;
    var cq=cellAt(x,z), dsum=0,hbase=0,hvar=0,cr=0,cg=0,cb=0,dr=0,dg=0,db=0;
    for(var q2=0;q2<cq.w.length;q2++){var B2=BIOMES[q2],w2b=cq.w[q2];
      dsum+=w2b*B2.gr.d; hbase+=w2b*B2.gr.h[0]; hvar+=w2b*B2.gr.h[1];
      cr+=w2b*shadeR(B2.gr.c,1); cg+=w2b*shadeG(B2.gr.c,1); cb+=w2b*shadeB(B2.gr.c,1);
      dr+=w2b*shadeR(B2.gr.dry,1); dg+=w2b*shadeG(B2.gr.dry,1); db+=w2b*shadeB(B2.gr.dry,1);
    }
    var R=G.pstream(PASS.GRASS,i+vx0,j+vz0);
    var want=dsum*3.2*dmul;
    var nb=Math.floor(want); if(R()<want-nb) nb++;
    for(var g2=0;g2<nb;g2++){
      gpos.push(x+(R()-0.5)*0.5,Hs[k],z+(R()-0.5)*0.5);
      gph.push(R()*6.28); gtint.push(R()<0.15?1:0);
      gsc.push(hbase+R()*hvar); gyaw.push(R()*3.14);
      gcol.push(cr,cg,cb); gdry.push(dr,dg,db);
    }
  }
  w.grass = { p: gpos, ph: gph, ti: gtint, sc: gsc, yw: gyaw, c: gcol, dc: gdry };
}
