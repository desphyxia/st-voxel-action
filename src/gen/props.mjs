/**
 * Props: everything stamped onto the surface after the ground is final —
 * trees, boulders, natural arcs, scree, clutter, the ruin and holding on the
 * routed sites, lamps along the trail, deck bridges, and one landmark tall
 * enough to see from three chunks away.
 *
 * makeStamps(w) builds the kit once per world; the kit closes over the voxel
 * arrays, so a stamp is a call and not a mesh. Everything lands on the 25 cm
 * grid, and nothing here knows what a renderer is.
 */
import { V, DIRS4, clamp } from './constants.mjs';
import { BIOMES, pickFrom, pushShade } from './biomes.mjs';

/** The stamp kit for one world: pure geometry, pushed into w's voxel arrays. */
export function makeStamps(w) {
  var R = w.R, pos = w.pos, col = w.col, mpos = w.mpos, mcol = w.mcol,
      half = w.half, NX = w.NX, NZ = w.NZ, Hs = w.Hs, FLG = w.FLG, y;
  function addVox(px,py,pz,hex,k2){ pos.push(Math.round(px/V)*V,Math.round(py/V)*V,Math.round(pz/V)*V); pushShade(col,hex,k2); }
  function surfAt(px,pz){var i2=clamp(Math.round((px+half)/V),0,NX-1),j2=clamp(Math.round((pz+half)/V),0,NZ-1);var k2=i2*NZ+j2;return {y:Hs[k2],f:FLG[k2]};}
  function tree(px,pz,b,t){
    var s=surfAt(px,pz); if(s.f) return; var y0=s.y;
    var th, r, ax, ay, az;
    if(t==='conifer'){
      th=3+R()*2;
      for(y=0;y<th;y+=V) addVox(px,y0+y,pz,b.k==='frost'?0x4a4038:0x4a3a2c,0.9+R()*0.2);
      for(var lv=0;lv<5;lv++){
        var ly=y0+th*0.35+lv*(th*0.15), lr=(1.5-lv*0.24);
        for(ax=-lr;ax<=lr;ax+=V)for(az=-lr;az<=lr;az+=V){
          if(ax*ax+az*az>lr*lr) continue;
          addVox(px+ax,ly,pz+az,(b.k==='frost'&&R()<0.45)?0xdfe7ee:(R()<0.5?0x2f5233:0x3c6b3e),0.85+R()*0.3);
        }
      }
    } else if(t==='scrub'){
      th=1+R()*1.2;
      for(y=0;y<th;y+=V) addVox(px,y0+y,pz,0x6b5233,0.9+R()*0.2);
      r=0.7+R()*0.4;
      for(ax=-r;ax<=r;ax+=V)for(ay=-r*0.5;ay<=r*0.6;ay+=V)for(az=-r;az<=r;az+=V){
        if((ax*ax+az*az)/(r*r)+(ay*ay)/(r*r*0.5)>1-R()*0.3) continue;
        addVox(px+ax,y0+th+ay,pz+az,R()<0.5?0x6f7f42:0x87904a,0.85+R()*0.3);
      }
    } else if(t==='snag'){
      th=2.5+R()*1.8;
      for(y=0;y<th;y+=V) addVox(px+(y>th*0.6?V:0),y0+y,pz,R()<0.5?0x2e2825:0x3a322e,0.85+R()*0.25);
      for(var br=0;br<3;br++){var bl=0.5+R()*0.7,dirx=R()<0.5?1:-1,by=y0+th*(0.55+br*0.15);
        for(var t2=0;t2<bl;t2+=V) addVox(px+dirx*t2,by+t2*0.4,pz+(R()-0.5)*0.3,0x332b27,0.9);}
    } else {
      th=2.5+R()*1.5;
      for(y=0;y<th;y+=V)for(ax=-V;ax<=V;ax+=V)for(az=-V;az<=V;az+=V)
        if(Math.abs(ax)+Math.abs(az)<=V) addVox(px+ax,y0+y,pz+az,0x5a4130,0.85+R()*0.3);
      r=1.1+R()*0.55;
      for(ax=-r;ax<=r;ax+=V)for(ay=-r*0.8;ay<=r*0.8;ay+=V)for(az=-r;az<=r;az+=V){
        if((ax*ax+az*az)/(r*r)+(ay*ay)/(r*r*0.68)>1-R()*0.28) continue;
        addVox(px+ax,y0+th+r*0.5+ay,pz+az,R()<0.15?0x8ea84b:(R()<0.5?0x4f7a3a:0x628f45),0.8+R()*0.35);
      }
    }
  }
  function boulder(px,pz,r,b){
    var s=surfAt(px,pz); if(s.f&1) return; var y0=s.y;
    for(var ax=-r;ax<=r;ax+=V)for(var ay=-r*0.6;ay<=r*0.8;ay+=V)for(var az=-r;az<=r;az+=V){
      if((ax*ax+az*az)/(r*r)+(ay*ay)/(r*r*0.8)>1-R()*0.18) continue;
      addVox(px+ax,y0+r*0.45+ay,pz+az,pickFrom(b.rock,R),0.85+R()*0.3);
    }
  }
  function scree(px,pz,dom,n){
    for(var q=0;q<n;q++){
      var sx=px+(R()-0.5)*2.4, sz=pz+(R()-0.5)*2.4, s=surfAt(sx,sz); if(s.f&1) continue;
      var n2=(R()<0.3)?2:1;
      for(var a=0;a<n2;a++)for(var b=0;b<n2;b++)for(var c2=0;c2<n2;c2++)
        addVox(sx+a*V,s.y+c2*V+V/2,sz+b*V,pickFrom(BIOMES[dom].rock,R),0.8+R()*0.3);
    }
  }
  function bush(px,pz,dom){
    var s=surfAt(px,pz); if(s.f) return;
    var r=0.35+R()*0.35;
    var cols=(dom===4)?[0x6f8390,0x8aa3ad]:(dom===3?[0x3b332e,0x4a403a]:(dom===1?[0x6f7f42,0x87904a]:[0x3f6b34,0x4e7d3e,0x5d8c46]));
    for(var ax=-r;ax<=r;ax+=V)for(var ay=0;ay<=r*1.5;ay+=V)for(var az=-r;az<=r;az+=V){
      if((ax*ax+az*az)/(r*r)+((ay-r*0.65)*(ay-r*0.65))/(r*r*0.65)>1-R()*0.3) continue;
      addVox(px+ax,s.y+ay+V/2,pz+az,pickFrom(cols,R),0.85+R()*0.3);
    }
  }
  function stump(px,pz){
    var s=surfAt(px,pz); if(s.f) return;
    for(var y2=0;y2<0.55;y2+=V)for(var ax=-V;ax<=V;ax+=V)for(var az=-V;az<=V;az+=V)
      if(Math.abs(ax)+Math.abs(az)<=V)
        addVox(px+ax,s.y+y2+V/2,pz+az,(y2>0.3&&ax===0&&az===0)?0x8a6a4a:0x5a4130,0.9+R()*0.2);
  }
  function fallenTrunk(px,pz){
    var s0=surfAt(px,pz); if(s0.f) return;
    var ang=R()*Math.PI, dx=Math.cos(ang), dz=Math.sin(ang), L=2+R()*2.2;
    for(var t2=-L/2;t2<=L/2;t2+=V)for(var ay=0;ay<=0.55;ay+=V)for(var b=-0.3;b<=0.3;b+=V){
      if((ay-0.28)*(ay-0.28)+b*b>0.082) continue;
      addVox(px+dx*t2-dz*b,s0.y+ay+V/2,pz+dz*t2+dx*b,R()<0.2?0x6b5a45:0x4c3728,0.85+R()*0.25);
    }
  }
  function fence(px,pz,ang,len){
    var dx=Math.cos(ang),dz=Math.sin(ang);
    for(var t2=0;t2<=len;t2+=1){
      var xx=px+dx*t2, zz=pz+dz*t2, s=surfAt(xx,zz); if(s.f&1) continue;
      for(var y2=0;y2<1.0;y2+=V) addVox(xx,s.y+y2+V/2,zz,0x6b5a45,0.9+R()*0.2);
      if(t2<len) for(var u=0;u<1;u+=V){
        addVox(xx+dx*u,s.y+0.8,zz+dz*u,0x5f5040,0.95);
        addVox(xx+dx*u,s.y+0.4,zz+dz*u,0x5f5040,0.95);
      }
    }
  }
  function lamp(px,pz){
    var s=surfAt(px,pz); if(s.f) return null;
    for(var y2=0;y2<2.5;y2+=V) addVox(px,s.y+y2+V/2,pz,0x3f4650,0.9+R()*0.15);
    addVox(px+V,s.y+2.5,pz,0x3f4650,0.95); addVox(px+2*V,s.y+2.5,pz,0x3f4650,0.95);
    var lx=Math.round((px+2*V)/V)*V, ly=Math.round((s.y+2.25)/V)*V;
    mpos.push(lx,ly,pz); pushShade(mcol,0xffd08a,1);
    return [lx,ly,pz];
  }
  function wallRun(px,pz,ang,len,h,dom){
    var dx=Math.cos(ang),dz=Math.sin(ang);
    for(var t2=0;t2<=len;t2+=V){
      if(R()<0.05){ t2+=0.75; continue; }
      var xx=px+dx*t2, zz=pz+dz*t2, s=surfAt(xx,zz); if(s.f&1) continue;
      var hh2=h*(0.55+0.45*Math.abs(Math.sin(t2*0.7)));
      for(var y2=0;y2<hh2;y2+=V)for(var b=-0.25;b<=0.25;b+=V)
        addVox(xx-dz*b,s.y+y2+V/2,zz+dx*b,pickFrom(BIOMES[dom].rock,R),0.9+R()*0.2);
    }
  }
  function pillarRuin(px,pz,h,dom){
    var s=surfAt(px,pz); if(s.f) return;
    for(var b1=-0.5;b1<=0.5;b1+=V)for(var b2=-0.5;b2<=0.5;b2+=V)
      addVox(px+b1,s.y+V/2,pz+b2,pickFrom(BIOMES[dom].rock,R),0.95);
    for(var y2=V;y2<h;y2+=V){
      var rr2=(y2>h-0.6&&R()<0.5)?0.25:0.375;
      for(var a1=-rr2;a1<=rr2;a1+=V)for(var a2=-rr2;a2<=rr2;a2+=V)
        addVox(px+a1,s.y+y2+V/2,pz+a2,pickFrom(BIOMES[dom].rock,R),0.88+R()*0.22);
    }
  }
  function hut(px,pz,dom){
    var s=surfAt(px,pz); if(s.f) return;
    var w=3.0,h=2.25;
    for(var a=-w/2;a<=w/2;a+=V)for(var b=-w/2;b<=w/2;b+=V){
      if(Math.abs(a)<w/2-V&&Math.abs(b)<w/2-V) continue;
      if(a>-0.6&&a<0.6&&b>w/2-V) continue;
      var hh2=h*(R()<0.22?0.45+R()*0.4:1);
      for(var y2=0;y2<hh2;y2+=V) addVox(px+a,s.y+y2+V/2,pz+b,pickFrom(BIOMES[dom].rock,R),0.88+R()*0.2);
    }
    for(var a2=-w/2;a2<=w/2;a2+=V)for(var b2=-w/2;b2<=w/2;b2+=V)
      if(R()<0.3) addVox(px+a2,s.y+h+V/2,pz+b2,0x5a4130,0.9);
  }
  function deckBridge(px,pz,di,dj,len,y){
    for(var t2=-len/2;t2<=len/2;t2+=V)for(var b=-0.75;b<=0.75;b+=V)
      addVox(px+di*t2-dj*b,y,pz+dj*t2+di*b,R()<0.25?0x6b5a45:0x5a4a38,0.9+R()*0.2);
    for(var side=-1;side<=1;side+=2)for(var t3=-len/2;t3<=len/2;t3+=0.5)
      addVox(px+di*t3-dj*side*0.75,y+0.5,pz+dj*t3+di*side*0.75,0x4c3f30,0.95);
  }
  return { addVox: addVox, surfAt: surfAt, tree: tree, boulder: boulder, scree: scree,
           bush: bush, stump: stump, fallenTrunk: fallenTrunk, fence: fence, lamp: lamp,
           wallRun: wallRun, pillarRuin: pillarRuin, hut: hut, deckBridge: deckBridge };
}

