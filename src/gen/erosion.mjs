/**
 * Erosion. Talus gathers at the foot of a cliff and high banks get cut back,
 * so the macro height field stops looking like noise and starts looking like
 * ground that weather has been at.
 *
 * Rewrites cell heights in place, from a snapshot, so the pass is order-free.
 */
import { CEIL, DIRS4, clamp } from './constants.mjs';

export function erode(w) {
  var M = w.M, cells = w.cells, R = w.R, d0;
  var Hn=new Int16Array(M*M),a,b;
  for(a=0;a<M*M;a++) Hn[a]=cells[a].H;
  for(a=1;a<M-1;a++)for(b=1;b<M-1;b++){
    var c0=cells[a*M+b]; if(c0.water||c0.magma) continue;
    var hi=0,nearW=false;
    for(d0=0;d0<4;d0++){
      var cn=cells[(a+DIRS4[d0][0])*M+(b+DIRS4[d0][1])];
      if(cn.H-c0.H>hi) hi=cn.H-c0.H;
      if(cn.water) nearW=true;
    }
    if(hi>=3&&R()<0.5) Hn[a*M+b]=c0.H+1;
    else if(hi===2&&R()<0.2) Hn[a*M+b]=c0.H+1;
    else if(nearW&&c0.H>=3&&R()<0.3) Hn[a*M+b]=c0.H-1;
  }
  for(a=0;a<M*M;a++) cells[a].H=clamp(Hn[a],0,CEIL);
}
