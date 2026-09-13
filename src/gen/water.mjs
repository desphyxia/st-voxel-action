/**
 * Water. Three passes that share one rule: water goes where the ground lets it.
 *
 *   fillWaterTable       hollows flood until they spill
 *   flowField            one downhill vector per cell, shared by water and foam
 *   buildWaterGeometry   the surface quads, shore foam and vertical falls
 *
 * The geometry is plain vertex, index and per-vertex attribute arrays — depth,
 * foam and flow — and no renderer object of any kind.
 */
import { V, DIRS4, clamp } from './constants.mjs';

export function fillWaterTable(w) {
  var M = w.M, cells = w.cells, i, j, d0;
  for(var it=0;it<4;it++){
    var changed=0;
    for(i=1;i<M-1;i++)for(j=1;j<M-1;j++){
      var cw2=cells[i*M+j]; if(cw2.water||cw2.magma) continue;
      var best=0,walls=0,spill=false;
      for(d0=0;d0<4;d0++){
        var cn2=cells[(i+DIRS4[d0][0])*M+(j+DIRS4[d0][1])];
        if(cn2.water){ if(cn2.wl>cw2.H+0.75&&cn2.wl>best) best=cn2.wl; }
        else if(cn2.H>=cw2.H+1) walls++;
        else if(cn2.H<cw2.H) spill=true;
      }
      /* a hollow fills; a plain drains */
      if(best>0&&walls>=2&&!spill){
        cw2.water=true; cw2.pond=true; cw2.wl=best; cw2.sp=[[0,Math.max(cw2.H,1)]]; changed++;
      }
    }
    if(!changed) break;
  }
}

export function flowField(w) {
  var M = w.M, cells = w.cells, i, j;
  for(i=0;i<M;i++)for(j=0;j<M;j++){
    var cf=cells[i*M+j];
    var hl=cells[(i>0?i-1:i)*M+j], hr=cells[(i<M-1?i+1:i)*M+j],
        hb=cells[i*M+(j>0?j-1:j)], hf=cells[i*M+(j<M-1?j+1:j)];
    var gx=(cf.water?(hl.wl||hl.H)-(hr.wl||hr.H):hl.H-hr.H),
        gz=(cf.water?(hb.wl||hb.H)-(hf.wl||hf.H):hb.H-hf.H);
    var gl=Math.hypot(gx,gz);
    if(gl<0.001){ cf.fx=0.7; cf.fz=0.7; } else { cf.fx=-gx/gl; cf.fz=-gz/gl; }
  }
}

export function buildWaterGeometry(w) {
  var NX = w.NX, NZ = w.NZ, Hs = w.Hs, WL = w.WL, FLG = w.FLG, half = w.half,
      cellAt = w.cellAt, i, j, k, x, z, y;
  var wv=[],wi=[],wd=[],wf=[],wfl=[],wn=0;
  function wquad(q,dep,foam,fx,fz){
    for(var a=0;a<4;a++){ wv.push(q[a*3],q[a*3+1],q[a*3+2]); wd.push(dep); wf.push(foam); wfl.push(fx,fz); }
    wi.push(wn,wn+2,wn+1, wn,wn+3,wn+2); wn+=4;
  }
  var WDIR=[[1,0],[-1,0],[0,1],[0,-1]];
  for(i=1;i<NX-1;i++)for(j=1;j<NZ-1;j++){
    k=i*NZ+j; if(!(FLG[k]&1)) continue;
    x=-half+i*V; z=-half+j*V; y=WL[k];
    var bsum=0,bn=0;
    for(var bi2=-2;bi2<=2;bi2++)for(var bj2=-2;bj2<=2;bj2++){
      var kb=(i+bi2)*NZ+(j+bj2);
      if(kb<0||kb>=NX*NZ) continue;
      bsum+=Hs[kb]; bn++;
    }
    var dep=clamp((y-bsum/bn)/1.6,0,1), foam=0, fx=0, fz=0, dd2;
    for(dd2=0;dd2<4;dd2++){
      var kn=(i+WDIR[dd2][0])*NZ+(j+WDIR[dd2][1]);
      if(FLG[kn]&1){
        var dy=WL[kn]-y;
        if(dy<-0.35){ fx+=WDIR[dd2][0]*-dy; fz+=WDIR[dd2][1]*-dy; foam=Math.max(foam,1); }
        else if(dy>0.35) foam=Math.max(foam,1);
        else { fx+=WDIR[dd2][0]*0.04; fz+=WDIR[dd2][1]*0.04; }
      } else {
        if(Hs[kn]>y-0.1) foam=Math.max(foam,1);
        else { fx+=WDIR[dd2][0]*0.5; fz+=WDIR[dd2][1]*0.5; foam=Math.max(foam,1); }
      }
    }
    var cfw=cellAt(x,z); fx=cfw.fx; fz=cfw.fz;
    wquad([x,y,z, x+V,y,z, x+V,y,z+V, x,y,z+V],dep,foam,fx,fz);
    /* vertical sheets wherever the surface steps down */
    for(dd2=0;dd2<4;dd2++){
      var di3=WDIR[dd2][0], dj3=WDIR[dd2][1], kn2=(i+di3)*NZ+(j+dj3);
      var yl=(FLG[kn2]&1)?WL[kn2]:Hs[kn2];
      if(yl>y-0.4) continue;
      var q2;
      if(di3===1) q2=[x+V,y,z, x+V,y,z+V, x+V,yl,z+V, x+V,yl,z];
      else if(di3===-1) q2=[x,y,z, x,y,z+V, x,yl,z+V, x,yl,z];
      else if(dj3===1) q2=[x,y,z+V, x+V,y,z+V, x+V,yl,z+V, x,yl,z+V];
      else q2=[x,y,z, x+V,y,z, x+V,yl,z, x,yl,z];
      wquad(q2,1,2,di3,dj3);
    }
  }
  w.water = { v: wv, i: wi, d: wd, f: wf, fl: wfl };
}