/** Trees, boulders and the arcs that span a canyon. */
export function scatterProps(w, kit) {
  var M = w.M, cells = w.cells, half = w.half, R = w.R, G = w.G, OX = w.OX, OZ = w.OZ,
      addVox = kit.addVox, tree = kit.tree, boulder = kit.boulder, i, j;
  var treeN=0, arcs=0;
  for(i=0;i<M;i+=2)for(j=0;j<M;j+=2){
    var cc=cells[i*M+j], px=-half+i+ (R()-0.5)*1.2, pz=-half+j+(R()-0.5)*1.2;
    var bb=BIOMES[cc.dom], dens=G.wsum(cc.w,'tree')||0;
    var td=0; for(var q=0;q<cc.w.length;q++) td+=cc.w[q]*BIOMES[q].tree.d;
    if(!cc.water&&!cc.magma&&R()<td*0.095&&treeN<260){ tree(px,pz,bb,bb.tree.t); treeN++; }
    else if(!cc.water&&R()<0.028) boulder(px,pz,0.5+R()*0.8,bb);
    /* arcs where a canyon crosses rock-heavy ground */
    if(arcs<3&&cc.canyon&&cc.canyon.d<0.6&&cc.cw>0.5&&R()<0.09){
      var span=cc.canyon.w+2+Math.floor(R()*2), rise=3+Math.floor(R()*3);
      var e=0.75, gx=G.canyonAt(px+OX+e,pz+OZ).d-G.canyonAt(px+OX-e,pz+OZ).d, gz=G.canyonAt(px+OX,pz+OZ+e).d-G.canyonAt(px+OX,pz+OZ-e).d;
      var L=Math.hypot(gx,gz)||1; gx/=L; gz/=L;
      var base=Math.max(0,cc.H);
      for(var t3=0;t3<=1.0001;t3+=0.01){
        var ox2=(t3-0.5)*span, yy=base+Math.sin(Math.PI*t3)*rise;
        var cxp=px+gx*ox2, czp=pz+gz*ox2;
        var thick=0.5+0.5*(1-Math.sin(Math.PI*t3));
        for(var w2=-0.75;w2<=0.75;w2+=V)for(var dy=-thick;dy<=thick*0.4;dy+=V)
          addVox(cxp-gz*w2,yy+dy,czp+gx*w2,pickFrom(BIOMES[cc.dom].rock,R),0.9+R()*0.2);
      }
      arcs++;
    }
  }
}

