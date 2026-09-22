// SPDX-License-Identifier: AGPL-3.0-or-later
// Develops Fujifilm RAF files with LibRaw and applies film simulation LUTs off the main thread.
import createRaw from './assets/raw.mjs';
const corePromise=createRaw();
const N=33; // neutral LUT grid
let full=null,preview=null; // {w,h,rgb:Uint8Array}
let luts={neutral:{},sim:{}}; // decoded LUT tables: neutral[dr] = Uint8Array(N^3*3), sim[name] = Uint8Array(16^3*3)
let composed=new Map(); // key dr:sim -> Uint8Array(N^3*3)

function downscale(src,w,h,factor){
  const ow=Math.floor(w/factor),oh=Math.floor(h/factor),out=new Uint8Array(ow*oh*3),n=factor*factor;
  for(let y=0;y<oh;y++)for(let x=0;x<ow;x++){
    let r=0,g=0,b=0;
    for(let dy=0;dy<factor;dy++){let i=((y*factor+dy)*w+x*factor)*3;for(let dx=0;dx<factor;dx++){r+=src[i];g+=src[i+1];b+=src[i+2];i+=3;}}
    const o=(y*ow+x)*3;out[o]=r/n;out[o+1]=g/n;out[o+2]=b/n;
  }
  return {w:ow,h:oh,rgb:out};
}
// Trilinear sample of a cubic LUT laid out [b][g][r] with `size` points per axis; input coords in [0,size-1].
function sample(lut,size,r,g,b,out,o){
  let ri=Math.floor(r),gi=Math.floor(g),bi=Math.floor(b);
  if(ri>=size-1)ri=size-2;if(gi>=size-1)gi=size-2;if(bi>=size-1)bi=size-2;
  const fr=r-ri,fg=g-gi,fb=b-bi,s2=size*size;
  const i000=((bi*size+gi)*size+ri)*3,i100=i000+3,i010=i000+size*3,i110=i010+3,i001=i000+s2*3,i101=i001+3,i011=i001+size*3,i111=i011+3;
  for(let c=0;c<3;c++){
    const c00=lut[i000+c]*(1-fr)+lut[i100+c]*fr,c10=lut[i010+c]*(1-fr)+lut[i110+c]*fr;
    const c01=lut[i001+c]*(1-fr)+lut[i101+c]*fr,c11=lut[i011+c]*(1-fr)+lut[i111+c]*fr;
    out[o+c]=(c00*(1-fg)+c10*fg)*(1-fb)+(c01*(1-fg)+c11*fg)*fb;
  }
}
function compose(dr,sim){
  const key=dr+':'+sim;if(composed.has(key))return composed.get(key);
  const neutral=luts.neutral[dr],simLut=sim==='neutral'?null:luts.sim[sim];
  if(!neutral||(sim!=='neutral'&&!simLut))throw Error('Look not loaded.');
  const table=new Uint8Array(N*N*N*3),tmp=new Float32Array(3);
  for(let i=0;i<N*N*N;i++){
    const r=neutral[i*3],g=neutral[i*3+1],b=neutral[i*3+2];
    if(simLut){sample(simLut,16,r/17,g/17,b/17,tmp,0);table[i*3]=tmp[0]+.5;table[i*3+1]=tmp[1]+.5;table[i*3+2]=tmp[2]+.5;}
    else{table[i*3]=r;table[i*3+1]=g;table[i*3+2]=b;}
  }
  composed.set(key,table);return table;
}
function render(img,table){
  const {w,h,rgb}=img,out=new Uint8ClampedArray(w*h*4),tmp=new Float32Array(3),k=(N-1)/255;
  for(let i=0,o=0;i<rgb.length;i+=3,o+=4){
    sample(table,N,rgb[i]*k,rgb[i+1]*k,rgb[i+2]*k,tmp,0);
    out[o]=tmp[0]+.5;out[o+1]=tmp[1]+.5;out[o+2]=tmp[2]+.5;out[o+3]=255;
  }
  return {w,h,data:out};
}
async function open(buffer){
  const core=await corePromise;
  const p=core._malloc(buffer.byteLength);if(!p)throw Error('Not enough memory for this file.');
  core.HEAPU8.set(new Uint8Array(buffer),p);
  try{
    let r=core._raw_open(p,buffer.byteLength);if(r)throw Error('LibRaw could not read this file.');
    const info={make:core.UTF8ToString(core._raw_make()),model:core.UTF8ToString(core._raw_model()),width:core._raw_width(),height:core._raw_height(),film:core._raw_film_mode(),dr:[core._raw_dev_dr(),core._raw_auto_dr()].find(v=>v===100||v===200||v===400)||100,xtrans:Boolean(core._raw_is_xtrans())};
    if(!/fuji/i.test(info.make))throw Error('Only Fujifilm RAF files are supported.');
    r=core._raw_develop(1,1,1,8);if(r)throw Error('Developing failed.');
    const w=core._raw_out_width(),h=core._raw_out_height(),d=core._raw_data();
    full={w,h,rgb:core.HEAPU8.slice(d,d+w*h*3)};
    const factor=Math.max(1,Math.ceil(Math.max(w,h)/1600));
    preview=factor>1?downscale(full.rgb,w,h,factor):full;
    return info;
  }finally{core._raw_free();core._free(p);}
}
self.onmessage=async({data})=>{
  try{
    let result,transfer=[];
    if(data.type==='open'){result=await open(data.buffer);}
    else if(data.type==='lut'){luts[data.kind][data.name]=data.table;composed.clear();result={ok:true};}
    else if(data.type==='render'){const img=data.full?full:preview;if(!img)throw Error('Open a RAF first.');result=render(img,compose(data.dr,data.sim));transfer=[result.data.buffer];}
    else if(data.type==='close'){full=preview=null;result={ok:true};}
    else throw Error('Unknown operation.');
    self.postMessage({id:data.id,result},transfer);
  }catch(e){self.postMessage({id:data.id,error:e.message||'Could not process this file.'});}
};
