/**
 * The scalar fields the world is cut from: climate, macro height, rivers,
 * canyons, columns, caves. One 1 m cell at a time, sized in whole metres.
 *
 * makeGen(seed, force) is pure with respect to world position: cell(x, z)
 * depends only on the seed and the coordinate, which is what lets the same
 * region be generated twice and match (issue #16).
 *
 * There used to be one exception — `rnd`, an ordered world-build stream every
 * later pass drew from. Issue #41 converted the last of its callers, and it is
 * gone: `prandIn` and `pstream` are what a pass draws through now, and both
 * answer for a place rather than for a step in a walk.
 */
import { BIOMES } from './biomes.mjs';
import { xmur3, makeNoise, posRand, placeRand, placeStream } from './rng.mjs';
import { V, CEIL, clamp } from './constants.mjs';
import { exp } from './exact.mjs';

export function makeGen(seedStr,force){
  var h=xmur3(String(seedStr));
  var N={h:makeNoise(h()),d:makeNoise(h()),t:makeNoise(h()),m:makeNoise(h()),
         r:makeNoise(h()),p:makeNoise(h()),c:makeNoise(h()),s:makeNoise(h()),v:makeNoise(h())};
  var wx=(h()%9973)/13, wz=(h()%9967)/17;
  /* A seed word for positional randomness, drawn from its own hash of the seed
     rather than from `h` — taking another value out of `h` would shift every
     stream below it and change every world for no reason. See rng.mjs. */
  var sw=xmur3('pos:'+String(seedStr))();
  function prand(x,z,salt){ return posRand(sw,x,z,salt); }
  /* The pass-scoped forms every window pass draws through — see rng.mjs. */
  function prandIn(pass,x,z,salt){ return placeRand(sw,pass,x,z,salt); }
  function pstream(pass,x,z){ return placeStream(sw,pass,x,z); }
  function climate(x,z){
    var t,m,i,w=[],s=0;
    if(force!=null){
      t=BIOMES[force].t+(N.t.fbm(x*0.022,z*0.022,2)-0.5)*0.13;
      m=BIOMES[force].m+(N.m.fbm(x*0.021+40,z*0.021,2)-0.5)*0.13;
    }else{
      t=N.t.fbm(x*0.0068+wx,z*0.0068+wz,3); m=N.m.fbm(x*0.0061+wz,z*0.0061+wx,3);
      t=clamp((t-0.5)*2.1+0.5,0,1); m=clamp((m-0.5)*2.1+0.5,0,1);
    }
    for(i=0;i<BIOMES.length;i++){var dt=t-BIOMES[i].t,dm=m-BIOMES[i].m;
      var e=exp(-(dt*dt+dm*dm)/0.055);w.push(e);s+=e;}
    for(i=0;i<w.length;i++)w[i]/=s;
    return w;
  }
  function wsum(w,key){var s=0;for(var i=0;i<w.length;i++)s+=w[i]*BIOMES[i][key];return s;}
  /* whole-metre macro height */
  function macro(x,z,w){
    var base=wsum(w,'base'), hill=wsum(w,'hill');
    var n=N.h.fbm(x*0.017,z*0.017,4), n2=N.h.fbm(x*0.055+9,z*0.055+9,2);
    return base+(n-0.38)*hill*1.9+(n2-0.5)*hill*0.55;
  }
  function riverAt(x,z){
    var v=N.r.fbm(x*0.0105,z*0.0105,3), d=Math.abs(v-0.5)*155;
    var w=1+Math.floor(N.r.n2(x*0.03+13,z*0.03+13)*4); if(w>4)w=4;
    return {d:d,w:w};
  }
  function canyonAt(x,z){
    var v=N.c.fbm(x*0.0082+5,z*0.0082+5,3), d=Math.abs(v-0.5)*120;
    var w=3+Math.floor(N.c.n2(x*0.02+31,z*0.02+7)*3); if(w>5)w=5;
    var dp=3+Math.floor(N.c.n2(x*0.015+3,z*0.015+3)*2); if(dp>4)dp=4;
    return {d:d,w:w,dp:dp};
  }
  function pillarAt(x,z,colw){
    if(colw<0.12) return 0;
    var cx=Math.floor(x/4),cz=Math.floor(z/4);
    if(N.p.n2(cx*7.7+0.5,cz*3.3+0.5)>1-0.30*colw){
      var r=1+Math.floor(N.p.n2(cx*1.3+5,cz*2.1+5)*2);
      var px=cx*4+2,pz=cz*4+2;
      if(Math.max(Math.abs(x-px),Math.abs(z-pz))<=r-0.5)
        return 2+Math.floor(N.p.n2(cx*0.7,cz*0.9)*3);
    }
    return 0;
  }
  /* one 1 m cell: everything sized in whole metres */
  function cell(x,z){
    var w=climate(x,z);
    var hm=macro(x,z,w), H=Math.round(hm);
    var cw=wsum(w,'canyon'), colw=wsum(w,'col');
    var c=null;
    if(cw>0.28){ c=canyonAt(x,z);
      if(c.d<c.w/2) H-=c.dp;
      else if(c.d<c.w/2+2) H-=Math.round(c.dp*(1-(c.d-c.w/2)/2));
    }
    H+=pillarAt(x,z,colw);
    var r=riverAt(x,z), rw=r.w+Math.round(w[2]*3), water=false, pond=false, wl=0;
    if(r.d<rw/2){ H-=1; water=true; }
    if(!water&&N.s.fbm(x*0.018+21,z*0.018+21,2)>0.60){
      var h4=(rawH(x+3,z)+rawH(x-3,z)+rawH(x,z+3)+rawH(x,z-3))/4;
      if(hm<h4-0.7){ H=Math.round(hm)-1; water=true; pond=true; }
    }
    var magma=false;
    if(w[3]>0.5){ var f=Math.abs(N.s.fbm(x*0.03+7,z*0.03+7,2)-0.5);
      if(f<0.022){ H-=1; magma=true; water=false; } }
    H=clamp(H,0,CEIL);
    if(water) wl=H+(pond?1.25:0.75);
    var top=0,ti=0; for(var i=0;i<w.length;i++) if(w[i]>top){top=w[i];ti=i;}
    return {w:w,H:H,water:water,pond:pond,wl:wl,magma:magma,dom:ti,canyon:c,cw:cw};
  }
  function rawH(x,z){ return macro(x,z,climate(x,z)); }
  /* a column is a run of solid spans, not one height: this is what lets a
     tunnel open onto a cliff face and a rim hang over nothing */
  function caveAt(x,y,z){
    var a=N.v.n2(x*0.070+y*0.10, z*0.070-y*0.085);
    var b=N.v.n2(z*0.058-y*0.065, x*0.058+y*0.050);
    return Math.abs(a-0.5)+Math.abs(b-0.5);
  }
  function spansFor(x,z,H){
    var sp=[],run=null,y;
    for(y=0;y<H;y++){
      var solid=!(y>=1&&y<=H-2&&caveAt(x,y+0.5,z)<0.062);
      if(solid){ if(run) run[1]=y+1; else run=[y,y+1]; }
      else if(run){ sp.push(run); run=null; }
    }
    if(run) sp.push(run);
    if(!sp.length) sp.push([0,Math.max(H,1)]);
    return sp;
  }
  function detail(x,z){ return (Math.round(N.d.fbm(x*0.62,z*0.62,2)*4)-2)*V; }
  return {cell:cell,detail:detail,climate:climate,canyonAt:canyonAt,wsum:wsum,spansFor:spansFor,
          sw:sw,prand:prand,prandIn:prandIn,pstream:pstream};
}

