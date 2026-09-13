/**
 * Routing. The path comes first and the ground is cut for it: two sites are
 * chosen, an A* route is found between them over movement cost, the route is
 * graded until every step is walkable, and only then is the terrain under it
 * pulled into shape. Crossings are placed where a route actually meets water —
 * never scattered over it.
 *
 * Sets w.TRAIL, w.sites, w.bridges, w.trailPath.
 */
import { MOVE, DIRS4 } from './constants.mjs';

/** Cost of stepping from cell a to cell b, or -1 where a player cannot. */
function passCost(a,b){
  if(b.magma) return -1;
  var dh=b.H-a.H;
  if(dh>MOVE.vault) return -1;
  var c=1+(dh>0?dh*3.2:(-dh)*1.1);
  if(b.water) c+=((b.wl-b.H)>MOVE.wade)?34:6;
  if(b.sp&&b.sp.length>1) c+=2;
  return c;
}

export function routeAStar(w,a0,b0,a1,b1){
  var M=w.M, cells=w.cells;
  var N2=M*M,dist=new Float32Array(N2),prev=new Int32Array(N2),seen=new Uint8Array(N2),q;
  for(q=0;q<N2;q++){dist[q]=1e9;prev[q]=-1;}
  var st=a0*M+b0, gl=a1*M+b1, heap=[];
  function push(pr,v){heap.push([pr,v]);var i2=heap.length-1;
    while(i2>0){var pi=(i2-1)>>1;if(heap[pi][0]<=heap[i2][0])break;
      var t=heap[pi];heap[pi]=heap[i2];heap[i2]=t;i2=pi;}}
  function pop(){var top=heap[0],last=heap.pop();
    if(heap.length){heap[0]=last;var i2=0;
      for(;;){var l=i2*2+1,r=l+1,sm=i2;
        if(l<heap.length&&heap[l][0]<heap[sm][0])sm=l;
        if(r<heap.length&&heap[r][0]<heap[sm][0])sm=r;
        if(sm===i2)break;var t=heap[sm];heap[sm]=heap[i2];heap[i2]=t;i2=sm;}}
    return top;}
  dist[st]=0; push(0,st);
  while(heap.length){
    var cu=pop()[1];
    if(seen[cu]) continue; seen[cu]=1;
    if(cu===gl) break;
    var cx=(cu/M)|0, cz=cu%M;
    for(var d1=0;d1<4;d1++){
      var nx=cx+DIRS4[d1][0], nz=cz+DIRS4[d1][1];
      if(nx<1||nz<1||nx>=M-1||nz>=M-1) continue;
      var nk=nx*M+nz; if(seen[nk]) continue;
      var cst=passCost(cells[cu],cells[nk]); if(cst<0) continue;
      var nd=dist[cu]+cst;
      if(nd<dist[nk]){ dist[nk]=nd; prev[nk]=cu; push(nd,nk); }
    }
  }
  if(gl!==st&&prev[gl]<0) return null;
  var path=[],p2=gl,g2=0;
  while(p2>=0&&g2++<5000){ path.push(p2); if(p2===st) break; p2=prev[p2]; }
  return path.reverse();
}