/** Scree at every cliff foot, clutter off the trails, the sites, lamps, crossings. */
export function placeClutter(w, kit) {
  var M = w.M, cells = w.cells, half = w.half, R = w.R, TRAIL = w.TRAIL, sites = w.sites,
      bridges = w.bridges, scree = kit.scree, bush = kit.bush, stump = kit.stump,
      fallenTrunk = kit.fallenTrunk, fence = kit.fence, lamp = kit.lamp,
      wallRun = kit.wallRun, pillarRuin = kit.pillarRuin, hut = kit.hut,
      deckBridge = kit.deckBridge, i, j;
  var lamps=[];
  for(i=2;i<M-2;i++)for(j=2;j<M-2;j++){
    var c0=cells[i*M+j], px0=-half+i, pz0=-half+j;
    for(var dd=0;dd<4;dd++){
      var di=DIRS4[dd][0], dj=DIRS4[dd][1], c1=cells[(i+di)*M+(j+dj)];
      if(!c1||c0.H-c1.H<2) continue;
      if(R()<0.32) scree(px0+di*1.7,pz0+dj*1.7,c1.dom,2+((R()*4)|0));
      break;
    }
  }
  /* scattered clutter, kept off the trails */
  for(i=1;i<M-1;i++)for(j=1;j<M-1;j++){
    var cc2=cells[i*M+j];
    if(cc2.water||cc2.magma||TRAIL[i*M+j]) continue;
    var px2=-half+i+(R()-0.5)*0.8, pz2=-half+j+(R()-0.5)*0.8, dm=cc2.dom, rv=R();
    if(rv<0.032) bush(px2,pz2,dm);
    else if(rv<0.0365&&(dm===0||dm===2)) stump(px2,pz2);
    else if(rv<0.0405&&(dm===0||dm===2)) fallenTrunk(px2,pz2);
    else if(rv<0.050) scree(px2,pz2,dm,2+((R()*3)|0));
  }
  /* a ruin and a holding on the sites the trails were routed to */
  for(var ps=0;ps<sites.length;ps++){
    var pi=sites[ps][0], pj=sites[ps][1], cp=cells[pi*M+pj];
    var px3=-half+pi, pz3=-half+pj, ang3=R()*6.28, dm3=cp.dom;
    if(ps===0){
      for(var q3=0;q3<4;q3++) pillarRuin(px3+Math.cos(ang3)*(q3*2-3),pz3+Math.sin(ang3)*(q3*2-3),2+R()*2,dm3);
      wallRun(px3-Math.sin(ang3)*2.5,pz3+Math.cos(ang3)*2.5,ang3,7,1.5,dm3);
      scree(px3,pz3,dm3,8);
    } else {
      hut(px3,pz3,dm3);
      fence(px3+2.5,pz3-3,ang3,6);
    }
  }
  /* lamps stand along the route, not scattered over the field */
  var trailCells=[];
  for(i=2;i<M-2;i++)for(j=2;j<M-2;j++)
    if(TRAIL[i*M+j]&&!cells[i*M+j].water) trailCells.push([i,j]);
  for(var lq=0;lq<3&&trailCells.length;lq++){
    var tcq=trailCells[Math.floor((lq+0.5)/3*trailCells.length)];
    var lp=lamp(-half+tcq[0]+0.6,-half+tcq[1]+0.6);
    if(lp) lamps.push(lp);
  }
  /* crossings, placed where the route meets water */
  for(var bq=0;bq<bridges.length;bq++){
    var bd=bridges[bq];
    deckBridge(bd[0],bd[1],bd[2],bd[3],bd[4],bd[5]);
  }
  w.lamps = lamps;
}

