/**
 * Seeded noise. Everything random in the generator comes from here, so that a
 * seed string and a world position are together enough to reproduce a world.
 *
 * xmur3 turns a string into a stream of 32-bit seeds; mulberry32 turns one of
 * those into a uniform stream; makeNoise builds a value-noise field from it.
 */

export function xmur3(str){var h=1779033703^str.length;
  for(var i=0;i<str.length;i++){h=Math.imul(h^str.charCodeAt(i),3432918353);h=h<<13|h>>>19;}
  return function(){h=Math.imul(h^h>>>16,2246822507);h=Math.imul(h^h>>>13,3266489909);h^=h>>>16;return h>>>0;};}
export function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;var t=Math.imul(a^a>>>15,1|a);
  t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
export function makeNoise(seed){
  var r=mulberry32(seed),p=new Uint8Array(512),i,j,t;
  for(i=0;i<256;i++)p[i]=i;
  for(i=255;i>0;i--){j=(r()*(i+1))|0;t=p[i];p[i]=p[j];p[j]=t;}
  for(i=0;i<256;i++)p[i+256]=p[i];
  function g(x,y){return p[(p[x&255]+(y&255))&255]/255;}
  function n2(x,y){var xi=Math.floor(x),yi=Math.floor(y),xf=x-xi,yf=y-yi;
    var u=xf*xf*(3-2*xf),v=yf*yf*(3-2*yf);
    var a=g(xi,yi),b=g(xi+1,yi),c=g(xi,yi+1),d=g(xi+1,yi+1);
    return (a*(1-u)+b*u)*(1-v)+(c*(1-u)+d*u)*v;}
  function fbm(x,y,o){var s=0,a=0.5,f=1,n=0;o=o||3;
    for(var i=0;i<o;i++){s+=a*n2(x*f,y*f);n+=a;f*=2;a*=0.5;}return s/n;}
  return {n2:n2,fbm:fbm};
}
