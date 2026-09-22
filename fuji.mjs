// SPDX-License-Identifier: AGPL-3.0-or-later
import {parseRaf} from './raf.mjs';
const $=id=>document.getElementById(id);
const worker=new Worker(new URL('./rawworker.mjs',import.meta.url),{type:'module'});
let nextId=0;const pending=new Map();
worker.onmessage=({data})=>{const p=pending.get(data.id);if(!p)return;pending.delete(data.id);data.error?p.reject(Error(data.error)):p.resolve(data.result);};
worker.onerror=()=>{for(const p of pending.values())p.reject(Error('The raw engine stopped. Reload to try again.'));pending.clear();};
const rpc=(type,args={},transfer=[])=>new Promise((resolve,reject)=>{const id=++nextId;pending.set(id,{resolve,reject});worker.postMessage({type,id,...args},transfer);});

// Film simulation LUTs (GPL, see NOTICE.md). Names are the looks being approximated.
const SIMS=[
  ['provia','Provia'],['velvia','Velvia'],['astia','Astia'],['classic_chrome','Classic Chrome'],['pro_neg_high','Pro Neg. Hi'],['pro_neg_std','Pro Neg. Std'],['eterna','Eterna'],
  ['acros','Acros'],['acros-red','Acros+R'],['acros-yellow','Acros+Ye'],['acros-green','Acros+G'],['mono','Mono'],['mono-red','Mono+R'],['mono-yellow','Mono+Ye'],['mono-green','Mono+G'],['sepia','Sepia']];
const LUT_URLS={
  provia:new URL('./assets/luts/provia.png',import.meta.url),velvia:new URL('./assets/luts/velvia.png',import.meta.url),astia:new URL('./assets/luts/astia.png',import.meta.url),
  classic_chrome:new URL('./assets/luts/classic_chrome.png',import.meta.url),pro_neg_high:new URL('./assets/luts/pro_neg_high.png',import.meta.url),pro_neg_std:new URL('./assets/luts/pro_neg_std.png',import.meta.url),
  eterna:new URL('./assets/luts/eterna.png',import.meta.url),acros:new URL('./assets/luts/acros.png',import.meta.url),'acros-red':new URL('./assets/luts/acros-red.png',import.meta.url),
  'acros-yellow':new URL('./assets/luts/acros-yellow.png',import.meta.url),'acros-green':new URL('./assets/luts/acros-green.png',import.meta.url),mono:new URL('./assets/luts/mono.png',import.meta.url),
  'mono-red':new URL('./assets/luts/mono-red.png',import.meta.url),'mono-yellow':new URL('./assets/luts/mono-yellow.png',import.meta.url),'mono-green':new URL('./assets/luts/mono-green.png',import.meta.url),
  sepia:new URL('./assets/luts/sepia.png',import.meta.url)};
const NEUTRAL_URLS={100:new URL('./assets/luts/neutral-dr100.png',import.meta.url),200:new URL('./assets/luts/neutral-dr200.png',import.meta.url),400:new URL('./assets/luts/neutral-dr400.png',import.meta.url)};
// Camera film mode and monochrome names (from the RAF makernote) to our LUT names.
const FROM_CAMERA={'Provia':'provia','Velvia':'velvia','Astia':'astia','Classic Chrome':'classic_chrome','Pro Neg. Hi':'pro_neg_high','Pro Neg. Std':'pro_neg_std','Eterna':'eterna',
  'Acros':'acros','Acros+R':'acros-red','Acros+Ye':'acros-yellow','Acros+G':'acros-green','Monochrome':'mono','Monochrome+R':'mono-red','Monochrome+Ye':'mono-yellow','Monochrome+G':'mono-green','Sepia':'sepia'};

const tool=$('tool'),canvas=$('canvas'),ctx=canvas.getContext('2d'),photo=$('photo');
let current=null,busy=false,toastTimer,sim='provia',dr=100,showCamera=false,holdCamera=false,renderId=0,cameraUrl=null;
const loaded=new Set(),loading=new Map();

