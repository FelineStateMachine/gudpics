// SPDX-License-Identifier: AGPL-3.0-or-later
const $=id=>document.getElementById(id);
const worker=new Worker(new URL('./elaworker.mjs',import.meta.url),{type:'module'});
let nextId=0;const pending=new Map();
worker.onmessage=({data})=>{const p=pending.get(data.id);if(!p)return;pending.delete(data.id);data.error?p.reject(Error(data.error)):p.resolve(data.result);};
worker.onerror=()=>{for(const p of pending.values())p.reject(Error('The analysis engine stopped. Reload to try again.'));pending.clear();};
const rpc=(type,args={},transfer=[])=>new Promise((resolve,reject)=>{const id=++nextId;pending.set(id,{resolve,reject});worker.postMessage({type,id,...args},transfer);});
const MAX_EDGE=4096,MAX_PIXELS=16e6;
const tool=$('tool'),canvas=$('canvas'),ctx=canvas.getContext('2d'),photo=$('photo'),stage=$('stage');
let current=null,busy=false,toastTimer,renderId=0,renderTimer,showOriginal=false,hold=false,exportCache=null,exportTimer;

function status(message,error=false){clearTimeout(toastTimer);const el=$('status');el.textContent=message;el.classList.toggle('error',error);el.hidden=!message;if(message)toastTimer=setTimeout(()=>{el.hidden=true;},error?5000:2500);}
function sync(){
  tool.dataset.state=current?'detected':'empty';const ready=Boolean(current)&&!busy;
  for(const id of ['save','share','reset','quality','scale'])$(id).disabled=!ready;
  $('open').disabled=busy;$('open-empty').disabled=busy;$('busy').hidden=!busy;$('compare').disabled=!current;
  $('quality-value').value=$('quality').value;$('scale-value').value=$('scale').value+'x';
  const orig=(showOriginal||hold)&&current;canvas.hidden=Boolean(orig);photo.hidden=!orig;$('compare').setAttribute('aria-pressed',String(Boolean(orig)));
}
function layout(){
  const cs=getComputedStyle(stage),w=stage.clientWidth-parseFloat(cs.paddingLeft)-parseFloat(cs.paddingRight),h=stage.clientHeight-parseFloat(cs.paddingTop)-parseFloat(cs.paddingBottom);
  for(const el of [canvas,photo]){if(!el.width)continue;const s=Math.min(w/el.width,h/el.height);el.style.width=Math.max(1,Math.floor(el.width*s))+'px';el.style.height=Math.max(1,Math.floor(el.height*s))+'px';}
}
new ResizeObserver(layout).observe(stage);
// JPEG quality estimate from the luminance quantization table, the inverse of the IJG scaling.
const STD=[16,11,10,16,24,40,51,61,12,12,14,19,26,58,60,55,14,13,16,24,40,57,69,56,14,17,22,29,51,87,80,62,18,22,37,56,68,109,103,77,24,35,55,64,81,104,113,92,49,64,78,87,103,121,120,101,72,92,95,98,112,100,103,99];
function estimateQuality(bytes){
  try{
    if(bytes[0]!==0xFF||bytes[1]!==0xD8)return null;
    const dv=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let p=2;
    while(p+4<=bytes.length&&bytes[p]===0xFF){
      const marker=bytes[p+1],len=dv.getUint16(p+2);
      if(marker===0xDB){let q=p+4;const end=p+2+len;while(q<end){const pq=bytes[q]>>4,id=bytes[q]&15;q++;const table=[];for(let i=0;i<64;i++){table.push(pq?dv.getUint16(q+i*2):bytes[q+i]);}q+=pq?128:64;
        if(id===0){let sum=0;for(let i=0;i<64;i++)sum+=table[i]/STD[i];const pct=sum/64*100;return Math.max(1,Math.min(100,Math.round(pct<=100?(200-pct)/2:5000/pct)));}}}
      if(marker===0xDA)break;p+=2+len;
    }
  }catch{}
  return null;
}
async function render(){
  if(!current)return;const id=++renderId;
  try{
    const r=await rpc('render',{quality:Number($('quality').value),scale:Number($('scale').value)});
    if(id!==renderId)return;
    canvas.width=r.w;canvas.height=r.h;ctx.putImageData(new ImageData(r.data,r.w,r.h),0,0);layout();
    exportCache=null;clearTimeout(exportTimer);exportTimer=setTimeout(async()=>{const blob=await new Promise(res=>canvas.toBlob(res,'image/png'));if(blob&&id===renderId)exportCache=blob;},800);
  }catch(e){status(e.message,true);}
}
function scheduleRender(){sync();clearTimeout(renderTimer);renderTimer=setTimeout(render,120);}
async function openFile(file){
  if(busy)return;busy=true;sync();
  try{
    if(!/^image\/(jpeg|png|webp)$/.test(file.type))throw Error('Choose a JPEG, PNG or WebP.');
    const bytes=new Uint8Array(await file.arrayBuffer());
    let bitmap=await createImageBitmap(file,{imageOrientation:'from-image'});
    const scale=Math.min(1,MAX_EDGE/Math.max(bitmap.width,bitmap.height),Math.sqrt(MAX_PIXELS/(bitmap.width*bitmap.height)));
    if(scale<1){const small=await createImageBitmap(bitmap,{resizeWidth:Math.round(bitmap.width*scale),resizeHeight:Math.round(bitmap.height*scale),resizeQuality:'high'});bitmap.close();bitmap=small;}
    photo.width=bitmap.width;photo.height=bitmap.height;photo.getContext('2d').drawImage(bitmap,0,0);
    const info=await rpc('load',{bitmap},[bitmap]);
    const q=file.type==='image/jpeg'?estimateQuality(bytes):null;
    current={name:file.name.replace(/\.[^.]+$/,''),w:info.w,h:info.h,q};
    $('info').textContent=[q?`JPEG ${q}`:file.type.replace('image/','').toUpperCase(),`${info.w} x ${info.h}`,scale<1?'reduced':''].filter(Boolean).join('  ');$('info').hidden=false;
    showOriginal=false;$('quality').value=95;$('scale').value=15;
    status(scale<1?'Reduced to fit. Levels are less reliable.':'');sync();await render();
  }catch(e){status(e.message||'Could not open this image.',true);}
  finally{busy=false;sync();}
}
$('quality').oninput=scheduleRender;$('scale').oninput=scheduleRender;
$('reset').onclick=()=>{$('quality').value=95;$('scale').value=15;showOriginal=false;scheduleRender();};
$('compare').onclick=()=>{showOriginal=!showOriginal;sync();};
stage.addEventListener('pointerdown',e=>{if(!current||e.target.closest('button'))return;hold=true;sync();});
for(const t of ['pointerup','pointercancel','pointerleave'])stage.addEventListener(t,()=>{if(!hold)return;hold=false;sync();});
$('file').onchange=()=>{const f=$('file').files[0];if(f)openFile(f);$('file').value='';};
$('open').onclick=()=>$('file').click();$('open-empty').onclick=()=>$('file').click();
stage.addEventListener('dragover',e=>{e.preventDefault();e.dataTransfer.dropEffect='copy';$('open-empty').classList.add('over');});
stage.addEventListener('dragleave',()=>$('open-empty').classList.remove('over'));
stage.addEventListener('drop',e=>{e.preventDefault();$('open-empty').classList.remove('over');const f=e.dataTransfer.files[0];if(f)openFile(f);});
stage.addEventListener('contextmenu',e=>e.preventDefault());
function download(blob,fname){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=fname;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
const fname=()=>`${current.name}-ela-q${$('quality').value}-x${$('scale').value}.png`;
async function pngBlob(){if(exportCache)return exportCache;const blob=await new Promise(res=>canvas.toBlob(res,'image/png'));if(!blob)throw Error('Could not encode the PNG.');return blob;}
$('save').onclick=async()=>{if(!current)return;busy=true;sync();try{download(await pngBlob(),fname());status('Saved');}catch(e){status(e.message,true);}finally{busy=false;sync();}};
if(navigator.canShare&&navigator.share)$('share').hidden=false;
$('share').onclick=()=>{
  if(!current)return;
  if(!exportCache){busy=true;sync();pngBlob().then(b=>{download(b,fname());status('Saved. Share it from your photos.');}).catch(e=>status(e.message,true)).finally(()=>{busy=false;sync();});return;}
  const file=new File([exportCache],fname(),{type:'image/png'});
  if(!navigator.canShare({files:[file]}))return status('Sharing files is not supported here.',true);
  navigator.share({files:[file]}).catch(e=>{if(e.name==='AbortError')return;download(exportCache,fname());status('Saved. Share it from your photos.');});
};
if('serviceWorker'in navigator){navigator.serviceWorker.register('./sw.js').catch(()=>{});let hadController=Boolean(navigator.serviceWorker.controller);navigator.serviceWorker.addEventListener('controllerchange',()=>{if(hadController&&!current)location.reload();hadController=true;});}
sync();
