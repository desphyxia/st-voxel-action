/**
 * Span columns. A column is a run of solid spans, not one height — which is
 * what lets a tunnel open onto a cliff face and a rim hang over nothing.
 * Caves are cut first, then rims are undercut over them.
 *
 * Sets cell.sp for every cell, and w.ovhPos — a sample overhang the plate
 * points its annotation at.
 */
import { DIRS4 } from './constants.mjs';

export function cutSpans(w) {
  var M = w.M, cells = w.cells, half = w.half, G = w.G, OX = w.OX, OZ = w.OZ, R = w.R, i, j, d0;
  var ovhPos=null;
  for(i=0;i<M;i++)for(j=0;j<M;j++){
    var cs=cells[i*M+j];
    cs.sp=(cs.water||cs.magma)?[[0,Math.max(cs.H,1)]]:G.spansFor(-half+i+OX,-half+j+OZ,cs.H);
  }
  for(i=1;i<M-1;i++)for(j=1;j<M-1;j++){
    var cl=cells[i*M+j];
    for(d0=0;d0<4;d0++){
      var ch=cells[(i+DIRS4[d0][0])*M+(j+DIRS4[d0][1])];
      if(ch.H-cl.H<2||ch.water||R()>0.17) continue;
      var out=1+((R()*2)|0), th=(R()<0.5?1:0.75), o;
      for(o=0;o<=out;o++){
        var ti=i-DIRS4[d0][0]*o, tj=j-DIRS4[d0][1]*o;
        if(ti<1||tj<1||ti>=M-1||tj>=M-1) break;
        var tc=cells[ti*M+tj];
        if(tc.H>=ch.H-1||tc.water) break;
        tc.sp.push([ch.H-th,ch.H]);
      }
      if(!ovhPos) ovhPos=[-half+i,cl.H+1.3,-half+j];
      break;
    }
  }
  w.ovhPos = ovhPos;
}
