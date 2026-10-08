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
  /* layRoutes has already run, so the marked route is known here. */
  var TRAIL = w.TRAIL;
  var ovhPos=null;
  for(i=0;i<M;i++)for(j=0;j<M;j++){
    var cs=cells[i*M+j];
    /* A mesa and its stones are solid rock (#75): a cave in one is a room
       in the wall of a block that is meant to have one way up. */
    /* A bracket shelf with room under it (#76) is the ground and a slab. */
    cs.sp=cs.sporeLo?[[0,cs.sporeLo],[cs.H-1,cs.H]]
         :(cs.water||cs.magma||cs.hold)?[[0,Math.max(cs.H,1)]]:G.spansFor(-half+i+OX,-half+j+OZ,cs.H);
  }
  for(i=0;i<M;i++)for(j=0;j<M;j++){
    var cl=cells[i*M+j], wx=-half+i+OX, wz=-half+j+OZ;
    /* Every draw this cell makes, in the order it makes them. Which directions
       draw at all depends on the neighbours, and those now agree across
       windows, so the sequence does too. */
    var S=G.pstream(PASS.SPAN,wx,wz);
    for(d0=0;d0<4;d0++){
      var ch=groundCellAt(w,wx+DIRS4[d0][0],wz+DIRS4[d0][1]);
      /* Not from a feature's face (#76): a mesa top or a column hung out over
         its foot is a wider top, or a ledge where the gap was meant to be.
         Nor from a glacier's skirt or over a crevasse: a rim hung from the
         skirt is a shelf across the crevasse's end. */
      if(ch.H-cl.H<2||ch.water||ch.hold||ch.rime||ch.spore||ch.glass||ch.hedge||S()>0.17) continue;
      var out=1+((S()*2)|0), th=(S()<0.5?1:0.75), o;
      for(o=0;o<=out;o++){
        var ti=i-DIRS4[d0][0]*o, tj=j-DIRS4[d0][1]*o;
        /* An undercut that runs off the edge belongs to the next chunk, so it
           is dropped rather than clamped. */
        if(ti<0||tj<0||ti>M-1||tj>M-1) break;
        var tc=cells[ti*M+tj];
        /* An undercut stops when it reaches the route. sampleGrid reads the
           *last* span as the column's surface, so a rim thrown over a trail
           made the drawn path jump to the rim's height — three metres, on the
           hero seed, between two cells that were both graded, both marked and
           both at H=5. The route is a cutting whose shoulder was already pulled
           back; hanging the cliff back over it undoes that. */
        /* Nor over magma. sampleGrid reads the last span as the column's top,
           and for magma that top is the liquid's level: rock hung over a seam
           or a basalt pool raised the magma to the rim, and a body standing
           on the rim beside it burned (#76). */
        /* Nor over the weapon site (#7): a lintel hung across the gate's cut, or a
           shelf along the foot of the arena's wall, is a ceiling over the ground the
           site was graded flat to leave open. */
        if(tc.H>=ch.H-1||tc.water||tc.magma||tc.spore||tc.rime||tc.glass||tc.hedge||tc.site||(TRAIL&&TRAIL[ti*M+tj])) break;
        tc.sp.push([ch.H-th,ch.H]);
      }
      if(!ovhPos) ovhPos=[-half+i,cl.H+1.3,-half+j];
      break;
    }
  }
  w.ovhPos = ovhPos;
}
