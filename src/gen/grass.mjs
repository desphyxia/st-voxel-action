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

/* ---------- patches (#55 item 14) ----------
   A field of grass one colour is a carpet. Two smooth positional fields, a
   few metres across, put clusters in it: wildflowers in meadow, and patches
   gone dry or autumnal everywhere else. Value noise from integer hashing —
   no sin, like everything in src/gen — keyed on the seed word and the world
   metre, so a patch is the same from every window that sees it. */
const PATCH = 7;
const FLOWERS = [[0.95, 0.86, 0.35], [0.95, 0.94, 0.90], [0.66, 0.52, 0.86], [0.93, 0.56, 0.66]];
function patchHash(sw, a, b, salt) {
  var h = Math.imul(sw ^ Math.imul(a, 0x27d4eb2d) ^ Math.imul(b, 0x165667b1) ^ salt, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function patchField(sw, x, z, salt) {
  var fx = x / PATCH, fz = z / PATCH, a = Math.floor(fx), b = Math.floor(fz);
  var u = fx - a, v = fz - b;
  u = u * u * (3 - 2 * u); v = v * v * (3 - 2 * v);
  var p00 = patchHash(sw, a, b, salt), p10 = patchHash(sw, a + 1, b, salt),
      p01 = patchHash(sw, a, b + 1, salt), p11 = patchHash(sw, a + 1, b + 1, salt);
  return (p00 + (p10 - p00) * u) + ((p01 + (p11 - p01) * u) - (p00 + (p10 - p00) * u)) * v;
}

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
    /* Where this cell sits in the two patch fields, by world metre. */
    var wmx=Math.floor(x+w.OX), wmz=Math.floor(z+w.OZ), sw=G.sw|0;
    var bloom=cq.w[0]>0.45?patchField(sw,wmx,wmz,0x5f1):0;
    var turn=(cq.w[4]||0)>0.5?0:patchField(sw,wmx,wmz,0x2a7);
    var flowerK=bloom>0.66?(bloom-0.66)/0.34:0, autumnK=turn>0.68?(turn-0.68)/0.32:0;
    var nb=Math.floor(want); if(R()<want-nb) nb++;
    for(var g2=0;g2<nb;g2++){
      gpos.push(x+(R()-0.5)*0.5,Hs[k],z+(R()-0.5)*0.5);
      gph.push(R()*6.28); gtint.push(R()<0.15+autumnK*0.45?1:0);
      gsc.push(hbase+R()*hvar); gyaw.push(R()*3.14);
      if(flowerK>0&&R()<flowerK*0.45){
        var fl=FLOWERS[(R()*FLOWERS.length)|0];
        gcol.push(fl[0],fl[1],fl[2]);
      } else if(autumnK>0){
        var ak=autumnK*0.45;
        gcol.push(cr+(dr-cr)*ak,cg+(dg-cg)*ak,cb+(db-cb)*ak);
      } else gcol.push(cr,cg,cb);
      gdry.push(dr,dg,db);
    }
  }
  w.grass = { p: gpos, ph: gph, ti: gtint, sc: gsc, yw: gyaw, c: gcol, dc: gdry };
}
