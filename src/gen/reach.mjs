/**
 * Reach and spawn. Floods the world from the spawn under the movement rules
 * from docs/DECISIONS.md §3 — step, vault, jump, fall — and marks everything
 * the flood never touches. The plate draws that as the traversability overlay;
 * the smoke test asserts on it. A world with a large unreachable fraction is
 * a world with terrain a player cannot use.
 *
 * Sets w.REACH (per cell), w.UNREACH (per voxel column) and w.spawn.
 */
import { V, MOVE, DIRS4, clamp } from './constants.mjs';

export function floodReach(w) {
  var M = w.M, cells = w.cells, half = w.half, trailPath = w.trailPath, ci = w.ci,
      NX = w.NX, NZ = w.NZ, i, j;
  var REACH=new Uint8Array(M*M);
  (function(){
    var st=-1,q;
    for(q=0;q<trailPath.length&&st<0;q++) if(!cells[trailPath[q]].water) st=trailPath[q];
    if(st<0){
      var mid=(M/2)|0;
      for(var rr2=0;rr2<M&&st<0;rr2++)for(var a=1;a<M-1&&st<0;a++)for(var b=1;b<M-1;b++){
        var cq=cells[a*M+b];
        if(!cq.water&&!cq.magma){ st=a*M+b; break; }
      }
    }
    if(st<0) return;
    var queue=[st],head=0; REACH[st]=1;
    function tryMove(from,nx,nz,mid2){
      if(nx<0||nz<0||nx>=M||nz>=M) return;
      var nk=nx*M+nz; if(REACH[nk]) return;
      var cc=cells[from], nc=cells[nk];
      if(nc.magma) return;
      if(nc.water&&(nc.wl-nc.H)>1.5) return;
      if(mid2!==null){
        var mc=cells[mid2];
        if(mc.magma) return;
        if(!(mc.water||mc.H<=cc.H-1)) return;
        if(Math.abs(nc.H-cc.H)>MOVE.step) return;
      } else {
        var dh=nc.H-cc.H;
        if(dh>MOVE.vault||dh< -MOVE.fall) return;
      }
      REACH[nk]=1; queue.push(nk);
    }
    while(head<queue.length){
      var cu=queue[head++], cx=(cu/M)|0, cz=cu%M;
      for(var d3=0;d3<4;d3++){
        var dx=DIRS4[d3][0], dz=DIRS4[d3][1];
        tryMove(cu,cx+dx,cz+dz,null);
        tryMove(cu,cx+dx*2,cz+dz*2,(cx+dx)*M+(cz+dz));
      }
    }
  })();
  var UNREACH=new Uint8Array(NX*NZ);
  for(i=0;i<NX;i++)for(j=0;j<NZ;j++){
    var ux=-half+i*V+V/2, uz=-half+j*V+V/2;
    UNREACH[i*NZ+j]=REACH[ci(ux)*M+ci(uz)]?0:1;
  }
  w.REACH = REACH; w.UNREACH = UNREACH;
}

/** Flat dry ground on the route near the middle, or failing that, anywhere flat. */
export function chooseSpawn(w) {
  var M = w.M, cells = w.cells, half = w.half, trailPath = w.trailPath, R = w.R,
      NX = w.NX, NZ = w.NZ, Hs = w.Hs, FLG = w.FLG, k;
  var spawn=null;
  for(var tp=0;tp<trailPath.length&&!spawn;tp++){
    var tc2=cells[trailPath[tp]];
    if(tc2.water||tc2.magma) continue;
    var tpi=(trailPath[tp]/M)|0, tpj=trailPath[tp]%M;
    if(Math.abs(tpi-M/2)+Math.abs(tpj-M/2)>10) continue;
    spawn=[-half+tpi,tc2.H,-half+tpj];
  }
  for(var tries=0;tries<900&&!spawn;tries++){
    var si=((NX*0.5)|0)+((R()-0.5)*NX*0.4|0), sj=((NZ*0.5)|0)+((R()-0.5)*NZ*0.4|0);
    si=clamp(si,2,NX-3); sj=clamp(sj,2,NZ-3); k=si*NZ+sj;
    if(!FLG[k]&&Math.abs(Hs[k]-Hs[k+NZ])<0.3&&Math.abs(Hs[k]-Hs[k+1])<0.3)
      spawn=[-half+si*V,Hs[k],-half+sj*V];
  }
  if(!spawn) spawn=[0,Hs[((NX/2)|0)*NZ+((NZ/2)|0)],0];
  w.spawn = spawn;
}
