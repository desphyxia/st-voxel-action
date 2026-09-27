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
import { V, CEIL, DIRS4, clamp } from './constants.mjs';
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
  /**
   * The level a river's surface stands at: the same smooth shape its bed
   * follows, but not rounded to the metre. The surface used to be the bed
   * plus 0.75, so wherever the land's shape crossed a whole metre the river
   * dropped a metre at once — a fall across the stream — and between those,
   * the banks eased it down a quarter at a time in every direction, a river
   * that slanted across itself. Now it descends a quarter-metre at a time
   * along its length, as gently as the land does, and stands level across it;
   * the bed is cut to keep the river's depth under whatever the level is.
   */
  function riverLevel(x,z,w){
    var base=wsum(w,'base'), hill=wsum(w,'hill');
    var n=N.h.fbm(x*0.017,z*0.017,2);
    return Math.round((base+(n-0.38)*hill*1.9-0.25)*4)/4;
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
  /* A gorge, not a trench (DECISIONS §5 "Canyons", #74): 6-10 m across, too
     wide for a double jump, and 5-8 m deep with vertical walls, too tall for
     one. `br` is how far a breach lifts the floor back towards the rim, 0 in
     the gorge proper and 1 where it has come right up: a slow noise along the
     canyon, so a breach is a long ramp every few tens of metres rather than a
     step. `taper` brings the depth out where the canyon ground fades, so a
     gorge ends in a slope rather than a wall. */
  function canyonAt(x,z){
    var v=N.c.fbm(x*0.0082+5,z*0.0082+5,3), d=Math.abs(v-0.5)*120;
    var w=6+Math.floor(N.c.n2(x*0.02+31,z*0.02+7)*5); if(w>10)w=10;
    var dp=5+Math.floor(N.c.n2(x*0.015+3,z*0.015+3)*4); if(dp>8)dp=8;
    var b=N.c.n2(x*0.021+71,z*0.021+13), br=clamp((b-0.45)/0.5,0,1);
    return {d:d,w:w,dp:dp,br:br};
  }
  /* Is this cell inside the body of a gorge, or on a sliver of it? Where the
     canyon band pinches out it leaves strands a cell or two wide, and cut to
     a gorge's depth those are pits you drop into and never leave. A cell of
     the body has canyon around it three metres out in most directions; a
     sliver does not, and stays at ground level. */
  var CANYON_RING=[[3,0],[-3,0],[0,3],[0,-3],[2,2],[2,-2],[-2,2],[-2,-2]];
  function canyonBody(x,z){
    var n=0;
    for(var q=0;q<8;q++){ var c=canyonAt(x+CANYON_RING[q][0],z+CANYON_RING[q][1]); if(c.d<c.w/2) n++; }
    return n>=5;
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
  /* Mesas (#75): a flat-topped block of rock, walled all round, with one way
     up — a line of 2 m stepping stones stepping down from its edge a metre at
     a time, a metre of ground between each. One jump climbs each stone; a
     double jump never reaches the top from the ground, because the top stands
     at least four metres over everything within three of its wall.

     A site per 48 m square, jittered, where the redrock dominates. Everything
     about it is drawn from the square's own coordinates, so a window and a
     chunk that both touch it build the same mesa. The site is computed once
     and kept: it reads the field over its footprint to find the top, and
     every cell within reach of it asks. */
  /* The apron is wide enough that a tree outside it cannot hang a canopy
     within a jump of the wall. MESA_REACH is the farthest a site's apron can
     stand from the square it belongs to. */
  var MESA_GRID=48, MESA_APRON=7, MESA_REACH=48, MESA_SITES=new Map();
  function mesaSite(gx,gz){
    var k=gx*131071+gz, s=MESA_SITES.get(k);
    if(s!==undefined) return s;
    s=null;
    /* Three tries at a spot in the square, so a river through the first one
       moves the mesa rather than losing it. */
    if(prand(gx,gz,0x3e5a)<0.7) for(var t=0;t<6&&!s;t++) s=mesaTry(gx,gz,0x3e5b+t*16);
    MESA_SITES.set(k,s);
    return s;
  }
  function mesaTry(gx,gz,salt){
    var cx=gx*MESA_GRID+12+Math.floor(prand(gx,gz,salt)*24),
        cz=gz*MESA_GRID+12+Math.floor(prand(gx,gz,salt+1)*24);
    if(climate(cx,cz)[BIO.MESA]<=0.5) return null;
    var rx=4+Math.floor(prand(gx,gz,salt+2)*7), rz=4+Math.floor(prand(gx,gz,salt+3)*7);
    var hi=-1e9, dx, dz, n, p, q;
    for(dx=-rx-3;dx<=rx+3;dx++) for(dz=-rz-3;dz<=rz+3;dz++){
      var hh=rawH(cx+dx,cz+dz); if(hh>hi) hi=hh;
    }
    var T=Math.round(hi)+4+Math.floor(prand(gx,gz,salt+4)*3);
    if(T>CEIL-2) return null;
    var dir=DIRS4[Math.floor(prand(gx,gz,salt+5)*4)], r=dir[0]?rx:rz, st=[];
    /* Stone n stands (r+2+3(n-1)) .. (r+3+3(n-1)) out from the centre along
       dir, two wide across it, its top T-n. It is the last one when it stands
       within a jump of the ground under it. */
    for(n=1;n<=8;n++){
      var a0=r+2+3*(n-1), top=T-n, g=-1e9;
      for(q=0;q<2;q++) for(p=0;p<2;p++){
        var gh=Math.round(rawH(cx+dir[0]*(a0+q)+(dir[0]?0:p), cz+dir[1]*(a0+q)+(dir[1]?0:p)));
        if(gh>g) g=gh;
      }
      if(top<=g) break;
      st.push(a0);
      if(top-g<=1) break;
    }
    /* A river through the rock would cut the top in two, and the half without
       the stones would be out of reach for good; a gorge through the apron
       would stop against it in a wall, a pocket with no way out, and one
       under the stones would leave the last of them out of reach. So a river
       or a gorge anywhere near the block or its stones rules the spot out. */
    for(dx=-rx-MESA_APRON;dx<=rx+MESA_APRON;dx++) for(dz=-rz-MESA_APRON;dz<=rz+MESA_APRON;dz++) if(mesaWet(cx+dx,cz+dz)) return null;
    for(n=r+1;n<=r+MESA_APRON+3*st.length;n++) for(p=-MESA_APRON;p<=MESA_APRON+1;p++){
      if(mesaWet(cx+dir[0]*n+(dir[0]?0:p), cz+dir[1]*n+(dir[1]?0:p))) return null;
    }
    return {cx:cx,cz:cz,rx:rx,rz:rz,T:T,dx:dir[0],dz:dir[1],st:st};
  }
  function mesaWet(x,z){
    if(riverAt(x,z).d<6) return true;
    var c=canyonAt(x,z);
    return c.d<c.w/2+2&&wsum(climate(x,z),'canyon')>0.28;
  }
  /* What a mesa makes of this cell: its top, a stone, the apron round it where
     no basalt column may stand (a column beside a wall is a second way up),
     or nothing. */
  function mesaAt(x,z){
    var gx0=Math.floor((x-MESA_REACH)/MESA_GRID), gx1=Math.floor((x+MESA_REACH)/MESA_GRID),
        gz0=Math.floor((z-MESA_REACH)/MESA_GRID), gz1=Math.floor((z+MESA_REACH)/MESA_GRID), apron=false;
    for(var gx=gx0;gx<=gx1;gx++) for(var gz=gz0;gz<=gz1;gz++){
      var s=mesaSite(gx,gz); if(!s) continue;
      var dx=x-s.cx, dz=z-s.cz;
      var ex=dx/s.rx, ez=dz/s.rz, e=ex*ex*ex*ex+ez*ez*ez*ez;
      if(e<=1) return {h:s.T,kind:1};
      /* along and across the stones' line */
      var al=dx*s.dx+dz*s.dz, ac=s.dx?dz:dx;
      if(ac>=0&&ac<=1&&al>0){
        for(var n=0;n<s.st.length;n++) if(al>=s.st[n]&&al<=s.st[n]+1) return {h:s.T-n-1,kind:2};
      }
      var lim=(s.dx?s.rx:s.rz)+MESA_APRON+3*s.st.length;
      if(Math.abs(dx)<=s.rx+MESA_APRON&&Math.abs(dz)<=s.rz+MESA_APRON) apron=true;
      else if(al>0&&al<=lim&&ac>=-MESA_APRON&&ac<=MESA_APRON+1) apron=true;
    }
    return apron?{h:null,kind:3}:null;
  }
  /* Basalt column fields (#76, Ashfall): a pool of magma set a metre under
     the lowest ground round it, and standing out of it on a 3 m lattice a
     field of 2 x 2 m columns, a metre of magma between each: a run and a jump
     from one lip lands on the next column's far half, where 1 m columns 2 m
     apart were overshot every time. They are crossed a jump
     at a time. Every column's top is the field's own base or a metre over it,
     so any two a jump apart are within a metre of each other; a quarter of
     them are missing, never on the two lines through the middle, so there is
     always a way across and seldom only one.

     Placed like a mesa: a jittered spot per 40 m square where the burn is
     more than half the ground, refused near a river, a gorge or a mesa, and
     drawn from the square's own coordinates. */
  var BAS_GRID=40, BAS_APRON=3, BAS_REACH=24, BAS_SITES=new Map();
  function basaltSite(gx,gz){
    var k=gx*131071+gz, s=BAS_SITES.get(k);
    if(s!==undefined) return s;
    s=null;
    if(prand(gx,gz,0x5a10)<0.75) for(var t=0;t<4&&!s;t++) s=basaltTry(gx,gz,0x5a11+t*16);
    BAS_SITES.set(k,s);
    return s;
  }
  function basaltTry(gx,gz,salt){
    var cx=gx*BAS_GRID+10+Math.floor(prand(gx,gz,salt)*20),
        cz=gz*BAS_GRID+10+Math.floor(prand(gx,gz,salt+1)*20);
    if(climate(cx,cz)[BIO.ASH]<=0.5) return null;
    var rx=6+Math.floor(prand(gx,gz,salt+2)*5), rz=6+Math.floor(prand(gx,gz,salt+3)*5);
    var lo=1e9, dx, dz, ex, ez;
    for(dx=-rx-BAS_APRON;dx<=rx+BAS_APRON;dx++) for(dz=-rz-BAS_APRON;dz<=rz+BAS_APRON;dz++){
      if(mesaWet(cx+dx,cz+dz)||mesaAt(cx+dx,cz+dz)) return null;
      ex=dx/rx; ez=dz/rz;
      if(ex*ex+ez*ez<=1){ var h=rawH(cx+dx,cz+dz); if(h<lo) lo=h; }
    }
    var B=Math.round(rawH(cx,cz)), P=Math.min(Math.round(lo)-1,B-2);
    if(P<1||B+1>CEIL) return null;
    return {cx:cx,cz:cz,rx:rx,rz:rz,B:B,P:P,salt:salt};
  }
  /* A column (1), the pool (2), the rim round it where nothing grows (3). */
  function basaltAt(x,z){
    var apron=false;
    for(var gx=Math.floor((x-BAS_REACH)/BAS_GRID);gx<=Math.floor((x+BAS_REACH)/BAS_GRID);gx++)
      for(var gz=Math.floor((z-BAS_REACH)/BAS_GRID);gz<=Math.floor((z+BAS_REACH)/BAS_GRID);gz++){
        var s=basaltSite(gx,gz); if(!s) continue;
        var dx=x-s.cx, dz=z-s.cz, ex=dx/s.rx, ez=dz/s.rz;
        if(ex*ex+ez*ez<=1){
          /* 2 x 2 m columns on a 3 m lattice: two cells of rock, one of magma.
             A block is one column, so it draws from its block's coordinates. */
          var bx=Math.floor(dx/3), bz=Math.floor(dz/3), ix=dx-3*bx, iz=dz-3*bz;
          if(ix<2&&iz<2&&(bx===0||bz===0||prand(bx+s.cx,bz+s.cz,s.salt+9)>=0.25))
            return {kind:1,h:s.B+(prand(bx+s.cx,bz+s.cz,s.salt+10)<0.5?0:1)};
          return {kind:2,h:s.P};
        }
        ex=dx/(s.rx+BAS_APRON); ez=dz/(s.rz+BAS_APRON);
        if(ex*ex+ez*ez<=1) apron=true;
      }
    return apron?{kind:3,h:null}:null;
  }
  /* How many column fields are centred in a box, for --diag. */
  function basaltIn(x0,z0,x1,z1){
    var n=0;
    for(var gx=Math.floor(x0/BAS_GRID);gx<=Math.floor(x1/BAS_GRID);gx++)
      for(var gz=Math.floor(z0/BAS_GRID);gz<=Math.floor(z1/BAS_GRID);gz++){
        var b=basaltSite(gx,gz); if(b&&b.cx>=x0&&b.cx<x1&&b.cz>=z0&&b.cz<z1) n++;
      }
    return n;
  }
  /* The column field over (x, z), for a test that wants to cross one. */
  function basaltOver(x,z){
    for(var gx=Math.floor((x-BAS_REACH)/BAS_GRID);gx<=Math.floor((x+BAS_REACH)/BAS_GRID);gx++)
      for(var gz=Math.floor((z-BAS_REACH)/BAS_GRID);gz<=Math.floor((z+BAS_REACH)/BAS_GRID);gz++){
        var s=basaltSite(gx,gz); if(!s) continue;
        var ex=(x-s.cx)/s.rx, ez=(z-s.cz)/s.rz; if(ex*ex+ez*ez<=1) return s;
      }
    return null;
  }
  /* Cliff bands (#76, Cloudpine): a long step in the ground, its front a
     sheer face 4-6 m over everything within seven metres of it, its back
     falling away a metre every three to meet the land behind. Round the
     back it is a walk; up the front it is a ledge line — 2 m ledges a metre
     deep, stuck to the face, each a metre over the last, from a jump off the
     ground to a jump onto the top. The ends are faces too.

     Placed like the others: a jittered spot per 56 m square where the pine
     is more than half the climate, refused near a river, a gorge, a mesa or
     a basalt field, drawn from the square's own coordinates. */
  var CLF_GRID=56, CLF_APRON=7, CLF_REACH=40, CLF_SITES=new Map();
  function cliffSite(gx,gz){
    var k=gx*131071+gz, s=CLF_SITES.get(k);
    if(s!==undefined) return s;
    s=null;
    if(prand(gx,gz,0x6c10)<0.8) for(var t=0;t<4&&!s;t++) s=cliffTry(gx,gz,0x6c11+t*16);
    CLF_SITES.set(k,s);
    return s;
  }
  /* A site's own frame: along the face, and across it — out of the band
     negative, into it positive. */
  function cliffFrame(s,x,z){ var dx=x-s.cx, dz=z-s.cz; return s.ax?[dx,dz*s.sg]:[dz,dx*s.sg]; }
  function cliffWorld(s,al,ac){ return s.ax?[s.cx+al,s.cz+ac*s.sg]:[s.cx+ac*s.sg,s.cz+al]; }
  function cliffTry(gx,gz,salt){
    var cx=gx*CLF_GRID+14+Math.floor(prand(gx,gz,salt)*28),
        cz=gz*CLF_GRID+14+Math.floor(prand(gx,gz,salt+1)*28);
    if(climate(cx,cz)[BIO.PINE]<=0.5) return null;
    var s={cx:cx,cz:cz,ax:prand(gx,gz,salt+2)<0.5,sg:prand(gx,gz,salt+3)<0.5?1:-1,
           half:8+Math.floor(prand(gx,gz,salt+4)*7),D:12+Math.floor(prand(gx,gz,salt+5)*7)};
    var hi=-1e9, al, ac, p;
    for(al=-s.half-CLF_APRON;al<=s.half+CLF_APRON;al++) for(ac=-CLF_APRON;ac<=s.D+3;ac++){
      p=cliffWorld(s,al,ac);
      if(mesaWet(p[0],p[1])||mesaAt(p[0],p[1])||basaltAt(p[0],p[1])) return null;
      if(ac<0&&Math.abs(al)<=s.half){ var h=rawH(p[0],p[1]); if(h>hi) hi=h; }
    }
    s.T=Math.round(hi)+4+Math.floor(prand(gx,gz,salt+6)*3);
    if(s.T>CEIL-1) return null;
    /* The ledges start two metres in from one end and climb along the face
       from the ground under the first to a metre under the top. */
    p=cliffWorld(s,-s.half+2,-1);
    var g=Math.round(rawH(p[0],p[1])), n=s.T-g-1;
    if(n<2||2*n>2*s.half-3) return null;
    s.l0=-s.half+2; s.lg=g; s.ln=n;
    return s;
  }
  /* The band's slope (1), its face row (2), a ledge (3), the apron (4). */
  function cliffAt(x,z){
    var apron=null;
    for(var gx=Math.floor((x-CLF_REACH)/CLF_GRID);gx<=Math.floor((x+CLF_REACH)/CLF_GRID);gx++)
      for(var gz=Math.floor((z-CLF_REACH)/CLF_GRID);gz<=Math.floor((z+CLF_REACH)/CLF_GRID);gz++){
        var s=cliffSite(gx,gz); if(!s) continue;
        var f=cliffFrame(s,x,z), al=f[0], ac=f[1];
        if(Math.abs(al)>s.half+CLF_APRON||ac<-CLF_APRON||ac>s.D) continue;
        if(Math.abs(al)<=s.half&&ac>=0){
          if(ac===0) return {kind:2,h:s.T};
          return {kind:1,h:s.T-Math.floor(ac/3)};
        }
        if(ac===-1&&al>=s.l0&&al<s.l0+2*s.ln){
          var n=Math.floor((al-s.l0)/2);
          return {kind:3,h:s.lg+1+n};
        }
        if(ac<0) apron={kind:4,h:null};
      }
    return apron;
  }
  function cliffIn(x0,z0,x1,z1){
    var n=0;
    for(var gx=Math.floor(x0/CLF_GRID);gx<=Math.floor(x1/CLF_GRID);gx++)
      for(var gz=Math.floor(z0/CLF_GRID);gz<=Math.floor(z1/CLF_GRID);gz++){
        var c=cliffSite(gx,gz); if(c&&c.cx>=x0&&c.cx<x1&&c.cz>=z0&&c.cz<z1) n++;
      }
    return n;
  }
  function cliffOver(x,z){
    for(var gx=Math.floor((x-CLF_REACH)/CLF_GRID);gx<=Math.floor((x+CLF_REACH)/CLF_GRID);gx++)
      for(var gz=Math.floor((z-CLF_REACH)/CLF_GRID);gz<=Math.floor((z+CLF_REACH)/CLF_GRID);gz++){
        var s=cliffSite(gx,gz); if(!s) continue;
        var f=cliffFrame(s,x,z);
        if(Math.abs(f[0])<=s.half+CLF_APRON&&f[1]>=-CLF_APRON&&f[1]<=s.D) return s;
      }
    return null;
  }
  /* Thickets (#76, Thornwood): a patch of thorn too dense to push through
     and too tall to jump, 3.25 m, with a fallen log lying through the middle
     of it in the one lane it crushed — a metre high, jumped onto at one end
     and walked along to the other. The thicket itself is props (props.mjs);
     what the cells carry is where it stands, so routes go round it and the
     floods can see it.

     A jittered spot per 64 m square where the thorn is more than half the
     climate — sparser than the others: every thicket is a route's detour,
     and at one per 40 m square the golden thorn window kept 38 trail cells of
     450 — refused near a river, a gorge or another feature. */
  var THN_GRID=64, THN_APRON=2, THN_REACH=20, THN_SITES=new Map();
  function thornSite(gx,gz){
    var k=gx*131071+gz, s=THN_SITES.get(k);
    if(s!==undefined) return s;
    s=null;
    if(prand(gx,gz,0x7d10)<0.6) for(var t=0;t<4&&!s;t++) s=thornTry(gx,gz,0x7d11+t*16);
    THN_SITES.set(k,s);
    return s;
  }
  function thornTry(gx,gz,salt){
    var cx=gx*THN_GRID+14+Math.floor(prand(gx,gz,salt)*36),
        cz=gz*THN_GRID+14+Math.floor(prand(gx,gz,salt+1)*36);
    if(climate(cx,cz)[BIO.THORN]<=0.5) return null;
    var rx=4+Math.floor(prand(gx,gz,salt+2)*4), rz=4+Math.floor(prand(gx,gz,salt+3)*4);
    var hi=-1e9;
    for(var dx=-rx-THN_APRON-1;dx<=rx+THN_APRON+1;dx++) for(var dz=-rz-THN_APRON-1;dz<=rz+THN_APRON+1;dz++){
      var x=cx+dx, z=cz+dz;
      if(mesaWet(x,z)||mesaAt(x,z)||basaltAt(x,z)||cliffAt(x,z)) return null;
      var h=rawH(x,z); if(h>hi) hi=h;
    }
    /* The top is flat, 3.5 m over the highest ground round it. A roof that
       followed the ground under it was 3.25 m over a hollow and a double
       jump from the rise beside it cleared it. The half metre over the
       field's own height is for the ramps and the relief the surface adds. */
    if(Math.round(hi)+4>CEIL) return null;
    /* The log lies along the longer axis. */
    return {cx:cx,cz:cz,rx:rx,rz:rz,ax:rx>=rz,top:Math.round(hi)+3.5};
  }
  /* The thicket (2), the log's lane (3), the ground round it where nothing
     else grows (4). */
  function thornAt(x,z){
    var apron=false;
    for(var gx=Math.floor((x-THN_REACH)/THN_GRID);gx<=Math.floor((x+THN_REACH)/THN_GRID);gx++)
      for(var gz=Math.floor((z-THN_REACH)/THN_GRID);gz<=Math.floor((z+THN_REACH)/THN_GRID);gz++){
        var s=thornSite(gx,gz); if(!s) continue;
        var dx=x-s.cx, dz=z-s.cz, ex=dx/s.rx, ez=dz/s.rz, e=ex*ex+ez*ez;
        /* The log runs a metre past the thicket at each end, onto open ground. */
        if(s.ax?(dz===0&&Math.abs(dx)<=s.rx+1):(dx===0&&Math.abs(dz)<=s.rz+1)) return {kind:3,top:s.top};
        if(e<=1) return {kind:2,top:s.top};
        ex=dx/(s.rx+THN_APRON); ez=dz/(s.rz+THN_APRON);
        if(ex*ex+ez*ez<=1) apron=true;
      }
    return apron?{kind:4}:null;
  }
  function thornIn(x0,z0,x1,z1){
    var n=0;
    for(var gx=Math.floor(x0/THN_GRID);gx<=Math.floor(x1/THN_GRID);gx++)
      for(var gz=Math.floor(z0/THN_GRID);gz<=Math.floor(z1/THN_GRID);gz++){
        var c=thornSite(gx,gz); if(c&&c.cx>=x0&&c.cx<x1&&c.cz>=z0&&c.cz<z1) n++;
      }
    return n;
  }
  function thornOver(x,z){
    for(var gx=Math.floor((x-THN_REACH)/THN_GRID);gx<=Math.floor((x+THN_REACH)/THN_GRID);gx++)
      for(var gz=Math.floor((z-THN_REACH)/THN_GRID);gz<=Math.floor((z+THN_REACH)/THN_GRID);gz++){
        var s=thornSite(gx,gz); if(!s) continue;
        var ex=(x-s.cx)/(s.rx+THN_APRON), ez=(z-s.cz)/(s.rz+THN_APRON); if(ex*ex+ez*ez<=1) return s;
      }
    return null;
  }
  /* Crevasse fields (#76, Rimewaste): a glacier — a level sheet of ice at
     least six metres up, its skirt falling a metre a metre to the land round
     it — cut clean across by two or three crevasses seven metres wide and
     four deep: wider than a double jump clears, higher than one climbs (it
     rises 2.4 m). Each is crossed by one snow bridge two metres wide at the
     sheet's level. A body that steps or jumps in lives, and is not lost: at
     each end a stair of 1 m steps climbs out onto the side it fell from and
     never the far one, so the floor is a way back and not a way over. Both
     ends, because the bridge stands on the floor and walls it in two. One
     that double jumps at a crevasse and falls short falls 6.4 m from the top
     of its arc, which kills: a crevasse is crossed at its bridge.

     The rime is low, flat ground — three to five metres, mostly — and a
     crevasse four deep in it would mostly have no floor. So the sheet stands on it
     rather than being cut into it.

     Placed like the others: a jittered spot per 56 m square where the rime
     is more than half the climate, refused near a river, a gorge or another
     feature. A field is up to 57 m long, longer than its square, so where
     two would overlap the one with the higher draw keeps its place. */
  var RIM_GRID=56, RIM_APRON=4, RIM_REACH=40, RIM_W=7, RIM_D=4, RIM_RAW=new Map(), RIM_SITES=new Map();
  function rimeRaw(gx,gz){
    var k=gx*131071+gz, s=RIM_RAW.get(k);
    if(s!==undefined) return s;
    s=null;
    if(prand(gx,gz,0x8e10)<0.8) for(var t=0;t<4&&!s;t++) s=rimeTry(gx,gz,0x8e11+t*16);
    if(s) s.pr=prand(gx,gz,0x8e0f);
    RIM_RAW.set(k,s);
    return s;
  }
  function rimeSite(gx,gz){
    var k=gx*131071+gz, s=RIM_SITES.get(k);
    if(s!==undefined) return s;
    s=rimeRaw(gx,gz);
    for(var a=-1;a<=1&&s;a++) for(var b=-1;b<=1&&s;b++){
      if(!a&&!b) continue;
      var o=rimeRaw(gx+a,gz+b);
      if(o&&o.pr>s.pr&&o.x0<=s.x1&&s.x0<=o.x1&&o.z0<=s.z1&&s.z0<=o.z1) s=null;
    }
    RIM_SITES.set(k,s);
    return s;
  }
  /* A site's own frame: along the sheet, where the crevasses follow one
     another, and across it, the way each one runs. */
  function rimeFrame(s,x,z){ var dx=x-s.cx, dz=z-s.cz; return s.ax?[dx,dz]:[dz,dx]; }
  function rimeWorld(s,al,ac){ return s.ax?[s.cx+al,s.cz+ac]:[s.cx+ac,s.cz+al]; }
  function rimeTry(gx,gz,salt){
    var cx=gx*RIM_GRID+14+Math.floor(prand(gx,gz,salt)*28),
        cz=gz*RIM_GRID+14+Math.floor(prand(gx,gz,salt+1)*28);
    if(climate(cx,cz)[BIO.RIME]<=0.5) return null;
    var n=2+Math.floor(prand(gx,gz,salt+2)*2), band=4+Math.floor(prand(gx,gz,salt+3)*3),
        len=n*RIM_W+(n+1)*band, lh=Math.floor(len/2);
    var s={cx:cx,cz:cz,ax:prand(gx,gz,salt+4)<0.5,n:n,band:band,lo:-lh,hi:len-lh-1,
           wd:6+Math.floor(prand(gx,gz,salt+5)*5),cr:[],br:[]};
    var hi=-1e9, lo=1e9, al, ac, p, h;
    for(al=s.lo-RIM_APRON;al<=s.hi+RIM_APRON;al++) for(ac=-s.wd-RIM_APRON;ac<=s.wd+RIM_APRON;ac++){
      p=rimeWorld(s,al,ac);
      if(mesaWet(p[0],p[1])||mesaAt(p[0],p[1])||basaltAt(p[0],p[1])||cliffAt(p[0],p[1])||thornAt(p[0],p[1])) return null;
      h=rawH(p[0],p[1]); if(h<lo) lo=h;
      if(al>=s.lo&&al<=s.hi&&Math.abs(ac)<=s.wd&&h>hi) hi=h;
    }
    /* Level with the highest ground under it, and never under five metres; its
       skirt has to reach the land within the apron. */
    s.S=Math.max(Math.round(hi),RIM_D+1);
    if(s.S+1>CEIL||s.S-Math.round(lo)>RIM_APRON) return null;
    /* Crevasse k starts `band` metres past the one before; its bridge crosses
       anywhere clear of the stairs at its ends. */
    for(var k=0;k<n;k++){
      s.cr.push(s.lo+band+k*(RIM_W+band));
      s.br.push(-s.wd+3+Math.floor(prand(gx,gz,salt+10+k)*(2*s.wd-6)));
    }
    var c0=rimeWorld(s,s.lo-RIM_APRON-1,-s.wd-RIM_APRON-1), c1=rimeWorld(s,s.hi+RIM_APRON+1,s.wd+RIM_APRON+1);
    s.x0=Math.min(c0[0],c1[0]); s.x1=Math.max(c0[0],c1[0]); s.z0=Math.min(c0[1],c1[1]); s.z1=Math.max(c0[1],c1[1]);
    return s;
  }
  /* The sheet (1), a crevasse's floor (2), a bridge (3), a stair (4), the
     skirt round it where nothing grows (5), whose height is a floor under
     the ground rather than the ground itself. */
  function rimeAt(x,z){
    var skirt=null;
    for(var gx=Math.floor((x-RIM_REACH)/RIM_GRID);gx<=Math.floor((x+RIM_REACH)/RIM_GRID);gx++)
      for(var gz=Math.floor((z-RIM_REACH)/RIM_GRID);gz<=Math.floor((z+RIM_REACH)/RIM_GRID);gz++){
        var s=rimeSite(gx,gz); if(!s) continue;
        var f=rimeFrame(s,x,z), al=f[0], ac=f[1];
        if(al<s.lo-RIM_APRON||al>s.hi+RIM_APRON||Math.abs(ac)>s.wd+RIM_APRON) continue;
        if(al<s.lo||al>s.hi||Math.abs(ac)>s.wd){
          var d=Math.max(s.lo-al,al-s.hi,Math.abs(ac)-s.wd,0);
          skirt={kind:5,h:s.S-d}; continue;
        }
        for(var k=0;k<s.n;k++){
          var o=al-s.cr[k];
          if(o<0||o>=RIM_W) continue;
          if(ac>=s.br[k]&&ac<=s.br[k]+1) return {kind:3,h:s.S};
          /* A stair: against the near wall, two wide, a metre a step, its
             top one under the sheet — a step out onto the near side, and
             five metres of air from the far one. */
          if(o<2&&Math.abs(ac)>=s.wd-2) return {kind:4,h:s.S-RIM_D+1+(Math.abs(ac)-(s.wd-2))};
          return {kind:2,h:s.S-RIM_D};
        }
        return {kind:1,h:s.S};
      }
    return skirt;
  }
  function rimeIn(x0,z0,x1,z1){
    var n=0;
    for(var gx=Math.floor(x0/RIM_GRID);gx<=Math.floor(x1/RIM_GRID);gx++)
      for(var gz=Math.floor(z0/RIM_GRID);gz<=Math.floor(z1/RIM_GRID);gz++){
        var c=rimeSite(gx,gz); if(c&&c.cx>=x0&&c.cx<x1&&c.cz>=z0&&c.cz<z1) n++;
      }
    return n;
  }
  function rimeOver(x,z){
    for(var gx=Math.floor((x-RIM_REACH)/RIM_GRID);gx<=Math.floor((x+RIM_REACH)/RIM_GRID);gx++)
      for(var gz=Math.floor((z-RIM_REACH)/RIM_GRID);gz<=Math.floor((z+RIM_REACH)/RIM_GRID);gz++){
        var s=rimeSite(gx,gz); if(!s) continue;
        var f=rimeFrame(s,x,z);
        if(f[0]>=s.lo-RIM_APRON&&f[0]<=s.hi+RIM_APRON&&Math.abs(f[1])<=s.wd+RIM_APRON) return s;
      }
    return null;
  }
  /* one 1 m cell: everything sized in whole metres */
  function cell(x,z){
    var w=climate(x,z);
    var hm=macro(x,z,w), H=Math.round(hm);
    var cw=wsum(w,'canyon'), colw=wsum(w,'col');
    var c=null, ms=mesaAt(x,z), bs=ms?null:basaltAt(x,z), cs=(ms||bs)?null:cliffAt(x,z), ts=(ms||bs||cs)?null:thornAt(x,z),
        rs=(ms||bs||cs||ts)?null:rimeAt(x,z), ft=!!(ms||bs||cs||ts||rs);
    if(cw>0.28&&!ft){ c=canyonAt(x,z);
      c.body=c.d<c.w/2&&canyonBody(x,z);
      if(c.body){ var taper=clamp((cw-0.28)/0.25,0,1); H-=Math.round(c.dp*taper*(1-c.br)); }
    }
    if(!ft) H+=pillarAt(x,z,colw);
    else if(ms&&ms.h!==null) H=ms.h;
    else if(cs&&cs.h!==null) H=cs.kind===1?Math.max(H,cs.h):cs.h;
    else if(rs) H=rs.kind===5?Math.max(H,rs.h):rs.h;
    var r=riverAt(x,z), rw=r.w+Math.round(w[BIO.SPORE]*3), water=false, pond=false, wl=0;
    var rl=null;
    /* The smooth level, but never above the ground the river runs through: a
       dip in the land would otherwise hold water metres deep above it, which
       the banks then pulled down and the bed was carved below the world to
       keep. Where the land is lower, the surface sits a quarter under it. */
    if(r.d<rw/2||riverCorner(x,z,rw)){ rl=Math.min(riverLevel(x,z,w),H-0.25); H=Math.min(H-1,Math.floor(rl-0.75+1e-9)); water=true; }
    if(!water&&!(ms&&ms.h!==null)&&!bs&&!(cs&&cs.h!==null)&&!ts&&!rs&&N.s.fbm(x*0.018+21,z*0.018+21,2)>0.60){
      var h4=(rawH(x+3,z)+rawH(x-3,z)+rawH(x,z+3)+rawH(x,z-3))/4;
      if(hm<h4-0.7){ H=Math.round(hm)-1; water=true; pond=true; }
    }
    var magma=false;
    /* A river quenches a seam: no magma in or within two metres of one. The
       burn is a scar now and crosses rivers the old ash biome never had, and
       a seam's trench beside a river is dry ground below the water (#3). */
    if(w[BIO.ASH]>0.5&&!water&&!bs&&r.d>=rw/2+2){ var f=Math.abs(N.s.fbm(x*0.03+7,z*0.03+7,2)-0.5);
      /* Level, like a river (#67): a seam used to be the ground less a metre,
         so it kept every bump under it and a basalt pillar standing in it
         carried magma up its top. Its bed is the large-scale shape of the
         land instead — no fine octave, no pillars, no canyon — so it flows
         through them. */
      if(f<0.022){ H=Math.min(H-1,riverBed(x,z,w)); magma=true; water=false; } }
    if(bs&&bs.h!==null){ H=bs.h; magma=bs.kind===2; water=false; pond=false; }
    H=clamp(H,0,CEIL);
    if(water) wl=(!pond&&rl!==null&&rl>=H+0.5)?rl:H+(pond?1.25:0.75);
    var top=0,ti=0; for(var i=0;i<w.length;i++) if(w[i]>top){top=w[i];ti=i;}
    return {w:w,H:H,water:water,pond:pond,wl:wl,magma:magma,dom:ti,canyon:c,cw:cw,mesa:ms?ms.kind:0,basalt:bs?bs.kind:0,cliff:cs?cs.kind:0,thorn:ts?ts.kind:0,thornTop:ts&&ts.top?ts.top:0,rime:rs?rs.kind:0,
      /* block: a route may not cross it — the thicket and its log's lane */
      block:!!(ts&&(ts.kind===2||ts.kind===3)),
      /* hold: a face the later passes keep as it is; bare: nothing grows here */
      hold:!!(ms&&ms.kind<=2)||!!(bs&&bs.kind===1)||!!(cs&&(cs.kind===2||cs.kind===3))||!!(rs&&rs.kind<=4),
      bare:!!(ms&&ms.kind>=2)||!!bs||!!(cs&&cs.kind>=2)||!!ts||!!rs};
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
    return {w:c.w,H:c.H,water:c.water,pond:c.pond,wl:c.wl,magma:c.magma,dom:c.dom,canyon:c.canyon,cw:c.cw,mesa:c.mesa,basalt:c.basalt,cliff:c.cliff,thorn:c.thorn,thornTop:c.thornTop,rime:c.rime,block:c.block,hold:c.hold,bare:c.bare};
  }
  /* A world keeps its generator (w.G) for as long as it lives, and a streamed
     field holds sixteen of them — so the cache is let go when generation ends,
     and whatever reads the field afterwards starts from empty. */
  function forget(){ CELLS.clear(); }
  /* The mesa whose top covers (x, z), for a test that wants to walk its
     stones: centre, radii, top, the stones' direction and where each stands. */
  function mesaOver(x,z){
    for(var gx=Math.floor((x-MESA_REACH)/MESA_GRID);gx<=Math.floor((x+MESA_REACH)/MESA_GRID);gx++)
      for(var gz=Math.floor((z-MESA_REACH)/MESA_GRID);gz<=Math.floor((z+MESA_REACH)/MESA_GRID);gz++){
        var m=mesaSite(gx,gz); if(!m) continue;
        var ex=(x-m.cx)/m.rx, ez=(z-m.cz)/m.rz;
        if(ex*ex*ex*ex+ez*ez*ez*ez<=1) return m;
      }
    return null;
  }
  /* How many mesas are centred in a box, straight from the site grid: what
     --diag counts, over more ground than one window holds (#75). */
  function mesasIn(x0,z0,x1,z1){
    var n=0;
    for(var gx=Math.floor(x0/MESA_GRID);gx<=Math.floor(x1/MESA_GRID);gx++)
      for(var gz=Math.floor(z0/MESA_GRID);gz<=Math.floor(z1/MESA_GRID);gz++){
        var m=mesaSite(gx,gz); if(m&&m.cx>=x0&&m.cx<x1&&m.cz>=z0&&m.cz<z1) n++;
      }
    return n;
  }
  return {cell:cachedCell,detail:detail,climate:climate,canyonAt:canyonAt,wsum:wsum,spansFor:spansFor,mesaOver:mesaOver,mesasIn:mesasIn,basaltOver:basaltOver,basaltIn:basaltIn,cliffOver:cliffOver,cliffIn:cliffIn,thornOver:thornOver,thornIn:thornIn,rimeOver:rimeOver,rimeIn:rimeIn,rimeFrame:rimeFrame,cliffFrame:cliffFrame,
          sw:sw,prand:prand,prandIn:prandIn,pstream:pstream,forget:forget};
}

