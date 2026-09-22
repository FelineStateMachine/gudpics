// Behavior tests on the real extracted WASM, not a mocked detector.
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import createCore from '../assets/core.mjs';
import {project,inverse,cropRect} from '../geometry.mjs';
const core=await createCore();
const w=700,h=560;
const distortion=[1,.12,15,.045,1,12,.00005,.00036,1];
const inv=inverse(distortion),image=new Uint8Array(w*h*4);
for(let y=0;y<h;y++)for(let x=0;x<w;x++){
  const [u,v]=project(inv,x,y);
  const interior=u>30&&u<640&&v>30&&v<560;
  const ink=interior&&((u%83)<4||(v%81)<4);
  const val=ink?35:interior?235:185;
  const i=(y*w+x)*4;image[i]=image[i+1]=image[i+2]=val;image[i+3]=255;
}
const p=core._malloc(image.byteLength);core.HEAPU8.set(image,p);
const n=core._detect(p,w,h);assert(n>20,`Only ${n} lines detected`);
const l=core._lines()/4,lines=Array.from(core.HEAPF32.subarray(l,l+n*6));
const rms=(matrix,mode=3)=>{
  let sum=0,count=0;
  for(let i=0;i<lines.length;i+=6){const t=lines[i+4];if(!(t&4)||!(t&1))continue;
    const vertical=t&2;if(mode===1&&!vertical||mode===2&&vertical)continue;
    const a=project(matrix,lines[i],lines[i+1]),b=project(matrix,lines[i+2],lines[i+3]);
    const dx=Math.abs(b[0]-a[0]),dy=Math.abs(b[1]-a[1]);
    const angle=Math.atan2(vertical?dx:dy,vertical?dy:dx)*180/Math.PI;sum+=angle*angle;count++;
  }
  assert(count>=2);return Math.sqrt(sum/count);
};
const identity=[1,0,0,0,1,0,0,0,1];
for(const mode of [1,2,3]){
  const code=core._fit(mode);assert.equal(code,0,`fit mode ${mode} failed`);
  const pp=core._parameters()/4,params=Array.from(core.HEAPF32.subarray(pp,pp+4));
  const mp=core._matrix(w,h,...params)/4+4,m=Array.from(core.HEAPF32.subarray(mp,mp+9));
  const before=rms(identity,mode),after=rms(m,mode);
  assert(after<.7&&after<before*.2,`Mode ${mode}: ${before} -> ${after}`);
  for(const cropMode of ['largest','original']){
    const crop=cropRect(m,w,h,cropMode),back=inverse(m);
    if(cropMode==='original')assert(Math.abs(crop.w/crop.h-w/h)<1e-6);
    for(const x of [crop.x,crop.x+crop.w])for(const y of [crop.y,crop.y+crop.h]){
      const [sx,sy]=project(back,x,y);assert(sx>=.9&&sy>=.9&&sx<=w-1.9&&sy<=h-1.9,'Crop leaks outside image');
    }
  }
  console.log(`PASS mode ${mode}: ${before.toFixed(3)}° → ${after.toFixed(3)}° RMS; crop contained`);
}
// A flat photo must fail gracefully instead of inventing a correction.
image.fill(255);core.HEAPU8.set(image,p);assert.equal(core._detect(p,w,h),0);assert.equal(core._fit(3),1);
assert.equal(core._detect(p,1,h),-1);
core._free(p);
assert.throws(()=>cropRect([1,0,0,0,1,0,-.01,0,1],w,h));
console.log('PASS blank image, invalid dimensions, folded homography');
