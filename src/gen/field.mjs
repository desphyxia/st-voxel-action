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
import { BIOMES, CLIMATE_N, BIO } from './biomes.mjs';
import { xmur3, makeNoise, posRand, placeRand, placeStream } from './rng.mjs';
import { V, CEIL, clamp } from './constants.mjs';
import { exp } from './exact.mjs';

/* Frequency, octaves and how many voxel steps the sub-metre relief spans. See
   `detail` below for what each one was measured at. DETAIL_LEVELS is an odd
   count centred on zero: 3 is +/-1 voxel, 5 is +/-2. */
/* The scar overlay (#3): its frequency, the noise level a scar starts at, how
   fast it reaches full strength past that, and the most of a cell all scars
   together may take from the climate beneath. */
const SCAR_FREQ = 0.0052, SCAR_AT = 0.66, SCAR_GAIN = 6, SCAR_MAX = 0.85;

export const DETAIL_FREQ = 0.16, DETAIL_OCT = 2, DETAIL_LEVELS = 3;

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
  /* The scar overlay's noise comes from its own hash of the seed, for the
     reason `sw` does: drawing four more values out of `h` would shift every
     field below it and change every world's climate for no reason (#3). */
  var hs=xmur3('scar:'+String(seedStr)), NS=[];
  for(var qs=CLIMATE_N;qs<BIOMES.length;qs++) NS.push(makeNoise(hs()));
  /**
   * A cell's weights: the four climate anchors, then the four scars (#3).
   *
   * Climate is the blend of where this column sits on the temperature and
   * moisture chart, as it always was, over the anchors only. Each scar is an
   * independent low-frequency field, present where its noise clears a
   * threshold and at full strength a little past it. The scars take their
   * share out of the climate's, and never all of it: SCAR_MAX leaves the land
   * underneath a share everywhere, which is what the decision means by being
   * able to see what the land used to be.
   *
   * A forced climate row centres the chart on that anchor and lays no scars,
   * so a plate of it shows the biome and not whatever scar crossed it. A
   * forced scar leaves the climate to the seed and lays that one scar over
   * nearly everything, holed where its noise dips so the land shows through.
   */
  function climate(x,z){
    var t,m,i,w=[],s=0,sc=[],S=0;
    if(force!=null&&force<CLIMATE_N){
      t=BIOMES[force].t+(N.t.fbm(x*0.022,z*0.022,2)-0.5)*0.13;
      m=BIOMES[force].m+(N.m.fbm(x*0.021+40,z*0.021,2)-0.5)*0.13;
    }else{
      t=N.t.fbm(x*0.0068+wx,z*0.0068+wz,3); m=N.m.fbm(x*0.0061+wz,z*0.0061+wx,3);
      t=clamp((t-0.5)*2.1+0.5,0,1); m=clamp((m-0.5)*2.1+0.5,0,1);
    }
    for(i=0;i<CLIMATE_N;i++){var dt=t-BIOMES[i].t,dm=m-BIOMES[i].m;
      var e=exp(-(dt*dt+dm*dm)/0.055);w.push(e);s+=e;}
    for(i=0;i<CLIMATE_N;i++)w[i]/=s;
    for(i=CLIMATE_N;i<BIOMES.length;i++){
      var v=0, f=NS[i-CLIMATE_N].fbm(x*SCAR_FREQ+11*i,z*SCAR_FREQ-7*i,3);
      if(force==null) v=clamp((f-SCAR_AT)*SCAR_GAIN,0,1);
      else if(force===i) v=clamp(0.9+(f-0.5)*2.4,0,1);
      sc.push(v); S+=v;
    }
    var k=S>SCAR_MAX?SCAR_MAX/S:1, keep=1-S*k;
    for(i=0;i<CLIMATE_N;i++) w[i]*=keep;
    for(i=0;i<sc.length;i++) w.push(sc[i]*k);
    return w;
  }
  /**
   * The weighted value of one row key. A scar row that leaves a key unset
   * takes the climate's value for it instead, so a scar over mesa keeps the
   * mesa's height and a scar over meadow keeps the meadow's (#3).
   */
  function wsum(w,key){
    var s=0,cs=0,i;
    for(i=0;i<CLIMATE_N;i++){ s+=w[i]*BIOMES[i][key]; cs+=w[i]; }
    var under=cs>0?s/cs:0;
    for(i=CLIMATE_N;i<w.length;i++){ var v=BIOMES[i][key]; s+=w[i]*(v==null?under:v); }
    return s;
  }
  /* whole-metre macro height */
  function macro(x,z,w){
    var base=wsum(w,'base'), hill=wsum(w,'hill');
    var n=N.h.fbm(x*0.017,z*0.017,4), n2=N.h.fbm(x*0.055+9,z*0.055+9,2);
    return base+(n-0.38)*hill*1.9+(n2-0.5)*hill*0.55;
  }
  /**
   * The level a river runs at, in whole metres of bed (#67). A river is a band
   * of noise that knows nothing about height, and its bed used to be the local
   * ground less a metre — so it rode up every pillar, hill and canyon lip the
   * band crossed, and fell off the far side: pools perched on rock with falls
   * pouring out and nothing flowing in. This is the ground with the relief a
   * river would have cut through taken out: the large-scale shape alone, no
   * fine octave, no pillars, no canyons. A river is never higher than this, so
   * where the land rises across it the river cuts a gorge instead of climbing.
   */
  function riverBed(x,z,w){
    var base=wsum(w,'base'), hill=wsum(w,'hill');
    var n=N.h.fbm(x*0.017,z*0.017,2);
    return Math.round(base+(n-0.38)*hill*1.9)-1;
  }
  function riverAt(x,z){
    var v=N.r.fbm(x*0.0105,z*0.0105,3), d=Math.abs(v-0.5)*155;
    var w=1+Math.floor(N.r.n2(x*0.03+13,z*0.03+13)*4); if(w>4)w=4;
    return {d:d,w:w};
  }
  /**
   * A river narrow enough to be a single cell, stepping diagonally, rasterises
   * to cells that meet only at their corners: 4-connected flood fill sees a
   * dotted line of one-cell puddles rather than a stream (issue #44). Nothing
   * downstream copes with that — flowField and buildWaterGeometry read
   * 4-neighbours for depth, foam and flow, wading is per-cell, and markPath
   * only asks for a crossing where the route meets a *run* of water.
   *
   * So fill the corner. Only a genuine corner-only contact: if the cell
   * diagonally opposite is also river then the two neighbours are already
   * joined and this is the inside of a bend, which must be left alone — filling
   * those too widens every river by up to half again and costs a crossing.
   *
   * The neighbour's width is taken from the calling cell's climate rather than
   * its own. Climate is fbm at 0.0068, so it does not measurably change across
   * one metre, and this keeps the test to four cheap noise lookups instead of
   * four more climate evaluations per cell.
   */
  function isRiver(x,z,rw){ return riverAt(x,z).d < rw/2; }
  function riverCorner(x,z,rw){
    for(var q=0;q<4;q++){
      var dx=(q<2?1:-1), dz=(q%2?1:-1);
      if(!isRiver(x+dx,z,rw)||!isRiver(x,z+dz,rw)) continue;
      if(isRiver(x+dx,z+dz,rw)) continue;
      return true;
    }
    return false;
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
    var r=riverAt(x,z), rw=r.w+Math.round(w[BIO.SPORE]*3), water=false, pond=false, wl=0;
    if(r.d<rw/2||riverCorner(x,z,rw)){ H=Math.min(H-1,riverBed(x,z,w)); water=true; }
    if(!water&&N.s.fbm(x*0.018+21,z*0.018+21,2)>0.60){
      var h4=(rawH(x+3,z)+rawH(x-3,z)+rawH(x,z+3)+rawH(x,z-3))/4;
      if(hm<h4-0.7){ H=Math.round(hm)-1; water=true; pond=true; }
    }
    var magma=false;
    /* A river quenches a seam: no magma in or within two metres of one. The
       burn is a scar now and crosses rivers the old ash biome never had, and
       a seam's trench beside a river is dry ground below the water (#3). */
    if(w[BIO.ASH]>0.5&&!water&&r.d>=rw/2+2){ var f=Math.abs(N.s.fbm(x*0.03+7,z*0.03+7,2)-0.5);
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
  /**
   * The sub-metre relief, in whole voxels. The cell field is sized in whole
   * metres, so without this every plateau would be exactly flat; this is what
   * keeps a hillside from reading as a staircase of perfect terraces.
   *
   * It used to run at 0.62 with two octaves and five levels, which put its
   * first octave at 1.6 m and its second at 0.8 m: measured along a line it
   * changed value **every 0.37 m**, one and a half voxels. That is not relief,
   * it is chatter, and it was the sole source of every lone bump and lone pit
   * in the world — 0.13% of columns with it, 0.00% without, while the macro
   * field and erosion contributed none at all (issue #52).
   *
   * The numbers below are chosen by measurement rather than taste. Over a 96 m
   * patch at voxel resolution, across three noise seeds, what matters is how
   * often the ground reverses direction: the macro field on its own does it
   * every 14-42 m depending on biome, and the old detail did it every 2.3 m.
   */
  function detail(x,z){
    var half=(DETAIL_LEVELS-1)/2;
    return (Math.round(N.d.fbm(x*DETAIL_FREQ,z*DETAIL_FREQ,DETAIL_OCT)*(DETAIL_LEVELS-1))-half)*V;
  }
  /* Issue #58. One region asked for 45,293 cells over 4,751 places — every
     cell 9.5 times, from erosion reading its neighbours, from choosing ports,
     and from reading past a window's edge — and the field is two thirds of
     generation. cell() is a pure function of (x, z), so a cache hit is the value
     a miss would have computed. It fills during one buildWorld, which
     empties it at the end (forget, below); bounded anyway, and cleared rather than evicted, because a
     rebuilt entry is identical and the bookkeeping would cost more than it saves.

     The cached object is never handed out. Two callers keep what cell() returns
     and write to it — a window's own cells and a region's grid both overwrite
     H — so every call gets a fresh copy, and nothing either of them does can
     reach the next caller. The nested w and canyon are read, never written. */
  var CELLS=new Map(), CELL_CAP=1<<18;
  function cachedCell(x,z){
    if((x|0)!==x||(z|0)!==z||x<-32768||z<-32768||x>32767||z>32767) return cell(x,z);
    var k=(x+32768)*65536+(z+32768), c=CELLS.get(k);
    if(c===undefined){
      if(CELLS.size>=CELL_CAP) CELLS.clear();
      c=cell(x,z); CELLS.set(k,c);
    }
    return {w:c.w,H:c.H,water:c.water,pond:c.pond,wl:c.wl,magma:c.magma,dom:c.dom,canyon:c.canyon,cw:c.cw};
  }
  /* A world keeps its generator (w.G) for as long as it lives, and a streamed
     field holds sixteen of them — so the cache is let go when generation ends,
     and whatever reads the field afterwards starts from empty. */
  function forget(){ CELLS.clear(); }
  return {cell:cachedCell,detail:detail,climate:climate,canyonAt:canyonAt,wsum:wsum,spansFor:spansFor,
          sw:sw,prand:prand,prandIn:prandIn,pstream:pstream,forget:forget};
}

