// SPDX-License-Identifier: AGPL-3.0-or-later
// Fujifilm in-camera lens corrections from the RAF metadata: distortion, lateral chromatic
// aberration and vignetting splines. Algorithm adapted from darktable 4.6 src/iop/lens.cc
// and RawTherapee rtengine/lensmetadata.cc (GPL-3.0-or-later).
const TYPES={1:1,2:1,3:2,4:4,5:8,7:1,8:2,9:4,10:8,11:4,12:8};
// Reads GeometricDistortionParams, ChromaticAberrationParams and VignettingParams from the RAF's Fuji IFD.
export function parseLens(buffer){
  try{
    const b=new Uint8Array(buffer),dv=new DataView(buffer);
    if(String.fromCharCode(...b.subarray(0,16))!=='FUJIFILMCCD-RAW ')return null;
    const base=dv.getUint32(100);
    if(b[base]!==0x49||b[base+1]!==0x49)return null; // little endian TIFF
    const u16=o=>dv.getUint16(base+o,true),u32=o=>dv.getUint32(base+o,true),i32=o=>dv.getInt32(base+o,true);
    const read=(off,tag)=>{const n=u16(off);for(let i=0;i<n;i++){const e=off+2+i*12;if(u16(e)!==tag)continue;const type=u16(e+2),count=u32(e+4),size=(TYPES[type]||1)*count,val=size<=4?e+8:u32(e+8);
      if(type!==10)return null;const out=[];for(let k=0;k<count;k++){const d=i32(val+k*8+4);out.push(d?i32(val+k*8)/d:0);}return out;}return null;};
    const fujiIfd=(()=>{const off=u32(4),n=u16(off);for(let i=0;i<n;i++){const e=off+2+i*12;if(u16(e)===0xf000)return u32(e+8);}return 0;})();
    if(!fujiIfd)return null;
    const d=read(fujiIfd,0xf00b),c=read(fujiIfd,0xf00f),v=read(fujiIfd,0xf010);
    if(!d||!c||!v)return null;
    let nc,knots,dist,caR,caB,vig;
    if(d.length===19&&c.length===29&&v.length===19){nc=9;knots=d.slice(1,10);dist=d.slice(10,19);caR=c.slice(10,19);caB=c.slice(19,28);vig=v.slice(10,19);}
    else if(d.length===23&&c.length===31&&v.length===23){nc=11;knots=d.slice(1,12);dist=d.slice(12,23);caR=[0,...c.slice(11,21)];caB=[0,...c.slice(21,31)];vig=v.slice(12,23);}
    else return null;
    return {nc,knots,dist,caR,caB,vig};
  }catch{return null;}
}
function spline(xs,ys,x){
  if(x<xs[0])return ys[0];
  for(let i=1;i<xs.length;i++)if(x>=xs[i-1]&&x<=xs[i])return ys[i-1]+(x-xs[i-1])*(ys[i]-ys[i-1])/(xs[i]-xs[i-1]);
  return ys[ys.length-1];
}
// Builds per-radius factor tables. cropf is 1.25 for the 1.25x crop modes. aspect is width/height of the
// image: the camera scales the corrected image so the field of view at the short-edge midpoint is kept.
export function lensTables(p,cropf=1,aspect=1.5){
  const kin=[],din=[],crin=[],cbin=[],kvig=[],vig=[];
  if(p.knots[0]>0){kin.push(0);din.push(1);crin.push(0);cbin.push(0);kvig.push(0);vig.push(1);}
  for(let i=0;i<p.nc;i++){kin.push(cropf*p.knots[i]);din.push(p.dist[i]/100+1);crin.push(p.caR[i]);cbin.push(p.caB[i]);kvig.push(cropf*p.knots[i]);vig.push(p.vig[i]?100/p.vig[i]:1);}
  // Convert from source-radius splines to destination-radius splines.
  const kd=[],dd=[],cr=[],cb=[];
  for(let i=0;i<16;i++){const rin=i/(p.nc-1),m=spline(kin,din,rin);kd.push(rin/m);dd.push(m);cr.push(spline(kin,crin,rin)+1);cb.push(spline(kin,cbin,rin)+1);}
  // Global scale g: the short-edge midpoint (radius h/2 over the half diagonal) maps onto itself.
  const rv=1/Math.hypot(aspect,1);let g=1;for(let i=0;i<30;i++)g=spline(kin,din,rv/g);
  const N=1024,fr=new Float32Array(N+1),fg=new Float32Array(N+1),fb=new Float32Array(N+1),fv=new Float32Array(N+1);
  for(let i=0;i<=N;i++){const r=i/N*1.5,rr=r/g,m=spline(kd,dd,rr)/g;fr[i]=m*spline(kd,cr,rr);fg[i]=m;fb[i]=m*spline(kd,cb,rr);fv[i]=spline(kvig,vig,r);}
  const hasVig=vig.some(x=>Math.abs(x-1)>1e-4),hasDist=dd.some(x=>Math.abs(x-1)>1e-6)||cr.some(x=>Math.abs(x-1)>1e-6)||cb.some(x=>Math.abs(x-1)>1e-6);
  return {fr,fg,fb,fv,N,hasVig,hasDist,g};
}
const toLin=new Float32Array(256),toSrgb=new Uint8Array(4097);
for(let i=0;i<256;i++){const u=i/255;toLin[i]=u<=0.04045?u/12.92:Math.pow((u+0.055)/1.055,2.4);}
for(let i=0;i<=4096;i++){const l=i/4096;const u=l<=0.0031308?l*12.92:1.055*Math.pow(l,1/2.4)-0.055;toSrgb[i]=Math.max(0,Math.min(255,Math.round(u*255)));}
// Applies vignetting (in linear light) then distortion and CA (output to input mapping, bilinear) to an 8-bit sRGB RGB image.
export function correctLens(img,t){
  const {w,h}=img;let src=img.rgb;
  const w2=w/2,h2=h/2,rf=1/Math.hypot(w2,h2),scale=t.N/1.5;
  if(t.hasVig){
    const v=new Uint8Array(src.length);
    for(let y=0,i=0;y<h;y++){const yc=y+0.5-h2;for(let x=0;x<w;x++,i+=3){const r=rf*Math.hypot(x+0.5-w2,yc),k=Math.min(t.N,r*scale)|0,f=t.fv[k];
      for(let c=0;c<3;c++){const l=toLin[src[i+c]]*f;v[i+c]=toSrgb[Math.min(4096,l*4096)|0];}}}
    src=v;
  }
  if(!t.hasDist)return {w,h,rgb:src};
  const out=new Uint8Array(src.length),tabs=[t.fr,t.fg,t.fb];
  for(let y=0,o=0;y<h;y++){const yc=y+0.5-h2;
    for(let x=0;x<w;x++,o+=3){const xc=x+0.5-w2,r=rf*Math.hypot(xc,yc),k=Math.min(t.N,r*scale)|0;
      for(let c=0;c<3;c++){const cf=tabs[c][k],sx=cf*xc+w2-0.5,sy=cf*yc+h2-0.5;
        const x0=Math.floor(sx),y0=Math.floor(sy);
        if(x0<0||y0<0||x0>=w-1||y0>=h-1){out[o+c]=0;continue;}
        const fx=sx-x0,fy=sy-y0,i=(y0*w+x0)*3+c;
        out[o+c]=src[i]*(1-fx)*(1-fy)+src[i+3]*fx*(1-fy)+src[i+w*3]*(1-fx)*fy+src[i+w*3+3]*fx*fy+0.5;
      }}}
  return {w,h,rgb:out};
}
