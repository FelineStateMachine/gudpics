// SPDX-License-Identifier: AGPL-3.0-or-later
import {project} from './geometry.mjs';
const $=id=>document.getElementById(id);
const worker=new Worker(new URL('./worker.mjs',import.meta.url),{type:'module'});
let nextId=0;const pending=new Map();
worker.onmessage=({data})=>{const p=pending.get(data.id);if(!p)return;pending.delete(data.id);data.error?p.reject(Error(data.error)):p.resolve(data.result);};
worker.onerror=()=>{for(const p of pending.values())p.reject(Error('The photo engine stopped. Reload to try again.'));pending.clear();};
function rpc(type,args={},transfer=[]) {return new Promise((resolve,reject)=>{const id=++nextId;pending.set(id,{resolve,reject});worker.postMessage({type,id,...args},transfer);});}

const tool=$('tool'),canvas=$('canvas'),overlay=$('overlay'),ctx=canvas.getContext('2d');
let original=null,rendered=null,lines=[],analysisSize=null,base=[0,0,0,0],activeMode=null,showBefore=false,holdBefore=false,busy=false,hasDetected=false,renderId=0;
let filename='photo',lastRender=null,renderTimer,cropMode='largest',showLines=true,showGuides=false;
const fitButtons=[...document.querySelectorAll('[data-mode]')];