/** One landmark per region, on the highest flat ground that is not a trail. */
export function placeLandmark(w, kit) {
  var M = w.M, cells = w.cells, half = w.half, R = w.R, TRAIL = w.TRAIL,
      OX = w.OX, OZ = w.OZ, mpos = w.mpos, mcol = w.mcol,
      addVox = kit.addVox, flatAt = w.flatAt;
  var lmPos=null;
  function landmarkStamp(px,pz,kind,dom,base){
    var a,b,y2,r2;
    if(kind===0){                                   /* obelisk */
      for(a=-1;a<=1;a+=V)for(b=-1;b<=1;b+=V) addVox(px+a,base+V/2,pz+b,pickFrom(BIOMES[dom].rock,R),0.9+R()*0.2);
      for(y2=V;y2<11;y2+=V){
        r2=0.5*(1-y2/16);
        for(a=-r2;a<=r2;a+=V)for(b=-r2;b<=r2;b+=V)
          addVox(px+a,base+y2+V/2,pz+b,pickFrom(BIOMES[dom].rock,R),0.85+R()*0.25);
      }
      mpos.push(Math.round(px/V)*V,Math.round((base+11.2)/V)*V,Math.round(pz/V)*V);
      pushShade(mcol,0x9fe3ff,1);
    } else if(kind===1){                            /* hive tree */
      for(y2=0;y2<8;y2+=V)for(a=-0.5;a<=0.5;a+=V)for(b=-0.5;b<=0.5;b+=V)
        if(a*a+b*b<0.3) addVox(px+a,base+y2+V/2,pz+b,R()<0.2?0x6b5a45:0x4c3728,0.85+R()*0.25);
      r2=3.2;
      for(a=-r2;a<=r2;a+=V)for(y2=-2.2;y2<=2.2;y2+=V)for(b=-r2;b<=r2;b+=V){
        if((a*a+b*b)/(r2*r2)+(y2*y2)/5.5>1-R()*0.25) continue;
        addVox(px+a,base+8.5+y2,pz+b,R()<0.1?0xb7d84f:(R()<0.5?0x3f6630:0x507f3c),0.8+R()*0.35);
      }
      for(var hq=0;hq<7;hq++){
        mpos.push(Math.round((px+(R()-0.5)*5)/V)*V,Math.round((base+7.5+R()*3)/V)*V,Math.round((pz+(R()-0.5)*5)/V)*V);
        pushShade(mcol,0xb7f04f,1);
      }
    } else if(kind===2){                            /* wrecked machine */
      for(var sl=0;sl<3;sl++){
        var ax2=Math.cos(sl*2.1), az2=Math.sin(sl*2.1);
        for(var t4=0;t4<6;t4+=V)for(b=-0.9;b<=0.9;b+=V)
          addVox(px+ax2*t4*0.75-az2*b, base+t4*0.8+V/2, pz+az2*t4*0.75+ax2*b, R()<0.3?0x6a6259:0x4a443e,0.85+R()*0.25);
      }
      for(var cq3=0;cq3<5;cq3++){
        mpos.push(Math.round((px+(R()-0.5)*1.5)/V)*V,Math.round((base+1+R()*1.5)/V)*V,Math.round((pz+(R()-0.5)*1.5)/V)*V);
        pushShade(mcol,0xff9a3c,1);
      }
    } else {                                        /* standing stones */
      for(var st=0;st<6;st++){
        var sa=st/6*6.283, sx=px+Math.cos(sa)*4, sz2=pz+Math.sin(sa)*4, sh=2.5+R()*1.5;
        for(y2=0;y2<sh;y2+=V)for(a=-0.375;a<=0.375;a+=V)for(b=-0.25;b<=0.25;b+=V)
          addVox(sx+a,base+y2+V/2,sz2+b,pickFrom(BIOMES[dom].rock,R),0.85+R()*0.25);
      }
    }
  }
  (function(){
    var best=null,a,b;
    for(a=6;a<M-6;a+=2)for(b=6;b<M-6;b+=2){
      var cq4=cells[a*M+b];
      if(cq4.water||cq4.magma||TRAIL[a*M+b]) continue;
      if(!flatAt(a,b,1)) continue;
      if(!best||cq4.H>best.h) best={a:a,b:b,h:cq4.H,dom:cq4.dom};
    }
    if(!best) return;
    var kinds=(best.dom===3)?[2,0]:((best.dom===1)?[0,3]:((best.dom===4)?[3,0]:[1,3]));
    var kind=kinds[Math.abs(Math.round(OX*0.37+OZ*0.11))%kinds.length];
    landmarkStamp(-half+best.a,-half+best.b,kind,best.dom,best.h);
    lmPos=[-half+best.a,best.h+(kind===0?12:(kind===1?11:4)),-half+best.b];
  })();
  w.lmPos = lmPos;
}
