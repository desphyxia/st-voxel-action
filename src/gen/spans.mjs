/**
 * Span columns. A column is a run of solid spans, not one height — which is
 * what lets a tunnel open onto a cliff face and a rim hang over nothing.
 * Caves are cut first, then rims are undercut over them.
 *
 * Both halves of issue #16's correction apply here, one level down from the
 * routes (issue #41):
 *
 *   - The undercut draws are positional, so a rim is undercut because of where
 *     it is and not because of how much of the window was walked to reach it.
 *   - The cliff that causes an undercut is looked up in the *field* when it
 *     falls outside the window, rather than the border ring being skipped. A
 *     rim one metre inside the window edge used to hang over nothing in one
 *     view and sit flush in another.
 *
 * Sets cell.sp for every cell, and w.ovhPos — a sample overhang the plate
 * points its annotation at. The out-of-window neighbour lookup is ground.mjs.
 */
import { DIRS4 } from './constants.mjs';
import { groundCellAt } from './ground.mjs';
import { PASS } from './rng.mjs';

export function cutSpans(w) {
  var M = w.M, cells = w.cells, half = w.half, G = w.G, OX = w.OX, OZ = w.OZ, i, j, d0;
  var ovhPos=null;
  for(i=0;i<M;i++)for(j=0;j<M;j++){
    var cs=cells[i*M+j];
    cs.sp=(cs.water||cs.magma)?[[0,Math.max(cs.H,1)]]:G.spansFor(-half+i+OX,-half+j+OZ,cs.H);
  }
  for(i=0;i<M;i++)for(j=0;j<M;j++){
    var cl=cells[i*M+j], wx=-half+i+OX, wz=-half+j+OZ;
    /* Every draw this cell makes, in the order it makes them. Which directions
       draw at all depends on the neighbours, and those now agree across
       windows, so the sequence does too. */
    var S=G.pstream(PASS.SPAN,wx,wz);
    for(d0=0;d0<4;d0++){
      var ch=groundCellAt(w,wx+DIRS4[d0][0],wz+DIRS4[d0][1]);
      if(ch.H-cl.H<2||ch.water||S()>0.17) continue;
      var out=1+((S()*2)|0), th=(S()<0.5?1:0.75), o;
      for(o=0;o<=out;o++){
        var ti=i-DIRS4[d0][0]*o, tj=j-DIRS4[d0][1]*o;
        /* An undercut that runs off the edge belongs to the next chunk, so it
           is dropped rather than clamped. */
        if(ti<0||tj<0||ti>M-1||tj>M-1) break;
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