let toastTimer;
function status(message,error=false){clearTimeout(toastTimer);const el=$('status');el.textContent=message;el.classList.toggle('error',error);el.hidden=!message;if(message)toastTimer=setTimeout(()=>{el.hidden=true;},error?5000:2500);}
function syncControls(){
  const ready=Boolean(original)&&!busy;
  tool.dataset.state=!original?'empty':hasDetected?'detected':'loaded';
  for(const id of ['detect','rotation','crop','reset','save','lines','guides'])$(id).disabled=!ready;
  $('open').disabled=busy;$('open-empty').disabled=busy;
  $('strength').disabled=!ready||activeMode===null;
  $('strength-row').classList.toggle('disabled',$('strength').disabled);
  $('rotation-row').classList.toggle('disabled',!ready);
  $('compare').disabled=!ready||!rendered;
  fitButtons.forEach(b=>{b.disabled=!ready||!hasDetected;b.setAttribute('aria-pressed',Number(b.dataset.mode)===activeMode?'true':'false');});
  $('lines').setAttribute('aria-pressed',String(showLines));$('guides').setAttribute('aria-pressed',String(showGuides));
}
function setBusy(value) {busy=value;$('busy').hidden=!value;syncControls();}
function currentParams(){const s=Number($('strength').value)/100;return [Number($('rotation').value),base[1]*s,base[2]*s,base[3]*s];}
function updateLabels(){const r=Number($('rotation').value);$('rotation-value').value=`${r>0?'+':''}${r.toFixed(2)}°`;$('strength-value').value=`${$('strength').value}%`;}
function draw(){
  const before=showBefore||holdBefore,source=before||!rendered?original:rendered;
  if(!source)return;
  canvas.width=source.width;canvas.height=source.height;ctx.drawImage(source,0,0);
  $('compare').setAttribute('aria-pressed',String(before&&Boolean(rendered)));
  drawOverlay();
}
function drawOverlay(){
  overlay.width=canvas.width;overlay.height=canvas.height;
  const c=overlay.getContext('2d'),scale=canvas.width/Math.max(canvas.clientWidth,1),before=showBefore||holdBefore;
  if(showGuides){c.strokeStyle='#fff9';c.lineWidth=scale*.75;c.beginPath();for(let i=1;i<4;i++){c.moveTo(i*canvas.width/4,0);c.lineTo(i*canvas.width/4,canvas.height);c.moveTo(0,i*canvas.height/4);c.lineTo(canvas.width,i*canvas.height/4);}c.stroke();}
  if(!showLines||!analysisSize)return;
  const transform=(x,y)=>{
    if(before||!rendered||!lastRender)return [x/analysisSize.w*canvas.width,y/analysisSize.h*canvas.height];
    const r=lastRender,p=project(r.matrix,x/analysisSize.w*r.sourceWidth,y/analysisSize.h*r.sourceHeight);
    return [(p[0]-r.crop.x)/r.crop.w*canvas.width,(p[1]-r.crop.y)/r.crop.h*canvas.height];
  };
  const rejectedToo=$('show-rejected').checked;
  for(let i=0;i<lines.length;i+=6){
    const type=lines[i+4],selected=type&4,vertical=type&2;
    if(!selected&&!rejectedToo)continue;
    const color=!(type&1)?'#8d979a':vertical?(selected?'#6af074':'#ff706b'):(selected?'#5e9dff':'#ffe15c');
    try{const a=transform(lines[i],lines[i+1]),b=transform(lines[i+2],lines[i+3]);c.beginPath();c.moveTo(...a);c.lineTo(...b);c.strokeStyle='#00000066';c.lineWidth=3*scale;c.stroke();c.strokeStyle=color;c.lineWidth=1.25*scale;c.stroke();}catch{}
  }
}
function scaledCanvas(source,max){const c=document.createElement('canvas');const s=Math.min(1,max/Math.max(source.width,source.height),Math.sqrt(4e6/(source.width*source.height)));c.width=Math.max(2,Math.round(source.width*s));c.height=Math.max(2,Math.round(source.height*s));const x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,c.width,c.height);x.drawImage(source,0,0,c.width,c.height);return c;}
const pixels=c=>({w:c.width,h:c.height,pixels:c.getContext('2d').getImageData(0,0,c.width,c.height).data});
function resetValues(){base=[0,0,0,0];activeMode=null;showBefore=false;rendered=null;lastRender=null;$('rotation').value=0;$('strength').value=100;updateLabels();}
async function load(source,name){
  clearTimeout(renderTimer);renderId++;resetValues();hasDetected=false;lines=[];analysisSize=null;
  filename=name.replace(/\.[^.]+$/,'');
  const full=scaledCanvas(source,2560);original=scaledCanvas(full,1200);
  const a=pixels(full),b=pixels(original);
  await rpc('load',{photo:a,preview:b},[a.pixels.buffer,b.pixels.buffer]);
  $('line-count').textContent='';
  draw();status('');
}
async function detect(){
  setBusy(true);
  try{
    const a=pixels(scaledCanvas(original,960)),start=performance.now();
    const result=await rpc('detect',{...a},[a.pixels.buffer]);
    lines=result.lines;analysisSize={w:result.w,h:result.h};hasDetected=true;showLines=true;
    let v=0,h=0,rejected=0,other=0;
    for(let i=4;i<lines.length;i+=6){const t=lines[i];if(!(t&1))other++;else if(!(t&4))rejected++;else if(t&2)v++;else h++;}
    $('line-count').textContent=`${v+h} lines`;
    $('debug-counts').textContent=`${v} vertical and ${h} horizontal lines used. ${rejected} rejected, ${other} other edges, ${lines.length/6} found in ${Math.round(performance.now()-start)} ms.`;
    status(v+h>=2?'':'Few usable lines. Try clearer straight edges.',v+h<2);drawOverlay();
  }catch(e){hasDetected=false;status(e.message,true);}finally{setBusy(false);}
}
async function render(exporting=false){
  const id=++renderId;
  const result=await rpc('render',{params:currentParams(),crop:cropMode,export:exporting});
  const c=document.createElement('canvas');c.width=result.w;c.height=result.h;c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(result.pixels),result.w,result.h),0,0);
  if(exporting)return c;
  if(id!==renderId)return;
  rendered=c;lastRender=result;showBefore=false;draw();syncControls();
}
async function fit(mode){
  clearTimeout(renderTimer);setBusy(true);
  const old={base:base.slice(),mode:activeMode,rotation:$('rotation').value};
  try{const r=await rpc('fit',{mode});base=r.params;activeMode=mode;$('rotation').value=base[0];$('strength').value=100;updateLabels();await render();}
  catch(e){base=old.base;activeMode=old.mode;$('rotation').value=old.rotation;updateLabels();status(e.message,true);}finally{setBusy(false);}
}
function scheduleRender(){updateLabels();clearTimeout(renderTimer);renderTimer=setTimeout(()=>{render().catch(e=>status(e.message,true));},100);}