function status(message,error=false){clearTimeout(toastTimer);const el=$('status');el.textContent=message;el.classList.toggle('error',error);el.hidden=!message;if(message)toastTimer=setTimeout(()=>{el.hidden=true;},error?5000:2500);}
function sync(){
  tool.dataset.state=current?'detected':'empty';
  $('save').disabled=!current||busy;$('share').disabled=!current||busy;$('open').disabled=busy;$('open-empty').disabled=busy;$('compare').disabled=!current||!current.camera;
  $('busy').hidden=!busy;
  for(const b of $('sims').children){b.setAttribute('aria-checked',String(b.dataset.sim===sim));b.disabled=!current||busy;}
  const cam=(showCamera||holdCamera)&&current?.camera;
  canvas.hidden=Boolean(cam);photo.hidden=!cam;$('compare').setAttribute('aria-pressed',String(Boolean(cam)));
}
async function decodeLut(url){
  const bitmap=await createImageBitmap(await (await fetch(url)).blob());
  const c=document.createElement('canvas');c.width=bitmap.width;c.height=bitmap.height;const x=c.getContext('2d');x.drawImage(bitmap,0,0);
  const d=x.getImageData(0,0,c.width,c.height).data,out=new Uint8Array(c.width*c.height*3);
  for(let i=0,o=0;i<d.length;i+=4,o+=3){out[o]=d[i];out[o+1]=d[i+1];out[o+2]=d[i+2];}
  return out;
}
function ensureLut(kind,name,url){
  const key=kind+':'+name;if(loaded.has(key))return Promise.resolve();
  if(!loading.has(key))loading.set(key,decodeLut(url).then(table=>rpc('lut',{kind,name,table},[table.buffer])).then(()=>{loaded.add(key);}).catch(e=>{loading.delete(key);throw e;}));
  return loading.get(key);
}
async function render(){
  if(!current)return;const id=++renderId;
  try{
    await Promise.all([ensureLut('neutral',dr,NEUTRAL_URLS[dr]||NEUTRAL_URLS[100]),ensureLut('sim',sim,LUT_URLS[sim])]);
    const r=await rpc('render',{dr:NEUTRAL_URLS[dr]?dr:100,sim});
    if(id!==renderId)return;
    canvas.width=r.w;canvas.height=r.h;ctx.putImageData(new ImageData(r.data,r.w,r.h),0,0);
  }catch(e){status(e.message,true);}
}
async function openFile(file){
  if(busy)return;busy=true;sync();
  try{
    if(file.size>200*1024*1024)throw Error('Choose a RAF smaller than 200 MB.');
    const buffer=await file.arrayBuffer();
    let camera=null,shot='';
    try{const r=parseRaf(buffer.slice(0));camera=new Blob([r.jpeg],{type:'image/jpeg'});shot=r.simulation;}catch{}
    const info=await rpc('open',{buffer},[buffer]);
    if(cameraUrl)URL.revokeObjectURL(cameraUrl);cameraUrl=camera?URL.createObjectURL(camera):null;photo.src=cameraUrl||'';
    current={name:file.name.replace(/\.[^.]+$/,''),camera,info};
    dr=[100,200,400].includes(info.dr)?info.dr:100;sim=FROM_CAMERA[shot]||'provia';showCamera=false;
    $('info').textContent=[info.model,shot,dr!==100?'DR'+dr:''].filter(Boolean).join('  ');$('info').hidden=false;
    sync();await render();
  }catch(e){status(e.message||'Could not read this file.',true);}
  finally{busy=false;sync();}
}
// Chips
for(const [name,label] of SIMS){const b=document.createElement('button');b.className='chip-btn';b.role='radio';b.dataset.sim=name;b.textContent=label;b.disabled=true;b.onclick=()=>{sim=name;showCamera=false;sync();render();b.scrollIntoView({inline:'center',block:'nearest',behavior:'smooth'});};$('sims').append(b);}
$('file').onchange=()=>{const f=$('file').files[0];if(f)openFile(f);$('file').value='';};
$('open').onclick=()=>$('file').click();$('open-empty').onclick=()=>$('file').click();
const stage=$('stage'),zone=$('open-empty');
stage.addEventListener('dragover',e=>{e.preventDefault();e.dataTransfer.dropEffect='copy';zone.classList.add('over');});
stage.addEventListener('dragleave',()=>zone.classList.remove('over'));
stage.addEventListener('drop',e=>{e.preventDefault();zone.classList.remove('over');const f=e.dataTransfer.files[0];if(f)openFile(f);});
stage.addEventListener('contextmenu',e=>e.preventDefault());
stage.addEventListener('pointerdown',e=>{if(!current?.camera||busy||e.target.closest('button'))return;holdCamera=true;sync();});
for(const t of ['pointerup','pointercancel','pointerleave'])stage.addEventListener(t,()=>{if(!holdCamera)return;holdCamera=false;sync();});
$('compare').onclick=()=>{showCamera=!showCamera;sync();};
// Save
const saveSheet=$('save-sheet');for(const b of saveSheet.querySelectorAll('[data-close]'))b.onclick=()=>saveSheet.close();saveSheet.addEventListener('click',e=>{if(e.target===saveSheet)saveSheet.close();});
$('save').onclick=()=>saveSheet.showModal();
for(const b of saveSheet.querySelectorAll('[data-save]'))b.onclick=()=>{saveSheet.close();save(b.dataset.save);};
function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
async function developedBlob(){
  const r=await rpc('render',{dr:NEUTRAL_URLS[dr]?dr:100,sim,full:true});
  const c=document.createElement('canvas');c.width=r.w;c.height=r.h;c.getContext('2d').putImageData(new ImageData(r.data,r.w,r.h),0,0);
  const blob=await new Promise(res=>c.toBlob(res,'image/jpeg',0.94));if(!blob)throw Error('Could not encode the JPEG.');return {blob,w:r.w,h:r.h};
}
async function save(what){
  if(!current)return;busy=true;sync();
  try{
    if(what==='camera'){if(!current.camera)throw Error('No camera JPEG in this file.');download(current.camera,current.name+'.jpg');status('Saved camera JPG');}
    else{const {blob,w,h}=await developedBlob();download(blob,`${current.name}-${sim}.jpg`);status(`Saved ${w} x ${h}`);}
  }catch(e){status(e.message,true);}finally{busy=false;sync();}
}
if(navigator.canShare&&navigator.share)$('share').hidden=false;
$('share').onclick=async()=>{
  if(!current)return;busy=true;sync();
  try{const {blob}=await developedBlob();const file=new File([blob],`${current.name}-${sim}.jpg`,{type:'image/jpeg'});
    if(!navigator.canShare({files:[file]}))throw Error('Sharing files is not supported here.');await navigator.share({files:[file]});}
  catch(e){if(e.name!=='AbortError')status(e.message,true);}finally{busy=false;sync();}
};
if('serviceWorker'in navigator){navigator.serviceWorker.register('./sw.js').catch(()=>{});let hadController=Boolean(navigator.serviceWorker.controller);navigator.serviceWorker.addEventListener('controllerchange',()=>{if(hadController&&!current)location.reload();hadController=true;});}
sync();
