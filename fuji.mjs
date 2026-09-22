// SPDX-License-Identifier: AGPL-3.0-or-later
import {parseRaf} from './raf.mjs';
const $=id=>document.getElementById(id);
const tool=$('tool'),photo=$('photo');
let current=null,filename='photo',busy=false,toastTimer,previewUrl;
function status(message,error=false){clearTimeout(toastTimer);const el=$('status');el.textContent=message;el.classList.toggle('error',error);el.hidden=!message;if(message)toastTimer=setTimeout(()=>{el.hidden=true;},error?5000:2500);}
function sync(){
  tool.dataset.state=current?'loaded':'empty';
  $('save').disabled=!current||busy;$('share').disabled=!current||busy;$('open').disabled=busy;$('open-empty').disabled=busy;
  $('busy').hidden=!busy;
}
function fmtDate(s){const m=/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2})/.exec(s||'');return m?`${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`:'-';}
async function openFile(file){
  if(busy)return;busy=true;sync();
  try{
    if(file.size>200*1024*1024)throw Error('Choose a RAF smaller than 200 MB.');
    const r=parseRaf(await file.arrayBuffer());
    if(previewUrl)URL.revokeObjectURL(previewUrl);
    const blob=new Blob([r.jpeg],{type:'image/jpeg'});
    previewUrl=URL.createObjectURL(blob);
    await new Promise((res,rej)=>{photo.onload=res;photo.onerror=()=>rej(Error('The embedded JPEG could not be decoded.'));photo.src=previewUrl;});
    current={blob,name:file.name.replace(/\.[^.]+$/,'')+'.jpg'};
    filename=current.name;
    $('camera').textContent=r.camera||r.model||'-';
    $('simulation').textContent=r.simulation||'-';
    $('size').textContent=r.width?`${r.width} x ${r.height}, ${(r.jpeg.length/1e6).toFixed(1)} MB`:`${(r.jpeg.length/1e6).toFixed(1)} MB`;
    $('date').textContent=fmtDate(r.date);
    status('');
  }catch(e){status(e.message||'Could not read this file.',true);}
  finally{busy=false;sync();}
}
$('file').onchange=()=>{const f=$('file').files[0];if(f)openFile(f);$('file').value='';};
$('open').onclick=()=>$('file').click();$('open-empty').onclick=()=>$('file').click();
const stage=$('stage'),zone=$('open-empty');
stage.addEventListener('dragover',e=>{e.preventDefault();e.dataTransfer.dropEffect='copy';zone.classList.add('over');});
stage.addEventListener('dragleave',()=>zone.classList.remove('over'));
stage.addEventListener('drop',e=>{e.preventDefault();zone.classList.remove('over');const f=e.dataTransfer.files[0];if(f)openFile(f);});
stage.addEventListener('contextmenu',e=>e.preventDefault());
$('save').onclick=()=>{
  if(!current)return;
  const url=URL.createObjectURL(current.blob),a=document.createElement('a');a.href=url;a.download=current.name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
  status('Saved');
};
// Share sheet is the native way to get a file into the photo library on phones.
const canShare=Boolean(navigator.canShare&&navigator.share);
if(canShare)$('share').hidden=false;
$('share').onclick=async()=>{
  if(!current)return;
  const file=new File([current.blob],current.name,{type:'image/jpeg'});
  if(!navigator.canShare({files:[file]}))return status('Sharing files is not supported here.',true);
  try{await navigator.share({files:[file]});}catch(e){if(e.name!=='AbortError')status(e.message,true);}
};
if('serviceWorker'in navigator){navigator.serviceWorker.register('./sw.js').catch(()=>{});let hadController=Boolean(navigator.serviceWorker.controller);navigator.serviceWorker.addEventListener('controllerchange',()=>{if(hadController&&!current)location.reload();hadController=true;});}
sync();