$('detect').onclick=detect;fitButtons.forEach(b=>b.onclick=()=>fit(Number(b.dataset.mode)));
$('rotation').oninput=scheduleRender;$('strength').oninput=scheduleRender;
$('lines').onclick=()=>{showLines=!showLines;syncControls();drawOverlay();};
$('guides').onclick=()=>{showGuides=!showGuides;syncControls();drawOverlay();};
$('show-rejected').onchange=drawOverlay;
$('compare').onclick=()=>{showBefore=!showBefore;draw();};
$('reset').onclick=()=>{clearTimeout(renderTimer);renderId++;resetValues();cropMode='largest';syncCrop();draw();syncControls();status('');};

// Press and hold the photo to peek at the original.
const stage=$('stage');
stage.addEventListener('pointerdown',e=>{if(!rendered||busy||e.target.closest('button'))return;holdBefore=true;draw();});
for(const type of ['pointerup','pointercancel','pointerleave'])stage.addEventListener(type,()=>{if(!holdBefore)return;holdBefore=false;draw();});
stage.addEventListener('contextmenu',e=>e.preventDefault());
// Drag and drop onto the stage.
const zone=$('open-empty');
stage.addEventListener('dragover',e=>{e.preventDefault();e.dataTransfer.dropEffect='copy';zone.classList.add('over');});
stage.addEventListener('dragleave',()=>zone.classList.remove('over'));
stage.addEventListener('drop',e=>{e.preventDefault();zone.classList.remove('over');const file=e.dataTransfer.files[0];if(file)openFile(file);});

// Sheets
function sheet(id){const d=$(id);d.onclick=e=>{if(e.target===d||e.target.closest('[data-close]'))d.close();};return d;}
const cropSheet=sheet('crop-sheet'),saveSheet=sheet('save-sheet'),linesSheet=sheet('lines-sheet');
function syncCrop(){for(const b of cropSheet.querySelectorAll('[data-crop]'))b.setAttribute('aria-checked',String(b.dataset.crop===cropMode));}
$('crop').onclick=()=>cropSheet.showModal();
for(const b of cropSheet.querySelectorAll('[data-crop]'))b.onclick=()=>{cropMode=b.dataset.crop;syncCrop();cropSheet.close();if(rendered)scheduleRender();};
$('line-chip').onclick=()=>linesSheet.showModal();
$('save').onclick=()=>saveSheet.showModal();
for(const b of saveSheet.querySelectorAll('[data-format]'))b.onclick=()=>{saveSheet.close();save(b.dataset.format);};

$('open').onclick=()=>$('file').click();$('open-empty').onclick=()=>$('file').click();
$('file').onchange=()=>{const file=$('file').files[0];if(file)openFile(file);};
async function openFile(file){
  if(busy)return;
  setBusy(true);
  let bitmap;
  try{
    if(file.size>60*1024*1024)throw Error('Choose a JPEG or PNG smaller than 60 MB.');
    const head=new Uint8Array(await file.slice(0,8).arrayBuffer());
    if(!((head[0]===255&&head[1]===216)||(head[0]===137&&head[1]===80&&head[2]===78&&head[3]===71)))throw Error('Only JPEG and PNG photos are supported.');
    bitmap=await createImageBitmap(file,{imageOrientation:'from-image'});
    if(bitmap.width<8||bitmap.height<8)throw Error('Choose an image at least 8 by 8 pixels.');
    const originalWidth=bitmap.width,originalHeight=bitmap.height;
    await load(bitmap,file.name);
    if(originalWidth>2560||originalHeight>2560||originalWidth*originalHeight>4e6)status('Reduced to 4 MP');
  }catch(e){status(e.message||'This image could not be opened.',true);}finally{bitmap?.close();$('file').value='';setBusy(false);}
};
async function save(format){
  clearTimeout(renderTimer);setBusy(true);
  try{
    const c=await render(true);
    const blob=await new Promise(resolve=>c.toBlob(resolve,`image/${format}`,0.94));
    if(!blob)throw Error('Save failed. Try a smaller photo.');
    const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`${filename}-perspective.${format==='jpeg'?'jpg':'png'}`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
    status(`Saved ${c.width} x ${c.height}`);
  }catch(e){status(e.message,true);}finally{setBusy(false);}
}
new ResizeObserver(drawOverlay).observe(canvas);
if('serviceWorker'in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});
syncCrop();
try{await rpc('init');}catch(e){status(e.message,true);}finally{setBusy(false);}
