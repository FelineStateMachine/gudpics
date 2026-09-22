// SPDX-License-Identifier: AGPL-3.0-or-later
const $=id=>document.getElementById(id);
const standalone=matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
const ios=/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
let installPrompt;
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installPrompt=e;if(!standalone)$('install').hidden=false;});
$('install').onclick=async()=>{await installPrompt?.prompt();installPrompt=null;$('install').hidden=true;};
if(ios&&!standalone)$('install-ios').hidden=false;
$('install-ios').onclick=()=>{$('info').showModal();$('install-help').scrollIntoView({block:'center'});};
$('about').onclick=()=>$('info').showModal();
$('close-info').onclick=()=>$('info').close();
$('info').onclick=e=>{if(e.target===$('info'))$('info').close();};
if('serviceWorker'in navigator){
  let hadController=Boolean(navigator.serviceWorker.controller);navigator.serviceWorker.addEventListener('controllerchange',()=>{if(hadController)location.reload();hadController=true;});
  navigator.serviceWorker.register('./sw.js').then(async()=>{await navigator.serviceWorker.ready;$('offline-status').textContent='Works offline.';}).catch(()=>{});
}

// Per-tool details, opened from the info button on each card.
const TOOLS={
  perspective:['Perspective',['JPEG and PNG.','Straightens verticals and horizontals from detected lines. Up to 4 MP and 2560 px.','Saved copies drop EXIF and color profiles.']],
  fuji:['Fuji',['RAF files, developed at half size with the camera\'s lens corrections.','16 film simulation looks as LUTs fitted from a Fuji body: close to the camera, not the camera\'s own rendering.','The in-camera JPEG can be saved as is.']],
  social:['Social',['JPEG, PNG and WebP.','Aspect ratios for photo and social, crop or pad, frame, vignette and grain.','Social ratios export with a 1080 short side. Photo ratios keep resolution up to 2160.']],
  ela:['ELA',['Error level analysis, as on FotoForensics. The picture is re-saved as JPEG at a chosen quality and the difference is amplified.','Regions edited or pasted at a different compression level stand out from the rest. Read it as a hint, not proof.','Native pixels up to 16 MP. The map saves as PNG.']]};
const toolSheet=$('tool-sheet');
for(const b of document.querySelectorAll('[data-info]'))b.onclick=e=>{e.preventDefault();const [title,paras]=TOOLS[b.dataset.info];$('tool-title').textContent=title;$('tool-text').replaceChildren(...paras.map(t=>{const p=document.createElement('p');p.textContent=t;return p;}));toolSheet.showModal();};
toolSheet.querySelector('[data-close]').onclick=()=>toolSheet.close();toolSheet.addEventListener('click',e=>{if(e.target===toolSheet)toolSheet.close();});