export function layRoutes(w) {
  var M = w.M, cells = w.cells, half = w.half, R = w.R;
  var TRAIL=new Uint8Array(M*M), sites=[], bridges=[], trailPath=[];
  function addBridge(bx,bz,di,dj,len,y){
    if(bridges.length>=2) return;
    for(var q=0;q<bridges.length;q++)
      if(Math.abs(bridges[q][0]-bx)+Math.abs(bridges[q][1]-bz)<6) return;
    bridges.push([bx,bz,di,dj,len,y]);
  }
  function flatAt(pi,pj,r){
    var cp=cells[pi*M+pj]; if(!cp||cp.water||cp.magma) return false;
    for(var a=-r;a<=r;a++)for(var b=-r;b<=r;b++){
      var cq=cells[(pi+a)*M+(pj+b)];
      if(!cq||cq.water||cq.magma||Math.abs(cq.H-cp.H)>1) return false;
    }
    return true;
  }
  function dryFlood(startIdx){
    var seen=new Uint8Array(M*M), q=[startIdx], head=0; seen[startIdx]=1;
    while(head<q.length){
      var cu=q[head++], cx=(cu/M)|0, cz=cu%M;
      for(var d1=0;d1<4;d1++){
        var nx=cx+DIRS4[d1][0], nz=cz+DIRS4[d1][1];
        if(nx<1||nz<1||nx>=M-1||nz>=M-1) continue;
        var nk=nx*M+nz; if(seen[nk]) continue;
        var nc=cells[nk];
        if(nc.water||nc.magma) continue;
        if(Math.abs(nc.H-cells[cu].H)>MOVE.vault) continue;
        seen[nk]=1; q.push(nk);
      }
    }
    return seen;
  }
  (function(){
    var cands=[],a,b;
    for(a=6;a<M-6;a++)for(b=6;b<M-6;b++) if(flatAt(a,b,2)) cands.push(a*M+b);
    if(!cands.length) return;
    var A0=cands[(R()*cands.length)|0], ai=(A0/M)|0, aj=A0%M;
    sites.push([ai,aj]);
    /* the far bank is the interesting second site: reaching it needs a crossing */
    var dry=dryFlood(A0), across=[], apart=[], q1;
    for(q1=0;q1<cands.length;q1++){
      var idx=cands[q1], di=(idx/M)|0, dj=idx%M;
      if(Math.abs(di-ai)+Math.abs(dj-aj)<10) continue;
      if(dry[idx]) apart.push(idx); else across.push(idx);
    }
    var pool=across.length?across:apart;
    if(!pool.length) return;
    /* try a handful: a site whose route has to cross water is the interesting one */
    var bestIdx=-1, bestLen=-1, tries=Math.min(10,pool.length), t2;
    for(t2=0;t2<tries;t2++){
      var cand=pool[(R()*pool.length)|0], rp=routeAStar(w,ai,aj,(cand/M)|0,cand%M);
      if(!rp) continue;
      var wet=0,q2;
      for(q2=0;q2<rp.length;q2++) if(cells[rp[q2]].water) wet++;
      if(wet>0){ bestIdx=cand; break; }
      if(rp.length>bestLen){ bestLen=rp.length; bestIdx=cand; }
    }
    if(bestIdx<0) bestIdx=pool[(R()*pool.length)|0];
    sites.push([(bestIdx/M)|0,bestIdx%M]);
  })();
  function gradePath(path){
    if(!path) return;
    var q,it2,A,B;
    for(it2=0;it2<3;it2++){
      for(q=1;q<path.length;q++){
        A=cells[path[q-1]]; B=cells[path[q]];
        if(A.water||B.water) continue;
        if(B.H-A.H>MOVE.step) B.H=A.H+MOVE.step;
        else if(A.H-B.H>MOVE.step) B.H=A.H-MOVE.step;
      }
      for(q=path.length-2;q>=0;q--){
        A=cells[path[q+1]]; B=cells[path[q]];
        if(A.water||B.water) continue;
        if(B.H-A.H>MOVE.step) B.H=A.H+MOVE.step;
        else if(A.H-B.H>MOVE.step) B.H=A.H-MOVE.step;
      }
    }
    /* pull the shoulders in so the route is a cutting, not a trench */
    for(q=0;q<path.length;q++){
      var pi=(path[q]/M)|0, pj=path[q]%M, hp=cells[path[q]].H;
      for(var d2=0;d2<4;d2++){
        var nc=cells[(pi+DIRS4[d2][0])*M+(pj+DIRS4[d2][1])];
        if(!nc||nc.water||nc.magma) continue;
        if(nc.H-hp>2) nc.H=hp+2; else if(hp-nc.H>2) nc.H=hp-2;
      }
    }
  }
  function markPath(path){
    if(!path) return;
    for(var q=0;q<path.length;q++){
      var pi=(path[q]/M)|0, pj=path[q]%M;
      if(!cells[path[q]].magma) TRAIL[path[q]]=1;
      var pv2=path[q>0?q-1:q], di4=pi-((pv2/M)|0), dj4=pj-(pv2%M);
      var sx=pi+dj4, sz=pj-di4;
      if(sx>0&&sz>0&&sx<M-1&&sz<M-1&&!cells[sx*M+sz].magma) TRAIL[sx*M+sz]=1;
      trailPath.push(path[q]);
    }
    /* a crossing only where the route actually meets water */
    var w=0;
    while(w<path.length){
      if(!cells[path[w]].water){ w++; continue; }
      var st2=w;
      while(w<path.length&&cells[path[w]].water) w++;
      var len=w-st2;
      if(len<=12){
        var pre=path[Math.max(0,st2-1)], post=path[Math.min(path.length-1,w)];
        var pc=cells[pre], qc=cells[post];
        if(!pc.magma&&!qc.magma&&!pc.water&&!qc.water){
          var pi0=(pre/M)|0, pj0=pre%M, pi1=(post/M)|0, pj1=post%M;
          var di=(pi1>pi0)?1:((pi1<pi0)?-1:0), dj=(pj1>pj0)?1:((pj1<pj0)?-1:0);
          if(di&&dj) dj=0;
          if(!di&&!dj) di=1;
          addBridge((pi0+pi1)/2-half,(pj0+pj1)/2-half,di,dj,len+3,
                    Math.max(pc.H,qc.H,cells[path[st2]].wl+0.5));
        }
      }
    }
  }
  function findFord(){
    var best=null,a,b,d1;
    for(a=2;a<M-2;a++)for(b=2;b<M-2;b++){
      var c0=cells[a*M+b];
      if(c0.water||c0.magma) continue;
      for(d1=0;d1<4;d1++){
        var di=DIRS4[d1][0], dj=DIRS4[d1][1], len=0, x2=a+di, z2=b+dj;
        while(x2>1&&z2>1&&x2<M-1&&z2<M-1&&cells[x2*M+z2].water&&len<8){ len++; x2+=di; z2+=dj; }
        if(len<1||len>6) continue;
        var fc=cells[x2*M+z2];
        if(!fc||fc.water||fc.magma||Math.abs(fc.H-c0.H)>1) continue;
        var score=len*10+Math.abs(fc.H-c0.H)-(TRAIL[a*M+b]?25:0);
        if(!best||score<best.score) best={score:score,ai:a,aj:b,bi:x2,bj:z2,di:di,dj:dj,len:len};
      }
    }
    return best;
  }
  (function(){
    var mid=(M/2)|0, r1=null, r2=null, q3;
    if(sites.length>0) r1=routeAStar(w,mid,mid,sites[0][0],sites[0][1]);
    if(sites.length>1) r2=routeAStar(w,sites[0][0],sites[0][1],sites[1][0],sites[1][1]);
    gradePath(r1); gradePath(r2); markPath(r1); markPath(r2);
    if(bridges.length||!sites.length) return;
    var wet=0;
    for(q3=0;q3<M*M;q3++) if(cells[q3].water) wet++;
    if(wet<20) return;
    var fd=findFord();
    if(!fd) return;
    /* bring the route to the near bank, then carry it over */
    var r3=routeAStar(w,sites[0][0],sites[0][1],fd.ai,fd.aj);
    gradePath(r3); markPath(r3);
    for(q3=0;q3<=fd.len+1;q3++){
      var xx=fd.ai+fd.di*q3, zz=fd.aj+fd.dj*q3;
      if(xx<1||zz<1||xx>=M-1||zz>=M-1) break;
      if(!cells[xx*M+zz].magma) TRAIL[xx*M+zz]=1;
    }
    for(q3=1;q3<=3;q3++){
      var fx=fd.bi+fd.di*q3, fz=fd.bj+fd.dj*q3;
      if(fx<1||fz<1||fx>=M-1||fz>=M-1) break;
      if(!cells[fx*M+fz].magma&&!cells[fx*M+fz].water) TRAIL[fx*M+fz]=1;
    }
    addBridge((fd.ai+fd.bi)/2-half,(fd.aj+fd.bj)/2-half,fd.di,fd.dj,fd.len+3,
              Math.max(cells[fd.ai*M+fd.aj].H,cells[fd.bi*M+fd.bj].H,
                       cells[(fd.ai+fd.di)*M+(fd.aj+fd.dj)].wl+0.5));
  })();
  w.TRAIL = TRAIL; w.sites = sites; w.bridges = bridges; w.trailPath = trailPath;
  /* the landmark pass needs the same 'is this ground buildable' test. */
  w.flatAt = flatAt;
}
