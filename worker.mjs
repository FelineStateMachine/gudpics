// SPDX-License-Identifier: AGPL-3.0-or-later
import createCore from './assets/core.mjs';
import {cropRect,inverse} from './geometry.mjs';
const corePromise=createCore();
let photo=null, preview=null, detected=false;
function alloc(core,data) {
  const p=core._malloc(data.byteLength);
  if(!p) throw Error('Not enough memory. Try a smaller photo.');
  core.HEAPU8.set(new Uint8Array(data.buffer,data.byteOffset,data.byteLength),p);
  return p;
}
async function handle(msg) {
  const core=await corePromise;
  if(msg.type==='init') return {ready:true};
  if(msg.type==='load') {photo=msg.photo;preview=msg.preview;detected=false;return {loaded:true};}
  if(msg.type==='detect') {
    detected=false;
    const p=alloc(core,msg.pixels);
    let n;
    try {n=core._detect(p,msg.w,msg.h);} finally {core._free(p);}
    if(n<0) throw Error('Line detection could not finish. Try a smaller photo.');
    detected=true;
    const ptr=core._lines();
    const lines=Array.from(core.HEAPF32.subarray(ptr/4,ptr/4+n*6));
    return {lines,w:msg.w,h:msg.h};
  }
  if(msg.type==='fit') {
    if(!detected) throw Error('Find the structure first.');
    const code=core._fit(msg.mode);
    if(code) throw Error(code===1?'Not enough matching lines. Try another direction or a more architectural photo.':code===2?'The fit did not settle. Try vertical or horizontal correction on its own.':'This fit would stretch the photo too far. Try another direction.');
    const p=core._parameters()/4;
    return {params:Array.from(core.HEAPF32.subarray(p,p+4))};
  }
  if(msg.type==='render') {
    const src=msg.export?photo:preview;
    if(!src) throw Error('Open a photo first.');
    const p=core._matrix(src.w,src.h,...msg.params)/4;
    const matrix=Array.from(core.HEAPF32.subarray(p+4,p+13));
    const crop=cropRect(matrix,src.w,src.h,msg.crop);
    const max=msg.export?2560:1200;
    const scale=Math.min(1,max/Math.max(crop.w,crop.h),Math.sqrt(4e6/(crop.w*crop.h)));
    const w=Math.max(2,Math.round(crop.w*scale)),h=Math.max(2,Math.round(crop.h*scale));
    const pointers=[];
    try {
      const input=alloc(core,src.pixels);pointers.push(input);
      const transform=alloc(core,new Float32Array(inverse(matrix)));pointers.push(transform);
      const output=core._malloc(w*h*4); if(!output) throw Error('Not enough memory for export.');pointers.push(output);
      core._warp(input,src.w,src.h,output,w,h,transform,crop.x,crop.y,crop.w,crop.h);
      const pixels=core.HEAPU8.slice(output,output+w*h*4);
      return {pixels,w,h,crop,matrix,sourceWidth:src.w,sourceHeight:src.h};
    } finally {pointers.forEach(p=>core._free(p));}
  }
  throw Error('Unknown operation.');
}
// Serialize requests: fitting and rendering share the same WASM module state.
let queue=Promise.resolve();
self.onmessage=({data})=>{
  queue=queue.then(async()=>{
    try {
      const result=await handle(data);
      self.postMessage({id:data.id,result},result.pixels?[result.pixels.buffer]:[]);
    } catch(error) {self.postMessage({id:data.id,error:error.message||'Could not process this photo.'});}
  });
};
