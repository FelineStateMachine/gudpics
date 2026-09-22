// SPDX-License-Identifier: AGPL-3.0-or-later
const $=id=>document.getElementById(id);
// Formats: ratio null keeps the original; size is the export size for platform presets.
const FORMATS=[
  ['original','Original',null,null],['square','Square',1,[1080,1080]],['post','Post 4:5',4/5,[1080,1350]],
  ['story','Story 9:16',9/16,[1080,1920]],['wide','Wide 16:9',16/9,[1920,1080]],['landscape','Post 1.91:1',1.91,[1080,566]],['classic','Classic 3:2',3/2,null]];
const MAX_EDGE=2160,PREVIEW_EDGE=1400;
const tool=$('tool'),canvas=$('canvas'),ctx=canvas.getContext('2d'),stage=$('stage');
let source=null,name='photo',busy=false,toastTimer,format='original',fit='crop',dark=false,pan={x:0,y:0},dragging=null,renderTimer;
// One large noise tile drawn at 1:1 so grain is pixel sized and never resampled.
const NOISE=1024;const noise=(()=>{const c=document.createElement('canvas');c.width=c.height=NOISE;const x=c.getContext('2d'),d=x.createImageData(NOISE,NOISE);let s=1234567;for(let i=0;i<d.data.length;i+=4){s=(s*1664525+1013904223)>>>0;const v=(s>>>8)&255;d.data[i]=d.data[i+1]=d.data[i+2]=v;d.data[i+3]=255;}x.putImageData(d,0,0);return c;})();

function status(message,error=false){clearTimeout(toastTimer);const el=$('status');el.textContent=message;el.classList.toggle('error',error);el.hidden=!message;if(message)toastTimer=setTimeout(()=>{el.hidden=true;},error?5000:2500);}
function sync(){
  tool.dataset.state=source?'detected':'empty';
  const ready=Boolean(source)&&!busy;
  for(const id of ['save','share','color','reset','frame','vignette','grain'])$(id).disabled=!ready;
  $('open').disabled=busy;$('open-empty').disabled=busy;$('busy').hidden=!busy;
  for(const b of $('formats').children){b.setAttribute('aria-checked',String(b.dataset.format===format));b.disabled=!ready;}
  for(const b of $('fit').children){b.setAttribute('aria-pressed',String(b.dataset.fit===fit));b.disabled=!ready||format==='original';}
  $('color').setAttribute('aria-pressed',String(dark));
  $('frame-value').value=$('frame').value+'%';$('vignette-value').value=$('vignette').value;$('grain-value').value=$('grain').value;
}
function layout(){
  if(!canvas.width)return;
  const cs=getComputedStyle(stage),w=stage.clientWidth-parseFloat(cs.paddingLeft)-parseFloat(cs.paddingRight),h=stage.clientHeight-parseFloat(cs.paddingTop)-parseFloat(cs.paddingBottom);
  const s=Math.min(w/canvas.width,h/canvas.height);canvas.style.width=Math.max(1,Math.floor(canvas.width*s))+'px';canvas.style.height=Math.max(1,Math.floor(canvas.height*s))+'px';
}
new ResizeObserver(layout).observe(stage);
// Output geometry: returns {w,h, sx,sy,sw,sh (source crop), dx,dy,dw,dh (placement)} for a given long edge budget.
function geometry(maxEdge,fixed){
  const f=FORMATS.find(f=>f[0]===format),ratio=f[2],size=f[3],sw0=source.width,sh0=source.height;
  let w,h;
  if(fixed&&size){[w,h]=size;}
  else{
    const r=ratio||sw0/sh0;
    if(fit==='pad'&&ratio){const contained=sw0/sh0>r?[sw0,Math.round(sw0/r)]:[Math.round(sh0*r),sh0];[w,h]=contained;}
    else{[w,h]=sw0/sh0>r?[Math.round(sh0*r),sh0]:[sw0,Math.round(sw0/r)];}
    const s=Math.min(1,maxEdge/Math.max(w,h));w=Math.round(w*s);h=Math.round(h*s);
  }
  const r=w/h;
  if(fit==='pad'&&ratio){
    const s=Math.min(w/sw0,h/sh0),dw=sw0*s,dh=sh0*s;
    return {w,h,sx:0,sy:0,sw:sw0,sh:sh0,dx:(w-dw)/2,dy:(h-dh)/2,dw,dh};
  }
  let sw=sw0,sh=sh0;if(sw0/sh0>r)sw=sh0*r;else sh=sw0/r;
  const sx=(sw0-sw)/2*(1+pan.x),sy=(sh0-sh)/2*(1+pan.y);
  return {w,h,sx,sy,sw,sh,dx:0,dy:0,dw:w,dh:h};
}
function paint(target,g){
  const x=target.getContext('2d'),bg=dark?'#000':'#fff';
  target.width=g.w;target.height=g.h;
  x.fillStyle=bg;x.fillRect(0,0,g.w,g.h);
  const framePct=Number($('frame').value)/100,border=Math.round(Math.min(g.w,g.h)*framePct);
  // Picture area inside the frame
  const aw=g.w-2*border,ah=g.h-2*border;
  x.save();x.beginPath();x.rect(border,border,aw,ah);x.clip();
  const scale=Math.min(aw/g.w,ah/g.h);
  x.translate(border,border);x.scale(scale,scale);
  x.imageSmoothingQuality='high';
  x.drawImage(source,g.sx,g.sy,g.sw,g.sh,g.dx,g.dy,g.dw,g.dh);
  const vig=Number($('vignette').value)/100;
  if(vig>0){const cx=g.dx+g.dw/2,cy=g.dy+g.dh/2,rad=Math.hypot(g.dw,g.dh)/2;const grad=x.createRadialGradient(cx,cy,rad*0.35,cx,cy,rad);grad.addColorStop(0,'rgba(0,0,0,0)');grad.addColorStop(1,`rgba(0,0,0,${(0.85*vig).toFixed(3)})`);x.fillStyle=grad;x.fillRect(g.dx,g.dy,g.dw,g.dh);}
  const grain=Number($('grain').value)/100;
  if(grain>0){x.save();x.beginPath();x.rect(g.dx,g.dy,g.dw,g.dh);x.clip();x.setTransform(1,0,0,1,0,0);x.globalCompositeOperation='overlay';x.globalAlpha=Math.min(1,grain*0.55);
    for(let ty=0;ty<g.h;ty+=NOISE)for(let tx=0;tx<g.w;tx+=NOISE)x.drawImage(noise,tx,ty);x.restore();}
  x.restore();
}
function render(){
  if(!source)return;
  const g=geometry(PREVIEW_EDGE,false);paint(canvas,g);layout();
  const full=geometry(MAX_EDGE,true);$('dims').textContent=`${full.w} x ${full.h}`;$('dims').hidden=false;
}
function scheduleRender(){sync();clearTimeout(renderTimer);renderTimer=setTimeout(render,16);}
async function exportBlob(){const c=document.createElement('canvas');paint(c,geometry(MAX_EDGE,true));const blob=await new Promise(res=>c.toBlob(res,'image/jpeg',0.92));if(!blob)throw Error('Could not encode the JPEG.');return {blob,w:c.width,h:c.height};}
function download(blob,fname){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=fname;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
async function openFile(file){
  if(busy)return;busy=true;sync();
  try{
    if(!/^image\/(jpeg|png|webp)$/.test(file.type))throw Error('Choose a JPEG, PNG or WebP.');
    const bitmap=await createImageBitmap(file,{imageOrientation:'from-image'});
    source?.close?.();source=bitmap;name=file.name.replace(/\.[^.]+$/,'');pan={x:0,y:0};
    status('');render();
  }catch(e){status(e.message||'Could not open this image.',true);}
  finally{busy=false;sync();}
}
// Controls
for(const [id,label] of FORMATS){const b=document.createElement('button');b.className='chip-btn';b.role='radio';b.dataset.format=id;b.textContent=label;b.disabled=true;b.onclick=()=>{format=id;pan={x:0,y:0};scheduleRender();b.scrollIntoView({inline:'center',block:'nearest',behavior:'smooth'});};$('formats').append(b);}
for(const b of $('fit').children)b.onclick=()=>{fit=b.dataset.fit;scheduleRender();};
for(const id of ['frame','vignette','grain'])$(id).oninput=scheduleRender;
$('color').onclick=()=>{dark=!dark;scheduleRender();};
$('reset').onclick=()=>{format='original';fit='crop';dark=false;pan={x:0,y:0};$('frame').value=0;$('vignette').value=0;$('grain').value=0;scheduleRender();};
$('file').onchange=()=>{const f=$('file').files[0];if(f)openFile(f);$('file').value='';};
$('open').onclick=()=>$('file').click();$('open-empty').onclick=()=>$('file').click();
// Drag to position the crop.
stage.addEventListener('pointerdown',e=>{if(!source||fit==='pad'||format==='original'||e.target.closest('button'))return;dragging={x:e.clientX,y:e.clientY,pan:{...pan}};try{stage.setPointerCapture(e.pointerId);}catch{}});
stage.addEventListener('pointermove',e=>{if(!dragging)return;const g=geometry(PREVIEW_EDGE,false),rect=canvas.getBoundingClientRect(),k=g.w/rect.width;
  const rangeX=(source.width-g.sw)/2*(g.w/g.sw),rangeY=(source.height-g.sh)/2*(g.h/g.sh);
  pan.x=rangeX>0?Math.max(-1,Math.min(1,dragging.pan.x-(e.clientX-dragging.x)*k/rangeX)):0;pan.y=rangeY>0?Math.max(-1,Math.min(1,dragging.pan.y-(e.clientY-dragging.y)*k/rangeY)):0;scheduleRender();});
for(const t of ['pointerup','pointercancel'])stage.addEventListener(t,()=>{dragging=null;});
stage.addEventListener('dragover',e=>{e.preventDefault();e.dataTransfer.dropEffect='copy';$('open-empty').classList.add('over');});
stage.addEventListener('dragleave',()=>$('open-empty').classList.remove('over'));
stage.addEventListener('drop',e=>{e.preventDefault();$('open-empty').classList.remove('over');const f=e.dataTransfer.files[0];if(f)openFile(f);});
stage.addEventListener('contextmenu',e=>e.preventDefault());
$('save').onclick=async()=>{if(!source)return;busy=true;sync();try{const {blob,w,h}=await exportBlob();download(blob,`${name}-${format}.jpg`);status(`Saved ${w} x ${h}`);}catch(e){status(e.message,true);}finally{busy=false;sync();}};
if(navigator.canShare&&navigator.share)$('share').hidden=false;
$('share').onclick=async()=>{
  if(!source)return;
  try{
    const {blob}=await exportBlob();const file=new File([blob],`${name}-${format}.jpg`,{type:'image/jpeg'});
    if(!navigator.canShare({files:[file]}))throw Error('Sharing files is not supported here.');
    await navigator.share({files:[file]});
  }catch(e){if(e.name==='AbortError')return;if(e.name==='NotAllowedError'){const {blob}=await exportBlob();download(blob,`${name}-${format}.jpg`);status('Saved. Share it from your photos.');}else status(e.message,true);}
};
if('serviceWorker'in navigator){navigator.serviceWorker.register('./sw.js').catch(()=>{});let hadController=Boolean(navigator.serviceWorker.controller);navigator.serviceWorker.addEventListener('controllerchange',()=>{if(hadController&&!source)location.reload();hadController=true;});}
sync();
